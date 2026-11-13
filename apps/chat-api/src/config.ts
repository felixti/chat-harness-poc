// All settings come from the environment (12-factor). Secrets never have defaults.
const env = process.env;

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
		model: env.LLM_MODEL ?? "meta/muse-spark-1.3-contributor",
		contextWindow: Number(env.LLM_CONTEXT_WINDOW ?? 200000),
	},
	blob: {
		/** e.g. https://stagentpocjt75.blob.core.windows.net ; empty = local-only workspaces */
		accountUrl: env.BLOB_ACCOUNT_URL ?? "",
		container: env.BLOB_CONTAINER ?? "chat-workspaces",
	},
	/** mongodb:// URL (FerretDB in the PoC); empty = in-memory history. */
	mongoUrl: env.MONGO_URL ?? "",
	parserUrl: env.PARSER_URL ?? "",
	/** In-cluster Brave Search MCP (http://brave-mcp/mcp); empty = no web search. */
	braveMcpUrl: env.BRAVE_MCP_URL ?? "",
	context7ApiKey: env.CONTEXT7_API_KEY ?? "",
	/** Dev only: identity when no gateway header is present. */
	devUser: env.DEV_USER ?? "",
};
