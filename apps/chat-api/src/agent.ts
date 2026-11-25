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
import { guardedFileTools, keepToolOutput } from "./fs-guard.ts";
import { foreignToolCallsAsText, withUnquotedArgs } from "./crossmodel.ts";
import { emptyUsage, gatewayPrices, type TurnUsage } from "./usage.ts";

const agentDir = join(config.tmpRoot, "agent");
const PROVIDER = "gateway";

let runtime: ModelRuntime | undefined;

export type Effort = "low" | "medium" | "high";
export const EFFORTS: Effort[] = ["low", "medium", "high"];

/** Models offered in the portal; the configured default always included. */
export function modelChoices() {
	const list = config.llm.models;
	return list.some((m) => m.id === config.llm.model) ? list : [{ id: config.llm.model, label: config.llm.model, note: "" }, ...list];
}

/** Model access through the platform LLM gateway (OpenAI-compatible; key injected by Envoy). */
async function modelRuntime(): Promise<ModelRuntime> {
	if (runtime) return runtime;
	await mkdir(agentDir, { recursive: true });
	const prices = await gatewayPrices(modelChoices().map((m) => m.id));
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
					// Every model the portal offers (H57), with reasoning effort sent the OpenRouter way
					// (`reasoning: {effort}`); the gateway URL is not openrouter.ai, so it is not auto-detected.
					models: modelChoices().map((m) => ({
						id: m.id,
						name: m.label,
						reasoning: true,
						input: ["text", "image"],
						contextWindow: config.llm.contextWindow,
						// Reasoning and the answer share max_tokens on OpenRouter.
						maxTokens: 32768,
						// Real prices, so pi reports each call's cost (H58).
						cost: prices[m.id] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						compat: { thinkingFormat: "openrouter", supportsReasoningEffort: true, ...(m.id.startsWith("anthropic/") ? { cacheControlFormat: "anthropic" } : {}) },
					})),
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
	/** "direct": tools always declared (per-user connectors); "deferred": loaded via tool_search. */
	exposure?: "direct" | "deferred";
	/** Per-call timeout in seconds (adapter default 60). */
	timeout?: number;
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
	/** Human-in-the-loop gate (approvals, ask_user): consulted before every tool call. */
	gate?: {
		check(call: { toolCallId: string; toolName: string; input: unknown }): { block: true; reason: string; terminate: true } | undefined;
		noteResult?(toolName: string, isError: boolean): void;
	};
	/** Per-turn folder with the user's personal skills (my-*), loaded like company skills, read-only. */
	userSkillsDir?: string;
	/** Model and reasoning effort picked in the portal (H57); validated, else the defaults. */
	model?: string;
	effort?: Effort;
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
- Longer tasks (3 or more steps: research, a deliverable from several files): call plan first and update it as
  steps finish.
- Forms and interactive pages: decide by where the result goes. Filled in once and sent back to you
  (a request, a booking, filters, a confirmation; also when you need several structured values instead of
  asking in text): show_ui, a form in the chat. A tool the user keeps using, with state on screen (to-do
  or shopping list, checklist ticked over time, calculator, simulator, chart): canvas. The word
  "formulário" alone does not decide.
- The chat lists the web pages you searched or read under your reply. Do not end with a list of
  sources; link a page inline only where a claim needs it.
- Answer in the user's language.

## How to reply
Write for a busy colleague who reads on a chat screen.
- Answer first. The first line is the answer, the result or the file; no run-up ("Vamos lá",
  "Ótima pergunta", "Analisei o arquivo e...") and no restating the question.
- Never narrate your tool use ("I'll read the skill first", "Vou verificar..."): the user sees
  the steps. Text you write between tool calls is shown too, so keep it out.
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
  and ask what they want with ask_user (2-4 options). Do not analyze everything up front.
- When missing context would change a deliverable (audience, format, scope), follow the clarify
  skill: ask_user with at most 3 multiple-choice questions, each with your recommended option.
- After reading a file, use what you read to do the task; do not summarize it unless asked.
- Plain, specific prose: no "não é X, é Y" contrasts, no one-line closers that repeat the point,
  no forced lists of three, no inflated words (crucial, robusto, poderoso, essencial), no emoji.
- Errors: state cause and fix in one or two lines.
- When a tool returns nothing or fails, say so and stop; never call unrelated tools (memory,
  remember, files) to test, as placeholders, or to keep the turn going.
Adapted from blader/humanizer and i-have-adhd (MIT).`;

/** MCP tool names a conversation already loaded (tool_search results) or called. */
export function previouslyLoadedTools(entries: unknown[]): Set<string> {
	const out = new Set<string>();
	for (const e of entries as { message?: { role?: string; content?: unknown; toolName?: string } }[]) {
		const m = e?.message;
		if (!m) continue;
		if (m.role === "assistant" && Array.isArray(m.content))
			for (const c of m.content as { type?: string; name?: string }[]) if (c.type === "toolCall" && c.name?.startsWith("mcp__")) out.add(c.name);
		if (m.role === "toolResult" && m.toolName === "tool_search" && Array.isArray(m.content))
			for (const c of m.content as { type?: string; text?: string }[]) for (const x of (c.text ?? "").matchAll(/^- (mcp__[\w-]+__[\w-]+):/gm)) out.add(x[1]);
	}
	return out;
}

/** Each turn rebuilds the session, so MCP tools that tool_search loaded in earlier messages are not
 *  declared now, while the history says they are. The provider only accepts declared tool names, so
 *  a model that "uses" one ends up calling an unrelated tool (it picked memory). Say so up front. */
export function reloadNote(entries: unknown[], alwaysLoaded: string[] = []): string[] {
	const tools = [...previouslyLoadedTools(entries)].filter((t) => !alwaysLoaded.includes(t.split("__")[1]));
	if (!tools.length) return [];
	const servers = [...new Set(tools.map((t) => t.split("__")[1]))];
	return [
		`\n## Tools from earlier messages\nMCP tools used or loaded earlier in this conversation (${tools.slice(0, 12).join(", ")}${tools.length > 12 ? ", ..." : ""}) are NOT loaded in this message. Before calling any of them, call tool_search again (for example with "${servers.join(" ")}" and the action you need). Never call an unrelated tool instead.`,
	];
}

export async function runTurn(input: TurnInput): Promise<{ entries: unknown[]; text: string; usage: TurnUsage }> {
	const cwd = input.workspace;
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true },
		retry: { enabled: true, maxRetries: 2 },
		defaultTools: ["+tool_search"],
	});
	const usedServers = new Set([...previouslyLoadedTools(input.entries)].map((t) => t.split("__")[1]));
	const modelId = input.model && modelChoices().some((m) => m.id === input.model) ? input.model : config.llm.model;
	const billed = { usd: 0, seen: 0 };
	const usage = emptyUsage(modelId);
	let imagesUsd = 0;
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
			// The gate runs before any tool (MCP ones included, and calls made from codemode).
			(pi) => {
				if (input.gate) pi.on("tool_call", (e) => input.gate!.check({ toolCallId: e.toolCallId, toolName: e.toolName, input: e.input }));
				pi.on("context", (e) => ({ messages: foreignToolCallsAsText(e.messages, modelId) }));
				// A truncated MCP result's full text goes to the workspace, and the model gets that path (H66).
				pi.on("tool_result", async (e) => {
					const from = (e.details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
					const to = await keepToolOutput(cwd, from);
					if (!to || typeof from !== "string") return undefined;
					return {
						content: e.content.map((c) => (c.type === "text" ? { ...c, text: c.text.split(from).join(to) } : c)),
						details: { ...(e.details as object), fullOutputPath: to },
						structuredContent: e.structuredContent,
					};
				});
				// OpenRouter reports what it billed in the last stream chunk (usage.cost, USD): the price
				// list can differ from the provider it routed to (H58), so this wins when present.
				pi.on("provider_stream_event", (e) => {
					const cost = (e.data as { usage?: { cost?: unknown } } | undefined)?.usage?.cost;
					if (typeof cost === "number" && Number.isFinite(cost)) (billed.usd += cost, billed.seen++);
				});
			},
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
						// A server this conversation already used stays declared: a deferred tool loaded in an
						// earlier message is gone in this one, and the model then calls an unrelated tool (H48).
						config: { type: "http" as const, url: s.url, headers: s.headers, description: s.description, ...(s.timeout ? { timeout: s.timeout } : {}), exposure: s.exposure ?? (usedServers.has(s.name) ? ("direct" as const) : ("deferred" as const)) },
					})),
				}),
			}),
		],
	});
	await resourceLoader.reload();

	const rt = await modelRuntime();
	const model = rt.getModel(PROVIDER, modelId);
	if (!model) throw new Error(`model ${modelId} not configured`);

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		thinkingLevel: input.effort && EFFORTS.includes(input.effort) ? input.effort : "medium",
		modelRuntime: rt,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd, undefined, input.entries as never),
		// Built-in grep/find run rg/fd (subprocesses): excluded, the emulated bash has grep/find.
		// The built-in bash is replaced by our just-bash tool of the same name (custom tools win), and
		// read/write/edit/ls by confined copies (workspace read-write, skills read-only; see fs-guard.ts).
		excludeTools: ["grep", "find", "powershell"],
		customTools: [...guardedFileTools(cwd, [config.skillsDir, ...(input.userSkillsDir ? [input.userSkillsDir] : [])]), bashTool(cwd), generatePdfTool(cwd), parseDocumentTool(cwd), ...officeTools(cwd), ...(input.extraTools ?? [])].map(withUnquotedArgs),
	});

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const u = (event.message as { usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } } }).usage;
			usage.calls++;
			usage.input += u?.input ?? 0;
			usage.output += u?.output ?? 0;
			usage.cacheRead += u?.cacheRead ?? 0;
			usage.usd += u?.cost?.total ?? 0;
		}
		if (event.type === "tool_execution_end" && event.toolName === "generate_image" && !event.isError) {
			// The image tool reports the provider's cost in its result ("US$0.021").
			const cost = /US\$([\d.]+)/.exec(JSON.stringify(event.result ?? ""))?.[1];
			if (cost) (imagesUsd += Number(cost), usage.images++);
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			input.onEvent({ type: "delta", text: event.assistantMessageEvent.delta });
		} else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
			input.onEvent({ type: "thinking", text: event.assistantMessageEvent.delta });
		} else if (event.type === "tool_execution_start") {
			input.onEvent({ type: "tool", id: event.toolCallId, name: event.toolName, args: event.args });
		} else if (event.type === "tool_execution_end") {
			input.gate?.noteResult?.(event.toolName, event.isError);
			input.onEvent({ type: "tool_end", id: event.toolCallId, name: event.toolName, isError: event.isError, result: event.result });
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
		// Billed cost when every model call reported one; else the price-list estimate.
		if (billed.seen >= usage.calls && billed.seen > 0) usage.usd = billed.usd;
		usage.usd += imagesUsd;
		return { entries: session.sessionManager.getEntries(), text: session.getLastAssistantText() ?? "", usage };
	} finally {
		unsubscribe();
		session.dispose();
	}
}
