// Running jobs (H68, H69, H73) with fake model turns: the run's cost comes from the ledger by runId,
// the cap stops it, a busy conversation sends it back to the queue, the user's stop is honoured at a
// heartbeat, and research resumes from its checkpoint after a lost worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryJobs, type Job } from "../src/jobs.ts";
import { runJob, type RunnerDeps } from "../src/job-runner.ts";
import { joinNotes, parseSpec, researchRunner, startResearchTool } from "../src/research.ts";
import { emptyUsage, openLedger, type UsageLedger } from "../src/usage.ts";
import { ConversationBusyError } from "../src/workspace.ts";
import type { TurnOutcome, TurnRequest } from "../src/turn.ts";
import { AguiRun } from "../src/agui.ts";

type Exec = (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

/** A fake turn: spends `steps` model calls of `usd` each, reporting live cost, then records the ledger row. */
function fakeTurn(ledger: UsageLedger, steps: number, usd: number, seen: TurnRequest[] = []) {
	return async (req: TurnRequest, begin: () => AguiRun): Promise<TurnOutcome> => {
		seen.push(req);
		const run = begin();
		run.toolStart("t1", "mcp__brave__brave_web_search", {});
		const u = { ...emptyUsage("m"), calls: 0, usd: 0 };
		for (let i = 0; i < steps && !req.signal.aborted; i++) {
			u.calls++;
			u.usd += usd;
			req.onUsage?.({ usd: u.usd, calls: u.calls });
		}
		await ledger.add(req.user, req.id, u, { runId: req.runId, kind: req.kind });
		return { ok: true, text: "ok", usage: u, waiting: false, runId: req.runId! };
	};
}

const prompt = (q: MemoryJobs, capUsd = 1) => q.enqueue({ user: "ana", kind: "prompt", title: "Notícias", prompt: "resuma", conversation: "conv-1", capUsd });

test("a prompt job runs one background turn in its conversation and records the run's cost", async () => {
	const jobs = new MemoryJobs();
	const ledger = await openLedger("");
	const seen: TurnRequest[] = [];
	const j = await prompt(jobs);
	const claimed = (await jobs.claim("w1", 60_000))!;
	assert.equal(await runJob({ jobs, ledger, turn: fakeTurn(ledger, 3, 0.01, seen) }, claimed, "w1"), "done");
	const done = (await jobs.get("ana", j.id))!;
	assert.equal(done.status, "done");
	assert.ok(Math.abs(done.cost.usd - 0.03) < 1e-9);
	assert.equal(seen[0].runId, j.id);
	assert.equal(seen[0].kind, "job");
	assert.equal(seen[0].id, "conv-1");
	assert.deepEqual(seen[0].background, { title: "Notícias" });
	assert.ok(Math.abs((await ledger.run("ana", j.id)).usd - 0.03) < 1e-9);
});

test("the cap stops the run and marks it stopped by the budget", async () => {
	const jobs = new MemoryJobs();
	const ledger = await openLedger("");
	const j = await prompt(jobs, 0.05);
	await runJob({ jobs, ledger, turn: fakeTurn(ledger, 100, 0.02) }, (await jobs.claim("w1", 60_000))!, "w1");
	const done = (await jobs.get("ana", j.id))!;
	assert.equal(done.status, "stopped");
	assert.equal(done.stopReason, "budget");
	assert.ok(done.cost.usd >= 0.05 && done.cost.usd < 0.07, `stopped right after the cap: ${done.cost.usd}`);
});

test("a busy conversation sends the job back to the queue, a minute later, without spending an attempt", async () => {
	const jobs = new MemoryJobs();
	const ledger = await openLedger("");
	const j = await prompt(jobs);
	const busy: RunnerDeps["turn"] = async () => {
		throw new ConversationBusyError();
	};
	assert.equal(await runJob({ jobs, ledger, turn: busy }, (await jobs.claim("w1", 60_000))!, "w1"), "released");
	const back = (await jobs.get("ana", j.id))!;
	assert.equal(back.status, "queued");
	assert.equal(back.attempts, 0);
	assert.ok(+back.runAt > Date.now() + 50_000);
});

test("the user's stop reaches a running job at its next heartbeat", async () => {
	const jobs = new MemoryJobs();
	const ledger = await openLedger("");
	const j = await prompt(jobs);
	const slow: RunnerDeps["turn"] = (req) =>
		new Promise((resolve) => {
			req.signal.addEventListener("abort", () => resolve({ ok: true, text: "", usage: emptyUsage("m"), waiting: false, runId: req.runId! }));
			void jobs.requestStop("ana", j.id);
		});
	await runJob({ jobs, ledger, turn: slow, heartbeatMs: 20 }, (await jobs.claim("w1", 60_000))!, "w1");
	const done = (await jobs.get("ana", j.id))!;
	assert.equal(done.status, "stopped");
	assert.equal(done.stopReason, "user");
});

test("start_research queues one research job in the conversation, with estimate and cap", async () => {
	const jobs = new MemoryJobs();
	const tool = startResearchTool(jobs, "ana", "conv-9", undefined);
	const exec = tool.execute as unknown as Exec;
	const few = await exec("c", { topic: "x", questions: ["a", "b"] });
	assert.match(few.content[0].text, /at least 3/);
	const ok = await exec("c", { topic: "Mercado de IA no varejo do Brasil", questions: ["tamanho", "players", "casos"], cap_brl: 4, format: "docx" });
	assert.match(ok.content[0].text, /Research started .* 3 sub-questions\. Estimate about R\$ [\d.]+, cap R\$ 4\.00/);
	const [job] = await jobs.list("ana", { conversation: "conv-9" });
	assert.equal(job.kind, "research");
	assert.deepEqual(parseSpec(job.prompt).questions, ["tamanho", "players", "casos"]);
	assert.equal(parseSpec(job.prompt).format, "docx");
	assert.match((await exec("c", { topic: "y", questions: ["a", "b", "c"] })).content[0].text, /already going/);
});

test("research: read each sub-question, write, check, deliver; resumes from the checkpoint after a lost worker", async () => {
	const jobs = new MemoryJobs();
	const ledger = await openLedger("");
	const spec = { topic: "Adoção de IA no varejo", questions: ["Q um", "Q dois", "Q três"], format: "chat" as const };
	const j = await jobs.enqueue({ user: "ana", kind: "research", title: spec.topic, prompt: JSON.stringify(spec), conversation: "conv-r", capUsd: 1 });
	const calls: string[] = [];
	let failOn: string | undefined = "write";
	const think = async (_job: Job, ctx: { onUsage: (u: { usd: number; calls: number }) => void; commitUsage: () => void }, step: string, p: string) => {
		if (step === failOn) throw new Error("worker died");
		if (step === "q1") throw new Error("MCP timeout");
		calls.push(step);
		ctx.onUsage({ usd: 0.01, calls: 1 });
		ctx.commitUsage();
		if (step.startsWith("q")) return `## Findings\n- fato de ${step} [S1]\n## Sources\n[S1] Página — https://example.com/${step}`;
		if (step === "write") return `# Relatório\n${p.includes("[Q3-S1]") ? "usa Q3-S1" : "sem notas"} [1]\n## Fontes\n1. https://example.com/q0`;
		return '[{"claim":"fato de q2","issue":"no source"}]';
	};
	const delivered: TurnRequest[] = [];
	const turn = fakeTurn(ledger, 1, 0.02, delivered);
	const research = researchRunner({ turn, ledger, think });
	// First worker: reads all three (q1 fails and becomes a gap), checkpoints, then dies while writing.
	assert.equal(await runJob({ jobs, ledger, turn, research }, (await jobs.claim("w1", 60_000))!, "w1"), "failed");
	assert.deepEqual(calls, ["q0", "q2"]);
	const mid = (await jobs.get("ana", j.id))!;
	const notes = (mid.checkpoint as { notes: Record<string, string> }).notes;
	assert.deepEqual(Object.keys(notes), ["0", "1", "2"]);
	assert.match(notes["1"], /Reading failed \(MCP timeout\)/);
	// Requeue, as when the lease of a killed worker expires.
	Object.assign((jobs as MemoryJobs).items.get(j.id)!, { status: "queued", runAt: new Date(0) });
	failOn = undefined;
	assert.equal(await runJob({ jobs, ledger, turn, research }, (await jobs.claim("w2", 60_000))!, "w2"), "done");
	assert.deepEqual(calls, ["q0", "q2", "write", "check"], "sub-questions are not read again");
	const req = delivered[0];
	assert.equal(req.message, "Relatório da pesquisa: Adoção de IA no varejo");
	assert.match(req.hidden![0], /usa Q3-S1/);
	assert.match(req.hidden![0], /"fato de q2": no source/);
	const done = (await jobs.get("ana", j.id))!;
	assert.equal(done.status, "done");
	assert.ok(done.cost.usd >= 0.02, "the delivery turn's cost is in the run");
});

test("notes keep each sub-question's sources distinct", () => {
	const s = joinNotes({ topic: "t", questions: ["a", "b"], format: "chat" }, { "0": "x [S1]", "1": "y [S1] [S2]" });
	assert.match(s, /### Q1\. a\nx \[Q1-S1\]/);
	assert.match(s, /### Q2\. b\ny \[Q2-S1\] \[Q2-S2\]/);
});

test("the ledger's billed total is the run's final cost even when the live estimate was higher", async () => {
	const jobs = new MemoryJobs();
	const ledger = await openLedger("");
	const j = await prompt(jobs);
	const turn: RunnerDeps["turn"] = async (req, begin) => {
		begin();
		req.onUsage?.({ usd: 0.02, calls: 2 }); // price-list estimate during the run
		const u = { ...emptyUsage("m"), usd: 0.009, calls: 2 }; // what OpenRouter billed
		await ledger.add(req.user, req.id, u, { runId: req.runId, kind: "job" });
		return { ok: true, text: "", usage: u, waiting: false, runId: req.runId! };
	};
	await runJob({ jobs, ledger, turn }, (await jobs.claim("w1", 60_000))!, "w1");
	assert.ok(Math.abs((await jobs.get("ana", j.id))!.cost.usd - 0.009) < 1e-9);
});
