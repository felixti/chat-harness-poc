// Share links (H72): a read-only, frozen copy of a conversation or a canvas, opened by anyone who
// signs in to the company tenant (the gateway authenticates every request; no anonymous access).
// The copy is taken when the link is created: later turns do not change it. The conversation's
// deliverables (outputs/) are copied next to it; uploads are not shared. The owner can revoke it.
import { randomBytes } from "node:crypto";
import { MongoClient, type Collection } from "mongodb";
import { objectStore } from "./workspace.ts";
import type { ViewMessage } from "./conversation-view.ts";

export interface ShareCanvas {
	name: string;
	title: string;
	version?: number;
	html: string;
	state: unknown;
}

export interface Share {
	id: string;
	/** Owner oid; never sent to viewers. */
	user: string;
	kind: "conversation" | "canvas";
	conversation: string;
	title: string;
	createdAt: Date;
	expiresAt: Date;
	messages?: ViewMessage[];
	files?: { path: string; size: number }[];
	canvas?: ShareCanvas;
	/** Files left out because of the limits (shown to the viewer as a note). */
	skipped?: number;
}

export const SHARE_ID = /^[A-Za-z0-9_-]{22}$/;
export const SHARE_DAYS = [7, 30, 90] as const;
export const SHARE_LIMITS = { files: 20, bytes: 50 * 1024 * 1024 };

export interface ShareStore {
	put(s: Share): Promise<void>;
	get(id: string): Promise<Share | undefined>;
	ofConversation(user: string, conversation: string): Promise<Share[]>;
	remove(user: string, id: string): Promise<boolean>;
	removeOfConversation(user: string, conversation: string): Promise<string[]>;
}

export class MemoryShares implements ShareStore {
	readonly items = new Map<string, Share>();
	async put(s: Share) {
		this.items.set(s.id, s);
	}
	async get(id: string) {
		return this.items.get(id);
	}
	async ofConversation(user: string, conversation: string) {
		return [...this.items.values()].filter((s) => s.user === user && s.conversation === conversation).sort((a, b) => +b.createdAt - +a.createdAt);
	}
	async remove(user: string, id: string) {
		return this.items.get(id)?.user === user && this.items.delete(id);
	}
	async removeOfConversation(user: string, conversation: string) {
		const ids = (await this.ofConversation(user, conversation)).map((s) => s.id);
		for (const id of ids) this.items.delete(id);
		return ids;
	}
}

type Doc = Omit<Share, "id"> & { _id: string };
const fromDoc = ({ _id, ...d }: Doc): Share => ({ id: _id, ...d });

export class MongoShares implements ShareStore {
	private readonly col: Collection<Doc>;
	private constructor(col: Collection<Doc>) {
		this.col = col;
	}
	static async connect(url: string) {
		const client = await new MongoClient(url, { appName: "chat-api-shares" }).connect();
		const col = client.db().collection<Doc>("shares");
		await col.createIndex({ user: 1, conversation: 1 });
		return new MongoShares(col);
	}
	async put({ id, ...s }: Share) {
		await this.col.insertOne({ _id: id, ...s });
	}
	async get(id: string) {
		const d = await this.col.findOne({ _id: id });
		return d ? fromDoc(d) : undefined;
	}
	async ofConversation(user: string, conversation: string) {
		const docs = await this.col.find({ user, conversation }, { projection: { messages: 0 } }).sort({ createdAt: -1 }).limit(50).toArray();
		return docs.map(fromDoc);
	}
	async remove(user: string, id: string) {
		return (await this.col.deleteOne({ _id: id, user })).deletedCount === 1;
	}
	async removeOfConversation(user: string, conversation: string) {
		const ids = (await this.col.find({ user, conversation }, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
		if (ids.length) await this.col.deleteMany({ _id: { $in: ids }, user });
		return ids;
	}
}

export async function openShares(mongoUrl: string): Promise<ShareStore> {
	return mongoUrl ? MongoShares.connect(mongoUrl) : new MemoryShares();
}

/** 128 random bits, URL-safe: the link is the only thing that names the share. */
export const newShareId = () => randomBytes(16).toString("base64url");

/** Blob prefix of a share's file copies; "_" cannot start a user oid, so no clash. */
export const sharePrefix = (id: string) => `_shares/${id}/`;

/** Copies the conversation's deliverables next to the share, within the limits. */
export async function copyOutputs(user: string, conversation: string, id: string): Promise<{ files: { path: string; size: number }[]; skipped: number }> {
	const s = objectStore();
	const from = `${user}/${conversation}/`;
	const outputs = (await s.list(from)).filter((f) => f.path.startsWith("outputs/") && !f.path.endsWith(".preview.png")).sort((a, b) => a.path.localeCompare(b.path));
	const files: { path: string; size: number }[] = [];
	let bytes = 0;
	for (const f of outputs) {
		if (files.length >= SHARE_LIMITS.files || bytes + f.size > SHARE_LIMITS.bytes) continue;
		const data = await s.get(from + f.path);
		if (!data) continue;
		await s.put(sharePrefix(id) + f.path, data);
		files.push({ path: f.path, size: data.length });
		bytes += data.length;
	}
	return { files, skipped: outputs.length - files.length };
}

export async function deleteShareFiles(id: string) {
	const s = objectStore();
	for (const f of await s.list(sharePrefix(id))) await s.delete(sharePrefix(id) + f.path);
}

export const expired = (s: Share, now = new Date()) => +s.expiresAt <= +now;

/** What a viewer receives: no owner id, no conversation id. */
export function viewOf(s: Share) {
	return { id: s.id, kind: s.kind, title: s.title, createdAt: s.createdAt, expiresAt: s.expiresAt, messages: s.messages, files: s.files, canvas: s.canvas, skipped: s.skipped };
}

/** What the owner sees in the share dialog. */
export function summaryOf(s: Share) {
	return { id: s.id, kind: s.kind, title: s.title, canvas: s.canvas?.name, createdAt: s.createdAt, expiresAt: s.expiresAt, expired: expired(s) };
}
