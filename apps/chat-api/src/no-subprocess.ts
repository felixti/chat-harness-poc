// Mirrors the company's Prisma runtime rule "no CLI invocation": any attempt to start a
// child process throws. Loaded before anything else (server.ts imports it first), so a
// harness feature that secretly shells out fails in tests instead of in production.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const blocked = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;

export function forbidSubprocesses(): void {
	for (const name of blocked) {
		(childProcess as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
			const what = typeof args[0] === "string" ? args[0] : "?";
			const error = new Error(`subprocess blocked (${name} ${what}): forbidden by runtime policy`);
			console.error(`[policy] ${error.message}`);
			throw error;
		};
	}
	syncBuiltinESMExports();
}

if (process.env.ALLOW_SUBPROCESS !== "1") forbidSubprocesses();
