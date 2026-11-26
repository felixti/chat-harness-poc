// Entry point of the chat-worker Deployment (H69): same image as chat-api, other entrypoint, so a
// chat-api rollout does not kill a long run. Every TICK it turns due schedules into jobs; it keeps
// up to WORKER_CONCURRENCY jobs running, claimed from FerretDB with a lease. No shell, no subprocess.
import "../no-subprocess.ts";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { config } from "../config.ts";
import { openStore } from "../store.ts";
import { openLedger } from "../usage.ts";
import { openProjects } from "../projects.ts";
import { openJobs, tick } from "../jobs.ts";
import { executeTurn } from "../turn.ts";
import { runJob, LEASE_MS } from "../job-runner.ts";
import { researchRunner } from "../research.ts";

const OWNER = `${hostname()}-${process.pid}`;
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 2);
const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 30_000);
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 5_000);

const store = await openStore(config.mongoUrl);
const ledger = await openLedger(config.mongoUrl);
const projects = await openProjects(config.mongoUrl);
const { schedules, jobs } = await openJobs(config.mongoUrl);
// A background run does not schedule more runs or start research: those tools are chat-only.
const deps = { store, ledger, projects };
const turn = (req: Parameters<typeof executeTurn>[1], begin: Parameters<typeof executeTurn>[2]) => executeTurn(deps, req, begin);

let running = 0;
let stopping = false;

async function fill() {
	while (!stopping && running < CONCURRENCY) {
		const job = await jobs.claim(OWNER, LEASE_MS).catch((e) => {
			console.warn(`[worker] claim: ${(e as Error).message}`);
			return undefined;
		});
		if (!job) return;
		running++;
		console.log(`[worker] ${job.id} ${job.kind} attempt ${job.attempts}`);
		void runJob({ jobs, ledger, turn, research: researchRunner({ turn, ledger }) }, job, OWNER)
			.catch((e) => console.error(`[worker] ${job.id}: ${(e as Error).stack}`))
			.finally(() => {
				running--;
				void fill();
			});
	}
}

const ticker = setInterval(() => {
	void tick(schedules, jobs)
		.then((created) => created.length && console.log(`[worker] ${created.length} scheduled run(s) queued`))
		.catch((e) => console.warn(`[worker] tick: ${(e as Error).message}`))
		.then(fill);
}, TICK_MS);
const poller = setInterval(() => void fill(), POLL_MS);

// Liveness only: no traffic comes in (the NetworkPolicy has no ingress).
const health = createServer((_q, r) => r.writeHead(200).end(`ok ${running}/${CONCURRENCY}`)).listen(config.port, () => console.log(`chat-worker ${OWNER} up: concurrency ${CONCURRENCY}`));

// A rollout: stop claiming, give running jobs the grace period, then exit; a job still running
// keeps its lease until it expires and another worker resumes it.
process.on("SIGTERM", () => {
	stopping = true;
	clearInterval(ticker);
	clearInterval(poller);
	const started = Date.now();
	const wait = setInterval(() => {
		if (running === 0 || Date.now() - started > 50_000) {
			clearInterval(wait);
			health.close();
			console.log(`[worker] exit with ${running} running`);
			process.exit(0);
		}
	}, 1000);
});
void fill();
