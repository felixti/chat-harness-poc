// Connectors: per-user OAuth to remote MCP servers (GitHub first).
// Tokens never touch the conversation workspace (the agent can read that). They are sealed with
// AES-256-GCM under a master key from Key Vault and stored in a separate Blob container,
// chat-credentials/<user>/<connector>.json, that only chat-api's code reads; the agent only ever
// sees the MCP tools, the token goes in the MCP request header.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WorkloadIdentityCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { config } from "./config.ts";
import type { McpServer } from "./agent.ts";

export interface Connector {
	id: string;
	name: string;
	description: string;
	/** Shown in the connectors panel. */
	summary: string;
	authorizeUrl: string;
	tokenUrl: string;
	scopes: string[];
	clientId: string;
	clientSecret: string;
	/** Remote MCP server the token unlocks; absent for connectors used only by chat-api itself
	 *  (e.g. Microsoft files: the portal's picker and import call Graph server-side). */
	mcpUrl?: string;
	/** Extra MCP headers (e.g. read-only mode). */
	mcpHeaders?: Record<string, string>;
	/** Provider-specific authorize parameters (e.g. GitHub's allow_signup). */
	authParams?: Record<string, string>;
	/** Account label for the panel ("@login"); called once after connecting. */
	account(token: string): Promise<string>;
}

export interface Credential {
	accessToken: string;
	/** Short-lived tokens (Microsoft: 1 h) come with a refresh token; GitHub OAuth App tokens do not. */
	refreshToken?: string;
	expiresAt?: number;
	account: string;
	scopes: string;
	connectedAt: string;
}

export function connectors(): Connector[] {
	const out: Connector[] = [];
	const gh = config.connectors.github;
	if (gh.clientId && gh.clientSecret)
		out.push({
			id: "github",
			name: "GitHub",
			summary: "Repositórios, issues, pull requests, código e Actions.",
			description: "GitHub as the signed-in user: repositories, issues, pull requests, code search, Actions runs.",
			authorizeUrl: "https://github.com/login/oauth/authorize",
			tokenUrl: "https://github.com/login/oauth/access_token",
			scopes: ["repo", "read:org", "read:user"],
			clientId: gh.clientId,
			clientSecret: gh.clientSecret,
			mcpUrl: "https://api.githubcopilot.com/mcp/",
			authParams: { allow_signup: "false" },
			// Read-only until write access is a deliberate decision (prompt injection could open PRs).
			mcpHeaders: gh.readOnly ? { "X-MCP-Readonly": "true" } : undefined,
			async account(token) {
				const r = await fetch("https://api.github.com/user", {
					headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "chat-harness" },
				});
				const u = (await r.json().catch(() => ({}))) as { login?: string };
				return u.login ? `@${u.login}` : "";
			},
		});
	const ado = config.connectors.azuredevops;
	if (ado.clientId && ado.clientSecret && ado.tenant && ado.organization) {
		const api = "api://2a72489c-aab2-4b65-b93a-a91edccf33b8"; // the "Azure DevOps MCP" resource
		out.push({
			id: "azuredevops",
			name: "Azure DevOps",
			summary: `Work items, repositórios, pull requests, pipelines e wiki da organização ${ado.organization}.`,
			description: `Azure DevOps organization ${ado.organization} as the signed-in user: work items and queries, repos and pull requests, pipelines and builds, wiki, iterations, test plans.`,
			authorizeUrl: `https://login.microsoftonline.com/${ado.tenant}/oauth2/v2.0/authorize`,
			tokenUrl: `https://login.microsoftonline.com/${ado.tenant}/oauth2/v2.0/token`,
			// Read always; write only when enabled, and every write call then waits for the user's
			// approval (approvals.ts). No *.manage scopes: administrative actions stay out of the chat.
			scopes: [
				...["Ado.Mcp.Tools", "repos.read", "wit.read", "pipelines.read", "wiki.read", "work.read", "testplan.read"].map((x) => `${api}/${x}`),
				...(ado.readOnly ? [] : ["repos.write", "wit.write", "pipelines.write", "wiki.write", "work.write", "testplan.write"].map((x) => `${api}/${x}`)),
				"offline_access",
			],
			authParams: { response_type: "code", response_mode: "query" },
			clientId: ado.clientId,
			clientSecret: ado.clientSecret,
			mcpUrl: `https://mcp.dev.azure.com/${encodeURIComponent(ado.organization)}`,
			mcpHeaders: { "X-MCP-Toolsets": ado.toolsets, ...(ado.readOnly ? { "X-MCP-Readonly": "true" } : {}) },
			// The token is for the MCP resource (not Graph): the account name comes from its claims.
			async account(token) {
				try {
					const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as { preferred_username?: string; upn?: string; name?: string };
					return claims.preferred_username ?? claims.upn ?? claims.name ?? "";
				} catch {
					return "";
				}
			},
		});
	}
	const ms = config.connectors.microsoft;
	if (ms.clientId && ms.clientSecret)
		out.push({
			id: "microsoft",
			name: "OneDrive e SharePoint",
			summary: "Anexe documentos do seu OneDrive ou do SharePoint direto na conversa.",
			description: "Microsoft OneDrive / SharePoint files of the signed-in user (read-only).",
			// /common: work accounts (company SharePoint/OneDrive) and personal Microsoft accounts.
			authorizeUrl: `https://login.microsoftonline.com/${ms.authority}/oauth2/v2.0/authorize`,
			tokenUrl: `https://login.microsoftonline.com/${ms.authority}/oauth2/v2.0/token`,
			scopes: ms.scopes,
			// Lets the user pick the account (work or personal) instead of reusing the chat's SSO session.
			authParams: { response_type: "code", response_mode: "query", prompt: "select_account" },
			clientId: ms.clientId,
			clientSecret: ms.clientSecret,
			async account(token) {
				const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,mail,displayName", { headers: { authorization: `Bearer ${token}` } });
				const u = (await r.json().catch(() => ({}))) as { mail?: string; userPrincipalName?: string };
				return u.mail ?? u.userPrincipalName ?? "";
			},
		});
	return out;
}

// --- sealing ---------------------------------------------------------------------------------

function masterKey(): Buffer {
	const k = Buffer.from(config.connectors.masterKey, "base64");
	if (k.length !== 32) throw new Error("CONNECTORS_MASTER_KEY must be 32 bytes, base64");
	return k;
}

/** AES-256-GCM; the user and connector are the AAD, so a sealed blob cannot be moved to another user. */
export function seal(plain: object, aad: string, key = masterKey()): string {
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(aad));
	const data = Buffer.concat([c.update(JSON.stringify(plain)), c.final()]);
	return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") });
}

export function unseal<T>(sealed: string, aad: string, key = masterKey()): T {
	const s = JSON.parse(sealed) as { v: number; iv: string; tag: string; data: string };
	const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64")).setAAD(Buffer.from(aad));
	d.setAuthTag(Buffer.from(s.tag, "base64"));
	return JSON.parse(Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]).toString());
}

// --- OAuth state (stateless: signed, bound to the user, 10 minutes) ----------------------------

const b64url = (b: Buffer) => b.toString("base64url");
const hmac = (key: Buffer, s: string) => createHmac("sha256", key).update(s).digest();

export function makeState(user: string, connector: string, key = masterKey(), now = Date.now()): { state: string; verifier: string; challenge: string } {
	const payload = b64url(Buffer.from(JSON.stringify({ u: user, c: connector, n: b64url(randomBytes(16)), e: now + 600_000 })));
	const state = `${payload}.${b64url(hmac(key, `state:${payload}`))}`;
	const verifier = pkceVerifier(state, key);
	return { state, verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/** PKCE verifier derived from the state, so no server-side session is needed. */
function pkceVerifier(state: string, key: Buffer): string {
	return b64url(hmac(key, `pkce:${state}`));
}

/** Checks signature, expiry, user and connector; returns the PKCE verifier. */
export function checkState(state: string, user: string, connector: string, key = masterKey(), now = Date.now()): string {
	const [payload, sig] = state.split(".");
	if (!payload || !sig) throw Object.assign(new Error("bad state"), { status: 400 });
	const want = hmac(key, `state:${payload}`);
	const got = Buffer.from(sig, "base64url");
	if (got.length !== want.length || !timingSafeEqual(got, want)) throw Object.assign(new Error("bad state"), { status: 400 });
	const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as { u: string; c: string; e: number };
	if (p.u !== user || p.c !== connector || p.e < now) throw Object.assign(new Error("expired or foreign state"), { status: 400 });
	return pkceVerifier(state, key);
}

// --- vault ---------------------------------------------------------------------------------------

let container: ContainerClient | undefined;
const memory = new Map<string, string>(); // local dev without Blob

function vault(): ContainerClient | undefined {
	if (!config.blob.accountUrl) return undefined;
	container ??= new BlobServiceClient(config.blob.accountUrl, new WorkloadIdentityCredential()).getContainerClient(config.connectors.container);
	return container;
}

const blobName = (user: string, id: string) => `${user}/${id}.json`;

export async function saveCredential(user: string, id: string, cred: Credential): Promise<void> {
	const sealed = seal(cred, blobName(user, id));
	const c = vault();
	if (!c) return void memory.set(blobName(user, id), sealed);
	await c.getBlockBlobClient(blobName(user, id)).uploadData(Buffer.from(sealed), { blobHTTPHeaders: { blobContentType: "application/json" } });
}

export async function loadCredential(user: string, id: string): Promise<Credential | undefined> {
	const c = vault();
	let sealed: string | undefined;
	if (!c) sealed = memory.get(blobName(user, id));
	else {
		const b = c.getBlockBlobClient(blobName(user, id));
		sealed = await b.downloadToBuffer().then((x) => x.toString(), (e) => (e?.statusCode === 404 ? undefined : Promise.reject(e)));
	}
	return sealed ? unseal<Credential>(sealed, blobName(user, id)) : undefined;
}

export async function deleteCredential(user: string, id: string): Promise<void> {
	const c = vault();
	if (!c) return void memory.delete(blobName(user, id));
	await c.getBlockBlobClient(blobName(user, id)).deleteIfExists();
}

// --- flow ----------------------------------------------------------------------------------------

export function find(id: string): Connector {
	const c = connectors().find((x) => x.id === id);
	if (!c) throw Object.assign(new Error("unknown connector"), { status: 404 });
	return c;
}

const callbackUrl = (id: string) => `${config.publicUrl}/api/connectors/${id}/callback`;

export function authorizeRedirect(user: string, id: string): string {
	const c = find(id);
	const { state, challenge } = makeState(user, id);
	const q = new URLSearchParams({
		client_id: c.clientId,
		redirect_uri: callbackUrl(id),
		scope: c.scopes.join(" "),
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
		...c.authParams,
	});
	return `${c.authorizeUrl}?${q}`;
}

export async function completeAuthorization(user: string, id: string, code: string, state: string): Promise<Credential> {
	const c = find(id);
	const verifier = checkState(state, user, id);
	const r = await fetch(c.tokenUrl, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
		// grant_type and scope: required by the Microsoft identity platform, accepted by GitHub.
		body: new URLSearchParams({ grant_type: "authorization_code", client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: callbackUrl(id), code_verifier: verifier, scope: c.scopes.join(" ") }),
		signal: AbortSignal.timeout(15_000),
	});
	const t = (await r.json().catch(() => ({}))) as TokenResponse;
	if (!r.ok || !t.access_token) throw Object.assign(new Error(`token exchange failed: ${t.error_description ?? r.status}`), { status: 502 });
	const cred: Credential = {
		accessToken: t.access_token,
		...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
		...(t.expires_in ? { expiresAt: Date.now() + t.expires_in * 1000 } : {}),
		account: await c.account(t.access_token).catch(() => ""),
		scopes: t.scope ?? "",
		connectedAt: new Date().toISOString(),
	};
	await saveCredential(user, id, cred);
	return cred;
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	error_description?: string;
}

/** A valid access token for this user and connector, refreshed (and re-sealed) when it expires
 *  within a minute. Undefined when the user never connected; throws when the grant was revoked. */
export async function accessToken(user: string, id: string): Promise<string | undefined> {
	const c = find(id);
	const cred = await loadCredential(user, id);
	if (!cred) return undefined;
	if (!cred.expiresAt || cred.expiresAt - Date.now() > 60_000 || !cred.refreshToken) return cred.accessToken;
	const r = await fetch(c.tokenUrl, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token", refresh_token: cred.refreshToken, scope: c.scopes.join(" ") }),
		signal: AbortSignal.timeout(15_000),
	});
	const t = (await r.json().catch(() => ({}))) as TokenResponse;
	if (!r.ok || !t.access_token) throw Object.assign(new Error(`${c.name}: reconnect needed (${t.error_description?.split("\n")[0] ?? r.status})`), { status: 401 });
	const next: Credential = { ...cred, accessToken: t.access_token, refreshToken: t.refresh_token ?? cred.refreshToken, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
	await saveCredential(user, id, next);
	return next.accessToken;
}

/** Removes the stored token and revokes the grant at the provider (best effort). */
export async function disconnect(user: string, id: string): Promise<void> {
	const c = find(id);
	const cred = await loadCredential(user, id).catch(() => undefined);
	await deleteCredential(user, id);
	if (cred && id === "github")
		await fetch(`https://api.github.com/applications/${c.clientId}/grant`, {
			method: "DELETE",
			headers: {
				authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`,
				accept: "application/vnd.github+json",
				"user-agent": "chat-harness",
			},
			body: JSON.stringify({ access_token: cred.accessToken }),
			signal: AbortSignal.timeout(10_000),
		}).catch(() => undefined);
}

export async function listFor(user: string) {
	return Promise.all(
		connectors().map(async (c) => {
			const cred = await loadCredential(user, c.id).catch(() => undefined);
			return { id: c.id, name: c.name, summary: c.summary, connected: !!cred, account: cred?.account ?? "", connectedAt: cred?.connectedAt ?? "", readOnly: !!c.mcpHeaders?.["X-MCP-Readonly"] };
		}),
	);
}

/** MCP servers of the connectors this user connected, with the token in the header. */
export async function connectedServers(user: string): Promise<McpServer[]> {
	const out: McpServer[] = [];
	for (const c of connectors()) {
		if (!c.mcpUrl) continue;
		const cred = await loadCredential(user, c.id).catch((e) => {
			console.warn(`[connectors] ${c.id}: ${(e as Error).message}`);
			return undefined;
		});
		if (!cred) continue;
		// Short-lived tokens (Entra: ~1 h) are refreshed here, before the turn opens the MCP session.
		const token = await accessToken(user, c.id).catch((e) => {
			console.warn(`[connectors] ${c.id}: ${(e as Error).message}`);
			return undefined;
		});
		if (!token) continue;
		out.push({
			name: c.id,
			url: c.mcpUrl,
			description: `${c.description} Connected as ${cred.account || "the user"}.${c.mcpHeaders?.["X-MCP-Readonly"] ? " Read-only." : " Write actions pause for the user's approval in the chat: call them with complete arguments, then wait."}`,
			headers: { authorization: `Bearer ${token}`, ...c.mcpHeaders },
		});
	}
	return out;
}
