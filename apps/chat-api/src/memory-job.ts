// Nightly memory curation (CronJob 03:00 UTC, docs/design.md H44): for each conversation changed
// since its last curation, read the new user messages and the latest answer, and let the curator
// update core memory, the facts graph and the conversation summary. Idempotent: curatedAt marks
// what was processed, so a missed night is picked up by the next one.
import type { Conversation, ConversationStore } from "./store.ts";
import type { CuratorInput, CuratorResult } from "./curator.ts";
import type { FactGraph } from "./graph-memory.ts";

type Entry = { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };

const textOf = (content: unknown): string =>
	typeof content === "string" ? content : Array.isArray(content) ? (content as { type?: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") : "";

/** User messages after `after` (all of them when never curated) and the last assistant answer. */
export function newMaterial(c: Conversation): { userText: string; reply: string } {
	const after = c.curatedAt ? +new Date(c.curatedAt) : 0;
	const users: string[] = [];
	let reply = "";
	for (const e of c.entries as Entry[]) {
		const m = e?.message;
		if (e?.type !== "message" || !m) continue;
		if (m.role === "user" && (!e.timestamp || +new Date(e.timestamp) > after)) users.push(textOf(m.content).replace(/^\/skill:[\w-]+\s+/, ""));
		if (m.role === "assistant") {
			const t = textOf(m.content);
			if (t.trim()) reply = t;
		}
	}
	return { userText: users.filter(Boolean).join("\n\n").slice(-6000), reply };
}

export interface JobDeps {
	store: ConversationStore;
	curate: (input: CuratorInput, graph: FactGraph | undefined) => Promise<CuratorResult>;
	graphFor: (user: string, conversation: string) => FactGraph | undefined;
	now?: Date;
	lookbackHours?: number;
	limit?: number;
}

export async function runCuration(d: JobDeps): Promise<{ processed: number; saved: number; skipped: number; failed: number }> {
	const now = d.now ?? new Date();
	const since = new Date(+now - (d.lookbackHours ?? 48) * 3_600_000);
	const pending = await d.store.pendingCuration(since, d.limit ?? 500);
	const stats = { processed: 0, saved: 0, skipped: 0, failed: 0 };
	for (const c of pending) {
		const { userText, reply } = newMaterial(c);
		if (!userText.trim()) {
			await d.store.markCurated(c.user, c.id, undefined, now);
			stats.skipped++;
			continue;
		}
		const graph = d.graphFor(c.user, c.id);
		try {
			const r = await d.curate({ user: c.user, userMessage: userText, assistantReply: reply, alreadySaved: [], previousSummary: c.summary }, graph);
			await d.store.markCurated(c.user, c.id, r.summary, now);
			stats.processed++;
			stats.saved += r.saved.length;
		} catch (e) {
			// Left uncurated: the next run retries it.
			console.warn(`[memory-job] ${c.id}: ${(e as Error).message}`);
			stats.failed++;
		} finally {
			await (graph as { dispose?: () => Promise<void> } | undefined)?.dispose?.().catch(() => undefined);
		}
	}
	return stats;
}
