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
		github: {
			clientId: env.GITHUB_CLIENT_ID ?? "",
			clientSecret: secret("GITHUB_CLIENT_SECRET", "github-client-secret"),
			/** GitHub MCP read-only mode; "false" lets the agent open issues and PRs. */
			readOnly: env.GITHUB_MCP_READONLY !== "false",
		},
	},
	/** Dev only: identity when no gateway header is present. */
	devUser: env.DEV_USER ?? "",
};
