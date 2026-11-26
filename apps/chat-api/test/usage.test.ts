// Cost ledger: per conversation, per run (H68), per user per calendar month (Brasília), kept after deletes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, openLedger } from "../src/usage.ts";
import { config } from "../src/config.ts";

test("sums per conversation and per month, per user", async () => {
	const l = await openLedger("");
	const u = (usd: number) => ({ ...emptyUsage("m"), usd });
	await l.add("ana", "c1", u(0.01), { runId: "r1", kind: "job" }, new Date("2026-10-31T12:00:00Z"));
	await l.add("ana", "c1", u(0.02), { runId: "r1", kind: "job" }, new Date("2026-11-01T04:00:00Z")); // 01:00 in Brasília: November
	await l.add("ana", "c2", u(0.03), {}, new Date("2026-11-10T12:00:00Z"));
	await l.add("bia", "c3", u(1), { runId: "r1", kind: "job" }, new Date("2026-11-10T12:00:00Z"));
	const c1 = await l.conversation("ana", "c1");
	assert.equal(c1.turns, 2);
	assert.ok(Math.abs(c1.usd - 0.03) < 1e-9);
	assert.ok(Math.abs(c1.brl - 0.03 * config.usdBrl) < 1e-9);
	const nov = await l.month("ana", new Date("2026-11-15T12:00:00Z"));
	assert.equal(nov.turns, 2);
	assert.ok(Math.abs(nov.usd - 0.05) < 1e-9);
	assert.equal((await l.conversation("bia", "c1")).turns, 0);
});

test("one run's cost, whatever conversation or month its calls fell in; other users' rows ignored", async () => {
	const l = await openLedger("");
	const u = (usd: number) => ({ ...emptyUsage("m"), usd });
	await l.add("ana", "c1", u(0.25), { runId: "job-1", kind: "job" });
	await l.add("ana", "c1", u(0.5), { runId: "job-1", kind: "job" });
	await l.add("ana", "c1", u(9), { runId: "job-2", kind: "job" });
	await l.add("bia", "c9", u(7), { runId: "job-1", kind: "job" });
	const r = await l.run("ana", "job-1");
	assert.equal(r.turns, 2);
	assert.ok(Math.abs(r.usd - 0.75) < 1e-9);
});
