// AG-UI wire format (validated against @ag-ui/core schemas) and the human-in-the-loop gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AguiRun, resultText } from "../src/agui.ts";
import { Gate, needsApproval, resumeMessage, stripHidden } from "../src/approvals.ts";

const schemas = createRequire(import.meta.url)("@ag-ui/core/schemas");

test("every event the server emits is valid AG-UI", () => {
	const events: any[] = [];
	const run = new AguiRun((e) => events.push(e), "thread-0001", "run-1");
	run.started();
	run.text("Olá");
	run.text(", tudo bem");
	run.toolStart("tc-1", "mcp__azuredevops__wit_work_item_write", { action: "create", project: "Demo" });
	run.toolResult("tc-1", "blocked", true);
	run.custom("memory_used", { core: 2, facts: [], conversations: [] });
	run.finished([{ id: "int-1", reason: "tool_call", message: "Azure DevOps: criar work item", toolCallId: "tc-1", responseSchema: { type: "object" } }]);
	run.error("boom");
	for (const e of events) {
		const r = schemas.EventSchema.safeParse(e);
		assert.ok(r.success, `${e.type}: ${JSON.stringify(r.error?.issues?.[0])}`);
	}
	assert.deepEqual(events.map((e) => e.type), ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT", "CUSTOM", "RUN_FINISHED", "RUN_ERROR"]);
	assert.equal(events.find((e) => e.type === "RUN_FINISHED").outcome.type, "interrupt");
	assert.ok(schemas.ResumeEntrySchema.safeParse({ interruptId: "int-1", status: "resolved", payload: { approved: true } }).success);
	assert.equal(resultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\nb");
});

test("which tools need approval", () => {
	for (const t of ["mcp__azuredevops__wit_work_item_write", "mcp__azuredevops__repo_pull_request_write", "mcp__azuredevops__pipelines_write", "mcp__azuredevops__repo_create_branch", "mcp__azuredevops__wiki_upsert_page", "mcp__github__create_issue", "mcp__github__merge_pull_request"])
		assert.ok(needsApproval(t), t);
	for (const t of ["mcp__azuredevops__wit_work_item", "mcp__azuredevops__pipelines_run", "mcp__azuredevops__search_code", "mcp__github__search_repositories", "mcp__brave__brave_web_search", "generate_pptx", "memory", "write"])
		assert.ok(!needsApproval(t), t);
});

test("a write is blocked until approved; only the exact approved call runs, once", () => {
	const call = { toolCallId: "tc-1", toolName: "mcp__azuredevops__wit_work_item_write", input: { action: "create", project: "Demo", fields: { "System.Title": "Corrigir login" } } };
	const g1 = new Gate();
	assert.equal(g1.check(call)?.block, true);
	assert.equal(g1.interrupts[0].message, "Azure DevOps: Criar work item no projeto Demo — “Corrigir login”");
	const { message, allow } = resumeMessage(g1.interrupts, [{ interruptId: g1.interrupts[0].id, status: "resolved", payload: { approved: true } }]);
	assert.match(stripHidden(message), /^Aprovado: Azure DevOps/);
	assert.ok(!stripHidden(message).includes("harness"));
	const g2 = new Gate();
	for (const a of allow) g2.allow(a.toolName, a.input);
	// same arguments in another key order: allowed once
	assert.equal(g2.check({ ...call, input: { fields: { "System.Title": "Corrigir login" }, project: "Demo", action: "create" } }), undefined);
	assert.equal(g2.check(call)?.block, true); // second run needs a new approval
	assert.equal(g2.check({ ...call, input: { ...call.input, project: "Outro" } })?.block, true);
});

test("declined, questions, and stale interrupts", () => {
	const g = new Gate();
	g.check({ toolCallId: "tc-2", toolName: "mcp__github__create_issue", input: { title: "x" } });
	g.check({ toolCallId: "tc-3", toolName: "ask_user", input: { questions: [{ id: "aud", question: "Para quem é o deck?", options: [{ label: "Diretoria" }, { label: "Time" }], recommended: "Diretoria" }] } });
	assert.deepEqual(g.interrupts.map((i) => i.reason), ["tool_call", "input_required"]);
	const r = resumeMessage(g.interrupts, [
		{ interruptId: g.interrupts[0].id, status: "resolved", payload: { approved: false } },
		{ interruptId: g.interrupts[1].id, status: "resolved", payload: { answers: { aud: "Diretoria" } } },
	]);
	assert.deepEqual(r.allow, []);
	assert.match(stripHidden(r.message), /Recusado: GitHub[\s\S]*Para quem é o deck\? → Diretoria/);
	assert.throws(() => resumeMessage(g.interrupts, [{ interruptId: "int-old", status: "resolved" }]), (e: any) => e.status === 409);
});

test("circuit breaker: repeated tool or errors in a row end the turn", () => {
	const g = new Gate();
	for (let i = 0; i < 5; i++) assert.equal(g.check({ toolCallId: `m${i}`, toolName: "memory", input: {} }), undefined);
	assert.match(g.check({ toolCallId: "m6", toolName: "memory", input: {} })?.reason ?? "", /Stopped: memory was called 6 times/);
	const h = new Gate();
	for (let i = 0; i < 4; i++) h.noteResult("bash", true);
	assert.match(h.check({ toolCallId: "b", toolName: "bash", input: {} })?.reason ?? "", /last 4 tool calls failed/);
	h.noteResult("bash", false);
	assert.equal(h.check({ toolCallId: "c", toolName: "bash", input: {} }), undefined);
});

test("tools loaded or used earlier in the conversation are re-activated", async () => {
	const { previouslyLoadedTools } = await import("../src/agent.ts");
	const entries = [
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "tool_search" }, { type: "toolCall", name: "mcp__azuredevops__core_list_projects" }] } },
		{ type: "message", message: { role: "toolResult", toolName: "tool_search", content: [{ type: "text", text: "Loaded 2 tools. They are available from your next call:\n- mcp__azuredevops__wit_work_item_write: Write operations...\n- mcp__azuredevops__wit_work_item_link_write: Link..." }] } },
	];
	assert.deepEqual([...previouslyLoadedTools(entries)].sort(), ["mcp__azuredevops__core_list_projects", "mcp__azuredevops__wit_work_item_link_write", "mcp__azuredevops__wit_work_item_write"]);
});
