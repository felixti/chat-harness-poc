import "./no-subprocess.ts"; // first: enforce the "no subprocess" runtime rule
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import { config } from "./config.ts";
import { runTurn, type McpServer } from "./agent.ts";
import { insideWorkspace } from "./tools.ts";
import { openStore } from "./store.ts";
import { retrievedPrompt, clearCore, coreEntries, corePrompt, editCore, memoryTools, sessionSearchTool, TARGETS, type Target } from "./memory.ts";
import { FactGraph, graphTools } from "./graph-memory.ts";
import { curate } from "./curator.ts";
import { attachToConversation, deleteLibraryFile, libraryTools, listLibrary } from "./library.ts";
import { deleteSkill, listSkills, materializeSkills, skillTools } from "./skills-memory.ts";
import { authorizeRedirect, completeAuthorization, connectedServers, disconnect, listFor } from "./connectors.ts";
import { listFiles, openTurn, readFileFromStore, userVisible, workspacePath, writeFileToStore } from "./workspace.ts";

const store = await openStore(config.mongoUrl);
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

async function chat(req: IncomingMessage, res: ServerResponse, user: string) {
	const input = JSON.parse((await body(req, 1_000_000)).toString()) as { conversationId?: string; message: string; skills?: string[] };
	const id = input.conversationId ?? randomUUID();
	if (!ID.test(id) || !input.message) return json(res, 400, { error: "bad request" });
	// Lease + fresh workspace from Blob; 409 before streaming when another turn holds it.
	const turn = await openTurn(user, id);
	const memoryOn = config.memory.enabled && !!config.connectors.masterKey;
	const facts = memoryOn ? new FactGraph(user, id) : undefined;
	const mySkills = memoryOn ? await materializeSkills(user) : undefined;
	let finished = false;
	try {
		const existing = await store.get(user, id);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
		const savedByAgent: string[] = [];
		const onEvent = (e: { type: string; [k: string]: unknown }) => {
			if (e.type === "tool" && (e.name === "memory" || e.name === "remember")) savedByAgent.push(JSON.stringify(e.args));
			send(e);
		};
		const abort = new AbortController();
		res.on("close", () => abort.abort());
		send({ type: "start", conversationId: id });
		try {
			const result = await runTurn({
				workspace: turn.dir,
				entries: existing?.entries ?? [],
				message: input.message,
				pinnedSkills: input.skills,
				mcpServers: await mcpServersFor(user),
				...(memoryOn && facts
					? { systemAppend: (await corePrompt(user)) + (await retrievedPrompt(user, input.message, id, store, facts)), extraTools: [...memoryTools(user), ...graphTools(facts), ...skillTools(user, id), sessionSearchTool(user, id, store), ...libraryTools(user, turn.dir, store)], userSkillsDir: mySkills?.dir }
					: { extraTools: [sessionSearchTool(user, id, store), ...libraryTools(user, turn.dir, store)] }),
				onEvent,
				signal: abort.signal,
			});
			const files = await turn.finish();
			finished = true;
			let summary = existing?.summary;
			// The answer is already on screen; the curator runs before "done" so the panel refreshes.
			if (memoryOn && config.memory.curator) {
				if (abort.signal.aborted) console.log("[curator] skipped: client disconnected");
				const cur = await curate({ user, userMessage: input.message, assistantReply: result.text, alreadySaved: savedByAgent, previousSummary: existing?.summary }, facts).catch((e) => {
					console.warn(`[curator] ${(e as Error).message}`);
					return { saved: [] as string[], summary: undefined };
				});
				summary = cur.summary ?? summary;
				if (cur.saved.length) send({ type: "memory", saved: cur.saved });
				console.log(`[curator] saved ${cur.saved.length}${cur.summary ? ", summary updated" : ""}`);
			}
			await store.save({ id, user, title: existing?.title ?? input.message.slice(0, 60), entries: result.entries, updatedAt: new Date(), summary, version: existing?.version });
			send({ type: "done", conversationId: id, files: userVisible(files) });
		} catch (e) {
			send({ type: "error", message: (e as Error).message });
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

async function route(req: IncomingMessage, res: ServerResponse) {
	const url = new URL(req.url ?? "/", "http://x");
	if (url.pathname === "/healthz") return res.writeHead(200).end("ok");
	if (url.pathname === "/" || url.pathname === "/index.html") {
		const html = await readFile(new URL("../public/index.html", import.meta.url));
		return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
	}
	const user = userOf(req);
	if (url.pathname === "/api/me") return json(res, 200, { user });
	if (url.pathname === "/api/conversations" && req.method === "GET") return json(res, 200, await store.list(user));
	if (url.pathname === "/api/chat" && req.method === "POST") return chat(req, res, user);

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
		if (!code) status = url.searchParams.get("error") ?? "denied";
		else
			await completeAuthorization(user, id, code, state).catch((e) => {
				console.warn(`[connectors] ${id} callback: ${(e as Error).message}`);
				status = "error";
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
