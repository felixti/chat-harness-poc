// OneDrive/SharePoint import: Graph mocked; tokens refresh; only supported types; no overwrite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.CONNECTORS_MASTER_KEY = randomBytes(32).toString("base64");
process.env.MICROSOFT_CLIENT_ID = "app-id";
process.env.MICROSOFT_CLIENT_SECRET = "s";
const { saveCredential, loadCredential, accessToken } = await import("../src/connectors.ts");
const { browse, importFiles } = await import("../src/m365.ts");
const { FolderStore, setObjectStore, listFiles } = await import("../src/workspace.ts");
setObjectStore(new FolderStore(await mkdtemp(join(tmpdir(), "m365-"))));
const U = "user-m365-0001";

const calls: string[] = [];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
	const url = String(input);
	calls.push(url);
	if (url.includes("/oauth2/v2.0/token")) return Response.json({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 });
	const auth = new Headers(init?.headers).get("authorization");
	if (auth !== "Bearer fresh") return new Response("{}", { status: 401 });
	if (url.includes("/me/drive/recent"))
		return Response.json({ value: [
			{ id: "f1", name: "Vendas Q3.xlsx", size: 10, file: {}, parentReference: { driveId: "d1" }, lastModifiedDateTime: "2026-11-10T10:00:00Z" },
			{ id: "f2", name: "setup.exe", size: 10, file: {}, parentReference: { driveId: "d1" } },
			{ id: "p1", name: "Projetos", folder: {}, parentReference: { driveId: "d1" } },
		] });
	if (url.includes("/content")) return new Response("xlsx-bytes");
	return new Response("{}", { status: 404 });
}) as typeof fetch;

test("an expired token is refreshed and re-sealed", async () => {
	await saveCredential(U, "microsoft", { accessToken: "old", refreshToken: "r1", expiresAt: Date.now() - 1000, account: "x@outlook.com", scopes: "", connectedAt: "" });
	assert.equal(await accessToken(U, "microsoft"), "fresh");
	const c = await loadCredential(U, "microsoft");
	assert.equal(c?.refreshToken, "r2");
	assert.ok((c?.expiresAt ?? 0) > Date.now());
});

test("browse marks unsupported files and lists folders first", async () => {
	const items = await browse(U, "recent");
	assert.deepEqual(items.map((i) => [i.name, i.folder, i.supported]), [["Projetos", true, true], ["Vendas Q3.xlsx", false, true], ["setup.exe", false, false]]);
});

test("import copies into uploads without overwriting; rejects unsupported types and bad ids", async () => {
	assert.deepEqual(await importFiles(U, "conv-m365-01", [{ driveId: "d1", id: "f1", name: "Vendas Q3.xlsx" }]), ["uploads/Vendas Q3.xlsx"]);
	assert.deepEqual(await importFiles(U, "conv-m365-01", [{ driveId: "d1", id: "f1", name: "Vendas Q3.xlsx" }]), ["uploads/Vendas Q3 (2).xlsx"]);
	assert.equal((await listFiles(U, "conv-m365-01")).length, 2);
	await assert.rejects(importFiles(U, "conv-m365-01", [{ driveId: "d1", id: "f2", name: "setup.exe" }]), (e: any) => e.status === 415);
	await assert.rejects(importFiles(U, "conv-m365-01", [{ driveId: "../x", id: "f1", name: "a.pdf" }]), (e: any) => e.status === 400);
});

test("not connected is a 412 the portal turns into a Connect button", async () => {
	await assert.rejects(browse("user-m365-0002", "recent"), (e: any) => e.status === 412);
});

test("the Microsoft authorize URL carries what the v2 endpoint requires", async () => {
	const { authorizeRedirect } = await import("../src/connectors.ts");
	const u = new URL(authorizeRedirect("user-m365-0003", "microsoft"));
	for (const [k, v] of [["response_type", "code"], ["code_challenge_method", "S256"], ["client_id", "app-id"]]) assert.equal(u.searchParams.get(k), v, k);
	assert.match(u.searchParams.get("scope") ?? "", /offline_access/);
	assert.equal(u.searchParams.get("allow_signup"), null);
});
