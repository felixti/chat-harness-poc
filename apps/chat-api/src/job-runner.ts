// Runs one claimed job (H69) under its cost cap (H68): renews the lease while it runs, saves the
// live cost and the current step for the portal, stops on the cap or on the user's request, and
// records the final cost from the ledger (every model call and image of the run has its runId).
import { AguiRun } from "./agui.ts";
import { ConversationBusyError } from "./workspace.ts";
import { isFinal, MAX_ATTEMPTS, type Job, type JobQueue, type StopReason } from "./jobs.ts";
import type { TurnOutcome, TurnRequest } from "./turn.ts";
import type { UsageLedger } from "./usage.ts";

export const LEASE_MS = 90_000;
export const HEARTBEAT_MS = 20_000;
/** A busy conversation (the user is chatting in it) pushes the run back this long. */
export const BUSY_RETRY_MS = 60_000;

export interface RunnerDeps {
	jobs: JobQueue;
	ledger: UsageLedger;
	/** executeTurn bound to its deps (a fake in tests). */
	turn: (req: TurnRequest, begin: () => AguiRun) => Promise<TurnOutcome>;
	/** Deep research (H73); a prompt job is one turn. */
	research?: (job: Job, ctx: RunContext) => Promise<{ ok: boolean; error?: string; waiting?: boolean }>;
	heartbeatMs?: number;
}

export interface RunContext {
	signal: AbortSignal;
	/** Cost so far of the part running now, added to the run's total. */
	onUsage: (u: { usd: number; calls: number }) => void;
	/** Commits the cost of a finished part, so the next part starts from 0. */
	commitUsage: () => void;
	progress: (step: string) => void;
	checkpoint: (c: unknown) => Promise<void>;
	stopped: () => StopReason | undefined;
}

export async function runJob(d: RunnerDeps, job: Job, owner: string): Promise<Job["status"] | "released" | "lost"> {
	if (job.attempts > MAX_ATTEMPTS) {
		await d.jobs.finish(job.id, owner, "failed", { stopReason: "attempts", error: `stopped after ${MAX_ATTEMPTS} attempts` });
		return "failed";
	}
	const abort = new AbortController();
	let stopReason: StopReason | undefined;
	let lost = false;
	let committed = { usd: job.cost.usd, calls: job.cost.calls };
	let live = { usd: 0, calls: 0 };
	let progress = job.progress ?? "starting";
	let checkpoint: unknown;
	const total = () => ({ usd: committed.usd + live.usd, calls: committed.calls + live.calls });
	const stop = (why: StopReason) => {
		if (stopReason) return;
		stopReason = why;
		console.log(`[job] ${job.id} stopping: ${why}`);
		abort.abort();
	};
	const beat = async () => {
		const r = await d.jobs.heartbeat(job.id, owner, LEASE_MS, { cost: total(), progress, ...(checkpoint !== undefined ? { checkpoint } : {}) }).catch((e) => {
			console.warn(`[job] ${job.id} heartbeat: ${(e as Error).message}`);
			return { cancel: false };
		});
		if (!r) {
			lost = true;
			abort.abort();
		} else if (r.cancel) stop("user");
	};
	const timer = setInterval(() => void beat(), d.heartbeatMs ?? HEARTBEAT_MS);
	// A new step reaches the portal at once (at most every 3 s), not only at the next heartbeat.
	let lastStepSent = 0;
	const setStep = (step: string) => {
		if (step === progress) return;
		progress = step;
		if (Date.now() - lastStepSent > 3000) {
			lastStepSent = Date.now();
			void beat();
		}
	};
	const ctx: RunContext = {
		signal: abort.signal,
		onUsage: (u) => {
			live = u;
			if (total().usd >= job.capUsd) stop("budget");
		},
		commitUsage: () => {
			committed = total();
			live = { usd: 0, calls: 0 };
		},
		progress: setStep,
		checkpoint: async (c) => {
			checkpoint = c;
			await beat();
		},
		stopped: () => stopReason,
	};
	let outcome: { ok: boolean; error?: string; waiting?: boolean };
	try {
		if (job.kind === "research") {
			if (!d.research) throw new Error("research runs are not enabled on this worker");
			outcome = await d.research(job, ctx);
		} else {
			// The worker's AG-UI stream goes nowhere; it only tracks the step for the portal.
			const emit = (e: { type: string; toolCallName?: unknown }) => {
				if (e.type === "TOOL_CALL_START") setStep(String(e.toolCallName));
				else if (e.type === "TEXT_MESSAGE_START") setStep("writing");
			};
			outcome = await d.turn(
				{ user: job.user, id: job.conversation, message: job.prompt, model: job.model, projectId: job.projectId, runId: job.id, kind: "job", background: { title: job.title }, onUsage: ctx.onUsage, signal: abort.signal },
				() => new AguiRun(emit, job.conversation, job.id),
			);
		}
	} catch (e) {
		if (e instanceof ConversationBusyError) {
			clearInterval(timer);
			await d.jobs.release(job.id, owner, new Date(Date.now() + BUSY_RETRY_MS));
			console.log(`[job] ${job.id} conversation busy, retry in ${BUSY_RETRY_MS / 1000}s`);
			return "released";
		}
		outcome = { ok: false, error: (e as Error).message };
	} finally {
		clearInterval(timer);
	}
	if (lost) {
		console.warn(`[job] ${job.id} lease lost to another worker`);
		return "lost";
	}
	// The ledger has every call of the run; the live figure is the fallback.
	const spent = await d.ledger.run(job.user, job.id).catch(() => undefined);
	const cost = spent && spent.turns > 0 ? { usd: spent.usd, calls: total().calls } : total();
	const status = stopReason ? "stopped" : outcome.ok ? "done" : "failed";
	await d.jobs.finish(job.id, owner, status, { cost, progress: status === "done" ? "done" : progress, stopReason, error: outcome.ok ? undefined : outcome.error?.slice(0, 500), waiting: outcome.waiting });
	console.log(`[job] ${job.id} ${status}${stopReason ? ` (${stopReason})` : ""} US$${cost.usd.toFixed(4)}`);
	return isFinal(status) ? status : "failed";
}
