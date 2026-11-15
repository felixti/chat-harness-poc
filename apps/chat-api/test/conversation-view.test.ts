import { test } from "node:test";
import assert from "node:assert/strict";
import { beforeLastUserMessage, entriesToView } from "../src/conversation-view.ts";
import { MemoryStore } from "../src/store.ts";

const msg = (id: string, message: object) => ({ type: "message", id, message });
const entries = [
	{ type: "model_change", id: "a" },
	msg("s", { role: "system", content: "" }),
	msg("u1", { role: "user", content: [{ type: "text", text: "/skill:pptx Faça um deck" }] }),
	msg("a1", { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "uploads/a.csv" } }] }),
	msg("r1", { role: "toolResult", toolCallId: "t1", isError: true, content: [] }),
	msg("a2", { role: "assistant", content: [{ type: "text", text: "Pronto." }] }),
	msg("u2", { role: "user", content: [{ type: "text", text: "Outra coisa" }] }),
	msg("a3", { role: "assistant", content: [{ type: "text", text: "Ok." }] }),
];

test("entries become user messages and assistant turns (tools + text), without system or thinking", () => {
	const v = entriesToView(entries);
	assert.deepEqual(v.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
	assert.equal((v[0] as any).text, "Faça um deck");
	assert.deepEqual((v[1] as any).parts, [{ type: "tool", id: "t1", name: "read", args: { path: "uploads/a.csv" }, isError: true }, { type: "text", text: "Pronto." }]);
});

test("edit/regenerate replays from before the last user message", () => {
	assert.deepEqual(beforeLastUserMessage(entries).map((e: any) => e.id), ["a", "s", "u1", "a1", "r1", "a2"]);
});

test("rename, remove and feedback are per user", async () => {
	const s = new MemoryStore();
	await s.save({ id: "c1", user: "u", title: "t", entries: [], updatedAt: new Date() });
	assert.equal(await s.rename("other", "c1", "x"), false);
	assert.equal(await s.rename("u", "c1", "Novo título"), true);
	await s.feedback("u", "c1", "a2", "up");
	assert.deepEqual(await s.feedbackOf("u", "c1"), { a2: "up" });
	await s.feedback("u", "c1", "a2", null);
	assert.deepEqual(await s.feedbackOf("u", "c1"), {});
	assert.equal(await s.remove("u", "c1"), true);
	assert.equal(await s.get("u", "c1"), undefined);
});
