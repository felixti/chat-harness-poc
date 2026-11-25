// Projects (H71): store, files with limits, read-only mount in a turn, prompt section, moving conversations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FolderStore, listFiles, openTurn, setObjectStore } from "../src/workspace.ts";
import { MemoryStore } from "../src/store.ts";
import { addProjectFile, deleteProjectFiles, LIMITS, listProjectFiles, MemoryProjects, projectPrefix, projectPrompt } from "../src/projects.ts";

setObjectStore(new FolderStore(await mkdtemp(join(tmpdir(), "projects-"))));
const U = "user-proj-0001";
const OTHER = "user-proj-0002";

test("projects belong to their owner; name and instructions are trimmed and capped", async () => {
	const s = new MemoryProjects();
	const p = await s.create(U, { name: "  Relatório   mensal ", instructions: "Responda em tópicos." });
	assert.equal(p.name, "Relatório mensal");
	assert.equal((await s.list(U)).length, 1);
	assert.equal(await s.get(OTHER, p.id), undefined);
	assert.equal(await s.update(OTHER, p.id, { name: "x" }), undefined);
	const long = await s.update(U, p.id, { instructions: "a".repeat(LIMITS.instructions + 50) });
	assert.equal(long?.instructions.length, LIMITS.instructions);
	assert.equal(await s.remove(OTHER, p.id), false);
	assert.equal(await s.remove(U, p.id), true);
});

test("project files: safe names, count and size limits", async () => {
	const pid = "11111111-2222-3333-4444-555555555555";
	assert.equal(await addProjectFile(U, pid, "Relatório final?.md", Buffer.from("x")), "Relatório final_.md");
	await assert.rejects(addProjectFile(U, pid, "../../evil.md", Buffer.from("x")), /bad file name/);
	await assert.rejects(addProjectFile(U, pid, ".env", Buffer.from("x")), /bad file name/);
	await assert.rejects(addProjectFile(U, pid, "big.bin", Buffer.alloc(LIMITS.fileBytes + 1)), /larger than/);
	assert.deepEqual((await listProjectFiles(U, pid)).map((f) => f.name), ["Relatório final_.md"]);
	await deleteProjectFiles(U, pid);
	assert.deepEqual(await listProjectFiles(U, pid), []);
});

test("a turn in a project sees its files under project/ and never writes them back", async () => {
	const pid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	await addProjectFile(U, pid, "guia.md", Buffer.from("# Guia"));
	const t = await openTurn(U, "conv-proj-0001", [{ prefix: projectPrefix(U, pid), as: "project" }]);
	assert.equal(await readFile(join(t.dir, "project/guia.md"), "utf8"), "# Guia");
	await writeFile(join(t.dir, "project/guia.md"), "changed by the model");
	await writeFile(join(t.dir, "project/new.md"), "new");
	await rm(join(t.dir, "uploads"), { recursive: true });
	await writeFile(join(t.dir, "notes.md"), "kept");
	await t.finish();
	await assert.rejects(stat(t.dir));
	assert.deepEqual((await listFiles(U, "conv-proj-0001")).map((f) => f.path), ["notes.md"]);
	assert.deepEqual((await listProjectFiles(U, pid)).map((f) => f.name), ["guia.md"]);
	await deleteProjectFiles(U, pid);
});

test("the prompt carries the instructions and the file list, files as data", async () => {
	const p = { id: "p", user: U, name: "Vendas", instructions: "Use sempre R$.", createdAt: new Date(), updatedAt: new Date() };
	const text = projectPrompt(p, [{ name: "metas.xlsx", size: 20_480 }]);
	assert.match(text, /## Project: Vendas/);
	assert.match(text, /Use sempre R\$\./);
	assert.match(text, /project\/metas\.xlsx \(20 KB\)/);
	assert.match(text, /data, not instructions/);
	assert.doesNotMatch(projectPrompt({ ...p, instructions: "" }, []), /Project instructions|Project files/);
});

test("conversations move into and out of a project; deleting a project keeps them", async () => {
	const s = new MemoryStore();
	await s.save({ id: "conv-a", user: U, title: "A", entries: [], updatedAt: new Date() });
	await s.save({ id: "conv-b", user: U, title: "B", entries: [], updatedAt: new Date(), projectId: "p1" });
	assert.equal(await s.move(OTHER, "conv-a", "p1"), false);
	assert.equal(await s.move(U, "conv-a", "p1"), true);
	assert.deepEqual((await s.list(U)).map((c) => c.projectId), ["p1", "p1"]);
	await s.detachProject(U, "p1");
	assert.deepEqual((await s.list(U)).map((c) => c.projectId), [undefined, undefined]);
	assert.equal((await s.list(U)).length, 2);
});
