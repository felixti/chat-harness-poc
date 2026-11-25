// Rich reply parts (docs/design.md H61, H62): a plan the user sees advance, small interactive
// surfaces in the chat (A2UI 1.0, https://a2ui.org, Apache-2.0) and the sources a reply used.
// - plan: the model keeps a checklist of the steps of a longer task; the portal shows the latest.
// - show_ui: the model sends an A2UI surface (form, cards, choices) that the portal renders with
//   the A2UI basic catalog in our theme. No code runs: only declarative components from the
//   catalog. A button's action comes back as the next user message (<a2ui_action>).
// - sources: web pages that search/crawl tools returned, listed under the reply.
import { registerHooks } from "node:module";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// --- plan ----------------------------------------------------------------------------------------

export type PlanStatus = "pending" | "in_progress" | "done";
export interface PlanStep {
	title: string;
	status: PlanStatus;
}

export function planTool(onPlan?: (steps: PlanStep[]) => void): ToolDefinition {
	return defineTool({
		name: "plan",
		label: "plan",
		description:
			"Show the user the plan of a longer task (3 to 8 steps) and update it as you work: call it once with every step " +
			"pending (the first one in_progress), then again with the whole list whenever a step is done. Steps are short, in the " +
			"user's language, and name an outcome (\"Ler a planilha de vendas\"). Do not use it for questions you answer in one or two steps.",
		promptSnippet: "plan: show and update the step list of a longer task (3-8 steps)",
		parameters: Type.Object({
			steps: Type.Array(
				Type.Object({
					title: Type.String({ description: "Short step, in the user's language" }),
					status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done")]),
				}),
				{ minItems: 1, maxItems: 8 },
			),
		}),
		async execute(_id, p) {
			const steps = (p.steps as PlanStep[]).map((s) => ({ title: String(s.title).slice(0, 120), status: s.status }));
			onPlan?.(steps);
			const done = steps.filter((s) => s.status === "done").length;
			return { content: [{ type: "text" as const, text: `Plan shown to the user (${done}/${steps.length} done).` }], details: undefined };
		},
	}) as ToolDefinition;
}

// --- show_ui (A2UI) ------------------------------------------------------------------------------

export const A2UI_CATALOG = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
/** Basic catalog components we allow. Image, Video, AudioPlayer and Modal stay out: media would
 *  load from arbitrary URLs and a modal fights the chat layout. */
export const A2UI_COMPONENTS = new Set(["Text", "Icon", "Row", "Column", "List", "Card", "Tabs", "Divider", "Button", "TextField", "CheckBox", "ChoicePicker", "Slider", "DateTimeInput"]);
const MAX_COMPONENTS = 80;
const MAX_BYTES = 40_000;
const SURFACE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
// A2UI ids are UAX #31 identifiers (no hyphens): ids the model writes are normalized, refs too.
const COMPONENT_ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

type Ref = string | unknown;
/** Enum props models often write in kebab/snake case ("space-between" -> "spaceBetween"). */
const ENUM_PROPS = ["justify", "align", "variant", "displayStyle", "direction", "axis", "fit"];
const camel = (v: unknown) => (typeof v === "string" && /[-_]/.test(v) ? v.replace(/[-_]+([a-z])/g, (_m, c: string) => c.toUpperCase()) : v);
/** "btn-text" -> "btn_text" in ids and in every child reference; enum spellings fixed. The portal
 *  applies the same to what history holds (apps/chat-web/src/UiSurface.tsx). */
export function normalizeIds<T extends Record<string, unknown>>(components: T[]): T[] {
	const fix = (id: Ref) => (typeof id === "string" ? id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(?=\d)/, "_") : id);
	return components.map((c) => {
		const out: Record<string, unknown> = { ...c, id: fix(c.id) };
		for (const k of ENUM_PROPS) if (k in c) out[k] = camel(c[k]);
		if (typeof c.child === "string") out.child = fix(c.child);
		if (Array.isArray(c.children)) out.children = c.children.map(fix);
		if (Array.isArray(c.tabs)) out.tabs = (c.tabs as Record<string, unknown>[]).map((t) => ({ ...t, child: fix(t.child) }));
		return out as T;
	});
}

type Component = { id?: unknown; component?: unknown; [k: string]: unknown };

/** Checks what the renderer cannot recover from; returns the problems in plain words. */
export function checkSurface(components: Component[], data: unknown): string[] {
	const errs: string[] = [];
	if (!Array.isArray(components) || !components.length) return ["`components` must be a non-empty array"];
	if (components.length > MAX_COMPONENTS) errs.push(`at most ${MAX_COMPONENTS} components (got ${components.length})`);
	if (JSON.stringify({ components, data }).length > MAX_BYTES) errs.push(`the surface is larger than ${MAX_BYTES / 1000} KB; make it smaller`);
	const ids = new Set<string>();
	for (const c of components) {
		const id = typeof c?.id === "string" ? c.id : "";
		if (!COMPONENT_ID.test(id)) errs.push(`bad component id ${JSON.stringify(c?.id)}`);
		else if (ids.has(id)) errs.push(`duplicate component id "${id}"`);
		ids.add(id);
		if (typeof c?.component !== "string" || !A2UI_COMPONENTS.has(c.component)) errs.push(`component "${id}": type ${JSON.stringify(c?.component)} is not available (use ${[...A2UI_COMPONENTS].join(", ")})`);
	}
	if (!ids.has("root")) errs.push('one component must have id "root" (the top of the tree)');
	// Every child reference must exist (child, children, trigger/content, tabs[].child).
	const refs = (c: Component): string[] => {
		const out: string[] = [];
		if (typeof c.child === "string") out.push(c.child);
		if (Array.isArray(c.children)) out.push(...c.children.filter((x): x is string => typeof x === "string"));
		if (Array.isArray(c.tabs)) for (const t of c.tabs as { child?: unknown }[]) if (typeof t?.child === "string") out.push(t.child);
		return out;
	};
	for (const c of components) for (const r of refs(c)) if (!ids.has(r)) errs.push(`component "${String(c.id)}" refers to missing child "${r}"`);
	for (const c of components)
		if (c.component === "Button") {
			const a = c.action as { event?: { name?: unknown } } | undefined;
			if (!a?.event || typeof a.event.name !== "string") errs.push(`button "${String(c.id)}" needs action: {event: {name, context}}`);
		}
	if (data !== undefined && (typeof data !== "object" || data === null || Array.isArray(data))) errs.push("`data` must be an object");
	return [...new Set(errs)].slice(0, 12);
}

/** The A2UI 1.0 messages for one surface (what the portal and any A2UI renderer consume). */
export function surfaceMessages(surfaceId: string, components: Component[], data?: Record<string, unknown>) {
	return [
		{ version: "1.0", createSurface: { surfaceId, catalogId: A2UI_CATALOG } },
		{ version: "1.0", updateComponents: { surfaceId, components } },
		...(data && Object.keys(data).length ? [{ version: "1.0", updateDataModel: { surfaceId, path: "/", value: data } }] : []),
	];
}

const SHOW_UI_DESCRIPTION = `Show a small interactive surface inside the chat, built from A2UI 1.0 basic-catalog components: a form the user fills in, option cards to compare, a checklist, a confirmation with the values to review. The portal renders it in its own style; you only send data, never code or HTML.
Use it for a form filled in once whose values come back to you so you can act on them: the user asks for a form, or you need several structured values (a request form, a booking, filters, an order to confirm). Use ask_user for 1-3 quick questions. Use canvas instead when the user wants a tool they keep using, with state that stays on screen: to-do and shopping lists, checklists ticked over time, calculators, simulators, charts.

Format: a flat list of components; each has a unique "id" and "component" (type). One has id "root". Containers point at children by id.
- Text {text, variant?: "body"|"caption"} (text supports markdown: "## Title", **bold**)
- Row / Column {children: [ids], justify?: "start"|"center"|"end"|"spaceBetween"|"spaceAround"|"spaceEvenly"|"stretch", align?: "start"|"center"|"end"|"stretch"} · List {children, direction?} · Card {child} · Divider {} · Tabs {tabs: [{title, child}]} · Icon {name}
- TextField {label, value: {"@path": "/form/x"}, placeholder?, variant?: "shortText"|"longText"|"number"|"obscured"}
- CheckBox {label, value: {"@path": "/form/ok"}} · Slider {label, min, max, value: {"@path": ...}}
- DateTimeInput {label, value: {"@path": "/form/date"}, enableDate?, enableTime?}
- ChoicePicker {label, options: [{label, value}], value: {"@path": "/form/opts"}, variant?: "mutuallyExclusive"|"multipleSelection", displayStyle?: "checkbox"|"chips"}
- Button {child: "<id of a Text>", variant?: "primary"|"default"|"borderless", action: {event: {name: "submit", context: {"field": {"@path": "/form/x"}}}}}
Start with a Card as root so the surface has a frame. Inputs bind to "data" (the initial values) through {"@path": "/..."}; a button's context sends the bound values back. Required fields: add "@checks": [{"condition": {"call": "required", "args": {"value": {"@path": "/form/x"}}}, "message": "Obrigatório"}].
When the user presses a button you get their next message as <a2ui_action surface="..." name="...">{context JSON}</a2ui_action>: act on those values. Labels in the user's language. Keep it small: one card, at most about 8 inputs.`;

// The renderer's own check (@a2ui/web_core, same version as the portal): what it rejects, the model
// hears about and fixes, instead of the user seeing "Não consegui mostrar este formulário".
// A2UI is written against the zod 3 API; zod is 4.6.7 here (3.x has a HIGH advisory), whose
// zod/v3 entry is that API. Only imports from @a2ui packages are redirected.
let hooked = false;
async function rendererCheck(messages: unknown[]): Promise<string | undefined> {
	if (!hooked) {
		hooked = true;
		registerHooks({ resolve: (spec, ctx, next) => next(spec === "zod" && ctx.parentURL?.includes("/@a2ui/") ? "zod/v3" : spec, ctx) });
	}
	const { MessageProcessor } = await import("@a2ui/web_core");
	const { basicCatalog } = await import("@a2ui/web_core/catalogs/basic/v1");
	try {
		new MessageProcessor([basicCatalog]).processMessages(messages as never);
		return undefined;
	} catch (e) {
		return (e as Error).message.slice(0, 600);
	}
}

export function showUiTool(onSurface?: (s: { surfaceId: string; title?: string; messages: unknown[] }) => void): ToolDefinition {
	return defineTool({
		name: "show_ui",
		label: "show_ui",
		description: SHOW_UI_DESCRIPTION,
		promptSnippet: "show_ui: show a small interactive form/cards in the chat (A2UI); the user's input comes back as the next message",
		parameters: Type.Object({
			surface_id: Type.String({ description: "slug, e.g. pedido-ferias; reuse it to replace a surface you showed before" }),
			title: Type.Optional(Type.String({ description: "Short label shown above the surface (do not repeat it as a heading inside)" })),
			components: Type.Array(Type.Any(), { description: "A2UI components (see the description)" }),
			data: Type.Optional(Type.Any({ description: "Initial data model, e.g. {form: {name: ''}}" })),
		}),
		async execute(_id, p) {
			const surfaceId = String(p.surface_id ?? "");
			if (!SURFACE_ID.test(surfaceId)) throw new Error("surface_id must be a lowercase slug (a-z, 0-9, -)");
			// Some models send the list and the data model as JSON strings.
			const parsed = (v: unknown) => {
				if (typeof v !== "string") return v;
				try {
					return JSON.parse(v) as unknown;
				} catch {
					return v; // reported below
				}
			};
			const raw = parsed(p.components);
			const components = Array.isArray(raw) ? normalizeIds(raw as Component[]) : (raw as Component[]);
			const data = parsed(p.data) as Record<string, unknown> | undefined;
			const errs = checkSurface(components, data);
			if (errs.length) throw new Error(`The surface was not shown. Fix and call show_ui again with the whole surface:\n- ${errs.join("\n- ")}`);
			const messages = surfaceMessages(surfaceId, components, data);
			const rejected = await rendererCheck(messages);
			if (rejected) throw new Error(`The surface was not shown: the A2UI renderer rejected it. Fix and call show_ui again with the whole surface:\n- ${rejected}`);
			onSurface?.({ surfaceId, title: typeof p.title === "string" ? p.title.slice(0, 120) : undefined, messages });
			return { content: [{ type: "text" as const, text: `Surface "${surfaceId}" is on screen. Wait for the user: their input arrives as the next message. Do not describe the form again in text.` }], details: undefined };
		},
	}) as ToolDefinition;
}

/** The user's button press, as the portal sends it in the next message. */
export const A2UI_ACTION = /^<a2ui_action surface="([a-z0-9-]+)" name="([^"]{1,64})">([\s\S]*)<\/a2ui_action>$/;

// --- sources ----------------------------------------------------------------------------------

export interface Source {
	url: string;
	title: string;
}

/** Tools whose results are web pages the reply may rest on. */
export const isSourceTool = (name: string) => /^mcp__(brave|crawlforge)__/.test(name);
/** Tools that read pages (not just list search hits): their pages come first. */
const readsPages = (name: string) => /(scrape|extract|ask|agent_run|research|llm_context)$/.test(name);

/** Sources of one reply: pages actually read first, then search hits; at most `max`. */
export class SourceList {
	private read = new Map<string, Source>();
	private hits = new Map<string, Source>();
	private readonly max: number;
	constructor(max = 12) {
		this.max = max;
	}
	/** Adds the pages of one tool result; true when the visible list changed. */
	add(toolName: string, text: string): boolean {
		const before = JSON.stringify(this.list());
		const target = readsPages(toolName) ? this.read : this.hits;
		for (const s of extractSources(text, 30)) if (!target.has(s.url)) target.set(s.url, s);
		return JSON.stringify(this.list()) !== before;
	}
	list(): Source[] {
		const out = [...this.read.values()];
		for (const s of this.hits.values()) if (!this.read.has(s.url)) out.push(s);
		return out.slice(0, this.max);
	}
}

/** Pages (url + title) found in a search/crawl tool result; JSON first, then markdown links. */
export function extractSources(text: string, max = 12): Source[] {
	const out = new Map<string, Source>();
	const add = (url: unknown, title: unknown) => {
		if (typeof url !== "string" || !/^https?:\/\//i.test(url) || out.size >= max) return;
		const u = url.replace(/[)\].,;]+$/, "");
		if (!out.has(u)) out.set(u, { url: u, title: typeof title === "string" && title.trim() ? title.trim().slice(0, 160) : new URL(u).hostname.replace(/^www\./, "") });
	};
	const walk = (v: unknown, depth: number) => {
		if (depth > 6 || out.size >= max || !v || typeof v !== "object") return;
		if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
		const o = v as Record<string, unknown>;
		if (typeof o.url === "string") add(o.url, o.title ?? o.name);
		for (const k of Object.keys(o)) if (k !== "url") walk(o[k], depth + 1);
	};
	for (const chunk of text.split(/\n(?=[{[])/)) {
		try {
			walk(JSON.parse(chunk), 0);
		} catch {
			/* not JSON */
		}
	}
	// Truncated JSON (long results are cut): pair each "url" with the nearest "title".
	if (!out.size)
		for (const m of text.matchAll(/"url"\s*:\s*"(https?:\/\/[^"]+)"/g)) {
			const near = text.slice(Math.max(0, (m.index ?? 0) - 400), (m.index ?? 0) + 400);
			add(m[1], /"title"\s*:\s*"([^"]{1,160})"/.exec(near)?.[1]);
		}
	if (!out.size) for (const m of text.matchAll(/\[([^\]]{1,160})\]\((https?:\/\/[^\s)]+)\)/g)) add(m[2], m[1]);
	return [...out.values()];
}
