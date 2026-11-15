// Another model's tool calls reach the current model as text (Gemini fails on them otherwise).
import { test } from "node:test";
import assert from "node:assert/strict";
import { foreignToolCallsAsText } from "../src/crossmodel.ts";

const history = [
	{ role: "user", content: [{ type: "text", text: "crie" }] },
	{ role: "assistant", model: "deepseek/x", content: [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", id: "c1", name: "canvas", arguments: { action: "create" } }], stopReason: "toolUse" },
	{ role: "toolResult", toolCallId: "c1", toolName: "canvas", content: [{ type: "text", text: "saved v1" }], isError: false },
	{ role: "assistant", model: "google/g", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: {} }], stopReason: "toolUse" },
	{ role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false },
];

test("other models' tool calls become text; the current model's stay structured", () => {
	const out = foreignToolCallsAsText(history, "google/g") as typeof history;
	assert.equal(out.length, 4); // the tool-call-only assistant turn is dropped
	assert.equal(out[1].role, "user");
	assert.match(JSON.stringify(out[1].content), /tool canvas ran with \{\\"action\\":\\"create\\"\}.*saved v1/);
	assert.equal(out[2], history[3]);
	assert.equal(out[3], history[4]);
});

test("same model throughout: messages untouched", () => {
	const same = history.map((m) => ("model" in m ? { ...m, model: "deepseek/x" } : m));
	assert.equal(foreignToolCallsAsText(same, "deepseek/x"), same);
});
