// Schedules and jobs (H69): São Paulo times, one job per due schedule even with several workers,
// leases that expire back to the queue, stop requests, and run-once schedules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeWhen, MemoryJobs, MemorySchedules, nextOf, nextRun, tick, validWhen } from "../src/jobs.ts";

const at = (iso: string) => new Date(iso);

test("cron in São Paulo time (UTC-3): daily, weekdays, weekly, monthly, once", () => {
	// 2026-11-25 is a Wednesday. 08:00 in São Paulo is 11:00 UTC.
	assert.equal(nextRun("0 8 * * *", at("2026-11-25T10:59:00Z")).toISOString(), "2026-11-25T11:00:00.000Z");
	assert.equal(nextRun("0 8 * * *", at("2026-11-25T11:00:00Z")).toISOString(), "2026-11-26T11:00:00.000Z");
	assert.equal(nextRun("30 7 * * 1-5", at("2026-11-27T12:00:00Z")).toISOString(), "2026-11-30T10:30:00.000Z"); // Fri after -> Mon
	assert.equal(nextOf(validWhen({ freq: "weekly", time: "09:15", weekday: 0 }), at("2026-11-25T00:00:00Z"))!.toISOString(), "2026-11-29T12:15:00.000Z");
	assert.equal(nextOf(validWhen({ freq: "monthly", time: "23:30", day: 5 }), at("2026-11-25T00:00:00Z"))!.toISOString(), "2026-12-06T02:30:00.000Z"); // 23:30 local = next day UTC
	const once = validWhen({ freq: "once", time: "18:00", date: "2026-12-01" });
	assert.equal(nextOf(once, at("2026-11-25T00:00:00Z"))!.toISOString(), "2026-12-01T21:00:00.000Z");
	assert.equal(nextOf(once, at("2026-12-02T00:00:00Z")), undefined);
	assert.equal(describeWhen({ freq: "weekly", time: "09:15", weekday: 1 }), "Toda segunda-feira às 09:15");
	assert.equal(describeWhen({ freq: "weekly", time: "09:15", weekday: 0 }), "Todo domingo às 09:15");
	assert.throws(() => validWhen({ freq: "hourly", time: "08:00" }), /freq/);
	assert.throws(() => validWhen({ freq: "daily", time: "8h" }), /HH:MM/);
	assert.throws(() => validWhen({ freq: "monthly", time: "08:00", day: 31 }), /day 1 to 28/);
});

test("a due schedule becomes exactly one job, even when two workers tick at once", async () => {
	const s = new MemorySchedules();
	const q = new MemoryJobs();
	const sch = await s.create({ user: "ana", title: "Notícias", prompt: "resuma as notícias de IA", kind: "prompt", when: { freq: "daily", time: "08:00" }, capUsd: 0.2 });
	assert.ok(sch.active && sch.nextRunAt);
	const due = new Date(+sch.nextRunAt! + 1000);
	const [a, b] = await Promise.all([tick(s, q, due), tick(s, q, due)]);
	assert.equal(a.length + b.length, 1);
	const job = [...a, ...b][0];
	assert.equal(job.conversation, sch.conversation);
	assert.equal(job.scheduleId, sch.id);
	const after = await s.get("ana", sch.id);
	assert.equal(after!.lastJob, job.id);
	assert.equal(+after!.nextRunAt! - +sch.nextRunAt!, 86_400_000);
	assert.equal((await tick(s, q, due)).length, 0);
});

test("a run-once schedule turns itself off after firing; a paused one never fires", async () => {
	const s = new MemorySchedules();
	const q = new MemoryJobs();
	const tomorrow = new Date(Date.now() + 86_400_000 + 3 * 3_600_000).toISOString().slice(0, 10);
	const once = await s.create({ user: "ana", title: "Lembrete", prompt: "x", kind: "prompt", when: { freq: "once", time: "10:00", date: tomorrow }, capUsd: 0.1 });
	const paused = await s.update("ana", (await s.create({ user: "ana", title: "P", prompt: "y", kind: "prompt", when: { freq: "daily", time: "10:00" }, capUsd: 0.1 })).id, { active: false });
	assert.equal(paused!.nextRunAt, undefined);
	const jobs = await tick(s, q, new Date(+once.nextRunAt! + 1));
	assert.equal(jobs.length, 1);
	const after = await s.get("ana", once.id);
	assert.equal(after!.active, false);
	assert.equal(after!.nextRunAt, undefined);
});

test("claim, heartbeat with live cost, finish; a lost lease goes back to the queue", async () => {
	const q = new MemoryJobs();
	const j = await q.enqueue({ user: "ana", kind: "prompt", title: "t", prompt: "p", conversation: "c1", capUsd: 0.5 });
	const t0 = new Date();
	const c = await q.claim("w1", 60_000, t0);
	assert.equal(c!.id, j.id);
	assert.equal(c!.attempts, 1);
	assert.equal(await q.claim("w2", 60_000, t0), undefined, "held by w1");
	assert.deepEqual(await q.heartbeat(j.id, "w1", 60_000, { cost: { usd: 0.01, calls: 2 }, progress: "web_search" }), { cancel: false });
	// w1 dies: after the lease, w2 takes it over and w1's heartbeat is refused.
	const later = new Date(+t0 + 61_000);
	const again = await q.claim("w2", 60_000, later);
	assert.equal(again!.attempts, 2);
	assert.deepEqual(again!.cost, { usd: 0.01, calls: 2 }, "progress survives");
	assert.equal(await q.heartbeat(j.id, "w1", 60_000), undefined);
	await q.finish(j.id, "w2", "done", { cost: { usd: 0.02, calls: 3 } });
	const done = await q.get("ana", j.id);
	assert.equal(done!.status, "done");
	assert.equal(await q.get("bia", j.id), undefined, "other users cannot read it");
});

test("stop: a queued job stops at once, a running one at its next heartbeat; release does not count an attempt", async () => {
	const q = new MemoryJobs();
	const a = await q.enqueue({ user: "ana", kind: "prompt", title: "a", prompt: "p", conversation: "c1", capUsd: 0.5, runAt: new Date(Date.now() + 3_600_000) });
	assert.equal((await q.requestStop("ana", a.id))!.status, "stopped");
	const b = await q.enqueue({ user: "ana", kind: "prompt", title: "b", prompt: "p", conversation: "c2", capUsd: 0.5 });
	await q.claim("w1", 60_000);
	await q.requestStop("ana", b.id);
	assert.deepEqual(await q.heartbeat(b.id, "w1", 60_000), { cancel: true });
	const c = await q.enqueue({ user: "ana", kind: "prompt", title: "c", prompt: "p", conversation: "c3", capUsd: 0.5 });
	await q.finish(b.id, "w1", "stopped", { stopReason: "user" });
	const claimed = await q.claim("w1", 60_000);
	assert.equal(claimed!.id, c.id);
	await q.release(c.id, "w1", new Date(Date.now() + 60_000));
	const back = await q.get("ana", c.id);
	assert.equal(back!.status, "queued");
	assert.equal(back!.attempts, 0);
	assert.equal((await q.list("ana", {})).length, 3);
	assert.equal((await q.list("ana", { conversation: "c3" })).length, 1);
});
