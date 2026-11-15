// The approved action is executed by chat-api against the MCP server, with the exact arguments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { callMcpTool } from "../src/mcp-call.ts";

test("calls the tool once over streamable HTTP (SSE and JSON responses), with the session id", async () => {
	const seen: any[] = [];
	const srv = createServer(async (req, res) => {
		let b = "";
		for await (const c of req) b += c;
		const m = JSON.parse(b);
		seen.push({ method: m.method, session: req.headers["mcp-session-id"], auth: req.headers.authorization, params: m.params });
		if (m.method === "initialize") return res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s-1" }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } })}\n\n`);
		if (m.method === "notifications/initialized") return res.writeHead(202).end();
		return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: '{"id":4,"title":"Demo User Story - 2"}' }] } }));
	}).listen(0);
	const port = (srv.address() as { port: number }).port;
	try {
		const r = await callMcpTool({ url: `http://localhost:${port}/mcp`, headers: { authorization: "Bearer t" } }, "wit_work_item_write", { action: "add_child", parentId: 2 });
		assert.deepEqual(r, { text: '{"id":4,"title":"Demo User Story - 2"}', isError: false });
		assert.deepEqual(seen.map((x) => x.method), ["initialize", "notifications/initialized", "tools/call"]);
		assert.deepEqual([seen[1].session, seen[2].session, seen[2].auth], ["s-1", "s-1", "Bearer t"]);
		assert.deepEqual(seen[2].params, { name: "wit_work_item_write", arguments: { action: "add_child", parentId: 2 } });
	} finally {
		srv.close();
	}
});
