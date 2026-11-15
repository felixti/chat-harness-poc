// Cost per chat and per user per month (H58). Every turn adds one row to a ledger: what OpenRouter
// billed for each model call (usage.cost in the stream; the price list alone was 9x off for
// DeepSeek, routed to a pricier provider), the price-list estimate only when that is missing, plus
// generated images at the cost the provider reported. Rows stay when a
// conversation is deleted or an answer regenerated: the money was spent. Shown in BRL at a
// configured rate (USD_BRL); the memory curator's background calls are not counted here.
import { MongoClient, type Collection } from "mongodb";
import { config } from "./config.ts";

export interface TurnUsage {
	usd: number;
	input: number;
	output: number;
	cacheRead: number;
	calls: number;
	images: number;
	model: string;
}

export const emptyUsage = (model: string): TurnUsage => ({ usd: 0, input: 0, output: 0, cacheRead: 0, calls: 0, images: 0, model });

interface Row extends TurnUsage {
	user: string;
	conv: string;
	at: Date;
}

export interface Spend {
	usd: number;
	brl: number;
	turns: number;
}

export interface UsageLedger {
	add(user: string, conv: string, u: TurnUsage, at?: Date): Promise<void>;
	conversation(user: string, conv: string): Promise<Spend>;
	month(user: string, now?: Date): Promise<Spend>;
}

const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) + 3 * 3600_000); // 00:00 in Brasília (UTC-3)
const toSpend = (rows: { usd: number }[]): Spend => {
	const usd = rows.reduce((s, r) => s + (r.usd || 0), 0);
	return { usd, brl: usd * config.usdBrl, turns: rows.length };
};

class MemoryLedger implements UsageLedger {
	rows: Row[] = [];
	async add(user: string, conv: string, u: TurnUsage, at = new Date()) {
		this.rows.push({ ...u, user, conv, at });
	}
	async conversation(user: string, conv: string) {
		return toSpend(this.rows.filter((r) => r.user === user && r.conv === conv));
	}
	async month(user: string, now = new Date()) {
		const from = monthStart(now);
		return toSpend(this.rows.filter((r) => r.user === user && r.at >= from));
	}
}

class MongoLedger implements UsageLedger {
	private col: Collection<Row>;
	constructor(col: Collection<Row>) {
		this.col = col;
	}
	static async connect(url: string) {
		const client = await new MongoClient(url, { appName: "chat-api-usage" }).connect();
		const col = client.db().collection<Row>("usage");
		await col.createIndex({ user: 1, at: -1 });
		await col.createIndex({ user: 1, conv: 1 });
		return new MongoLedger(col);
	}
	async add(user: string, conv: string, u: TurnUsage, at = new Date()) {
		await this.col.insertOne({ ...u, user, conv, at });
	}
	async conversation(user: string, conv: string) {
		return toSpend(await this.col.find({ user, conv }, { projection: { usd: 1 } }).toArray());
	}
	async month(user: string, now = new Date()) {
		return toSpend(await this.col.find({ user, at: { $gte: monthStart(now) } }, { projection: { usd: 1 } }).toArray());
	}
}

export const openLedger = (mongoUrl: string): Promise<UsageLedger> => (mongoUrl ? MongoLedger.connect(mongoUrl) : Promise.resolve(new MemoryLedger()));

/** Gateway price list (OpenRouter /models): USD per million tokens, for pi's cost calculation. */
export async function gatewayPrices(ids: string[]): Promise<Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>> {
	try {
		const r = await fetch(`${config.llm.baseUrl}/models`, { headers: { authorization: `Bearer ${config.llm.apiKey}` }, signal: AbortSignal.timeout(10_000) });
		const { data } = (await r.json()) as { data: { id: string; pricing?: Record<string, string> }[] };
		const per = (v?: string) => (Number(v) || 0) * 1_000_000;
		return Object.fromEntries(
			data
				.filter((m) => ids.includes(m.id))
				.map((m) => [m.id, { input: per(m.pricing?.prompt), output: per(m.pricing?.completion), cacheRead: per(m.pricing?.input_cache_read ?? m.pricing?.prompt), cacheWrite: per(m.pricing?.input_cache_write ?? m.pricing?.prompt) }]),
		);
	} catch (e) {
		console.warn(`[usage] price list unavailable, costs will read 0: ${(e as Error).message}`);
		return {};
	}
}
