import "./no-subprocess.ts"; // first: enforce the "no subprocess" runtime rule
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { config } from "./config.ts";
import { runTurn, type McpServer } from "./agent.ts";
import { insideWorkspace } from "./tools.ts";
import { openStore } from "./store.ts";
import { hydrate, listLocal, persistChanges, persistFile, readWorkspaceFile, workspacePath } from "./workspace.ts";

const store = await openStore(config.mongoUrl);
const ID = /^[a-zA-Z0-9-]{8,64}$/;

/** Identity: in the cluster the gateway authenticates (Entra OIDC) and forwards the user. */
function userOf(req: IncomingMessage): string {
	const u = (req.headers["x-user-oid"] as string | undefined) ?? config.devUser;
	if (!u || !ID.test(u)) throw Object.assign(new Error("unauthenticated"), { status: 401 });
	return u;
}

function mcpServersFor(_user: string): McpServer[] {
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
	return servers;
}

async function listFiles(dir: string) {
	return (await listLocal(dir)).map(({ path, size }) => ({ path, size }));
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
	const existing = await store.get(user, id);
	const workspace = await hydrate(user, id);
	const started = Date.now();

	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
	const abort = new AbortController();
	res.on("close", () => abort.abort());
	send({ type: "start", conversationId: id });
	try {
		const result = await runTurn({
			workspace,
			entries: existing?.entries ?? [],
			message: input.message,
			pinnedSkills: input.skills,
			mcpServers: mcpServersFor(user),
			onEvent: send,
			signal: abort.signal,
		});
		await persistChanges(user, id, started);
		await store.save({ id, user, title: existing?.title ?? input.message.slice(0, 60), entries: result.entries, updatedAt: new Date() });
		send({ type: "done", conversationId: id, files: await listFiles(workspace) });
	} catch (e) {
		send({ type: "error", message: (e as Error).message });
	}
	res.end();
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

	const m = url.pathname.match(/^\/api\/conversations\/([^/]+)\/(files|uploads)(?:\/(.+))?$/);
	if (m && ID.test(m[1])) {
		const workspace = workspacePath(user, m[1]);
		if (m[2] === "files" && !m[3]) return json(res, 200, await listFiles(await hydrate(user, m[1])));
		if (m[2] === "files" && req.method === "GET") {
			const rel = decodeURIComponent(m[3]);
			const file = insideWorkspace(workspace, rel);
			const name = file.split("/").pop()!;
			return res
				.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"` })
				.end(await readWorkspaceFile(user, m[1], rel, file));
		}
		if (m[2] === "uploads" && req.method === "POST" && m[3]) {
			const name = decodeURIComponent(m[3]).replace(/[^\w.\- ]/g, "_");
			const target = insideWorkspace(workspace, join("uploads", name));
			await mkdir(join(workspace, "uploads"), { recursive: true });
			await writeFile(target, await body(req, 100 * 1024 * 1024));
			await persistFile(user, m[1], `uploads/${name}`);
			return json(res, 201, { path: `uploads/${name}` });
		}
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
