// Multi-user isolation: Pi's file tools must not leave the turn's workspace (skills read-only).
import "../src/no-subprocess.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { guardedFileTools, keepToolOutput } from "../src/fs-guard.ts";

const root = await mkdtemp(join(tmpdir(), "guard-"));
const me = join(root, "ws", "user-a", "conv-1");
const other = join(root, "ws", "user-b", "conv-9");
const skills = join(root, "skills");
for (const d of [me, other, skills]) await mkdir(d, { recursive: true });
await writeFile(join(me, "mine.txt"), "mine");
await writeFile(join(other, "secret.txt"), "user b secret");
await writeFile(join(skills, "SKILL.md"), "skill");
await symlink(join(other, "secret.txt"), join(me, "link.txt"));

const tools = Object.fromEntries(guardedFileTools(me, [skills]).map((t) => [t.name, t]));
const run = async (name: string, args: object) => {
	try {
		const r: any = await tools[name].execute("t", args as never, undefined, undefined, undefined as never);
		return r.content.map((c: any) => c.text ?? "").join("");
	} catch (e) {
		return `ERR ${(e as Error).message}`;
	}
};

test("reads inside the workspace and the skills; nothing else", async () => {
	assert.match(await run("read", { path: "mine.txt" }), /mine/);
	assert.match(await run("read", { path: join(skills, "SKILL.md") }), /skill/);
	for (const p of [join(other, "secret.txt"), "../../user-b/conv-9/secret.txt", "link.txt", "/proc/self/environ", "/etc/hostname"])
		assert.match(await run("read", { path: p }), /ERR access denied/, p);
});

test("writes and edits only inside the workspace", async () => {
	assert.doesNotMatch(await run("write", { path: "outputs/new.md", content: "ok" }), /ERR/);
	assert.match(await run("write", { path: join(skills, "SKILL.md"), content: "x" }), /ERR access denied/);
	assert.match(await run("write", { path: "../../user-b/conv-9/x.txt", content: "x" }), /ERR access denied/);
	assert.match(await run("write", { path: "link.txt", content: "x" }), /ERR access denied/);
	assert.match(await run("edit", { path: join(other, "secret.txt"), edits: [{ oldText: "user", newText: "x" }] }), /ERR/);
});

test("ls cannot list another user's workspace", async () => {
	assert.match(await run("ls", { path: "." }), /mine\.txt/);
	assert.match(await run("ls", { path: join(root, "ws") }), /ERR/);
	assert.match(await run("ls", { path: other }), /ERR/);
});

test("a truncated MCP output Pi saved in /tmp moves to work/tool-output; the old path still reads the copy", async () => {
	const saved = join(tmpdir(), "pi-mcp-0123456789abcdef.txt");
	await writeFile(saved, "line 1\nline 2\nthe end");
	const pending = keepToolOutput(me, saved);
	assert.match(await run("read", { path: saved, offset: 2 }), /line 2[\s\S]*the end/);
	assert.equal(await pending, join(me, "work", "tool-output", "pi-mcp-0123456789abcdef.txt"));
	assert.equal(await keepToolOutput(me, "/etc/passwd"), undefined);
	assert.match(await run("read", { path: "work/tool-output/pi-mcp-0123456789abcdef.txt" }), /line 1/);
	await assert.rejects(stat(saved));
	const otherSaved = join(tmpdir(), "pi-mcp-feedfacefeedface.txt");
	await writeFile(otherSaved, "not moved");
	assert.match(await run("read", { path: otherSaved }), /ERR/);
	assert.match(await run("read", { path: join(tmpdir(), "other.txt") }), /ERR access denied/);
	await rm(otherSaved);
});
