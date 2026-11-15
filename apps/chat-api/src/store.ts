// Conversation history. Memory store for local runs; Mongo-compatible store (FerretDB in the
// PoC, the company's MongoDB or memory service later) when MONGO_URL is set.
import { MongoClient, type Collection } from "mongodb";

export interface Conversation {
	id: string;
	user: string;
	title: string;
	/** Pi session entries (messages, tool calls, compactions) to rebuild the session. */
	entries: unknown[];
	updatedAt: Date;
	/** Curator's 1-2 sentence summary: what was asked and the outcome (episodic memory). */
	summary?: string;
	/** AG-UI interrupts waiting for the user (approvals, questions); cleared by the next turn. */
	pending?: import("./approvals.ts").Pending[];
	/** Last time the memory curator processed this conversation (nightly job). */
	curatedAt?: Date;
	/** Optimistic concurrency: save() succeeds only if the stored version is still this one
	 *  (undefined = new conversation). Backs up the per-conversation lease. */
	version?: number;
}

export class ConflictError extends Error {
	status = 409;
	constructor() {
		super("conversation changed in another tab or device; reload it");
	}
}

export type ConversationSummary = Pick<Conversation, "id" | "title" | "updatedAt">;

export interface SearchHit extends ConversationSummary {
	snippets: string[];
	summary?: string;
}

export interface Episode extends ConversationSummary {
	summary?: string;
}

/** User and assistant text of a Pi session (tool output left out: big and often third-party). */
export function conversationText(entries: unknown[], max = 100_000): string {
	const out: string[] = [];
	for (const e of entries as { message?: { role?: string; content?: unknown } }[]) {
		const m = e?.message;
		if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
		if (typeof m.content === "string") out.push(m.content);
		else if (Array.isArray(m.content)) for (const c of m.content as { type?: string; text?: string }[]) if (c?.type === "text" && c.text) out.push(c.text);
	}
	const text = out.join("\n");
	return text.length > max ? text.slice(-max) : text;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Ranks by distinct terms found (accent-insensitive), then by recency; 2 snippets per hit. */
export function rank(docs: { id: string; title: string; updatedAt: Date; text: string; summary?: string }[], query: string, limit: number): SearchHit[] {
	const terms = [...new Set(fold(query).split(/\s+/).filter((t) => t.length >= 2))];
	if (!terms.length) return [];
	return docs
		.map((d) => {
			const hay = fold(`${d.title}\n${d.summary ?? ""}\n${d.text}`);
			const found = terms.filter((t) => hay.includes(t));
			const snippets: string[] = [];
			const plain = d.text;
			const folded = fold(plain);
			for (const t of found) {
				const i = folded.indexOf(t);
				if (i < 0 || snippets.length >= 2) continue;
				snippets.push(plain.slice(Math.max(0, i - 120), i + 180).replace(/\s+/g, " ").trim());
			}
			return { id: d.id, title: d.title, updatedAt: d.updatedAt, summary: d.summary, snippets, score: found.length };
		})
		.filter((h) => h.score > 0)
		.sort((a, b) => b.score - a.score || +b.updatedAt - +a.updatedAt)
		.slice(0, limit)
		.map(({ score: _s, ...h }) => h);
}

export function searchTerms(query: string): string[] {
	return [...new Set(query.split(/\s+/).filter((t) => t.length >= 2))].map(escapeRe);
}

export interface ConversationStore {
	get(user: string, id: string): Promise<Conversation | undefined>;
	save(c: Conversation): Promise<void>;
	list(user: string): Promise<ConversationSummary[]>;
	rename(user: string, id: string, title: string): Promise<boolean>;
	remove(user: string, id: string): Promise<boolean>;
	/** Thumbs up/down on an assistant turn (null clears it). Kept apart from the history document. */
	feedback(user: string, id: string, turn: string, value: "up" | "down" | null): Promise<void>;
	feedbackOf(user: string, id: string): Promise<Record<string, "up" | "down">>;
	/** Conversations changed since `since` that the curator has not processed yet (all users). */
	pendingCuration(since: Date, limit: number): Promise<Conversation[]>;
	markCurated(user: string, id: string, summary: string | undefined, at: Date): Promise<void>;
	/** Most recent conversations with their summaries (episodic context for every turn). */
	recent(user: string, limit: number, exclude?: string): Promise<Episode[]>;
	/** Earlier conversations of this user matching any keyword (episodic memory). */
	search(user: string, query: string, limit: number, exclude?: string): Promise<SearchHit[]>;
}

export class MemoryStore implements ConversationStore {
	private readonly items = new Map<string, Conversation>();
	private readonly votes = new Map<string, Record<string, "up" | "down">>();
	async rename(user: string, id: string, title: string) {
		const c = this.items.get(id);
		if (!c || c.user !== user) return false;
		c.title = title;
		return true;
	}
	async pendingCuration(since: Date, limit: number) {
		return [...this.items.values()].filter((c) => c.updatedAt >= since && (!c.curatedAt || c.curatedAt < c.updatedAt)).slice(0, limit);
	}
	async markCurated(user: string, id: string, summary: string | undefined, at: Date) {
		const c = this.items.get(id);
		if (c && c.user === user) Object.assign(c, { curatedAt: at, ...(summary ? { summary } : {}) });
	}
	async remove(user: string, id: string) {
		const c = this.items.get(id);
		if (!c || c.user !== user) return false;
		this.items.delete(id);
		this.votes.delete(`${user}/${id}`);
		return true;
	}
	async feedback(user: string, id: string, turn: string, value: "up" | "down" | null) {
		const k = `${user}/${id}`;
		const v = { ...(this.votes.get(k) ?? {}) };
		if (value) v[turn] = value;
		else delete v[turn];
		this.votes.set(k, v);
	}
	async feedbackOf(user: string, id: string) {
		return this.votes.get(`${user}/${id}`) ?? {};
	}
	async get(user: string, id: string) {
		const c = this.items.get(id);
		return c && c.user === user ? c : undefined;
	}
	async save(c: Conversation) {
		const cur = this.items.get(c.id);
		if ((cur?.version ?? undefined) !== c.version || (cur && cur.user !== c.user)) throw new ConflictError();
		this.items.set(c.id, { ...c, version: (c.version ?? 0) + 1 });
	}
	async recent(user: string, limit: number, exclude?: string) {
		return [...this.items.values()]
			.filter((c) => c.user === user && c.id !== exclude)
			.sort((a, b) => +b.updatedAt - +a.updatedAt)
			.slice(0, limit)
			.map(({ id, title, updatedAt, summary }) => ({ id, title, updatedAt, summary }));
	}
	async search(user: string, query: string, limit: number, exclude?: string) {
		const mine = [...this.items.values()].filter((c) => c.user === user && c.id !== exclude);
		return rank(mine.map((c) => ({ ...c, text: conversationText(c.entries) })), query, limit);
	}
	async list(user: string) {
		return [...this.items.values()]
			.filter((c) => c.user === user)
			.sort((a, b) => +b.updatedAt - +a.updatedAt)
			.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
	}
}

type Doc = Omit<Conversation, "id"> & { _id: string; text?: string };

type Vote = { _id: string; user: string; conversation: string; turn: string; value: "up" | "down"; at: Date };

export class MongoStore implements ConversationStore {
	private readonly col: Collection<Doc>;
	private readonly votes: Collection<Vote>;
	private constructor(col: Collection<Doc>, votes: Collection<Vote>) {
		this.col = col;
		this.votes = votes;
	}

	async rename(user: string, id: string, title: string) {
		return (await this.col.updateOne({ _id: id, user }, { $set: { title } })).matchedCount === 1;
	}

	async pendingCuration(since: Date, limit: number) {
		// Filtered in code: FerretDB's $expr support is partial, and the window is one or two days.
		const docs = await this.col.find({ updatedAt: { $gte: since } } as never).sort({ updatedAt: 1 }).limit(limit * 4).toArray();
		return docs
			.filter((d) => !d.curatedAt || d.curatedAt < d.updatedAt)
			.slice(0, limit)
			.map((d) => ({ id: d._id, user: d.user, title: d.title, entries: d.entries, updatedAt: d.updatedAt, summary: d.summary, curatedAt: d.curatedAt, version: d.version ?? 0 }));
	}

	async markCurated(user: string, id: string, summary: string | undefined, at: Date) {
		// $set only: neither the history nor its version changes, so a running turn is not disturbed.
		await this.col.updateOne({ _id: id, user }, { $set: { curatedAt: at, ...(summary ? { summary } : {}) } });
	}

	async remove(user: string, id: string) {
		await this.votes.deleteMany({ user, conversation: id });
		return (await this.col.deleteOne({ _id: id, user })).deletedCount === 1;
	}

	async feedback(user: string, id: string, turn: string, value: "up" | "down" | null) {
		const _id = `${user}/${id}/${turn}`;
		if (!value) await this.votes.deleteOne({ _id });
		else await this.votes.replaceOne({ _id }, { user, conversation: id, turn, value, at: new Date() }, { upsert: true });
	}

	async feedbackOf(user: string, id: string) {
		const rows = await this.votes.find({ user, conversation: id }).toArray();
		return Object.fromEntries(rows.map((r) => [r.turn, r.value]));
	}

	static async connect(url: string): Promise<MongoStore> {
		const client = await new MongoClient(url, { appName: "chat-api" }).connect();
		const col = client.db().collection<Doc>("conversations");
		await col.createIndex({ user: 1, updatedAt: -1 });
		const votes = client.db().collection<Vote>("feedback");
		await votes.createIndex({ user: 1, conversation: 1 });
		return new MongoStore(col, votes);
	}

	async get(user: string, id: string) {
		// Filter by user too: a conversation id alone never grants access.
		const d = await this.col.findOne({ _id: id, user });
		return d ? { id: d._id, user: d.user, title: d.title, entries: d.entries, updatedAt: d.updatedAt, summary: d.summary, curatedAt: d.curatedAt, pending: d.pending, version: d.version ?? 0 } : undefined;
	}

	async save(c: Conversation) {
		const { id, version, ...base } = c;
		const rest = { ...base, text: conversationText(c.entries) }; // searchable copy for session_search
		if (version === undefined) {
			await this.col.insertOne({ _id: id, ...rest, version: 1 }).catch((e) => Promise.reject(e?.code === 11000 ? new ConflictError() : e));
			return;
		}
		// Documents written before versioning have no field: treat that as version 0.
		const filter = version === 0 ? { _id: id, user: c.user, version: { $in: [0, null] } } : { _id: id, user: c.user, version };
		const r = await this.col.replaceOne(filter as never, { ...rest, version: version + 1 });
		if (r.matchedCount === 0) throw new ConflictError();
	}

	async search(user: string, query: string, limit: number, exclude?: string) {
		// Accents vary ("orcamento" vs "orçamento"): the regex matches each term with or without them.
		const terms = searchTerms(query.normalize("NFD").replace(/\p{M}/gu, "")).slice(0, 8);
		if (!terms.length) return [];
		const loose = (t: string) => t.replace(/[aeioucn]/gi, (ch) => ACCENTS[ch.toLowerCase()] ?? ch);
		const or = terms.flatMap((t) => ["text", "title", "summary"].map((f) => ({ [f]: { $regex: loose(t), $options: "i" } })));
		const docs = await this.col
			.find({ user, ...(exclude ? { _id: { $ne: exclude } } : {}), $or: or } as never, { projection: { title: 1, updatedAt: 1, text: 1, summary: 1 } })
			.sort({ updatedAt: -1 })
			.limit(50)
			.toArray();
		return rank(docs.map((d) => ({ id: d._id, title: d.title, updatedAt: d.updatedAt, text: d.text ?? "", summary: d.summary })), query, limit);
	}

	async recent(user: string, limit: number, exclude?: string) {
		const docs = await this.col
			.find({ user, ...(exclude ? { _id: { $ne: exclude } } : {}) } as never, { projection: { title: 1, updatedAt: 1, summary: 1 } })
			.sort({ updatedAt: -1 })
			.limit(limit)
			.toArray();
		return docs.map((d) => ({ id: d._id, title: d.title, updatedAt: d.updatedAt, summary: d.summary }));
	}

	async list(user: string) {
		const docs = await this.col.find({ user }, { projection: { title: 1, updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(50).toArray();
		return docs.map((d) => ({ id: d._id, title: d.title, updatedAt: d.updatedAt }));
	}
}

const ACCENTS: Record<string, string> = { a: "[aáàâãä]", e: "[eéèêë]", i: "[iíìîï]", o: "[oóòôõö]", u: "[uúùûü]", c: "[cç]", n: "[nñ]" };

export async function openStore(mongoUrl: string): Promise<ConversationStore> {
	return mongoUrl ? MongoStore.connect(mongoUrl) : new MemoryStore();
}
