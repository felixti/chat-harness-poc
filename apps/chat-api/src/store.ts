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
	/** Most recent conversations with their summaries (episodic context for every turn). */
	recent(user: string, limit: number, exclude?: string): Promise<Episode[]>;
	/** Earlier conversations of this user matching any keyword (episodic memory). */
	search(user: string, query: string, limit: number, exclude?: string): Promise<SearchHit[]>;
}

export class MemoryStore implements ConversationStore {
	private readonly items = new Map<string, Conversation>();
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

export class MongoStore implements ConversationStore {
	private readonly col: Collection<Doc>;
	private constructor(col: Collection<Doc>) {
		this.col = col;
	}

	static async connect(url: string): Promise<MongoStore> {
		const client = await new MongoClient(url, { appName: "chat-api" }).connect();
		const col = client.db().collection<Doc>("conversations");
		await col.createIndex({ user: 1, updatedAt: -1 });
		return new MongoStore(col);
	}

	async get(user: string, id: string) {
		// Filter by user too: a conversation id alone never grants access.
		const d = await this.col.findOne({ _id: id, user });
		return d ? { id: d._id, user: d.user, title: d.title, entries: d.entries, updatedAt: d.updatedAt, summary: d.summary, version: d.version ?? 0 } : undefined;
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
