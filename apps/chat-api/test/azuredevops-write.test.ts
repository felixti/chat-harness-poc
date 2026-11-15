import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
process.env.CONNECTORS_MASTER_KEY = randomBytes(32).toString("base64");
Object.assign(process.env, { AZDO_CLIENT_ID: "ado-app", AZDO_CLIENT_SECRET: "s", AZDO_TENANT: "tenant-1", AZDO_ORG: "felix-demo", AZDO_MCP_READONLY: "false" });
const { authorizeRedirect, connectors } = await import("../src/connectors.ts");

test("write mode: write scopes, never manage, no read-only header", () => {
	const scopes = (new URL(authorizeRedirect("user-ado-0002", "azuredevops")).searchParams.get("scope") ?? "").split(" ");
	for (const x of ["wit.write", "repos.write", "pipelines.write", "wit.read"]) assert.ok(scopes.some((s) => s.endsWith(`/${x}`)), x);
	assert.ok(!scopes.some((s) => s.endsWith(".manage")));
	const c = connectors().find((x) => x.id === "azuredevops")!;
	assert.equal(c.mcpHeaders?.["X-MCP-Readonly"], undefined);
});
