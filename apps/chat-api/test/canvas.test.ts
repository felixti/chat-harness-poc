// Canvas: versions on every save, exact edits, state the user set read back by the model, Blob routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canvasTool, getCanvas, listCanvases, putState, toFragment, type CanvasEvent } from "../src/canvas.ts";
import { FolderStore, setObjectStore, writeFileToStore } from "../src/workspace.ts";

type Exec = (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const run = (t: ReturnType<typeof canvasTool>, p: Record<string, unknown>) => (t.execute as unknown as Exec)("call-1", p);

test("create, edit and update make versions; each version is streamed to the portal", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "canvas-"));
	const events: CanvasEvent[] = [];
	const t = canvasTool(cwd, (e) => events.push(e));
	await run(t, { action: "create", name: "simulador-roi", title: "Simulador de ROI", html: "<h1>ROI</h1><p>taxa 10%</p>" });
	const r = await run(t, { action: "edit", name: "simulador-roi", edits: [{ old: "taxa 10%", new: "taxa 12%" }], note: "taxa" });
	assert.match(r.content[0].text, /version 2/);
	assert.equal(events.length, 2);
	assert.equal(events[1].html, "<h1>ROI</h1><p>taxa 12%</p>");
	assert.equal(events[1].title, "Simulador de ROI");
	const meta = JSON.parse(await readFile(join(cwd, "work/canvas/simulador-roi/meta.json"), "utf8"));
	assert.deepEqual(meta.versions.map((v: { v: number }) => v.v), [1, 2]);
	assert.equal(await readFile(join(cwd, "work/canvas/simulador-roi/v1.html"), "utf8"), "<h1>ROI</h1><p>taxa 10%</p>");
	await run(t, { action: "update", name: "simulador-roi", html: "<!doctype html><html><head><title>x</title><style>h1{color:red}</style></head><body><h1>Novo</h1></body></html>" });
	assert.equal(events[2].version, 3);
	assert.equal(events[2].html, "<style>h1{color:red}</style>\n<h1>Novo</h1>");
});

test("bad edits, duplicate create and bad names fail without a new version", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "canvas-"));
	const events: CanvasEvent[] = [];
	const t = canvasTool(cwd, (e) => events.push(e));
	await run(t, { action: "create", name: "lista", html: "<li>a</li><li>a</li>" });
	await assert.rejects(run(t, { action: "edit", name: "lista", edits: [{ old: "<li>a</li>", new: "<li>b</li>" }] }), /occurs 2 times/);
	await assert.rejects(run(t, { action: "create", name: "lista", html: "<p>x</p>" }), /already exists/);
	await assert.rejects(run(t, { action: "create", name: "../etc", html: "<p>x</p>" }), /name/);
	await assert.rejects(run(t, { action: "edit", name: "nao-existe", edits: [{ old: "a", new: "b" }] }), /no canvas/);
	await assert.rejects(run(t, { action: "update", name: "lista", note: "sem html" }), /`html` argument is missing[\s\S]*use edit/);
	await assert.rejects(run(t, { action: "edit", name: "lista", note: "sem edits" }), /`edits` argument is missing/);
	assert.equal(events.length, 1);
});

test("read returns the code and what the user marked in the page", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "canvas-"));
	const t = canvasTool(cwd, () => {});
	await run(t, { action: "create", name: "checklist", title: "Onboarding", html: "<ul id=l></ul>" });
	await mkdir(join(cwd, "work/canvas/checklist"), { recursive: true });
	await writeFile(join(cwd, "work/canvas/checklist/state.json"), JSON.stringify({ done: ["notebook"] }));
	const r = await run(t, { action: "read", name: "checklist" });
	assert.match(r.content[0].text, /"done":\["notebook"\]/);
	assert.match(r.content[0].text, /<ul id=l><\/ul>/);
});

test("portal routes read versions from Blob and persist state per user", async () => {
	setObjectStore(new FolderStore(await mkdtemp(join(tmpdir(), "canvas-store-"))));
	const U = "user-canvas-01";
	const C = "conv-canvas-0001";
	await writeFileToStore(U, C, "work/canvas/roi/meta.json", Buffer.from(JSON.stringify({ name: "roi", title: "ROI", versions: [{ v: 1, at: "x" }, { v: 2, at: "y" }] })));
	await writeFileToStore(U, C, "work/canvas/roi/v1.html", Buffer.from("<p>1</p>"));
	await writeFileToStore(U, C, "work/canvas/roi/v2.html", Buffer.from("<p>2</p>"));
	assert.deepEqual((await listCanvases(U, C)).map((c) => c.name), ["roi"]);
	assert.equal((await getCanvas(U, C, "roi"))?.html, "<p>2</p>");
	assert.equal((await getCanvas(U, C, "roi", 1))?.html, "<p>1</p>");
	await putState(U, C, "roi", { taxa: 12 });
	assert.deepEqual((await getCanvas(U, C, "roi"))?.state, { taxa: 12 });
	assert.equal(await getCanvas("other-user-01", C, "roi"), undefined);
	await assert.rejects(putState(U, C, "roi", { big: "x".repeat(300_000) }), /too large/);
});

test("toFragment leaves fragments alone", () => {
	assert.equal(toFragment("  <div>oi</div>\n"), "<div>oi</div>");
});
