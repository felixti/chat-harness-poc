// File confinement for Pi's built-in read/write/edit/ls. Those tools accept absolute paths and
// "../", so in a shared multi-user pod they could reach another user's workspace, /proc/self/environ
// (secrets) or the agent dir. We rebuild them with operations that resolve the real path (symlinks
// included) and allow only: the turn's workspace (read-write) and the skills folder (read-only).
import { access, constants, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, basename, join, relative, isAbsolute } from "node:path";
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

export function fsGuard(workspace: string, readOnlyRoots: string[]) {
	const roots = Promise.all([real(workspace), ...readOnlyRoots.map(real)]);
	const check = async (p: string, write: boolean): Promise<string> => {
		const [ws, ...ro] = await roots;
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
