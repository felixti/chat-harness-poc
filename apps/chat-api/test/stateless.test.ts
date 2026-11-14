// Stateless turns: the store is the only truth, /tmp is scratch, one turn per conversation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FolderStore, listFiles, openTurn, readFileFromStore, setObjectStore, writeFileToStore } from "../src/workspace.ts";
import { ConflictError, MemoryStore } from "../src/store.ts";

const root = await mkdtemp(join(tmpdir(), "stateless-"));
setObjectStore(new FolderStore(root));
const U = "user-aaaa-0001";

test("a turn sees uploads, persists new and changed files, deletes removed ones, cleans /tmp", async () => {
	await writeFileToStore(U, "conv-0001", "uploads/a.csv", Buffer.from("x,y"));
	await writeFileToStore(U, "conv-0001", "outputs/old.md", Buffer.from("old"));
	const t = await openTurn(U, "conv-0001");
	assert.equal(await readFile(join(t.dir, "uploads/a.csv"), "utf8"), "x,y");
	await mkdir(join(t.dir, "outputs"), { recursive: true });
	await writeFile(join(t.dir, "outputs/new.md"), "new");
	await writeFile(join(t.dir, "uploads/a.csv"), "x,y,z");
	await rm(join(t.dir, "outputs/old.md"));
	await t.finish();
	await assert.rejects(stat(t.dir)); // local scratch gone
	const files = (await listFiles(U, "conv-0001")).map((f) => f.path).sort();
	assert.deepEqual(files, ["outputs/new.md", "uploads/a.csv"]);
	assert.equal((await readFileFromStore(U, "conv-0001", "uploads/a.csv")).toString(), "x,y,z");
});

test("a second turn on the same conversation is refused while the first runs (other pod/tab)", async () => {
	const first = await openTurn(U, "conv-0002");
	await assert.rejects(openTurn(U, "conv-0002"), (e: any) => e.status === 409);
	const other = await openTurn(U, "conv-0003"); // other conversations are not blocked
	await other.finish();
	await first.finish();
	const again = await openTurn(U, "conv-0002"); // lease released
	await again.abandon();
});

test("a stale local copy never wins: the next turn always starts from the store", async () => {
	const t1 = await openTurn(U, "conv-0004");
	await writeFile(join(t1.dir, "note.txt"), "v1");
	await t1.finish();
	await writeFileToStore(U, "conv-0004", "note.txt", Buffer.from("v2 from another pod"));
	const t2 = await openTurn(U, "conv-0004");
	assert.equal(await readFile(join(t2.dir, "note.txt"), "utf8"), "v2 from another pod");
	await t2.abandon();
});

test("users never see each other's files", async () => {
	await writeFileToStore("user-bbbb-0002", "conv-0001", "secret.txt", Buffer.from("b"));
	const t = await openTurn(U, "conv-0001");
	await assert.rejects(stat(join(t.dir, "secret.txt")));
	await t.abandon();
	await assert.rejects(readFileFromStore(U, "conv-0001", "secret.txt"), (e: any) => e.status === 404);
});

test("history saves are versioned: a stale writer gets a conflict", async () => {
	const s = new MemoryStore();
	const base = { id: "c1", user: U, title: "t", entries: [], updatedAt: new Date() };
	await s.save({ ...base });
	const a = await s.get(U, "c1");
	const b = await s.get(U, "c1");
	await s.save({ ...a!, entries: ["a"] });
	await assert.rejects(s.save({ ...b!, entries: ["b"] }), ConflictError);
	await assert.rejects(s.save({ ...base }), ConflictError); // a second "new" conversation with the same id
	assert.deepEqual((await s.get(U, "c1"))!.entries, ["a"]);
});

test("the user sees uploads and outputs; work/ is kept but hidden", async () => {
	const { userVisible } = await import("../src/workspace.ts");
	const t = await openTurn(U, "conv-0009");
	for (const p of ["outputs/deck.pptx", "work/deck.json", "work/img/cover.jpg", "work/notes.md"]) {
		await mkdir(join(t.dir, p, ".."), { recursive: true });
		await writeFile(join(t.dir, p), "x");
	}
	const all = await t.finish();
	assert.deepEqual(userVisible(all).map((f) => f.path).sort(), ["outputs/deck.pptx", "uploads/a.csv"].filter((p) => all.some((f) => f.path === p)).sort());
	assert.equal((await listFiles(U, "conv-0009")).filter((f) => f.path.startsWith("work/")).length, 3); // still persisted
});
