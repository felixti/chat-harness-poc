// All settings come from the environment (12-factor). Secrets never have defaults.
// In the cluster secrets are files under SECRETS_DIR (not env vars, so they are not in
// /proc/self/environ); the env var of the same name is the fallback for local runs.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const secretsDir = env.SECRETS_DIR ?? "/var/run/secrets/chat";

function secret(envName: string, file: string): string {
	try {
		return readFileSync(join(secretsDir, file), "utf8").trim();
	} catch {
		return env[envName] ?? "";
	}
}

/** mongodb://user@host/db plus the password file -> full URL (password URL-encoded). */
function mongoUrl(): string {
	const url = env.MONGO_URL ?? "";
	const pw = secret("DB_PASSWORD", "db-password");
	if (!url || !pw || /:\/\/[^/@]*:[^/@]*@/.test(url)) return url;
	return url.replace(/:\/\/([^/@:]+)@/, (_m, u) => `://${u}:${encodeURIComponent(pw)}@`);
}

export const config = {
	port: Number(env.PORT ?? 8080),
	/** Writable scratch root; the only writable path besides PVCs under the company policy. */
	tmpRoot: env.TMP_ROOT ?? "/tmp/chat",
	/** Skills folder (synced from Blob /skills/ at startup in the cluster). */
	skillsDir: env.SKILLS_DIR ?? new URL("../../../skills", import.meta.url).pathname,
	llm: {
		baseUrl: env.LLM_BASE_URL ?? "http://llm-gateway.envoy-gateway-system.svc/api/v1",
		/** The platform gateway injects the real key; this placeholder never leaves the cluster. */
		apiKey: env.LLM_API_KEY ?? "injected-by-platform-gateway",
		model: env.LLM_MODEL ?? "deepseek/deepseek-v4.1-flash-1017",
		contextWindow: Number(env.LLM_CONTEXT_WINDOW ?? 200000),
		/** Models the user can pick in the portal (H57): "id|label|note" separated by commas. The
		 *  first one that matches LLM_MODEL is the default. */
		models: (env.LLM_MODELS ?? "deepseek/deepseek-v4.1-flash-1017|DeepSeek V4.1 Flash|O mais econômico,anthropic/claude-haiku-5.5|Claude Haiku 5.5|Bom e barato · ~5× o custo,google/gemini-4-hydrogen|Gemini 4 Hydrogen|O mais capaz · ~75× o custo")
			.split(",")
			.map((x) => x.trim().split("|"))
			.filter(([id]) => id)
			.map(([id, label, note]) => ({ id, label: label || id, note: note ?? "" })),
	},
	/** OpenRouter image model for generate_image (through the same gateway). MiniMax H3 at 1K:
	 *  ~US$0.021/image and closer to the theme palette; Gemini Flash Lite Image is the fast fallback. */
	imageModel: env.IMAGE_MODEL ?? "minimax/minimax-h3-image",
	blob: {
		/** e.g. https://stagentpocjt75.blob.core.windows.net ; empty = local-only workspaces */
		accountUrl: env.BLOB_ACCOUNT_URL ?? "",
		container: env.BLOB_CONTAINER ?? "chat-workspaces",
	},
	/** mongodb:// URL (FerretDB in the PoC); empty = in-memory history. */
	mongoUrl: mongoUrl(),
	parserUrl: env.PARSER_URL ?? "",
	/** In-cluster Brave Search MCP (http://brave-mcp/mcp); empty = no web search. */
	braveMcpUrl: env.BRAVE_MCP_URL ?? "",
	context7ApiKey: secret("CONTEXT7_API_KEY", "context7-api-key"),
	/** Public origin of the chat, for OAuth redirect URIs. */
	publicUrl: (env.PUBLIC_URL ?? "http://localhost:8080").replace(/\/$/, ""),
	connectors: {
		/** 32 random bytes, base64, from Key Vault (connectors-master-key). Seals tokens and OAuth state. */
		masterKey: secret("CONNECTORS_MASTER_KEY", "connectors-master-key"),
		/** Separate from the workspaces: the agent never sees this container. */
		container: env.CONNECTORS_CONTAINER ?? "chat-credentials",
		microsoft: {
			clientId: env.MICROSOFT_CLIENT_ID ?? "",
			clientSecret: secret("MICROSOFT_CLIENT_SECRET", "microsoft-client-secret"),
			/** "common" = work and personal accounts; a tenant id restricts to the company. */
			authority: env.MICROSOFT_AUTHORITY ?? "common",
			/** Read what the user can see; write only to the user's own drive (save deliverables).
			 *  Add Sites.Read.All for SharePoint site browsing on work accounts. */
			scopes: (env.MICROSOFT_SCOPES ?? "openid profile offline_access User.Read Files.Read.All Files.ReadWrite").split(/\s+/),
		},
		azuredevops: {
			clientId: env.AZDO_CLIENT_ID ?? "",
			clientSecret: secret("AZDO_CLIENT_SECRET", "azuredevops-client-secret"),
			/** Entra tenant that backs the Azure DevOps organization (single-tenant app). */
			tenant: env.AZDO_TENANT ?? "",
			organization: env.AZDO_ORG ?? "",
			/** Read-only by default (X-MCP-Readonly + read scopes only). */
			readOnly: env.AZDO_MCP_READONLY !== "false",
			toolsets: env.AZDO_MCP_TOOLSETS ?? "repos,wit,pipelines,wiki,work,testplan",
		},
		github: {
			clientId: env.GITHUB_CLIENT_ID ?? "",
			clientSecret: secret("GITHUB_CLIENT_SECRET", "github-client-secret"),
			/** GitHub MCP read-only mode; "false" lets the agent open issues and PRs. */
			readOnly: env.GITHUB_MCP_READONLY !== "false",
		},
	},
	memory: {
		/** Long-term memory (docs/architecture.md §6); sealed per user, the agent only reaches it via tools. */
		container: env.MEMORY_CONTAINER ?? "chat-memory",
		enabled: env.MEMORY_ENABLED !== "false",
		/** Turn-end curator that saves what the user said worth keeping; "false" turns it off. */
		curator: env.MEMORY_CURATOR !== "false",
		/** When the curator runs: "async" (default: right after the answer, the chat never waits; the
		 *  03:00 UTC CronJob retries what it missed), "nightly" (only the CronJob) or
		 *  "inline" (before "done", shows "Guardei na memória"). */
		curatorMode: (env.MEMORY_CURATOR_MODE ?? "async") as "nightly" | "async" | "inline",
	},
	/** Workspace files are deleted after this many days without access (Blob lifecycle rule). */
	retentionDays: Number(env.RETENTION_DAYS ?? 30),
	/** Model for the memory curator (one small JSON call per turn). */
	curatorModel: env.CURATOR_MODEL ?? env.LLM_MODEL ?? "deepseek/deepseek-v4.1-flash-1017",
	/** Dev only: identity when no gateway header is present. */
	devUser: env.DEV_USER ?? "",
};
