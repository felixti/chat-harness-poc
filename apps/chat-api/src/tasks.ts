// Scheduled tasks (H69) as the portal and the agent see them: validation, BRL views with the
// cost of each run (H68), and the schedule_task tool ("todo dia às 8h, me traga ...").
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { config } from "./config.ts";
import { describeWhen, SCHEDULE_LIMITS, validWhen, type Job, type JobKind, type Schedule, type ScheduleStore, type When } from "./jobs.ts";

/** Cost cap of one run, BRL: default and ceiling (a prompt task usually costs a few centavos). */
export const CAP_BRL = { prompt: { default: 1, max: 20 }, research: { default: 5, max: 30 } };

const bad = (m: string) => Object.assign(new Error(m), { status: 400 });

export interface ScheduleInput {
	title: string;
	prompt: string;
	when: When;
	capUsd: number;
	kind: JobKind;
	model?: string;
}

/** Body of POST/PATCH /api/schedules (and the tool's arguments) -> checked values. */
export function scheduleInput(b: Record<string, unknown>, partial = false): Partial<ScheduleInput> {
	const out: Partial<ScheduleInput> = {};
	if (!partial || b.title !== undefined) {
		const t = String(b.title ?? "").trim();
		if (!t) throw bad("title");
		out.title = t.slice(0, SCHEDULE_LIMITS.title);
	}
	if (!partial || b.prompt !== undefined) {
		const p = String(b.prompt ?? "").trim();
		if (!p) throw bad("prompt");
		if (p.length > SCHEDULE_LIMITS.prompt) throw bad(`prompt: at most ${SCHEDULE_LIMITS.prompt} characters`);
		out.prompt = p;
	}
	if (!partial || b.when !== undefined) out.when = validWhen(b.when);
	const kind: JobKind = b.kind === "research" ? "research" : "prompt";
	if (!partial) out.kind = kind;
	if (!partial || b.capBrl !== undefined) {
		const cap = b.capBrl === undefined ? CAP_BRL[kind].default : Number(b.capBrl);
		if (!Number.isFinite(cap) || cap <= 0 || cap > CAP_BRL[kind].max) throw bad(`capBrl: more than 0, at most ${CAP_BRL[kind].max}`);
		out.capUsd = cap / config.usdBrl;
	}
	if (typeof b.model === "string" && b.model) out.model = b.model;
	return out;
}

const brl = (usd: number) => Math.round(usd * config.usdBrl * 10000) / 10000;

export function jobView(j: Job) {
	const { checkpoint: _c, owner: _o, leaseUntil: _l, cancel, ...rest } = j;
	return { ...rest, stopping: !!cancel && j.status === "running", costBrl: brl(j.cost.usd), capBrl: brl(j.capUsd) };
}

export function scheduleView(s: Schedule, last?: Job) {
	return { ...s, whenText: describeWhen(s.when), capBrl: brl(s.capUsd), last: last ? jobView(last) : undefined };
}

const SP = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const spDate = (d: Date) => SP.format(d);

/** The agent creates a schedule when the user asks for something recurring or for later. */
export function scheduleTaskTool(schedules: ScheduleStore, user: string, projectId: string | undefined): ToolDefinition {
	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
	return defineTool({
		name: "schedule_task",
		label: "schedule_task",
		description:
			`Schedule a task that runs later on its own (the user is not present): once at a date, or daily, on weekdays, weekly or monthly, at a time in São Paulo. ` +
			`Use it only when the user asks for something at a later time or on a schedule ("todo dia às 8h, me traga...", "amanhã às 9h, lembre..."). ` +
			`Each run asks an AI agent the prompt with the same tools (web search, files, connectors) and posts the answer in the task's own conversation; the user sees each run's cost in "Tarefas". ` +
			`Write the prompt as a complete, self-contained instruction (what to search or produce, format, language). Now in São Paulo: ${spDate(new Date())}.`,
		promptSnippet: "schedule_task: run a prompt later or on a schedule (daily, weekdays, weekly, monthly, once)",
		parameters: Type.Object({
			title: Type.String({ description: "Short name, in the user's language" }),
			prompt: Type.String({ description: "Self-contained instruction for each run" }),
			freq: Type.Union([Type.Literal("once"), Type.Literal("daily"), Type.Literal("weekdays"), Type.Literal("weekly"), Type.Literal("monthly")]),
			time: Type.String({ description: "HH:MM, São Paulo time" }),
			weekday: Type.Optional(Type.Integer({ description: "weekly: 0 Sunday ... 6 Saturday", minimum: 0, maximum: 6 })),
			day: Type.Optional(Type.Integer({ description: "monthly: day 1 to 28", minimum: 1, maximum: 28 })),
			date: Type.Optional(Type.String({ description: "once: YYYY-MM-DD" })),
			cap_brl: Type.Optional(Type.Number({ description: `Cost cap of one run in BRL (default ${CAP_BRL.prompt.default}, max ${CAP_BRL.prompt.max})` })),
		}),
		async execute(_id, p) {
			if ((await schedules.list(user)).filter((s) => s.active).length >= SCHEDULE_LIMITS.perUser) return text(`The user already has ${SCHEDULE_LIMITS.perUser} active tasks; ask them to pause or delete one in "Tarefas".`);
			const v = scheduleInput({ title: p.title, prompt: p.prompt, when: { freq: p.freq, time: p.time, weekday: p.weekday, day: p.day, date: p.date }, capBrl: p.cap_brl });
			const s = await schedules.create({ user, title: v.title!, prompt: v.prompt!, kind: "prompt", when: v.when!, capUsd: v.capUsd!, projectId });
			if (!s.nextRunAt) {
				await schedules.remove(user, s.id);
				return text("That date and time already passed; ask the user for a future one.");
			}
			console.log(`[schedule] created by the agent: ${s.id} ${s.when.freq}`);
			return text(
				`Scheduled "${s.title}": ${describeWhen(s.when)} (São Paulo). Next run: ${spDate(s.nextRunAt)}. Cap per run: R$ ${(s.capUsd * config.usdBrl).toFixed(2)}. ` +
					`Each run posts in its own conversation "${s.title}"; the user manages it in Tarefas (run now, pause, history with the cost of each run). Tell the user this in one or two sentences.`,
			);
		},
	}) as ToolDefinition;
}
