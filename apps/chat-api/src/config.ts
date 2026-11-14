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
	mongoUrl: env.MONGO_URL ?? "",
	parserUrl: env.PARSER_URL ?? "",
	/** In-cluster Brave Search MCP (http://brave-mcp/mcp); empty = no web search. */
	braveMcpUrl: env.BRAVE_MCP_URL ?? "",
	context7ApiKey: env.CONTEXT7_API_KEY ?? "",
	/** Public origin of the chat, for OAuth redirect URIs. */
	publicUrl: (env.PUBLIC_URL ?? "http://localhost:8080").replace(/\/$/, ""),
	connectors: {
		/** 32 random bytes, base64, from Key Vault (connectors-master-key). Seals tokens and OAuth state. */
		masterKey: env.CONNECTORS_MASTER_KEY ?? "",
		/** Separate from the workspaces: the agent never sees this container. */
		container: env.CONNECTORS_CONTAINER ?? "chat-credentials",
		github: {
			clientId: env.GITHUB_CLIENT_ID ?? "",
			clientSecret: env.GITHUB_CLIENT_SECRET ?? "",
			/** GitHub MCP read-only mode; "false" lets the agent open issues and PRs. */
			readOnly: env.GITHUB_MCP_READONLY !== "false",
		},
	},
	/** Dev only: identity when no gateway header is present. */
	devUser: env.DEV_USER ?? "",
};
