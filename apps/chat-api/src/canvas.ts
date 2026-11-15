// Canvas (docs/design.md H52): live interactive pages in a side panel of the portal. The model
// writes an HTML fragment (markup, <style>, <script>); the portal wraps it with the theme, Apache
// ECharts and a tiny runtime, and runs it in a sandboxed frame with no network (CSP). Every save is
// a new version; values the user sets in the page (checklist marks, inputs) persist as state that
// the model reads back. Files live with the conversation, under work/canvas/<name>/.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { objectStore } from "./workspace.ts";

export const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_HTML = 400_000;
export const MAX_STATE = 256_000;
const MAX_VERSIONS = 30;

export interface CanvasMeta {
	name: string;
	title: string;
	versions: { v: number; at: string; note?: string }[];
}

export interface CanvasEvent {
	name: string;
	title: string;
	version: number;
	html: string;
}

const dirOf = (cwd: string, name: string) => join(cwd, "work", "canvas", name);

/** A whole document pasted by the model -> the parts the wrapper needs (head styles + body). */
export function toFragment(html: string): string {
	if (!/<(html|body|head)[\s>]/i.test(html)) return html.trim();
	const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? "";
	const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html.replace(/<!doctype[^>]*>|<\/?html[^>]*>|<head[\s\S]*?<\/head>/gi, "");
	// Keep styles and scripts from <head>; meta/title/link (no network anyway) are dropped.
	const keep = (head.match(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi) ?? []).join("\n");
	return `${keep}\n${body}`.trim();
}

async function readMeta(cwd: string, name: string): Promise<CanvasMeta | undefined> {
	try {
		return JSON.parse(await readFile(join(dirOf(cwd, name), "meta.json"), "utf8")) as CanvasMeta;
	} catch {
		return undefined;
	}
}

async function save(cwd: string, name: string, title: string | undefined, html: string, note?: string): Promise<CanvasEvent> {
	const dir = dirOf(cwd, name);
	await mkdir(dir, { recursive: true });
	const meta: CanvasMeta = (await readMeta(cwd, name)) ?? { name, title: title ?? name, versions: [] };
	if (title) meta.title = title.slice(0, 120);
	const v = (meta.versions.at(-1)?.v ?? 0) + 1;
	meta.versions = [...meta.versions, { v, at: new Date().toISOString(), ...(note ? { note: note.slice(0, 160) } : {}) }].slice(-MAX_VERSIONS);
	await writeFile(join(dir, `v${v}.html`), html);
	await writeFile(join(dir, "meta.json"), JSON.stringify(meta));
	return { name, title: meta.title, version: v, html };
}

async function latest(cwd: string, name: string): Promise<{ meta: CanvasMeta; html: string } | undefined> {
	const meta = await readMeta(cwd, name);
	const v = meta?.versions.at(-1)?.v;
	if (!meta || !v) return undefined;
	return { meta, html: await readFile(join(dirOf(cwd, name), `v${v}.html`), "utf8") };
}

async function readState(cwd: string, name: string): Promise<string> {
	const p = join(dirOf(cwd, name), "state.json");
	return existsSync(p) ? await readFile(p, "utf8") : "{}";
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
const fail = (text: string) => {
	throw new Error(text);
};

/** The canvas tool. `emit` streams each saved version to the portal (the files reach Blob only at
 *  the end of the turn, so the panel updates from the event, not from storage). */
export function canvasTool(cwd: string, emit: (e: CanvasEvent) => void): ToolDefinition {
	return defineTool({
		name: "canvas",
		label: "canvas",
		description:
			"Create or change an interactive page shown live in a side panel of the chat: calculators, simulators, " +
			"interactive charts, checklists, timelines, step-by-step guides, forms, small tools. Read the canvas skill " +
			"first. Actions: create (new page, full HTML fragment), edit (exact text replacements on the latest " +
			"version; prefer it for small changes), update (replace the whole page), read (latest code plus the values " +
			"the user set in it, e.g. checked items). Every create/edit/update is a new version the user can go back to. " +
			"Not for data dashboards from Excel/CSV files (use the dashboard skill) or documents to download.",
		promptSnippet: "canvas: live interactive page in a side panel (create/edit/update/read)",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("create"), Type.Literal("edit"), Type.Literal("update"), Type.Literal("read")]),
			name: Type.String({ description: "slug, e.g. simulador-roi (lowercase, digits, hyphens)" }),
			title: Type.Optional(Type.String({ description: "title shown to the user, in their language" })),
			html: Type.Optional(Type.String({ description: "create/update: HTML fragment (markup, <style>, <script>); no <html>/<head> needed" })),
			edits: Type.Optional(Type.Array(Type.Object({ old: Type.String(), new: Type.String() }), { description: "edit: each old text must occur exactly once" })),
			note: Type.Optional(Type.String({ description: "what changed in this version, a few words" })),
		}),
		async execute(_id, p) {
			if (!NAME.test(p.name)) fail("name: lowercase letters, digits and hyphens, up to 48 characters");
			if (p.action === "read") {
				const cur = await latest(cwd, p.name);
				if (!cur) fail(`no canvas named ${p.name} in this conversation`);
				const state = await readState(cwd, p.name);
				return ok(`Canvas "${cur!.meta.title}" v${cur!.meta.versions.at(-1)!.v}.\nState saved by the user (JSON):\n${state.slice(0, 20_000)}\n\nCode:\n${cur!.html.slice(0, 60_000)}`);
			}
			let html: string;
			if (p.action === "edit") {
				const cur = await latest(cwd, p.name);
				if (!cur) fail(`no canvas named ${p.name}: use create`);
				if (!p.edits?.length) fail("edit needs edits: [{old, new}]");
				html = cur!.html;
				for (const [i, e] of p.edits!.entries()) {
					const n = html.split(e.old).length - 1;
					if (n !== 1) fail(`edit ${i + 1}: the old text occurs ${n} times (must be exactly once). Use read to see the code.`);
					html = html.replace(e.old, () => e.new);
				}
			} else {
				if (!p.html?.trim()) fail(`${p.action} needs html`);
				if (p.action === "create" && (await readMeta(cwd, p.name))) fail(`${p.name} already exists: use edit or update`);
				html = toFragment(p.html!);
			}
			if (html.length > MAX_HTML) fail(`page too large (${html.length} chars; max ${MAX_HTML})`);
			const saved = await save(cwd, p.name, p.title, html, p.note);
			emit(saved);
			return ok(`Canvas "${saved.title}" saved as version ${saved.version} and shown to the user in the side panel. Reply in one or two sentences: what it does and how to use it. Do not paste the code.`);
		},
	}) as ToolDefinition;
}

// --- portal routes (state and versions after the turn, from Blob) --------------------------------

const key = (user: string, conv: string, name: string, file: string) => `${user}/${conv}/work/canvas/${name}/${file}`;

export async function listCanvases(user: string, conv: string): Promise<CanvasMeta[]> {
	const files = await objectStore().list(`${user}/${conv}/work/canvas/`);
	const names = [...new Set(files.map((f) => f.path.split("/")[0]).filter((n) => NAME.test(n)))];
	const out: CanvasMeta[] = [];
	for (const n of names) {
		const raw = await objectStore().get(key(user, conv, n, "meta.json"));
		if (raw) out.push(JSON.parse(raw.toString()) as CanvasMeta);
	}
	return out;
}

export async function getCanvas(user: string, conv: string, name: string, version?: number) {
	const raw = await objectStore().get(key(user, conv, name, "meta.json"));
	if (!raw) return undefined;
	const meta = JSON.parse(raw.toString()) as CanvasMeta;
	const v = version && meta.versions.some((x) => x.v === version) ? version : meta.versions.at(-1)?.v;
	const html = v ? await objectStore().get(key(user, conv, name, `v${v}.html`)) : undefined;
	const state = await objectStore().get(key(user, conv, name, "state.json"));
	return { ...meta, version: v, html: html?.toString() ?? "", state: state ? (JSON.parse(state.toString()) as unknown) : {} };
}

export async function putState(user: string, conv: string, name: string, state: unknown) {
	const data = Buffer.from(JSON.stringify(state ?? {}));
	if (data.length > MAX_STATE) throw Object.assign(new Error("state too large"), { status: 413 });
	await objectStore().put(key(user, conv, name, "state.json"), data);
}
