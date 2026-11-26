// Deep research as a background job (H73) with its cost per run (H68).
// In the chat the agent clarifies (ask_user, up to 3 questions), proposes 3 to 8 sub-questions and
// calls start_research: that queues a "research" job in the same conversation, with an estimate and
// a cap in BRL. The worker then:
//   1. reads: one subagent per sub-question (cheap model, web search and page reading only, a small
//      search budget) writes notes with the sources it read; each finished one is checkpointed;
//   2. writes: a stronger model turns the notes into a report with numbered citations;
//   3. checks: the cheap model lists claims the notes do not support;
//   4. delivers: a turn in the conversation posts the report with the flagged claims fixed, and a
//      docx or pdf when asked. If the conversation is busy, the job waits and resumes from here.
// Every model call carries the job id as runId, so the run's cost is exact and visible live.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { config } from "./config.ts";
import { runTurn } from "./agent.ts";
import { Gate } from "./approvals.ts";
import { AguiRun } from "./agui.ts";
import { mcpServersFor, type TurnOutcome, type TurnRequest } from "./turn.ts";
import type { Job, JobQueue } from "./jobs.ts";
import type { RunContext } from "./job-runner.ts";
import type { UsageLedger } from "./usage.ts";
import { CAP_BRL } from "./tasks.ts";

export interface ResearchSpec {
	topic: string;
	questions: string[];
	audience?: string;
	format: "chat" | "docx" | "pdf";
}

interface Checkpoint {
	notes: Record<string, string>;
	draft?: string;
	issues?: { claim: string; issue: string }[];
}

export const RESEARCH_LIMITS = { minQuestions: 3, maxQuestions: 8 };

/** Rough cost from experience (USD): cheap-model reading per sub-question, plus writing and checking. */
export const estimateUsd = (questions: number) => questions * 0.025 + 0.1;

export const readerModel = () => process.env.RESEARCH_READER_MODEL ?? config.llm.model;
export const writerModel = () => process.env.RESEARCH_WRITER_MODEL ?? "anthropic/claude-haiku-5.5";

export function parseSpec(prompt: string): ResearchSpec {
	const s = JSON.parse(prompt) as ResearchSpec;
	if (!s.topic || !Array.isArray(s.questions) || !s.questions.length) throw new Error("research spec without topic or questions");
	return s;
}

/** The chat tool: queues the research in this conversation after the clarifying questions. */
export function startResearchTool(jobs: JobQueue, user: string, conversation: string, projectId: string | undefined): ToolDefinition {
	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
	return defineTool({
		name: "start_research",
		label: "start_research",
		description:
			"Start a deep research run in the background (it reads many web pages, takes 5 to 20 minutes, and posts a report with numbered sources in this conversation). " +
			"Use it when the user asks for deep research, a survey, a market or technical study, or a question that needs many sources. " +
			"Before calling it, if the scope is unclear, ask up to 3 questions with ask_user (audience, period, region, depth, format). " +
			"Then call it once with 3 to 8 sub-questions that together answer the topic. After it returns, tell the user in two short lines: that it started, the estimate and the cap.",
		promptSnippet: "start_research: deep research in the background, report with sources",
		parameters: Type.Object({
			topic: Type.String({ description: "The research question, complete and in the user's language" }),
			questions: Type.Array(Type.String(), { description: "3 to 8 sub-questions, each answerable by web search", minItems: 3, maxItems: 8 }),
			audience: Type.Optional(Type.String({ description: "Who reads it and what they will decide" })),
			format: Type.Optional(Type.Union([Type.Literal("chat"), Type.Literal("docx"), Type.Literal("pdf")], { description: "chat (default), or also a docx or pdf file" })),
			cap_brl: Type.Optional(Type.Number({ description: `Cost cap in BRL (default ${CAP_BRL.research.default}, max ${CAP_BRL.research.max})` })),
		}),
		async execute(_id, p) {
			const questions = p.questions.map((q) => q.trim()).filter(Boolean).slice(0, RESEARCH_LIMITS.maxQuestions);
			if (questions.length < RESEARCH_LIMITS.minQuestions) return text(`Give at least ${RESEARCH_LIMITS.minQuestions} sub-questions.`);
			const running = (await jobs.list(user, { conversation, kind: "research" }, 5)).find((j) => j.status === "queued" || j.status === "running");
			if (running) return text(`A research run is already going in this conversation (${running.id}); wait for it or stop it in the card above the composer.`);
			const capBrl = Math.min(Math.max(Number(p.cap_brl) || CAP_BRL.research.default, 0.5), CAP_BRL.research.max);
			const spec: ResearchSpec = { topic: p.topic.trim(), questions, audience: p.audience?.trim() || undefined, format: p.format ?? "chat" };
			const job = await jobs.enqueue({ user, kind: "research", title: spec.topic.slice(0, 80), prompt: JSON.stringify(spec), conversation, projectId, capUsd: capBrl / config.usdBrl });
			const est = estimateUsd(questions.length) * config.usdBrl;
			console.log(`[research] queued ${job.id}: ${questions.length} sub-questions, cap R$${capBrl}`);
			return text(
				`Research started (run ${job.id}): ${questions.length} sub-questions. Estimate about R$ ${est.toFixed(2)}, cap R$ ${capBrl.toFixed(2)} (it stops there). ` +
					"The user follows it in the card above the composer (step and cost live) and the report is posted in this conversation when it ends. Do not research it yourself now.",
			);
		},
	}) as ToolDefinition;
}

const readerPrompt = (spec: ResearchSpec, q: string) => `You are a research assistant reading the web for one sub-question of a larger study.
Study: ${spec.topic}${spec.audience ? `\nAudience: ${spec.audience}` : ""}
Sub-question: ${q}

Search the web and read the most relevant pages. Budget: at most 4 searches and 5 page reads. Prefer primary, official and recent sources; note the date of each figure.
Do not write files. Reply ONLY with notes in this format:
## Findings
- <one fact, with numbers, dates and names> [S1]
## Sources
[S1] <page title> — <url> (<publication date if known>)
Every finding cites a source you actually read in this run. If nothing reliable was found, write "No reliable source found" and why.`;

const writerPrompt = (spec: ResearchSpec, notes: string) => `Write a research report from the notes below. Use ONLY facts in the notes.
Study: ${spec.topic}${spec.audience ? `\nAudience: ${spec.audience}` : ""}
Language: the language of the study text above.

Structure: a title (# heading); "Resumo" with the answer in 3 to 5 bullets; one section per theme (not necessarily one per sub-question), comparisons in tables when they help; "Limitações" (gaps, conflicting sources, old data); "Fontes".
Citations: numbered [1], [2] in order of first use, placed after the claim; the "Fontes" section is a markdown numbered list, one source per line ("1. Page title — URL"), once per URL. Never cite a URL that is not in the notes. Keep numbers and dates exactly as in the notes.
Plain, specific prose for a busy reader. Reply with the report only, in markdown.

NOTES
${notes}`;

const checkerPrompt = (draft: string, notes: string) => `Compare the REPORT with the NOTES it was written from. List claims in the report (numbers, dates, names, specific facts) that the notes do not support, or that cite the wrong source.
Reply ONLY with a JSON array: [{"claim": "<short quote from the report>", "issue": "<why>"}]. Reply [] when every claim is supported.

REPORT
${draft}

NOTES
${notes}`;

const deliverNote = (spec: ResearchSpec, report: string, issues: Checkpoint["issues"]) =>
	`This is the finished deep research run the user started earlier in this conversation. Post the report below as your answer, as written, with two changes: ` +
	(issues?.length ? `fix or remove these claims the checker found unsupported (${issues.map((i) => `"${i.claim}": ${i.issue}`).join("; ")}), keeping the numbering of the sources consistent; ` : "") +
	`and nothing else; keep the "Fontes" section as a numbered list, one source per line. Do not search the web again.` +
	(spec.format === "docx" ? " Then also save it as a Word document in outputs/ (docx skill), and mention the file in one line." : spec.format === "pdf" ? " Then also save it as a PDF in outputs/ with generate_pdf, and mention the file in one line." : "") +
	`\n\nREPORT\n${report}`;

function parseIssues(text: string): Checkpoint["issues"] {
	const m = /\[[\s\S]*\]/.exec(text);
	if (!m) return [];
	try {
		const v = JSON.parse(m[0]) as { claim?: unknown; issue?: unknown }[];
		return v.filter((x) => typeof x?.claim === "string").slice(0, 15).map((x) => ({ claim: String(x.claim).slice(0, 300), issue: String(x.issue ?? "").slice(0, 300) }));
	} catch {
		return [];
	}
}

/** Notes of every sub-question, sources renamed per sub-question (Q2-S1) so they stay distinct. */
export function joinNotes(spec: ResearchSpec, notes: Record<string, string>): string {
	return spec.questions
		.map((q, i) => `### Q${i + 1}. ${q}\n${(notes[String(i)] ?? "(not read)").replace(/\[S(\d+)\]/g, `[Q${i + 1}-S$1]`)}`)
		.join("\n\n");
}

export interface ResearchDeps {
	turn: (req: TurnRequest, begin: () => AguiRun) => Promise<TurnOutcome>;
	ledger: UsageLedger;
	/** One model run outside the conversation (a fake in tests). */
	think?: (job: Job, ctx: RunContext, step: string, prompt: string, model: string, web: boolean) => Promise<string>;
}

/** A model run in a scratch folder: no conversation, web tools only when reading. Cost goes to the job. */
async function think(d: ResearchDeps, job: Job, ctx: RunContext, step: string, prompt: string, model: string, web: boolean): Promise<string> {
	const dir = join(config.tmpRoot, "research", job.id, step);
	await mkdir(dir, { recursive: true });
	try {
		const servers = web ? (await mcpServersFor(job.user)).filter((s) => s.name === "brave" || s.name === "crawlforge").map((s) => ({ ...s, exposure: "direct" as const })) : [];
		const r = await runTurn({ workspace: dir, entries: [], message: prompt, mcpServers: servers, gate: new Gate(), model, effort: "low", onEvent: () => undefined, onUsage: ctx.onUsage, signal: ctx.signal });
		await d.ledger.add(job.user, job.conversation, r.usage, { runId: job.id, kind: "job" });
		ctx.commitUsage();
		return r.text.trim();
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

export function researchRunner(d: ResearchDeps) {
	const run = d.think ?? ((job, ctx, step, prompt, model, web) => think(d, job, ctx, step, prompt, model, web));
	return async (job: Job, ctx: RunContext): Promise<{ ok: boolean; error?: string; waiting?: boolean }> => {
		const spec = parseSpec(job.prompt);
		const cp: Checkpoint = { notes: {}, ...((job.checkpoint as Checkpoint | undefined) ?? {}) };
		// 1. Read, one sub-question at a time (resumes after the last checkpointed one).
		for (const [i, q] of spec.questions.entries()) {
			if (cp.notes[String(i)]) continue;
			if (ctx.stopped()) return { ok: false, error: "stopped" };
			ctx.progress(`reading ${i + 1}/${spec.questions.length}: ${q.slice(0, 120)}`);
			// One sub-question failing (a site or MCP timeout) leaves a gap in the report, not a failed run.
			cp.notes[String(i)] = await run(job, ctx, `q${i}`, readerPrompt(spec, q), readerModel(), true).then(
				(t) => t || "No reliable source found (empty answer).",
				(e) => {
					if (ctx.signal.aborted) throw e;
					console.warn(`[research] ${job.id} q${i}: ${(e as Error).message}`);
					return `Reading failed (${(e as Error).message.slice(0, 200)}): no findings for this sub-question.`;
				},
			);
			await ctx.checkpoint(cp);
		}
		const notes = joinNotes(spec, cp.notes);
		// 2. Write.
		if (!cp.draft) {
			if (ctx.stopped()) return { ok: false, error: "stopped" };
			ctx.progress("writing");
			cp.draft = await run(job, ctx, "write", writerPrompt(spec, notes), writerModel(), false);
			if (!cp.draft) return { ok: false, error: "the writer returned an empty report" };
			await ctx.checkpoint(cp);
		}
		// 3. Check.
		if (!cp.issues) {
			if (ctx.stopped()) return { ok: false, error: "stopped" };
			ctx.progress("checking");
			cp.issues = parseIssues(await run(job, ctx, "check", checkerPrompt(cp.draft, notes), readerModel(), false));
			await ctx.checkpoint(cp);
		}
		// 4. Deliver in the conversation (busy: the runner releases the job and it resumes here).
		if (ctx.stopped()) return { ok: false, error: "stopped" };
		ctx.progress("delivering");
		const out = await d.turn(
			{
				user: job.user,
				id: job.conversation,
				message: `Relatório da pesquisa: ${spec.topic}`,
				hidden: [deliverNote(spec, cp.draft, cp.issues)],
				projectId: job.projectId,
				runId: job.id,
				kind: "job",
				background: { title: spec.topic.slice(0, 80) },
				onUsage: ctx.onUsage,
				signal: ctx.signal,
			},
			() => new AguiRun(() => undefined, job.conversation, job.id),
		);
		ctx.commitUsage();
		return out.ok ? { ok: true, waiting: out.waiting } : { ok: false, error: out.error };
	};
}
