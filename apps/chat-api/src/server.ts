import "./no-subprocess.ts"; // first: enforce the "no subprocess" runtime rule
import { canvasTool, getCanvas, listCanvases, MAX_STATE, putState } from "./canvas.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join, relative } from "node:path";
import { config } from "./config.ts";
import { openLedger } from "./usage.ts";
import { EFFORTS, modelChoices, runTurn, type Effort, type McpServer } from "./agent.ts";
import { insideWorkspace } from "./tools.ts";
import { openStore } from "./store.ts";
import { retrieve, clearCore, coreEntries, corePrompt, editCore, memoryTools, sessionSearchTool, TARGETS, type Target } from "./memory.ts";
import { FactGraph, graphTools } from "./graph-memory.ts";
import { beforeLastUserMessage, entriesToView } from "./conversation-view.ts";
import { companySkills } from "./skills-catalog.ts";
import { deletePrefix, objectStore } from "./workspace.ts";
import { curate } from "./curator.ts";
import { isSourceTool, planTool, showUiTool, SourceList } from "./ui-tools.ts";
import { AguiRun, resultText, type ResumeEntry } from "./agui.ts";
import { askUserTool, Gate, resumeMessage, stripHidden, withHidden } from "./approvals.ts";
import { callMcpTool } from "./mcp-call.ts";
import { browse, exportedOf, importFiles, saveToOneDrive, type View } from "./m365.ts";
import { attachToConversation, deleteLibraryFile, libraryTools, listLibrary } from "./library.ts";
import { deleteSkill, listSkills, materializeSkills, skillTools } from "./skills-memory.ts";
import { authorizeRedirect, completeAuthorization, connectedServers, disconnect, listFor } from "./connectors.ts";
import { addProjectFile, deleteProjectFile, deleteProjectFiles, LIMITS as PROJECT_LIMITS, listProjectFiles, openProjects, PROJECT_ID, projectPrefix, projectPrompt } from "./projects.ts";
import { copyOutputs, deleteShareFiles, expired, newShareId, openShares, SHARE_DAYS, SHARE_ID, sharePrefix, summaryOf, viewOf, type Share } from "./shares.ts";
import { listFiles, openTurn, readFileFromStore, userVisible, workspacePath, writeFileToStore } from "./workspace.ts";

const store = await openStore(config.mongoUrl);
const ledger = await openLedger(config.mongoUrl);
const projects = await openProjects(config.mongoUrl);
const shares = await openShares(config.mongoUrl);

/** Deleting a conversation also deletes its share links and their file copies. */
async function removeShares(user: string, conversation: string) {
	for (const sid of await shares.removeOfConversation(user, conversation)) await deleteShareFiles(sid);
}
const ID = /^[a-zA-Z0-9-]{8,64}$/;

/** Identity: in the cluster the gateway authenticates (Entra OIDC) and forwards the user. */
function userOf(req: IncomingMessage): string {
	const u = (req.headers["x-user-oid"] as string | undefined) ?? config.devUser;
	if (!u || !ID.test(u)) throw Object.assign(new Error("unauthenticated"), { status: 401 });
	return u;
}

async function mcpServersFor(user: string): Promise<McpServer[]> {
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

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const c of req) {
		size += c.length;
		if (size > limit) throw Object.assign(new Error("payload too large"), { status: 413 });
		chunks.push(c);
	}
	return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, data: unknown) {
	res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
}

/** First words of the first message, cut at a word boundary. */
function titleOf(message: string): string {
	const t = message.replace(/\s+/g, " ").replace(/\(arquivos anexados:[^)]*\)/, "").trim() || "Nova conversa";
	if (t.length <= 60) return t;
	const cut = t.slice(0, 60);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 30)).replace(/[,.;:]$/, "")}…`;
}

/** Retrieved memory for this turn; tells the portal what was used ("memória usada" chip). */
async function memoryContext(user: string, message: string, id: string, facts: FactGraph | undefined, used: (v: unknown) => void): Promise<string> {
	const [{ prompt, used: u }, core] = await Promise.all([retrieve(user, message, id, store, facts), coreEntries(user).catch(() => ({ user: [], memory: [] }))]);
	u.core = core.user.length + core.memory.length;
	if (u.core || u.facts.length || u.conversations.length) used(u);
	return prompt;
}

/** AG-UI RunAgentInput (the portal) or the original { conversationId, message } shape. */
type ChatInput = {
	threadId?: string;
	runId?: string;
	messages?: { id?: string; role: string; content: unknown }[];
	forwardedProps?: { skills?: string[]; edit?: boolean; model?: string; effort?: Effort; projectId?: string };
	resume?: ResumeEntry[];
	conversationId?: string;
	message?: string;
	skills?: string[];
	edit?: boolean;
};

const lastUserText = (msgs: ChatInput["messages"]): string | undefined => {
	const m = [...(msgs ?? [])].reverse().find((x) => x.role === "user");
	if (!m) return undefined;
	return typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content as { type?: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text).join("\n") : undefined;
};

async function chat(req: IncomingMessage, res: ServerResponse, user: string) {
	const input = JSON.parse((await body(req, 1_000_000)).toString()) as ChatInput;
	const id = input.threadId ?? input.conversationId ?? randomUUID();
	const skills = input.forwardedProps?.skills ?? input.skills;
	const edit = input.forwardedProps?.edit ?? input.edit ?? false;
	if (!ID.test(id)) return json(res, 400, { error: "bad request" });
	// Project (H71): a conversation keeps the project it was created in or moved to; a new one takes
	// the project the portal was showing. Its files are mounted read-only under project/.
	const before = await store.get(user, id);
	const wanted = before ? before.projectId : input.forwardedProps?.projectId;
	const project = wanted && PROJECT_ID.test(wanted) ? await projects.get(user, wanted) : undefined;
	const projectFiles = project ? await listProjectFiles(user, project.id) : [];
	// Lease + fresh workspace from Blob; 409 before streaming when another turn holds it.
	const turn = await openTurn(user, id, project ? [{ prefix: projectPrefix(user, project.id), as: "project" }] : []);
	const memoryOn = config.memory.enabled && !!config.connectors.masterKey;
	const facts = memoryOn ? new FactGraph(user, id) : undefined;
	const mySkills = memoryOn ? await materializeSkills(user) : undefined;
	let finished = false;
	try {
		const existing = await store.get(user, id);
		// A resume answers the interrupts saved with the conversation (any replica can serve it).
		let message = input.message ?? lastUserText(input.messages);
		const gate = new Gate();
		let resumed: ReturnType<typeof resumeMessage> | undefined;
		if (input.resume?.length) {
			resumed = resumeMessage(existing?.pending ?? [], input.resume);
			message = resumed.message;
		}
		if (!message) return json(res, 400, { error: "bad request: no user message" });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const run = new AguiRun((e) => res.write(`data: ${JSON.stringify(e)}\n\n`), id, input.runId as string | undefined);
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
			}
			else if (e.type === "error") run.custom("model_error", { message: e.message });
		};
		const abort = new AbortController();
		res.on("close", () => abort.abort());
		run.started();
		try {
			// Approved actions run here, exactly as approved; the model only reports the outcome.
			if (resumed) {
				const hidden = [...resumed.hidden];
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
				message = withHidden(message, hidden);
			}
			const canvas = canvasTool(turn.dir, (c) => run.custom("canvas", c));
			const projectAppend = project ? projectPrompt(project, projectFiles) : "";
			const uiTools = [planTool((steps) => run.activity(`plan-${run.runId}`, "plan", { steps })), showUiTool((s) => run.activity(`a2ui-${s.surfaceId}`, "a2ui-surface", { surfaceId: s.surfaceId, title: s.title, a2ui_operations: s.messages }))];
			const result = await runTurn({
				workspace: turn.dir,
				// edit/regenerate: replay from before the last user message (the old answer is replaced).
				entries: edit ? beforeLastUserMessage(existing?.entries ?? []) : (existing?.entries ?? []),
				message,
				pinnedSkills: skills,
				model: input.forwardedProps?.model,
				effort: input.forwardedProps?.effort,
				mcpServers: await mcpServersFor(user),
				gate,
				...(memoryOn && facts
					? { systemAppend: projectAppend + (await corePrompt(user)) + (await memoryContext(user, message, id, facts, (v) => run.custom("memory_used", v))), extraTools: [...memoryTools(user), ...graphTools(facts), ...skillTools(user, id), sessionSearchTool(user, id, store), ...libraryTools(user, turn.dir, store), askUserTool(), canvas, ...uiTools], userSkillsDir: mySkills?.dir }
					: { systemAppend: projectAppend || undefined, extraTools: [sessionSearchTool(user, id, store), ...libraryTools(user, turn.dir, store), askUserTool(), canvas, ...uiTools] }),
				onEvent,
				signal: abort.signal,
			});
			if (gate.tripped && !result.text.trim()) {
				// The breaker stopped a looping model before it wrote anything: tell the user plainly.
				run.text("Não consegui concluir: entrei em repetição ao usar as ferramentas e parei para não fazer nada errado. Tente de novo; se repetir, descreva o pedido em outras palavras.");
			}
			const files = await turn.finish();
			finished = true;
			let summary = existing?.summary;
			const userWords = stripHidden(message);
			// The answer is already on screen; the curator runs before RUN_FINISHED so the panel refreshes.
			if (memoryOn && config.memory.curator && config.memory.curatorMode === "inline") {
				const cur = await curate({ user, userMessage: userWords, assistantReply: result.text, alreadySaved: savedByAgent, previousSummary: existing?.summary }, facts).catch((e) => {
					console.warn(`[curator] ${(e as Error).message}`);
					return { saved: [] as string[], summary: undefined };
				});
				summary = cur.summary ?? summary;
				if (cur.saved.length) run.custom("memory_saved", cur.saved);
			}
			// Cost (H58): recorded before saving the conversation, so a save conflict does not lose it.
			await ledger.add(user, id, result.usage).catch((e) => console.warn(`[usage] ${(e as Error).message}`));
			const [convSpend, monthSpend] = await Promise.all([ledger.conversation(user, id), ledger.month(user)]).catch(() => [undefined, undefined]);
			if (convSpend && monthSpend) run.custom("usage", { turn: { usd: result.usage.usd, brl: result.usage.usd * config.usdBrl, model: result.usage.model, input: result.usage.input + result.usage.cacheRead, output: result.usage.output }, conversation: convSpend, month: monthSpend });
			await store.save({
				id,
				user,
				title: existing?.title ?? titleOf(userWords),
				entries: result.entries,
				updatedAt: new Date(),
				summary,
				curatedAt: existing?.curatedAt,
				pending: gate.interrupts.length ? gate.interrupts : undefined,
				version: existing?.version,
				projectId: existing ? existing.projectId : project?.id,
			});
			if (memoryOn && config.memory.curator && config.memory.curatorMode === "async" && !input.resume?.length) {
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
		} catch (e) {
			run.error((e as Error).message);
		}
		res.end();
	} finally {
		// Files the turn already wrote are kept even on error; only a turn that never reached
		// finish() is abandoned (local copy deleted, lease released).
		if (!finished) await turn.finish().catch(() => turn.abandon());
		await facts?.dispose().catch((e) => console.warn(`[graph] dispose: ${(e as Error).message}`));
		await mySkills?.cleanup();
	}
}

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".woff2": "font/woff2",
	".json": "application/json", ".ico": "image/x-icon", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
};
const PUBLIC = new URL("../public/", import.meta.url).pathname;

/** The portal (Vite build in public/): hashed assets cached long, index.html never. */
async function staticFile(res: ServerResponse, pathname: string): Promise<boolean> {
	const rel = pathname === "/" ? "index.html" : pathname.slice(1);
	if (rel.includes("..") || rel.startsWith("api/")) return false;
	const file = join(PUBLIC, rel);
	const data = await readFile(file).catch(() => undefined);
	if (!data) return false;
	const ext = extname(file).toLowerCase();
	res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache" }).end(data);
	return true;
}

async function route(req: IncomingMessage, res: ServerResponse) {
	const url = new URL(req.url ?? "/", "http://x");
	if (url.pathname === "/healthz") return res.writeHead(200).end("ok");
	if (req.method === "GET" && !url.pathname.startsWith("/api/") && (await staticFile(res, url.pathname))) return;
	const user = userOf(req);
	if (url.pathname === "/api/me") return json(res, 200, { user });
	if (url.pathname === "/api/usage" && req.method === "GET") return json(res, 200, { month: await ledger.month(user), usdBrl: config.usdBrl });
	if (url.pathname === "/api/models" && req.method === "GET") return json(res, 200, { models: modelChoices(), default: config.llm.model, efforts: EFFORTS, defaultEffort: "medium" });
	if (url.pathname === "/api/conversations" && req.method === "GET") return json(res, 200, await store.list(user));
	const pj = url.pathname.match(/^\/api\/projects(?:\/([a-f0-9-]{36})(?:\/files\/([^/]+))?)?$/);
	if (pj) return projectRoute(req, res, user, pj[1], pj[2] && decodeURIComponent(pj[2]));
	if (url.pathname === "/api/chat" && req.method === "POST") return chat(req, res, user);
	if (url.pathname === "/api/skills" && req.method === "GET") {
		const mine = config.connectors.masterKey ? await listSkills(user).catch(() => []) : [];
		return json(res, 200, [...(await companySkills()), ...mine.map((s) => ({ name: `my-${s.name}`, label: `Meu: ${s.name.replace(/-/g, " ")}`, description: s.description, personal: true }))]);
	}
	// Bulk delete from the history ("Selecionar" in the sidebar): one request, up to 100 conversations.
	if (url.pathname === "/api/conversations/delete" && req.method === "POST") {
		const { ids } = JSON.parse((await body(req, 20_000)).toString()) as { ids?: unknown };
		if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every((i) => typeof i === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(i)))
			return json(res, 400, { error: "ids: 1 to 100 conversation ids" });
		const deleted: string[] = [];
		for (const id of new Set(ids as string[])) {
			await store.remove(user, id);
			await deletePrefix(user, id);
			await removeShares(user, id);
			deleted.push(id);
		}
		return json(res, 200, { deleted });
	}
	// Canvas: versions and the state the user set in the page (H52).
	const cvs = url.pathname.match(/^\/api\/conversations\/([a-zA-Z0-9-]{8,64})\/canvas(?:\/([a-z0-9][a-z0-9-]{0,47})(\/state)?)?$/);
	if (cvs) {
		const [, id, name, state] = cvs;
		if (!name && req.method === "GET") return json(res, 200, await listCanvases(user, id));
		if (name && !state && req.method === "GET") {
			const c = await getCanvas(user, id, name, Number(url.searchParams.get("v")) || undefined);
			return c ? json(res, 200, c) : json(res, 404, { error: "canvas not found" });
		}
		if (name && state && req.method === "PUT") {
			const raw = await body(req, MAX_STATE + 1000);
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw.toString());
			} catch {
				return json(res, 400, { error: "state must be JSON" });
			}
			await putState(user, id, name, parsed);
			return json(res, 200, { ok: true });
		}
		return json(res, 405, { error: "method not allowed" });
	}
	const sh = url.pathname.match(/^\/api\/conversations\/([a-zA-Z0-9-]{8,64})\/shares$/);
	if (sh) return conversationSharesRoute(req, res, user, sh[1]);
	const sv = url.pathname.match(/^\/api\/shares\/([A-Za-z0-9_-]{22})(?:\/files\/(.+))?$/);
	if (sv) return shareRoute(req, res, user, sv[1], sv[2] && decodeURIComponent(sv[2]));
	const cv = url.pathname.match(/^\/api\/conversations\/([a-zA-Z0-9-]{8,64})(\/feedback)?$/);
	if (cv) {
		const id = cv[1];
		if (cv[2] && req.method === "POST") {
			const { turn, value } = JSON.parse((await body(req, 10_000)).toString()) as { turn?: string; value?: "up" | "down" | null };
			if (!turn || (value !== "up" && value !== "down" && value !== null)) return json(res, 400, { error: "turn and value up|down|null" });
			await store.feedback(user, id, turn, value);
			return json(res, 200, { ok: true });
		}
		if (req.method === "GET") {
			const c = await store.get(user, id);
			if (!c) return json(res, 404, { error: "conversation not found" });
			return json(res, 200, {
				id,
				title: c.title,
				projectId: c.projectId,
				summary: c.summary,
				updatedAt: c.updatedAt,
				messages: entriesToView(c.entries),
				files: userVisible(await listFiles(user, id)),
				feedback: await store.feedbackOf(user, id),
				cost: await ledger.conversation(user, id),
				interrupts: (c.pending ?? []).map(({ id: iid, reason, message, toolCallId, responseSchema, toolName, input, questions }) => ({ id: iid, reason, message, toolCallId, responseSchema, metadata: { toolName, input, questions } })),
			});
		}
		if (req.method === "PATCH") {
			const { title, projectId } = JSON.parse((await body(req, 10_000)).toString()) as { title?: string; projectId?: string | null };
			if (projectId !== undefined) {
				if (projectId !== null && !(PROJECT_ID.test(projectId) && (await projects.get(user, projectId)))) return json(res, 404, { error: "project not found" });
				return json(res, (await store.move(user, id, projectId)) ? 200 : 404, { ok: true });
			}
			if (!title?.trim()) return json(res, 400, { error: "title" });
			return json(res, (await store.rename(user, id, title.trim().slice(0, 120))) ? 200 : 404, { ok: true });
		}
		if (req.method === "DELETE") {
			await store.remove(user, id);
			await deletePrefix(user, id);
			await removeShares(user, id);
			return json(res, 200, { ok: true });
		}
	}

	if (url.pathname === "/api/files" && req.method === "GET") return json(res, 200, await listLibrary(user, store, url.searchParams.get("q") ?? undefined));
	if (url.pathname === "/api/files" && req.method === "DELETE") {
		await deleteLibraryFile(user, url.searchParams.get("id") ?? "");
		return json(res, 200, { ok: true });
	}
	if (url.pathname === "/api/memory") return memoryRoute(req, res, user, url);
	if (url.pathname === "/api/memory/skills" && req.method === "GET")
		return json(res, 200, config.connectors.masterKey ? (await listSkills(user)).map(({ name, description, src, updatedAt }) => ({ name, description, src, updatedAt })) : []);
	const sk = url.pathname.match(/^\/api\/memory\/skills\/([a-z0-9-]{3,40})$/);
	if (sk && req.method === "DELETE") return json(res, 200, { deleted: await deleteSkill(user, sk[1]) });
	const gm = url.pathname.match(/^\/api\/memory\/graph(?:\/([a-f0-9-]{8}))?$/);
	if (gm) return graphRoute(req, res, user, gm[1]);

	const k = url.pathname.match(/^\/api\/connectors(?:\/([a-z0-9-]+)\/(connect|callback))?(?:\/([a-z0-9-]+))?$/);
	if (k) return connectorRoute(req, res, user, url, k);

	if (url.pathname === "/api/m365/browse" && req.method === "GET") {
		const view = (url.searchParams.get("view") ?? "recent") as View;
		if (!["recent", "mine", "shared", "folder", "search"].includes(view)) return json(res, 400, { error: "view" });
		return json(res, 200, await browse(user, view, { driveId: url.searchParams.get("driveId") ?? undefined, id: url.searchParams.get("id") ?? undefined, q: url.searchParams.get("q") ?? undefined }));
	}
	const od = url.pathname.match(/^\/api\/conversations\/([a-zA-Z0-9-]{8,64})\/onedrive$/);
	if (od && req.method === "GET") return json(res, 200, await exportedOf(user, od[1]));
	if (od && req.method === "POST") {
		const { path, again } = JSON.parse((await body(req, 10_000)).toString()) as { path?: string; again?: boolean };
		try {
			return json(res, 200, await saveToOneDrive(user, od[1], path ?? "", { again }));
		} catch (e) {
			const err = e as Error & { status?: number; code?: string };
			return json(res, err.status ?? 500, { error: err.message, code: err.code ?? (err.status === 412 ? "connect" : undefined) });
		}
	}
	const imp = url.pathname.match(/^\/api\/conversations\/([a-zA-Z0-9-]{8,64})\/import$/);
	if (imp && req.method === "POST") {
		const { items } = JSON.parse((await body(req, 20_000)).toString()) as { items?: { driveId: string; id: string; name: string }[] };
		return json(res, 201, { paths: await importFiles(user, imp[1], items ?? []) });
	}
	const at = url.pathname.match(/^\/api\/conversations\/([a-zA-Z0-9-]{8,64})\/attach$/);
	if (at && req.method === "POST") {
		const { file_id } = JSON.parse((await body(req, 10_000)).toString()) as { file_id?: string };
		return json(res, 201, { path: await attachToConversation(user, file_id ?? "", at[1]) });
	}
	const m = url.pathname.match(/^\/api\/conversations\/([^/]+)\/(files|uploads)(?:\/(.+))?$/);
	if (m && ID.test(m[1])) {
		const workspace = workspacePath(user, m[1]);
		if (m[2] === "files" && !m[3]) return json(res, 200, userVisible(await listFiles(user, m[1])));
		if (m[2] === "files" && req.method === "GET") {
			// Validates the path (no ../ into another prefix), then reads straight from Blob.
			const rel = relative(workspace, insideWorkspace(workspace, decodeURIComponent(m[3])));
			const name = rel.split("/").pop()!.replace(/["\r\n]/g, "_");
			const data = await readFileFromStore(user, m[1], rel);
			// ?inline=1: previews in the portal (images, HTML in a sandboxed frame, text); default: download.
			if (url.searchParams.get("inline") === "1")
				return res.writeHead(200, { "content-type": TYPES[extname(name).toLowerCase()] ?? "application/octet-stream", "content-disposition": "inline", "x-content-type-options": "nosniff" }).end(data);
			return res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"` }).end(data);
		}
		if (m[2] === "uploads" && req.method === "POST" && m[3]) {
			const name = decodeURIComponent(m[3]).replace(/[^\w.\- ]/g, "_");
			if (!name || name.startsWith(".")) return json(res, 400, { error: "bad file name" });
			await writeFileToStore(user, m[1], `uploads/${name}`, await body(req, 100 * 1024 * 1024));
			return json(res, 201, { path: `uploads/${name}` });
		}
	}
	json(res, 404, { error: "not found" });
}

/** Share links of one conversation (H72): the owner lists them and creates one. */
async function conversationSharesRoute(req: IncomingMessage, res: ServerResponse, user: string, id: string) {
	if (req.method === "GET") return json(res, 200, (await shares.ofConversation(user, id)).map(summaryOf));
	if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
	const { canvas: canvasName, days } = JSON.parse((await body(req, 10_000)).toString() || "{}") as { canvas?: string; days?: number };
	const c = await store.get(user, id);
	if (!c) return json(res, 404, { error: "conversation not found" });
	const life = SHARE_DAYS.includes(days as never) ? (days as number) : 30;
	const sid = newShareId();
	const now = new Date();
	const base = { id: sid, user, conversation: id, createdAt: now, expiresAt: new Date(+now + life * 86_400_000) };
	let share: Share;
	if (canvasName) {
		if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(canvasName)) return json(res, 400, { error: "canvas" });
		const doc = await getCanvas(user, id, canvasName);
		if (!doc) return json(res, 404, { error: "canvas not found" });
		share = { ...base, kind: "canvas", title: doc.title, canvas: { name: doc.name, title: doc.title, version: doc.version, html: doc.html, state: doc.state } };
	} else {
		const { files, skipped } = await copyOutputs(user, id, sid);
		share = { ...base, kind: "conversation", title: c.title, messages: entriesToView(c.entries), files, ...(skipped ? { skipped } : {}) };
	}
	await shares.put(share);
	console.log(`[share] created ${share.kind} ${sid} (${life} days)`);
	return json(res, 201, summaryOf(share));
}

/** A share link: any signed-in user of the tenant reads it; only the owner revokes it. */
async function shareRoute(req: IncomingMessage, res: ServerResponse, user: string, sid: string, file?: string) {
	const s = await shares.get(sid);
	if (req.method === "DELETE" && !file) {
		if (!s || s.user !== user) return json(res, 404, { error: "share not found" });
		await shares.remove(user, sid);
		await deleteShareFiles(sid);
		console.log(`[share] revoked ${sid}`);
		return json(res, 200, { ok: true });
	}
	if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
	if (!s || expired(s)) return json(res, 404, { error: "link not found, expired or revoked" });
	if (file) {
		if (!s.files?.some((f) => f.path === file)) return json(res, 404, { error: "file not in this share" });
		const data = await objectStore().get(sharePrefix(sid) + file);
		if (!data) return json(res, 410, { error: "file no longer available" });
		const name = file.split("/").pop()!.replace(/["\r\n]/g, "_");
		if (inlineRequested(req)) return res.writeHead(200, { "content-type": TYPES[extname(name).toLowerCase()] ?? "application/octet-stream", "content-disposition": "inline", "x-content-type-options": "nosniff" }).end(data);
		return res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"` }).end(data);
	}
	// Who opened what, for the audit trail (the viewer is the signed-in user).
	console.log(`[share] ${sid} viewed by ${s.user === user ? "owner" : user}`);
	return json(res, 200, { ...viewOf(s), mine: s.user === user });
}

const inlineRequested = (req: IncomingMessage) => new URL(req.url ?? "/", "http://x").searchParams.get("inline") === "1";

/** Projects (H71): list, create, edit, delete, and their reference files. */
async function projectRoute(req: IncomingMessage, res: ServerResponse, user: string, id?: string, file?: string) {
	if (!id) {
		if (req.method === "GET") return json(res, 200, await projects.list(user));
		if (req.method === "POST") {
			const { name, instructions } = JSON.parse((await body(req, 20_000)).toString()) as { name?: string; instructions?: string };
			if (!name?.trim()) return json(res, 400, { error: "name" });
			return json(res, 201, await projects.create(user, { name, instructions: typeof instructions === "string" ? instructions : "" }));
		}
		return json(res, 405, { error: "method not allowed" });
	}
	const p = await projects.get(user, id);
	if (!p) return json(res, 404, { error: "project not found" });
	if (file) {
		if (req.method === "POST") return json(res, 201, { name: await addProjectFile(user, id, file, await body(req, PROJECT_LIMITS.fileBytes + 1)) });
		if (req.method === "DELETE") {
			await deleteProjectFile(user, id, file);
			return json(res, 200, { ok: true });
		}
		return json(res, 405, { error: "method not allowed" });
	}
	if (req.method === "GET") return json(res, 200, { ...p, files: await listProjectFiles(user, id), limits: PROJECT_LIMITS });
	if (req.method === "PATCH") {
		const { name, instructions } = JSON.parse((await body(req, 20_000)).toString()) as { name?: string; instructions?: string };
		if (name !== undefined && !String(name).trim()) return json(res, 400, { error: "name" });
		return json(res, 200, await projects.update(user, id, { name: name === undefined ? undefined : String(name), instructions: instructions === undefined ? undefined : String(instructions) }));
	}
	if (req.method === "DELETE") {
		// Conversations stay (without a project); the project's own files go.
		await store.detachProject(user, id);
		await deleteProjectFiles(user, id);
		await projects.remove(user, id);
		return json(res, 200, { ok: true });
	}
	json(res, 405, { error: "method not allowed" });
}

/** The user sees and edits what the agent remembers (Memória panel). */
async function memoryRoute(req: IncomingMessage, res: ServerResponse, user: string, url: URL) {
	if (req.method === "GET") return json(res, 200, await coreEntries(user));
	if (req.method === "DELETE") {
		const target = url.searchParams.get("target") as Target | null;
		const text = url.searchParams.get("text");
		if (!target && !text) await clearCore(user);
		else if (target && target in TARGETS && text) await editCore(user, target, { action: "remove", old_text: text });
		else return json(res, 400, { error: "target and text, or nothing to clear all" });
		return json(res, 200, await coreEntries(user));
	}
	json(res, 405, { error: "method not allowed" });
}

/** Memory graph in the panel: overview, and "forget" for one fact. */
async function graphRoute(req: IncomingMessage, res: ServerResponse, user: string, factId?: string) {
	if (!config.connectors.masterKey) return json(res, 200, { entities: 0, facts: 0, recent: [] });
	const g = new FactGraph(user, "memory-panel");
	try {
		if (req.method === "GET" && !factId) return json(res, 200, await g.overview(100));
		if (req.method === "DELETE" && factId) {
			await g.forget(factId, "removed in the Memória panel");
			return json(res, 200, await g.overview(100));
		}
		json(res, 405, { error: "method not allowed" });
	} finally {
		await g.dispose();
	}
}

async function connectorRoute(req: IncomingMessage, res: ServerResponse, user: string, url: URL, k: RegExpMatchArray) {
	const [, id, step, single] = k;
	if (!id && !single && req.method === "GET") return json(res, 200, await listFor(user));
	if (single && req.method === "DELETE") {
		await disconnect(user, single);
		return json(res, 200, { ok: true });
	}
	if (id && step === "connect" && req.method === "GET") return res.writeHead(302, { location: authorizeRedirect(user, id) }).end();
	if (id && step === "callback" && req.method === "GET") {
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state") ?? "";
		let status = "ok";
		if (!code) {
			const desc = (url.searchParams.get("error_description") ?? "").split(/\r?\n/)[0].slice(0, 300);
			console.warn(`[connectors] ${id} authorize error: ${url.searchParams.get("error")} ${desc}`);
			status = [url.searchParams.get("error") ?? "denied", desc].filter(Boolean).join(": ");
		}
		else
			await completeAuthorization(user, id, code, state).catch((e) => {
				console.warn(`[connectors] ${id} callback: ${(e as Error).message}`);
				status = `error: ${(e as Error).message.split(/ Trace ID:|\r?\n/)[0].slice(0, 200)}`;
			});
		return res.writeHead(302, { location: `/?connector=${id}&status=${encodeURIComponent(status)}` }).end();
	}
	json(res, 404, { error: "not found" });
}

createServer((req, res) => {
	route(req, res).catch((e) => {
		const status = (e as { status?: number }).status ?? 500;
		if (status === 500) console.error(e);
		if (!res.headersSent) json(res, status, { error: (e as Error).message });
		else res.end();
	});
}).listen(config.port, () => console.log(`chat-api listening on :${config.port}`));
