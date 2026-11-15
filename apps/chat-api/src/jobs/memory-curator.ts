// Entry point of the memory-curator CronJob (same image as chat-api, no shell, no subprocess).
import "../no-subprocess.ts";
import { config } from "../config.ts";
import { openStore } from "../store.ts";
import { curate } from "../curator.ts";
import { FactGraph } from "../graph-memory.ts";
import { runCuration } from "../memory-job.ts";

const started = Date.now();
const store = await openStore(config.mongoUrl);
const stats = await runCuration({
	store,
	curate,
	graphFor: (user, conversation) => (config.connectors.masterKey ? new FactGraph(user, conversation) : undefined),
	lookbackHours: Number(process.env.CURATION_LOOKBACK_HOURS ?? 48),
	limit: Number(process.env.CURATION_LIMIT ?? 500),
});
console.log(`[memory-job] done in ${Math.round((Date.now() - started) / 1000)}s: ${JSON.stringify(stats)}`);
process.exit(stats.failed && !stats.processed ? 1 : 0);
