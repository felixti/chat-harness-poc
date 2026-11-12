// One Pi agent session per request: in-memory, rebuilt from stored history, scoped to one
// user's conversation workspace. Nothing is written outside /tmp.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createAgentSession,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { config } from "./config.ts";
import { bashTool, generatePdfTool, parseDocumentTool } from "./tools.ts";

const agentDir = join(config.tmpRoot, "agent");
const PROVIDER = "gateway";

let runtime: ModelRuntime | undefined;

/** Model access through the platform LLM gateway (OpenAI-compatible; key injected by Envoy). */
async function modelRuntime(): Promise<ModelRuntime> {
	if (runtime) return runtime;
	await mkdir(agentDir, { recursive: true });
	const modelsPath = join(agentDir, "models.json");
	await writeFile(
		modelsPath,
		JSON.stringify({
			providers: {
				[PROVIDER]: {
					name: "Platform LLM gateway",
					baseUrl: config.llm.baseUrl,
					apiKey: config.llm.apiKey,
					api: "openai-completions",
					models: [
						{
							id: config.llm.model,
							name: config.llm.model,
							reasoning: false,
							input: ["text", "image"],
							contextWindow: config.llm.contextWindow,
							maxTokens: 16384,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath, refreshOnCreate: false });
	return runtime;
}

export interface McpServer {
	name: string;
	url: string;
	description: string;
	/** Sent with every request; carries the signed-in user's token where needed. */
	headers?: Record<string, string>;
}

export interface TurnInput {
	workspace: string;
	/** Stored Pi session entries of this conversation ([] for a new one). */
	entries: unknown[];
	message: string;
	/** Skills the caller pins (the old `skills: [ids]` API field). */
	pinnedSkills?: string[];
	mcpServers: McpServer[];
	extraTools?: ToolDefinition[];
	onEvent: (event: { type: string; [k: string]: unknown }) => void;
	signal?: AbortSignal;
}

const SYSTEM_APPEND = `
You are the company's internal assistant, used through a web chat.
- Your current directory is the conversation workspace. Use relative paths. Uploaded files are in uploads/.
- Files you create in the workspace are offered to the user for download. Put deliverables in outputs/.
- Large documents: call parse_document once, then read the markdown in slices (read with offset/limit,
  or grep with bash). Never read a whole large file into the conversation.
- Before following a skill, read its SKILL.md. Skills are listed in the system prompt.
- Tools from MCP servers are not loaded by default: use tool_search to find and load them.
- Answer in the user's language.`;

export async function runTurn(input: TurnInput): Promise<{ entries: unknown[]; text: string }> {
	const cwd = input.workspace;
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true },
		retry: { enabled: true, maxRetries: 2 },
		defaultTools: ["+tool_search"],
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
		additionalSkillPaths: [config.skillsDir],
		// Only the company catalog: ignore skills found in the user's home or the workspace.
		skillsOverride: (base) => ({
			skills: base.skills.filter((s) => s.filePath.startsWith(`${config.skillsDir}/`)),
			diagnostics: base.diagnostics,
		}),
		appendSystemPrompt: [SYSTEM_APPEND],
		extensionFactories: [
			createToolSearchExtension(),
			createMcpExtension({
				logPath: join(agentDir, "mcp.log"),
				startupWaitMs: 5000,
				loadConfig: () => ({
					errors: [],
					autoEnableCodemode: false,
					servers: input.mcpServers.map((s) => ({
						name: s.name,
						source: "extension",
						scope: "extension" as const,
						config: { type: "http" as const, url: s.url, headers: s.headers, description: s.description, exposure: "deferred" as const },
					})),
				}),
			}),
		],
	});
	await resourceLoader.reload();

	const rt = await modelRuntime();
	const model = rt.getModel(PROVIDER, config.llm.model);
	if (!model) throw new Error(`model ${config.llm.model} not configured`);

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		thinkingLevel: "off",
		modelRuntime: rt,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd, undefined, input.entries as never),
		// Built-in grep/find run rg/fd (subprocesses): excluded, the emulated bash has grep/find.
		// The built-in bash is replaced by our just-bash tool of the same name (custom tools win).
		excludeTools: ["grep", "find", "powershell"],
		customTools: [bashTool(cwd), generatePdfTool(cwd), parseDocumentTool(cwd), ...(input.extraTools ?? [])],
	});

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			input.onEvent({ type: "delta", text: event.assistantMessageEvent.delta });
		} else if (event.type === "tool_execution_start") {
			input.onEvent({ type: "tool", name: event.toolName, args: event.args });
		} else if (event.type === "tool_execution_end") {
			input.onEvent({ type: "tool_end", name: event.toolName, isError: event.isError });
		}
	});
	input.signal?.addEventListener("abort", () => void session.abort());

	try {
		await session.bindExtensions({});
		// Pinned skills (the old API's `skills: [ids]`): one uses Pi's /skill command, several are
		// named explicitly so the model reads each SKILL.md first.
		const pinned = input.pinnedSkills ?? [];
		const prompt =
			pinned.length === 1
				? `/skill:${pinned[0]} ${input.message}`
				: pinned.length > 1
					? `First read and follow these skills: ${pinned.join(", ")}.\n\n${input.message}`
					: input.message;
		await session.prompt(prompt);
		const last = session.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
		if (last?.role === "assistant" && last.stopReason !== "stop") {
			console.warn(`[turn] ended with stopReason=${last.stopReason} ${last.errorMessage ?? ""}`);
			if (last.stopReason === "error") input.onEvent({ type: "error", message: last.errorMessage ?? "model error" });
		}
		return { entries: session.sessionManager.getEntries(), text: session.getLastAssistantText() ?? "" };
	} finally {
		unsubscribe();
		session.dispose();
	}
}
