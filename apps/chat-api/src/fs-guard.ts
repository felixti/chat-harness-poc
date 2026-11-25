// File confinement for Pi's built-in read/write/edit/ls. Those tools accept absolute paths and
// "../", so in a shared multi-user pod they could reach another user's workspace, /proc/self/environ
// (secrets) or the agent dir. We rebuild them with operations that resolve the real path (symlinks
// included) and allow only: the turn's workspace (read-write) and the skills folder (read-only).
import { access, constants, copyFile, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, basename, join, relative, isAbsolute, resolve } from "node:path";
import {
	createEditToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

function within(root: string, p: string): boolean {
	const r = relative(root, p);
	return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** Real path of `p`, or of its nearest existing ancestor plus the rest (for files about to be created). */
async function real(p: string): Promise<string> {
	try {
		return await realpath(p);
	} catch {
		const parent = dirname(p);
		if (parent === p) return p;
		return join(await real(parent), basename(p));
	}
}

// Pi saves the full text of a truncated MCP result to <tmpdir>/pi-mcp-<hex>.txt and tells the model
// to read it there, outside the workspace. keepToolOutput moves it into work/tool-output/ when the
// tool ends (kept with the conversation like any work file), and a read of the /tmp path is served
// from that copy, in this turn and later ones.
const TOOL_OUTPUT = /^pi-mcp-[0-9a-f]{8,64}\.txt$/;
const moving = new Map<string, Promise<void>>();
const toolOutputCopy = (workspace: string, p: string) => {
	const abs = resolve(p);
	return dirname(abs) === resolve(tmpdir()) && TOOL_OUTPUT.test(basename(abs)) ? { abs, copy: join(workspace, "work", "tool-output", basename(abs)) } : undefined;
};

/** Moves a truncated tool output Pi saved in the temp folder into the workspace. */
export function keepToolOutput(workspace: string, path: unknown): void {
	const t = typeof path === "string" ? toolOutputCopy(workspace, path) : undefined;
	if (!t || moving.has(t.abs)) return;
	const done = (async () => {
		await mkdir(dirname(t.copy), { recursive: true });
		await copyFile(t.abs, t.copy);
		await rm(t.abs, { force: true });
	})()
		.catch((e) => console.warn(`[tool-output] ${(e as Error).message}`))
		.finally(() => setTimeout(() => moving.delete(t.abs), 60_000).unref());
	moving.set(t.abs, done);
}

export function fsGuard(workspace: string, readOnlyRoots: string[]) {
	const roots = Promise.all([real(workspace), ...readOnlyRoots.map(real)]);
	const check = async (p: string, write: boolean): Promise<string> => {
		const [ws, ...ro] = await roots;
		const out = write ? undefined : toolOutputCopy(workspace, p);
		if (out) {
			await moving.get(out.abs);
			p = out.copy;
		}
		const r = await real(p);
		if (within(ws, r)) return r;
		if (!write && ro.some((root) => within(root, r))) return r;
		throw new Error(`access denied: ${p} is outside the conversation workspace${write ? "" : " and the skills"}`);
	};
	return {
		check,
		read: async (p: string) => readFile(await check(p, false)),
		write: async (p: string, content: string) => writeFile(await check(p, true), content),
	};
}

/** Pi's read/write/edit/ls with every filesystem call confined. They replace the built-ins (same names). */
export function guardedFileTools(workspace: string, readOnlyRoots: string[]): ToolDefinition[] {
	const g = fsGuard(workspace, readOnlyRoots);
	return [
		createReadToolDefinition(workspace, {
			operations: {
				readFile: g.read,
				access: async (p) => access(await g.check(p, false), constants.R_OK),
			},
		}),
		createWriteToolDefinition(workspace, {
			operations: {
				writeFile: g.write,
				mkdir: async (d) => void (await mkdir(await g.check(d, true), { recursive: true })),
			},
		}),
		createEditToolDefinition(workspace, {
			operations: {
				readFile: async (p) => readFile(await g.check(p, true)),
				writeFile: g.write,
				access: async (p) => access(await g.check(p, true), constants.R_OK | constants.W_OK),
			},
		}),
		createLsToolDefinition(workspace, {
			operations: {
				exists: async (p) => g.check(p, false).then((r) => stat(r).then(() => true, () => false), () => false),
				stat: async (p) => stat(await g.check(p, false)),
				readdir: async (p) => readdir(await g.check(p, false)),
			},
		}),
	] as ToolDefinition[];
}
