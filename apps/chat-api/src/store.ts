// Conversation history. Memory store for local runs; Mongo-compatible store (FerretDB in the
// PoC, the company's MongoDB or memory service later) when MONGO_URL is set.
export interface Conversation {
	id: string;
	user: string;
	title: string;
	entries: unknown[];
	updatedAt: Date;
}

export interface ConversationStore {
	get(user: string, id: string): Promise<Conversation | undefined>;
	save(c: Conversation): Promise<void>;
	list(user: string): Promise<Pick<Conversation, "id" | "title" | "updatedAt">[]>;
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
