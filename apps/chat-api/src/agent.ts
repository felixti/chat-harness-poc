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
import { officeTools } from "./office/tools.ts";
import { guardedFileTools } from "./fs-guard.ts";

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
	/** Per-user system prompt additions (core memory snapshot). */
	systemAppend?: string;
	/** Per-turn folder with the user's personal skills (my-*), loaded like company skills, read-only. */
	userSkillsDir?: string;
	onEvent: (event: { type: string; [k: string]: unknown }) => void;
	signal?: AbortSignal;
}

const SYSTEM_APPEND = `
You are the company's internal assistant, used through a web chat.
- Your current directory is the conversation workspace. Use relative paths. Uploaded files are in uploads/.
- Folders: uploads/ has the user's files; outputs/ is ONLY for deliverables the user asked for (pptx,
  docx, xlsx, pdf, html, csv, md they will download). Everything else you write (notes, JSON specs,
  markdown sources, generated images, intermediate data, scripts) goes in work/: it is kept for later
  turns but not shown to the user.
- Large documents: call parse_document once, then read the markdown in slices (read with offset/limit,
  or grep with bash). Never read a whole large file into the conversation.
- Before following a skill, read its SKILL.md. Skills are listed in the system prompt.
- Tools from MCP servers are not loaded by default: use tool_search to find and load them.
- Answer in the user's language.

## How to reply
Write for a busy colleague who reads on a chat screen.
- Answer first. The first line is the answer, the result or the file; no run-up ("Vamos lá",
  "Ótima pergunta", "Analisei o arquivo e...") and no restating the question.
- Size follows the question. A short question gets 1 to 3 sentences. Use headings only for
  long documents; lists at most 5 items; bold only for the one thing to find, not every label.
- Do what was asked and stop. No menu of next steps, no "Se quiser, posso...", "Quer que eu...?",
  "Posso também..." and no recap of what you just did.
- Offer a next step only when the context calls for it, and then just one short line:
  - the user's goal clearly needs a follow-up they did not ask for (a file they will need, a
    blocking error);
  - a decision only they can make blocks the work: ask one question, with your recommendation;
  - something is risky or wrong (a broken number, a missing source, a destructive action).
- When the intent is unclear (a file uploaded with no request), say in 2 or 3 lines what it is
  and ask one short question about what they want. Do not analyze everything up front.
- After reading a file, use what you read to do the task; do not summarize it unless asked.
- Plain, specific prose: no "não é X, é Y" contrasts, no one-line closers that repeat the point,
  no forced lists of three, no inflated words (crucial, robusto, poderoso, essencial), no emoji.
- Errors: state cause and fix in one or two lines.
Adapted from blader/humanizer and i-have-adhd (MIT).`;

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
		additionalSkillPaths: [config.skillsDir, ...(input.userSkillsDir ? [input.userSkillsDir] : [])],
		// Only the company catalog: ignore skills found in the user's home or the workspace.
		skillsOverride: (base) => ({
			skills: base.skills.filter(
				(s) => s.filePath.startsWith(`${config.skillsDir}/`) || (!!input.userSkillsDir && s.filePath.startsWith(`${input.userSkillsDir}/`)),
			),
			diagnostics: base.diagnostics,
		}),
		appendSystemPrompt: [SYSTEM_APPEND, ...(input.systemAppend ? [input.systemAppend] : [])],
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
		// The built-in bash is replaced by our just-bash tool of the same name (custom tools win), and
		// read/write/edit/ls by confined copies (workspace read-write, skills read-only; see fs-guard.ts).
		excludeTools: ["grep", "find", "powershell"],
		customTools: [...guardedFileTools(cwd, [config.skillsDir, ...(input.userSkillsDir ? [input.userSkillsDir] : [])]), bashTool(cwd), generatePdfTool(cwd), parseDocumentTool(cwd), ...officeTools(cwd), ...(input.extraTools ?? [])],
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
