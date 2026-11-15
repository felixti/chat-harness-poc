// Human-in-the-loop gate (docs/design.md H46). Write actions on connectors and questions to the
// user pause the run as AG-UI interrupts; nothing that writes outside the conversation runs
// without an explicit "Aprovar" for that exact call (same tool, same arguments).
import { createHash, randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Interrupt, ResumeEntry } from "./agui.ts";

export interface Pending extends Interrupt {
	toolName?: string;
	input?: unknown;
	questions?: Question[];
	createdAt: string;
}

export interface Question {
	id: string;
	question: string;
	options: { label: string; description?: string }[];
	recommended?: string;
	multiSelect?: boolean;
}

/** MCP tools that change something outside the chat. Azure DevOps names its write dispatchers
 *  *_write; GitHub's MCP uses verb prefixes (create_issue, merge_pull_request...). */
export function needsApproval(toolName: string): boolean {
	const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
	if (!m) return false;
	const tool = m[2];
	if (/(_write$|^repo_create_branch$|_attachment_(upload|link)$|^wiki_upsert_page$)/.test(tool)) return true;
	return /^(create|update|merge|push|delete|add|remove|fork|assign|request|submit|dismiss|close|reopen|rerun|cancel|run_)/.test(tool);
}

const canon = (v: unknown): unknown =>
	Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
export const callKey = (toolName: string, input: unknown) => createHash("sha256").update(`${toolName}\n${JSON.stringify(canon(input))}`).digest("hex");

const ACTIONS: Record<string, Record<string, string>> = {
	wit_work_item_write: { create: "Criar work item", update: "Atualizar work item", update_batch: "Atualizar work items", add_child: "Criar itens filhos" },
	wit_work_item_comment_write: { add: "Comentar no work item", update: "Editar comentário do work item" },
	wit_work_item_link_write: { link: "Vincular work items", unlink: "Desvincular work items", link_to_pull_request: "Vincular work item ao pull request", add_artifact_link: "Vincular artefato ao work item" },
	repo_pull_request_write: { create: "Abrir pull request", update: "Atualizar pull request", update_reviewers: "Alterar revisores do pull request", vote: "Votar no pull request" },
	repo_pull_request_thread_write: { create: "Comentar no pull request", reply: "Responder no pull request", update_status: "Mudar status da discussão do pull request" },
	pipelines_write: { run_pipeline: "Executar pipeline", create_pipeline: "Criar pipeline", update_build_stage: "Alterar estágio do build" },
	work_iteration_write: { create: "Criar iteração", assign: "Atribuir iteração ao time" },
	work_capacity_write: { update: "Atualizar capacidade do time" },
};
const SINGLE: Record<string, string> = {
	repo_create_branch: "Criar branch",
	wiki_upsert_page: "Criar ou editar página da wiki",
	wit_work_item_attachment_upload: "Enviar anexo",
	wit_work_item_attachment_link: "Anexar arquivo ao work item",
	create_issue: "Criar issue",
	create_pull_request: "Abrir pull request",
	merge_pull_request: "Fazer merge do pull request",
	add_issue_comment: "Comentar na issue",
};

/** A short pt-BR description of a write call for the approval card. */
export function describeCall(toolName: string, input: unknown): string {
	const [, server = "", tool = toolName] = /^mcp__(.+?)__(.+)$/.exec(toolName) ?? [];
	const a = (input ?? {}) as Record<string, unknown>;
	const fields = (a.fields ?? {}) as Record<string, unknown>;
	const where = server === "azuredevops" ? "Azure DevOps" : server === "github" ? "GitHub" : server;
	const verb = (typeof a.action === "string" && ACTIONS[tool]?.[a.action]) || SINGLE[tool] || `${tool.replace(/_/g, " ")}${typeof a.action === "string" ? ` (${a.action})` : ""}`;
	const kind = typeof (a.type ?? a.workItemType) === "string" ? ` (${a.type ?? a.workItemType})` : "";
	const title = [a.title, fields["System.Title"], a.name, a.branchName, a.path, a.pipelineName].find((x) => typeof x === "string" && x);
	const id = typeof a.id === "number" || typeof a.id === "string" ? ` #${a.id}` : typeof a.pipelineId === "number" ? ` #${a.pipelineId}` : "";
	const project = typeof a.project === "string" ? ` no projeto ${a.project}` : typeof a.repo === "string" ? ` em ${a.repo}` : "";
	return `${where}: ${verb}${kind}${id}${project}${title ? ` — “${String(title).slice(0, 120)}”` : ""}`;
}

export const APPROVAL_SCHEMA = { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] };

/** Per-turn gate: blocks calls that need approval unless approved in this resume, and turns
 *  ask_user into an input_required interrupt. Collected interrupts end the run. */
export class Gate {
	readonly interrupts: Pending[] = [];
	private readonly allowed = new Set<string>();
	private readonly calls = new Map<string, number>();
	private errorsInARow = 0;
	/** Set when the breaker stopped the turn: the server then makes sure the user gets a message. */
	tripped?: string;
	/** Circuit breaker: a model stuck repeating a tool or failing in a row ends the turn. */
	noteResult(_toolName: string, isError: boolean) {
		this.errorsInARow = isError ? this.errorsInARow + 1 : 0;
	}
	private loop(toolName: string): string | undefined {
		const n = (this.calls.get(toolName) ?? 0) + 1;
		this.calls.set(toolName, n);
		const limit = toolName === "memory" || toolName === "remember" || toolName === "forget" ? 5 : 15;
		if (n > limit) return `${toolName} was called ${n} times in this turn.`;
		if (this.errorsInARow >= 4) return `the last ${this.errorsInARow} tool calls failed.`;
		return undefined;
	}
	allow(toolName: string, input: unknown) {
		this.allowed.add(callKey(toolName, input));
	}
	check(call: { toolCallId: string; toolName: string; input: unknown }): { block: true; reason: string; terminate: true } | undefined {
		const stuck = this.loop(call.toolName);
		if (stuck) this.tripped = stuck;
		if (stuck)
			return {
				block: true,
				terminate: true,
				reason: `Stopped: ${stuck} Do not call more tools. Tell the user in one or two sentences what you were trying to do, what failed, and what you need from them.`,
			};
		if (call.toolName === "ask_user") {
			const questions = ((call.input as { questions?: Question[] })?.questions ?? []).slice(0, 3);
			this.interrupts.push({
				id: `int-${randomUUID().slice(0, 12)}`,
				reason: "input_required",
				message: questions.map((q) => q.question).join(" · ").slice(0, 300),
				toolCallId: call.toolCallId,
				questions,
				responseSchema: { type: "object", properties: { answers: { type: "object", additionalProperties: { type: "string" } } }, required: ["answers"] },
				createdAt: new Date().toISOString(),
			});
			return { block: true, reason: "Questions sent to the user. Stop now and wait for the answers; do not answer them yourself.", terminate: true };
		}
		if (!needsApproval(call.toolName)) return undefined;
		const key = callKey(call.toolName, call.input);
		if (this.allowed.has(key)) {
			this.allowed.delete(key); // one approval, one execution
			return undefined;
		}
		this.interrupts.push({
			id: `int-${randomUUID().slice(0, 12)}`,
			reason: "tool_call",
			message: describeCall(call.toolName, call.input),
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			input: call.input,
			responseSchema: APPROVAL_SCHEMA,
			createdAt: new Date().toISOString(),
		});
		return { block: true, reason: "This action changes data outside the chat and needs the user's approval. It was sent to the user as an approval request; stop now and say in one short sentence what you are waiting for.", terminate: true };
	}
}

const HIDDEN = (s: string) => `\n\n<harness>${s}</harness>`;

export interface ApprovedCall {
	interruptId: string;
	toolName: string;
	input: unknown;
	message: string;
}

/** Resume entries + saved interrupts -> what the user said, the hidden notes for the model, and the
 *  approved calls. Approved calls are executed by chat-api itself (see server.ts), never by the model. */
export function resumeMessage(pending: Pending[], resume: ResumeEntry[]): { message: string; approved: ApprovedCall[]; hidden: string[] } {
	const parts: string[] = [];
	const hidden: string[] = [];
	const approved: ApprovedCall[] = [];
	for (const r of resume) {
		const p = pending.find((x) => x.id === r.interruptId);
		if (!p) throw Object.assign(new Error("this request is no longer pending (expired or already answered)"), { status: 409 });
		if (p.reason === "tool_call") {
			const ok = r.status === "resolved" && (r.payload as { approved?: boolean } | undefined)?.approved === true;
			if (ok && p.toolName) {
				parts.push(`Aprovado: ${p.message}`);
				approved.push({ interruptId: p.id, toolName: p.toolName, input: p.input, message: p.message });
			} else {
				parts.push(`Recusado: ${p.message}`);
				hidden.push(`The user declined ${p.toolName}. Do not run it or anything equivalent. Acknowledge in one sentence.`);
			}
		} else {
			const answers = (r.status === "resolved" ? (r.payload as { answers?: Record<string, string> } | undefined)?.answers : undefined) ?? {};
			const lines = (p.questions ?? []).map((q) => `- ${q.question} → ${answers[q.id]?.trim() || "(sem resposta: use a recomendação)"}`);
			parts.push(r.status === "cancelled" ? "Pulei as perguntas." : `Respostas:\n${lines.join("\n")}`);
			hidden.push(r.status === "cancelled" ? "The user skipped the questions: continue with your recommended assumptions and state them briefly." : "Use these answers and continue the task now. Do not ask the same questions again.");
		}
	}
	return { message: parts.join("\n"), approved, hidden };
}

export const withHidden = (message: string, hidden: string[]) => (hidden.length ? message + HIDDEN(hidden.join(" ")) : message);

/** The questions tool. Execution never happens: the gate turns the call into an interrupt. */
export function askUserTool(): ToolDefinition {
	return defineTool({
		name: "ask_user",
		label: "ask_user",
		description:
			"Ask the user 1 to 3 short multiple-choice questions when missing context would change the result (audience, " +
			"format, scope, deadline, a decision only they can make). Each question has 2 to 4 options and your recommended " +
			"option. The run pauses until the user answers in the chat. Read the clarify skill first.",
		promptSnippet: "ask_user: ask 1-3 multiple-choice questions with a recommended option (pauses the run)",
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					id: Type.String({ description: "short slug, e.g. audience" }),
					question: Type.String({ description: "One sentence, in the user's language" }),
					options: Type.Array(Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) }), { minItems: 2, maxItems: 4 }),
					recommended: Type.Optional(Type.String({ description: "label of the option you recommend" })),
					multiSelect: Type.Optional(Type.Boolean()),
				}),
				{ minItems: 1, maxItems: 3 },
			),
		}),
		async execute() {
			return { content: [{ type: "text" as const, text: "Waiting for the user's answers." }], details: undefined };
		},
	}) as ToolDefinition;
}

/** Shows the user's words, not the harness note appended to a resume message. */
export const stripHidden = (t: string) => t.replace(/\n\n<harness>[\s\S]*?<\/harness>\s*$/, "");
