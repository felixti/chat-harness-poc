// One chat turn, end to end: lease and workspace, project mount, memory, tools, the agent run,
// cost, saving the conversation. The portal's /api/chat streams it (AG-UI over SSE); the worker
// runs the same turn for a scheduled task with no one watching (H69), under a cost cap (H68).
import { config } from "./config.ts";
import { runTurn, type Effort, type McpServer } from "./agent.ts";
import { canvasTool } from "./canvas.ts";
import type { ConversationStore } from "./store.ts";
import type { RunKind, TurnUsage, UsageLedger } from "./usage.ts";
import { retrieve, coreEntries, corePrompt, memoryTools, sessionSearchTool } from "./memory.ts";
import { FactGraph, graphTools } from "./graph-memory.ts";
import { beforeLastUserMessage } from "./conversation-view.ts";
import { curate } from "./curator.ts";
import { isSourceTool, planTool, showUiTool, SourceList } from "./ui-tools.ts";
import { AguiRun, resultText, type ResumeEntry } from "./agui.ts";
import { askUserTool, Gate, resumeMessage, stripHidden, withHidden } from "./approvals.ts";
import { callMcpTool } from "./mcp-call.ts";
import { libraryTools } from "./library.ts";
import { materializeSkills, skillTools } from "./skills-memory.ts";
import { connectedServers } from "./connectors.ts";
import { listProjectFiles, PROJECT_ID, projectPrefix, projectPrompt, type ProjectStore } from "./projects.ts";
import { openTurn, userVisible } from "./workspace.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface TurnDeps {
	store: ConversationStore;
	ledger: UsageLedger;
	projects: ProjectStore;
	/** Extra tools every turn gets (the scheduler's schedule_task). */
	tools?: (user: string, conversation: string, projectId: string | undefined) => ToolDefinition[];
}

export interface TurnRequest {
	user: string;
	id: string;
	message?: string;
	resume?: ResumeEntry[];
	skills?: string[];
	edit?: boolean;
	model?: string;
	effort?: Effort;
	/** Project of a new conversation (an existing one keeps its own). */
	projectId?: string;
	/** Ledger tag: the run that pays (a turn, or a job's id). */
	runId?: string;
	kind?: RunKind;
	/** A scheduled run: nobody is watching, so no questions or forms, no curator; title for a new conversation. */
	background?: { title: string };
	/** Instructions for the model that the conversation does not show (research delivery). */
	hidden?: string[];
	/** Live cost after each model call or image (the worker enforces the cap with it). */
	onUsage?: (u: { usd: number; calls: number }) => void;
	signal: AbortSignal;
}

export type TurnOutcome = { ok: false; error: string } | { ok: true; text: string; usage: TurnUsage; waiting: boolean; runId: string };

export async function mcpServersFor(user: string): Promise<McpServer[]> {
	const servers: McpServer[] = [];
	// App-level key (optional: Context7 also serves anonymous clients at a lower rate limit).
	servers.push({
		name: "context7",
		url: "https://mcp.context7.com/mcp",
		description: "Up-to-date documentation and code examples for software libraries and frameworks.",
		headers: config.context7ApiKey ? { CONTEXT7_API_KEY: config.context7ApiKey } : undefined,
	});
	// In-cluster Brave Search MCP (the API key lives in that pod, not here).
	if (config.braveMcpUrl)
		servers.push({
			name: "brave",
			url: config.braveMcpUrl,
			description: "Web and news search (Brave): current facts, statistics, sources and LLM-ready page context for research.",
		});
	// CrawlForge (H60): shared app key from Key Vault. Its sync calls run up to ~120 s.
	if (config.crawlforge.url && config.crawlforge.apiKey)
		servers.push({
			name: "crawlforge",
			url: config.crawlforge.url,
			description:
				"Web crawling and research (CrawlForge): scrape a URL to markdown/tables/links (also PDFs and JS-heavy pages), web search, extract structured data from a page with a schema, grounded answers with sources (ask), multi-step research (agent_run, research). Use it when a page must be read in full or a question needs several searches; keep agent_run and research for questions that need several sources (they take up to two minutes). Both return a finished report with sources: answer from it, and do not re-scrape its sources one by one.",
			headers: { "x-api-key": config.crawlforge.apiKey },
			timeout: 150,
		});
	// Per-user connectors (GitHub, ...): token from the sealed vault, never from the workspace.
	servers.push(...(await connectedServers(user)));
	return servers;
}

/** First words of the first message, cut at a word boundary. */
export function titleOf(message: string): string {
	const t = message.replace(/\s+/g, " ").replace(/\(arquivos anexados:[^)]*\)/, "").trim() || "Nova conversa";
	if (t.length <= 60) return t;
	const cut = t.slice(0, 60);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 30)).replace(/[,.;:]$/, "")}…`;
}

const BACKGROUND_NOTE =
	"This message is a scheduled task running in the background: the user is not watching and cannot answer questions now. Do the task completely in this turn. If something is missing, make a reasonable assumption and state it in one line. Write the answer for the user to read later.";

/** Runs one turn. `begin` is called once the turn is ready (the caller starts its stream there). */
export async function executeTurn(deps: TurnDeps, req: TurnRequest, begin: () => AguiRun): Promise<TurnOutcome> {
	const { store, ledger, projects } = deps;
	const { user, id } = req;
	// Project (H71): a conversation keeps the project it was created in or moved to; a new one takes
	// the project the portal was showing. Its files are mounted read-only under project/.
	const before = await store.get(user, id);
	const wanted = before ? before.projectId : req.projectId;
	const project = wanted && PROJECT_ID.test(wanted) ? await projects.get(user, wanted) : undefined;
	const projectFiles = project ? await listProjectFiles(user, project.id) : [];
	// Lease + fresh workspace from Blob; ConversationBusyError (409) before streaming when another turn holds it.
	const turn = await openTurn(user, id, project ? [{ prefix: projectPrefix(user, project.id), as: "project" }] : []);
	const memoryOn = config.memory.enabled && !!config.connectors.masterKey;
	const facts = memoryOn ? new FactGraph(user, id) : undefined;
	const mySkills = memoryOn ? await materializeSkills(user) : undefined;
	let finished = false;
	try {
		const existing = await store.get(user, id);
		// A resume answers the interrupts saved with the conversation (any replica can serve it).
		let message = req.message;
		const gate = new Gate();
		let resumed: ReturnType<typeof resumeMessage> | undefined;
		if (req.resume?.length) {
			resumed = resumeMessage(existing?.pending ?? [], req.resume);
			message = resumed.message;
		}
		if (!message) return { ok: false, error: "bad request: no user message" };
		const run = begin();
		const savedByAgent: string[] = [];
		const sources = new SourceList();
		const onEvent = (e: { type: string; [k: string]: unknown }) => {
			if (e.type === "delta") run.text(String(e.text));
			else if (e.type === "thinking") run.reasoning(String(e.text));
			else if (e.type === "tool") {
				if (e.name === "memory" || e.name === "remember") savedByAgent.push(JSON.stringify(e.args));
				run.toolStart(String(e.id), String(e.name), e.args);
			} else if (e.type === "tool_end") {
				const text = resultText(e.result);
				run.toolResult(String(e.id), text, !!e.isError);
				// Web pages a search/crawl returned: listed under the reply (H62).
				if (!e.isError && isSourceTool(String(e.name)) && sources.add(String(e.name), text)) run.custom("sources", sources.list());
			} else if (e.type === "error") run.custom("model_error", { message: e.message });
		};
		run.started();
		try {
			const hidden: string[] = [];
			// Approved actions run here, exactly as approved; the model only reports the outcome.
			if (resumed) {
				hidden.push(...resumed.hidden);
				if (resumed.approved.length) {
					const servers = await mcpServersFor(user);
					for (const a of resumed.approved) {
						const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(a.toolName) ?? [];
						const target = servers.find((x) => x.name === server);
						const callId = `approved-${a.interruptId}`;
						run.toolStart(callId, a.toolName, a.input);
						const out = target ? await callMcpTool(target, tool, a.input).catch((e) => ({ text: (e as Error).message, isError: true })) : { text: `connector ${server} is not connected`, isError: true };
						run.toolResult(callId, out.text, out.isError);
						console.log(`[approval] ${a.toolName} ${out.isError ? "failed" : "ran"}`);
						hidden.push(
							out.isError
								? `The approved action ${a.toolName} was executed by the system and FAILED: ${out.text.slice(0, 1500)}. Tell the user in one or two sentences what failed and what they can do. Do not retry it yourself.`
								: `The approved action ${a.toolName} was already executed by the system, exactly as approved. Result: ${out.text.slice(0, 3000)}. Report the outcome in one or two sentences (IDs, names, links). Do not call it again.`,
						);
					}
				}
			}
			if (req.background) hidden.push(BACKGROUND_NOTE);
			if (req.hidden) hidden.push(...req.hidden);
			if (hidden.length) message = withHidden(message, hidden);
			const canvas = canvasTool(turn.dir, (c) => run.custom("canvas", c));
			const projectAppend = project ? projectPrompt(project, projectFiles) : "";
			const plan = planTool((steps) => run.activity(`plan-${run.runId}`, "plan", { steps }));
			// Questions and forms need someone at the screen: not in a background run.
			const interactive = req.background ? [] : [askUserTool(), showUiTool((s) => run.activity(`a2ui-${s.surfaceId}`, "a2ui-surface", { surfaceId: s.surfaceId, title: s.title, a2ui_operations: s.messages }))];
			const shared = [sessionSearchTool(user, id, store), ...libraryTools(user, turn.dir, store), ...interactive, canvas, plan, ...(deps.tools?.(user, id, project?.id ?? existing?.projectId) ?? [])];
			const result = await runTurn({
				workspace: turn.dir,
				// edit/regenerate: replay from before the last user message (the old answer is replaced).
				entries: req.edit ? beforeLastUserMessage(existing?.entries ?? []) : (existing?.entries ?? []),
				message,
				pinnedSkills: req.skills,
				model: req.model,
				effort: req.effort,
				mcpServers: await mcpServersFor(user),
				gate,
				...(memoryOn && facts
					? { systemAppend: projectAppend + (await corePrompt(user)) + (await memoryContext(store, user, message, id, facts, (v) => run.custom("memory_used", v))), extraTools: [...memoryTools(user), ...graphTools(facts), ...skillTools(user, id), ...shared], userSkillsDir: mySkills?.dir }
					: { systemAppend: projectAppend || undefined, extraTools: shared }),
				onEvent,
				onUsage: req.onUsage,
				signal: req.signal,
			});
			if (gate.tripped && !result.text.trim()) {
				// The breaker stopped a looping model before it wrote anything: tell the user plainly.
				run.text("Não consegui concluir: entrei em repetição ao usar as ferramentas e parei para não fazer nada errado. Tente de novo; se repetir, descreva o pedido em outras palavras.");
			}
			const files = await turn.finish();
			finished = true;
			let summary = existing?.summary;
			const userWords = stripHidden(message);
			const curatorOn = memoryOn && config.memory.curator && !req.background;
			// The answer is already on screen; the curator runs before RUN_FINISHED so the panel refreshes.
			if (curatorOn && config.memory.curatorMode === "inline") {
				const cur = await curate({ user, userMessage: userWords, assistantReply: result.text, alreadySaved: savedByAgent, previousSummary: existing?.summary }, facts).catch((e) => {
					console.warn(`[curator] ${(e as Error).message}`);
					return { saved: [] as string[], summary: undefined };
				});
				summary = cur.summary ?? summary;
				if (cur.saved.length) run.custom("memory_saved", cur.saved);
			}
			// Cost (H58, H68): recorded before saving the conversation, so a save conflict does not lose it.
			await ledger.add(user, id, result.usage, { runId: req.runId ?? run.runId, kind: req.kind ?? "turn" }).catch((e) => console.warn(`[usage] ${(e as Error).message}`));
			const [convSpend, monthSpend] = await Promise.all([ledger.conversation(user, id), ledger.month(user)]).catch(() => [undefined, undefined]);
			if (convSpend && monthSpend) run.custom("usage", { turn: { usd: result.usage.usd, brl: result.usage.usd * config.usdBrl, model: result.usage.model, input: result.usage.input + result.usage.cacheRead, output: result.usage.output }, conversation: convSpend, month: monthSpend });
			await store.save({
				id,
				user,
				title: existing?.title ?? req.background?.title ?? titleOf(userWords),
				entries: result.entries,
				updatedAt: new Date(),
				summary,
				curatedAt: existing?.curatedAt,
				pending: gate.interrupts.length ? gate.interrupts : undefined,
				version: existing?.version,
				projectId: existing ? existing.projectId : project?.id,
			});
			if (curatorOn && config.memory.curatorMode === "async" && !req.resume?.length) {
				// After the answer, off the request path; the nightly job catches anything this misses.
				const later = { user, userMessage: userWords, assistantReply: result.text, alreadySaved: savedByAgent, previousSummary: existing?.summary };
				setImmediate(() => {
					const g = new FactGraph(user, id);
					void curate(later, g)
						.then((r) => store.markCurated(user, id, r.summary, new Date()))
						.catch((e) => console.warn(`[curator] async: ${(e as Error).message}`))
						.finally(() => g.dispose().catch(() => undefined));
				});
			}
			run.custom("files", userVisible(files));
			run.finished(gate.interrupts.map(({ id: iid, reason, message: msg, toolCallId, responseSchema, toolName, input: args, questions }) => ({ id: iid, reason, message: msg, toolCallId, responseSchema, metadata: { toolName, input: args, questions } })));
			return { ok: true, text: result.text, usage: result.usage, waiting: gate.interrupts.length > 0, runId: run.runId };
		} catch (e) {
			run.error((e as Error).message);
			return { ok: false, error: (e as Error).message };
		}
	} finally {
		// Files the turn already wrote are kept even on error; only a turn that never reached
		// finish() is abandoned (local copy deleted, lease released).
		if (!finished) await turn.finish().catch(() => turn.abandon());
		await facts?.dispose().catch((e) => console.warn(`[graph] dispose: ${(e as Error).message}`));
		await mySkills?.cleanup();
	}
}

/** Retrieved memory for this turn; tells the portal what was used ("memória usada" chip). */
async function memoryContext(store: ConversationStore, user: string, message: string, id: string, facts: FactGraph | undefined, used: (v: unknown) => void): Promise<string> {
	const [{ prompt, used: u }, core] = await Promise.all([retrieve(user, message, id, store, facts), coreEntries(user).catch(() => ({ user: [], memory: [] }))]);
	u.core = core.user.length + core.memory.length;
	if (u.core || u.facts.length || u.conversations.length) used(u);
	return prompt;
}
