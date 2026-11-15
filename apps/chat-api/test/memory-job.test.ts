// Nightly curation: only changed conversations, only new user messages, idempotent, retries failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.ts";
import { newMaterial, runCuration } from "../src/memory-job.ts";

const msg = (role: string, text: string, at: string) => ({ type: "message", timestamp: at, message: { role, content: [{ type: "text", text }] } });

test("new material: user messages after the last curation, plus the latest answer", () => {
	const c = {
		id: "c1", user: "u", title: "t", updatedAt: new Date("2026-11-15T10:00:00Z"), curatedAt: new Date("2026-11-14T03:00:00Z"),
		entries: [msg("user", "/skill:pptx antigo", "2026-11-13T10:00:00Z"), msg("assistant", "ok", "2026-11-13T10:01:00Z"), msg("user", "Marina lidera o Atlas", "2026-11-15T09:00:00Z"), msg("assistant", "Anotado.", "2026-11-15T09:01:00Z")],
	};
	assert.deepEqual(newMaterial(c), { userText: "Marina lidera o Atlas", reply: "Anotado." });
});

test("the job curates pending conversations once, marks them, and retries failures next night", async () => {
	const s = new MemoryStore();
	const now = new Date("2026-11-16T03:00:00Z");
	const day = (h: number) => new Date(+now - h * 3_600_000);
	await s.save({ id: "a", user: "u1", title: "A", entries: [msg("user", "Sou gerente da regional Sul", day(5).toISOString())], updatedAt: day(5) });
	await s.save({ id: "b", user: "u2", title: "B", entries: [msg("user", "falha aqui", day(4).toISOString())], updatedAt: day(4) });
	await s.save({ id: "old", user: "u1", title: "Velha", entries: [msg("user", "fora da janela", day(100).toISOString())], updatedAt: day(100) });
	const seen: string[] = [];
	const curate = async (i: { user: string; userMessage: string }) => {
		seen.push(i.userMessage);
		if (i.userMessage.includes("falha")) throw new Error("LLM down");
		return { saved: ["x"], summary: `resumo de ${i.user}` };
	};
	const r1 = await runCuration({ store: s, curate, graphFor: () => undefined, now });
	assert.deepEqual(r1, { processed: 1, saved: 1, skipped: 0, failed: 1 });
	assert.deepEqual(seen, ["Sou gerente da regional Sul", "falha aqui"]);
	assert.equal((await s.get("u1", "a"))?.summary, "resumo de u1");
	const r2 = await runCuration({ store: s, curate: async () => ({ saved: [], summary: "ok" }), graphFor: () => undefined, now: new Date(+now + 60_000) });
	assert.deepEqual(r2, { processed: 1, saved: 0, skipped: 0, failed: 0 }); // only "b" again
});
