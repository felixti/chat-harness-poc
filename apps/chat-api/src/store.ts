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
}

export type ConversationSummary = Pick<Conversation, "id" | "title" | "updatedAt">;

export interface ConversationStore {
	get(user: string, id: string): Promise<Conversation | undefined>;
	save(c: Conversation): Promise<void>;
	list(user: string): Promise<ConversationSummary[]>;
}

export class MemoryStore implements ConversationStore {
	private readonly items = new Map<string, Conversation>();
	async get(user: string, id: string) {
		const c = this.items.get(id);
		return c && c.user === user ? c : undefined;
	}
	async save(c: Conversation) {
		this.items.set(c.id, c);
	}
	async list(user: string) {
		return [...this.items.values()]
			.filter((c) => c.user === user)
			.sort((a, b) => +b.updatedAt - +a.updatedAt)
			.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
	}
}

type Doc = Omit<Conversation, "id"> & { _id: string };

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
		return d ? { id: d._id, user: d.user, title: d.title, entries: d.entries, updatedAt: d.updatedAt } : undefined;
	}

	async save(c: Conversation) {
		const { id, ...rest } = c;
		await this.col.replaceOne({ _id: id, user: c.user }, rest, { upsert: true });
	}

	async list(user: string) {
		const docs = await this.col.find({ user }, { projection: { title: 1, updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(50).toArray();
		return docs.map((d) => ({ id: d._id, title: d.title, updatedAt: d.updatedAt }));
	}
}

export async function openStore(mongoUrl: string): Promise<ConversationStore> {
	return mongoUrl ? MongoStore.connect(mongoUrl) : new MemoryStore();
}
