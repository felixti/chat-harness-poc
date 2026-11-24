// Rich reply parts (H61, H62): the model's reasoning, the plan of a longer task, the web sources a
// reply used, and small interactive surfaces (A2UI 1.0 basic catalog, Apache-2.0) in our theme.
import { lazy, useState } from "react";
import { Check, ChevronRight, Circle, ExternalLink, Globe, Loader2, Sparkles } from "lucide-react";
import type { Source, ToolStep } from "./api";

export function Reasoning({ text, live }: { text: string; live: boolean }) {
	const [open, setOpen] = useState(false);
	if (!text.trim()) return null;
	return (
		<div className="reasoning">
			<button type="button" className="steps-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
				<ChevronRight size={14} className="chev" />
				<span className={`label${live ? " running-label" : ""}`}>{live ? "Pensando…" : "Raciocínio"}</span>
			</button>
			{open && <div className="reasoning-body">{text}</div>}
		</div>
	);
}

const host = (u: string) => {
	try {
		return new URL(u).hostname.replace(/^www\./, "");
	} catch {
		return u;
	}
};

export function Sources({ sources }: { sources: Source[] }) {
	const [all, setAll] = useState(false);
	if (!sources.length) return null;
	const shown = all ? sources : sources.slice(0, 4);
	return (
		<div className="sources" aria-label="Fontes">
			<span className="sources-head">
				<Globe size={13} /> Fontes
			</span>
			<ol>
				{shown.map((s, i) => (
					<li key={s.url}>
						<a href={s.url} target="_blank" rel="noopener noreferrer nofollow" title={s.url}>
							<span className="n">{i + 1}</span>
							<span className="t">{s.title}</span>
							<span className="h">{host(s.url)}</span>
							<ExternalLink size={12} aria-hidden="true" />
						</a>
					</li>
				))}
			</ol>
			{sources.length > 4 && (
				<button type="button" className="link-btn" onClick={() => setAll((v) => !v)}>
					{all ? "Mostrar menos" : `Mostrar todas (${sources.length})`}
				</button>
			)}
		</div>
	);
}

type PlanStep = { title: string; status: "pending" | "in_progress" | "done" };

/** The latest plan the model sent in this reply. */
export function planOf(steps: ToolStep[]): PlanStep[] | undefined {
	for (let i = steps.length - 1; i >= 0; i--) {
		const s = steps[i];
		const list = (s.args as { steps?: PlanStep[] })?.steps;
		if (s.name === "plan" && !s.isError && Array.isArray(list) && list.length) return list;
	}
	return undefined;
}

export function PlanCard({ steps, live }: { steps: PlanStep[]; live: boolean }) {
	const done = steps.filter((s) => s.status === "done").length;
	return (
		<div className="plan-card" aria-label="Plano">
			<div className="plan-head">
				<Sparkles size={14} /> Plano <span className="muted">· {done} de {steps.length}</span>
			</div>
			<ol>
				{steps.map((s, i) => (
					<li key={i} className={s.status}>
						<span className="mark" aria-hidden="true">
							{s.status === "done" ? <Check size={13} /> : s.status === "in_progress" && live ? <Loader2 size={13} className="spin" /> : <Circle size={11} />}
						</span>
						<span>{s.title}</span>
						<span className="sr-only">{s.status === "done" ? "(feito)" : s.status === "in_progress" ? "(em andamento)" : "(pendente)"}</span>
					</li>
				))}
			</ol>
		</div>
	);
}

// --- A2UI ---------------------------------------------------------------------------------------

export interface UiArgs {
	surface_id: string;
	title?: string;
	components: unknown[];
	data?: Record<string, unknown>;
}

/** Surfaces shown in this reply (successful show_ui calls); a later call with the same id replaces it. */
export function surfacesOf(steps: ToolStep[]): UiArgs[] {
	const out = new Map<string, UiArgs>();
	for (const s of steps) {
		const a = s.args as UiArgs | undefined;
		if (s.name !== "show_ui" || s.isError || s.running || !a?.surface_id || !Array.isArray(a.components)) continue;
		out.set(a.surface_id, a);
	}
	return [...out.values()];
}

/** The text the portal sends when a surface button is pressed (read by the model, see ui-tools.ts). */
export const actionMessage = (surface: string, name: string, context: Record<string, unknown>) =>
	`<a2ui_action surface="${surface}" name="${name.replace(/[^\w .-]/g, "").slice(0, 64)}">${JSON.stringify(context)}</a2ui_action>`;

const ACTION = /^<a2ui_action surface="([a-z0-9-]+)" name="([^"]{1,64})">([\s\S]*)<\/a2ui_action>$/;
export function parseAction(text: string): { surface: string; name: string; context: Record<string, unknown> } | undefined {
	const m = ACTION.exec(text.trim());
	if (!m) return undefined;
	try {
		return { surface: m[1], name: m[2], context: JSON.parse(m[3]) as Record<string, unknown> };
	} catch {
		return { surface: m[1], name: m[2], context: {} };
	}
}

const fmt = (v: unknown): string => (Array.isArray(v) ? v.map(fmt).join(", ") : typeof v === "boolean" ? (v ? "sim" : "não") : v && typeof v === "object" ? JSON.stringify(v) : String(v ?? ""));

/** How a surface submission looks in the user's bubble. */
export function ActionSummary({ action }: { action: NonNullable<ReturnType<typeof parseAction>> }) {
	const entries = Object.entries(action.context).filter(([, v]) => v !== "" && v !== undefined && v !== null);
	return (
		<div className="action-summary">
			<div className="action-title">
				<Check size={14} /> Enviado
			</div>
			{entries.length > 0 && (
				<dl>
					{entries.slice(0, 12).map(([k, v]) => (
						<div key={k}>
							<dt>{k.replace(/[_-]/g, " ")}</dt>
							<dd>{fmt(v)}</dd>
						</div>
					))}
				</dl>
			)}
		</div>
	);
}

/** The A2UI renderer (lit, markdown-it, zod) loads only when a reply has a surface. */
export const UiSurface = lazy(() => import("./UiSurface"));
