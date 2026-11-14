// "Meus arquivos": cross-conversation files of one user, attached on request, never another user's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FolderStore, setObjectStore, writeFileToStore, listFiles } from "../src/workspace.ts";
import { attachToConversation, libraryTools, listLibrary } from "../src/library.ts";
import { MemoryStore } from "../src/store.ts";

const root = await mkdtemp(join(tmpdir(), "library-"));
setObjectStore(new FolderStore(root));
const U = "user-lib-0001";
await writeFileToStore(U, "conv-aaaa-01", "uploads/vendas_q3.xlsx", Buffer.from("xlsx-bytes"));
await writeFileToStore(U, "conv-aaaa-01", "outputs/deck.pptx", Buffer.from("pptx"));
await writeFileToStore(U, "conv-aaaa-01", "outputs/deck.preview.png", Buffer.from("png"));
await writeFileToStore("user-lib-0002", "conv-bbbb-01", "uploads/segredo.pdf", Buffer.from("other user"));

test("lists uploads and outputs across conversations, with title and expiry; only this user's", async () => {
	const store = new MemoryStore();
	await store.save({ id: "conv-aaaa-01", user: U, title: "Vendas Q3", entries: [], updatedAt: new Date() });
	const files = await listLibrary(U, store);
	assert.deepEqual(files.map((f) => [f.id, f.kind, f.title]).sort(), [
		["conv-aaaa-01/outputs/deck.pptx", "output", "Vendas Q3"],
		["conv-aaaa-01/uploads/vendas_q3.xlsx", "upload", "Vendas Q3"],
	]);
	assert.ok(Date.parse(files[0].expiresAt!) > Date.now() + 29 * 86_400_000);
	assert.deepEqual((await listLibrary(U, store, "VENDAS")).map((f) => f.name).sort(), ["deck.pptx", "vendas_q3.xlsx"]); // title match too
	assert.equal((await listLibrary(U, store, "segredo")).length, 0);
});

test("attach copies into uploads/ without overwriting; bad ids are rejected", async () => {
	assert.equal(await attachToConversation(U, "conv-aaaa-01/uploads/vendas_q3.xlsx", "conv-cccc-01"), "uploads/vendas_q3.xlsx");
	assert.equal(await attachToConversation(U, "conv-aaaa-01/uploads/vendas_q3.xlsx", "conv-cccc-01"), "uploads/vendas_q3 (2).xlsx");
	assert.deepEqual((await listFiles(U, "conv-cccc-01")).map((f) => f.path).sort(), ["uploads/vendas_q3 (2).xlsx", "uploads/vendas_q3.xlsx"]);
	for (const bad of ["../user-lib-0002/conv-bbbb-01/uploads/segredo.pdf", "conv-aaaa-01/uploads/../../x", "conv-bbbb-01/uploads/segredo.pdf"])
		await assert.rejects(attachToConversation(U, bad, "conv-cccc-01"), (e: any) => e.status === 400 || e.status === 410, bad);
});

test("agent tools: my_files finds it, attach_file puts it in the running workspace", async () => {
	const ws = await mkdtemp(join(tmpdir(), "ws-"));
	const [myFiles, attach] = libraryTools(U, ws, new MemoryStore()) as any[];
	assert.match((await myFiles.execute("1", { query: "vendas" })).content[0].text, /conv-aaaa-01\/uploads\/vendas_q3\.xlsx/);
	const r = await attach.execute("2", { file_id: "conv-aaaa-01/uploads/vendas_q3.xlsx" });
	assert.match(r.content[0].text, /uploads\/vendas_q3\.xlsx/);
	assert.equal(await readFile(join(ws, "uploads/vendas_q3.xlsx"), "utf8"), "xlsx-bytes");
});

test("delete removes only this user's file; bad ids rejected", async () => {
	const { deleteLibraryFile } = await import("../src/library.ts");
	await deleteLibraryFile(U, "conv-aaaa-01/outputs/deck.pptx");
	assert.deepEqual((await listLibrary(U)).map((f) => f.name).includes("deck.pptx"), false);
	await assert.rejects(deleteLibraryFile(U, "conv-aaaa-01/../../user-lib-0002/conv-bbbb-01/uploads/segredo.pdf"), (e: any) => e.status === 400);
	await deleteLibraryFile(U, "conv-bbbb-01/uploads/segredo.pdf"); // other user's conversation id under MY prefix: nothing there
	assert.equal((await listLibrary("user-lib-0002")).length, 1);
});
