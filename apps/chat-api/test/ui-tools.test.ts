// Rich reply parts (H61, H62): A2UI surfaces, plan, sources, reasoning on the wire and in history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AguiRun } from "../src/agui.ts";
import { entriesToView } from "../src/conversation-view.ts";
import { checkSurface, extractSources, planTool, showUiTool, SourceList, surfaceMessages } from "../src/ui-tools.ts";

const schemas = createRequire(import.meta.url)("@ag-ui/core/schemas");
type Exec = (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const exec = (t: { execute: unknown }, p: Record<string, unknown>) => (t.execute as Exec)("call-1", p);

const form = [
	{ id: "root", component: "Card", child: "col" },
	{ id: "col", component: "Column", children: ["title", "name", "send"] },
	{ id: "title", component: "Text", text: "## Pedido" },
	{ id: "name", component: "TextField", label: "Nome", value: { "@path": "/form/name" } },
	{ id: "send_t", component: "Text", text: "Enviar" },
	{ id: "send", component: "Button", child: "send_t", variant: "primary", action: { event: { name: "submit", context: { name: { "@path": "/form/name" } } } } },
];

test("a valid surface becomes A2UI 1.0 messages; bad ones explain what to fix", async () => {
	assert.deepEqual(checkSurface(form, { form: { name: "" } }), []);
	const msgs = surfaceMessages("pedido", form, { form: { name: "" } });
	assert.deepEqual(msgs.map((m) => Object.keys(m)[1]), ["createSurface", "updateComponents", "updateDataModel"]);
	const errs = checkSurface([{ id: "root", component: "Column", children: ["x"] }, { id: "i", component: "Image", url: "https://evil" }, { id: "b", component: "Button", child: "root" }], undefined);
	assert.ok(errs.some((e) => /missing child "x"/.test(e)));
	assert.ok(errs.some((e) => /"Image" is not available/.test(e)));
	assert.ok(errs.some((e) => /needs action/.test(e)));
	assert.ok(checkSurface([{ id: "a", component: "Text", text: "x" }], undefined).some((e) => /root/.test(e)));

	const shown: unknown[] = [];
	const t = showUiTool((s) => shown.push(s));
	const r = await exec(t, { surface_id: "pedido", title: "Pedido", components: form, data: { form: { name: "" } } });
	assert.match(r.content[0].text, /on screen/);
	assert.equal(shown.length, 1);
	await assert.rejects(exec(t, { surface_id: "Bad Id", components: form }), /slug/);
	await assert.rejects(exec(t, { surface_id: "x", components: [{ id: "root", component: "Video" }] }), /not shown[\s\S]*Video/);
});

test("hyphenated ids are normalized with their references", async () => {
	const shown: { messages: { updateComponents?: { components: { id: string; child?: string }[] } }[] }[] = [];
	await exec(showUiTool((s) => shown.push(s as never)), { surface_id: "x", components: [{ id: "root", component: "Card", child: "btn-text" }, { id: "btn-text", component: "Text", text: "Oi" }] });
	const comps = shown[0].messages[1].updateComponents!.components;
	assert.deepEqual(comps.map((c) => c.id), ["root", "btn_text"]);
	assert.equal(comps[0].child, "btn_text");
});

test("plan reports progress", async () => {
	const seen: unknown[] = [];
	const r = await exec(planTool((s) => seen.push(s)), { steps: [{ title: "Ler", status: "done" }, { title: "Escrever", status: "in_progress" }] });
	assert.match(r.content[0].text, /1\/2 done/);
	assert.equal(seen.length, 1);
});

test("sources come from search JSON, truncated JSON and markdown links", () => {
	const brave = JSON.stringify({ web: { results: [{ title: "Kubernetes v1.37", url: "https://kubernetes.io/blog/v137/" }, { title: "Dup", url: "https://kubernetes.io/blog/v137/" }] } });
	assert.deepEqual(extractSources(brave), [{ url: "https://kubernetes.io/blog/v137/", title: "Kubernetes v1.37" }]);
	const cut = 'Warning: truncated output\n{"success":true,"results":[{"title":"Release notes","url":"https://example.com/notes","snippet":"...';
	assert.equal(extractSources(cut)[0].url, "https://example.com/notes");
	assert.equal(extractSources("veja [Docs](https://docs.example.com/a).")[0].title, "Docs");
	assert.deepEqual(extractSources("no links here"), []);
});

test("reasoning and activities are valid AG-UI and close before text", () => {
	const events: { type: string }[] = [];
	const run = new AguiRun((e) => events.push(e), "thread-0001", "run-1");
	run.started();
	run.reasoning("pensando");
	run.reasoning(" mais");
	run.activity("a2ui-pedido", "a2ui-surface", { surfaceId: "pedido", a2ui_operations: surfaceMessages("pedido", form) });
	run.reasoning("de novo");
	run.text("Pronto");
	run.finished();
	for (const e of events) assert.ok(schemas.EventSchema.safeParse(e).success, e.type);
	assert.deepEqual(events.map((e) => e.type), ["RUN_STARTED", "REASONING_START", "REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_END", "REASONING_END", "ACTIVITY_SNAPSHOT", "REASONING_START", "REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_END", "REASONING_END", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"]);
});

test("history keeps reasoning and sources of a turn", () => {
	const entries = [
		{ type: "message", id: "u1", message: { role: "user", content: "pesquise" } },
		{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "thinking", thinking: "Vou buscar." }, { type: "toolCall", id: "t1", name: "mcp__brave__brave_web_search", arguments: { query: "x" } }] } },
		{ type: "message", id: "r1", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: JSON.stringify({ results: [{ title: "A", url: "https://a.example/" }] }) }] } },
		{ type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "Resposta" }] } },
	];
	const v = entriesToView(entries);
	const a = v[1] as { reasoning?: string; sources?: { url: string }[] };
	assert.equal(a.reasoning, "Vou buscar.");
	assert.deepEqual(a.sources?.map((s) => s.url), ["https://a.example/"]);
});

test("pages the model read come before search hits; components may arrive as a JSON string", async () => {
	const l = new SourceList(3);
	l.add("mcp__brave__brave_web_search", JSON.stringify({ results: [{ title: "H1", url: "https://h1.example/" }, { title: "H2", url: "https://h2.example/" }, { title: "H3", url: "https://h3.example/" }] }));
	assert.ok(l.add("mcp__crawlforge__scrape", JSON.stringify({ url: "https://read.example/", title: "Lida" })));
	assert.deepEqual(l.list().map((s) => s.url), ["https://read.example/", "https://h1.example/", "https://h2.example/"]);
	const shown: unknown[] = [];
	await exec(showUiTool((s) => shown.push(s)), { surface_id: "x", components: JSON.stringify([{ id: "root", component: "Text", text: "oi" }]) });
	assert.equal(shown.length, 1);
	await exec(showUiTool((s) => shown.push(s)), { surface_id: "y", components: JSON.stringify(form), data: JSON.stringify({ form: { name: "" } }) });
	const dm = (shown[1] as { messages: { updateDataModel?: { value?: unknown } }[] }).messages[2].updateDataModel;
	assert.deepEqual(dm?.value, { form: { name: "" } });
});

test("what the A2UI renderer rejects goes back to the model; common enum spellings are fixed", async () => {
	const shown: { messages: { updateComponents?: { components: { justify?: string }[] } }[] }[] = [];
	const t = showUiTool((s) => shown.push(s as never));
	await exec(t, { surface_id: "x", components: [{ id: "root", component: "Row", justify: "space-between", children: ["a"] }, { id: "a", component: "Text", text: "oi" }] });
	assert.equal(shown[0].messages[1].updateComponents!.components[0].justify, "spaceBetween");
	await assert.rejects(exec(t, { surface_id: "y", components: [{ id: "root", component: "Text", text: "oi", foo: 1 }] }), /renderer rejected it[\s\S]*foo/);
	await assert.rejects(exec(t, { surface_id: "z", components: [{ id: "root", component: "Slider", label: "x", value: { "@path": "/v" } }] }), /renderer rejected it/);
});

test("show_ui and canvas point at each other with the same rule: sent back once vs kept on screen", async () => {
	const { canvasTool } = await import("../src/canvas.ts");
	const ui = showUiTool(() => {}).description;
	const cv = canvasTool("/tmp", () => {}).description;
	assert.match(ui, /filled in once/);
	assert.match(ui, /canvas instead[\s\S]*shopping lists/);
	assert.match(cv, /keeps\s+using/);
	assert.match(cv, /use show_ui for that/);
	assert.doesNotMatch(cv, /\bforms\b/);
});
