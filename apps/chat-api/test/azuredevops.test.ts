// Azure DevOps connector: Entra OAuth to the "Azure DevOps MCP" resource, read-only headers, refresh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
process.env.CONNECTORS_MASTER_KEY = randomBytes(32).toString("base64");
Object.assign(process.env, { AZDO_CLIENT_ID: "ado-app", AZDO_CLIENT_SECRET: "s", AZDO_TENANT: "tenant-1", AZDO_ORG: "felix-demo" });
const { authorizeRedirect, connectedServers, saveCredential, connectors } = await import("../src/connectors.ts");

test("authorize URL: tenant authority, MCP read scopes, code flow", () => {
	const u = new URL(authorizeRedirect("user-ado-0001", "azuredevops"));
	assert.equal(u.origin + u.pathname, "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/authorize");
	assert.equal(u.searchParams.get("response_type"), "code");
	const scopes = (u.searchParams.get("scope") ?? "").split(" ");
	assert.ok(scopes.includes("api://2a72489c-aab2-4b65-b93a-a91edccf33b8/wit.read"));
	assert.ok(scopes.includes("offline_access"));
	assert.ok(!scopes.some((s) => s.endsWith(".write") || s.endsWith(".manage")));
});

test("account name comes from the token claims", async () => {
	const c = connectors().find((x) => x.id === "azuredevops")!;
	const jwt = `x.${Buffer.from(JSON.stringify({ preferred_username: "felix@contoso.com" })).toString("base64url")}.y`;
	assert.equal(await c.account(jwt), "felix@contoso.com");
});

test("MCP server gets a refreshed token, org URL and read-only headers", async () => {
	await saveCredential("user-ado-0001", "azuredevops", { accessToken: "old", refreshToken: "r1", expiresAt: Date.now() - 1, account: "felix", scopes: "", connectedAt: "" });
	const prev = globalThis.fetch;
	globalThis.fetch = (async () => Response.json({ access_token: "new", refresh_token: "r2", expires_in: 3600 })) as typeof fetch;
	try {
		const [s] = await connectedServers("user-ado-0001");
		assert.equal(s.url, "https://mcp.dev.azure.com/felix-demo");
		assert.equal(s.headers?.authorization, "Bearer new");
		assert.equal(s.headers?.["X-MCP-Readonly"], "true");
		assert.match(s.headers?.["X-MCP-Toolsets"] ?? "", /wit/);
	} finally {
		globalThis.fetch = prev;
	}
});

