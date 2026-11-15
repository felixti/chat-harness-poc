// Runs one MCP tool call from chat-api itself (streamable HTTP, JSON-RPC). Used for actions the
// user approved: the exact approved arguments go to the server, with no model in the loop, so
// nothing can drift between the approval card and what executes.
const PROTOCOL = "2025-06-18";

interface Rpc {
	result?: { content?: { type?: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };
	error?: { code?: number; message?: string };
}

async function post(url: string, headers: Record<string, string>, body: unknown, session?: string): Promise<{ rpc?: Rpc; session?: string; status: number }> {
	const r = await fetch(url, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}), "mcp-protocol-version": PROTOCOL },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(120_000),
	});
	const sid = r.headers.get("mcp-session-id") ?? session;
	const text = await r.text();
	if (!text.trim()) return { session: sid ?? undefined, status: r.status };
	// Either a JSON body or an SSE stream whose last "data:" line is the response.
	const data = text.trimStart().startsWith("{") ? text : (text.match(/^data: (.*)$/gm) ?? []).map((l) => l.slice(6)).filter((l) => l.includes('"id"')).pop();
	let rpc: Rpc | undefined;
	try {
		rpc = data ? (JSON.parse(data) as Rpc) : undefined;
	} catch {
		rpc = undefined;
	}
	return { rpc, session: sid ?? undefined, status: r.status };
}

export interface McpCallResult {
	text: string;
	isError: boolean;
}

/** Calls `tool` (the server's own name, without the mcp__server__ prefix) once. */
export async function callMcpTool(server: { url: string; headers?: Record<string, string> }, tool: string, args: unknown): Promise<McpCallResult> {
	const headers = server.headers ?? {};
	const init = await post(server.url, headers, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "chat-harness", version: "1" } } });
	if (init.status >= 400 || init.rpc?.error) return { text: `MCP initialize failed (${init.status}): ${init.rpc?.error?.message ?? ""}`, isError: true };
	await post(server.url, headers, { jsonrpc: "2.0", method: "notifications/initialized" }, init.session);
	const call = await post(server.url, headers, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args ?? {} } }, init.session);
	if (call.status >= 400 || call.rpc?.error) return { text: `MCP call failed (${call.status}): ${call.rpc?.error?.message ?? ""}`, isError: true };
	const text = (call.rpc?.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") || JSON.stringify(call.rpc?.result?.structuredContent ?? {});
	return { text: text.slice(0, 8000), isError: !!call.rpc?.result?.isError };
}
