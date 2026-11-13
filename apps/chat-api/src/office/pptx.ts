// Deck spec (JSON) -> PPTX with pptxgenjs, in process (no subprocess, no LibreOffice).
// Design quality lives here, not in the model: a fixed 16:9 grid, a type scale, curated themes,
// layout recipes, text fitting and lint warnings. The model only chooses content and layouts
// (skills `pptx` and `design` teach it how).
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createRequire } from "node:module";
import { addIcon, hasIcon, suggestIcons } from "./icons.ts";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PptxGenJS: any = require("pptxgenjs");

// ---------- spec ----------

export interface Theme {
	bg: string; // content slide background
	surface: string; // cards, table zebra
	ink: string; // main text
	muted: string; // secondary text, axes
	accent: string; // titles bar, highlights, cover background
	accent2: string; // second highlight
	onAccent: string; // text on accent background
	line: string; // hairlines, grid
	chart: string[]; // series colors, in order
	headFont: string;
	bodyFont: string;
	/** Dark themes: covers stay on the dark background with accent details (a bright full-bleed accent is too loud). */
	darkCover?: boolean;
}

export const THEMES: Record<string, Theme> = {
	executive: {
		bg: "FFFFFF", surface: "F2F4F7", ink: "1D2939", muted: "667085", accent: "0B3B75", accent2: "0E9384",
		onAccent: "FFFFFF", line: "D0D5DD", chart: ["0B3B75", "0E9384", "F79009", "7A5AF8", "EE46BC", "98A2B3"],
		headFont: "Aptos Display", bodyFont: "Aptos",
	},
	midnight: {
		bg: "0F172A", surface: "1E293B", ink: "E2E8F0", muted: "94A3B8", accent: "38BDF8", accent2: "A78BFA",
		onAccent: "0F172A", line: "334155", chart: ["38BDF8", "A78BFA", "34D399", "FBBF24", "F472B6", "94A3B8"],
		headFont: "Aptos Display", bodyFont: "Aptos", darkCover: true,
	},
	warm: {
		bg: "FFFBF5", surface: "F5EDE3", ink: "292524", muted: "78716C", accent: "C2410C", accent2: "0F766E",
		onAccent: "FFFFFF", line: "E7DCCF", chart: ["C2410C", "0F766E", "CA8A04", "6D28D9", "BE185D", "A8A29E"],
		headFont: "Georgia", bodyFont: "Aptos",
	},
	mono: {
		bg: "FFFFFF", surface: "F4F4F5", ink: "18181B", muted: "71717A", accent: "18181B", accent2: "E11D48",
		onAccent: "FFFFFF", line: "E4E4E7", chart: ["18181B", "E11D48", "71717A", "A1A1AA", "D4D4D8", "F43F5E"],
		headFont: "Aptos Display", bodyFont: "Aptos",
	},
	fresh: {
		bg: "FFFFFF", surface: "ECFDF3", ink: "101828", muted: "475467", accent: "067647", accent2: "2E90FA",
		onAccent: "FFFFFF", line: "D0D5DD", chart: ["067647", "2E90FA", "FDB022", "9E77ED", "F04438", "98A2B3"],
		headFont: "Aptos Display", bodyFont: "Aptos",
	},
	// Palettes below adapted from minimax-ai/skills pptx-generator design-system.md (MIT).
	tech_night: {
		bg: "000814", surface: "001D3D", ink: "E8EEF6", muted: "8DA2BC", accent: "FFC300", accent2: "4CC9F0",
		onAccent: "000814", line: "17325A", chart: ["FFC300", "4CC9F0", "F72585", "7BD389", "B8C0FF", "8DA2BC"],
		headFont: "Aptos Display", bodyFont: "Aptos", darkCover: true,
	},
	authority: {
		bg: "FFFFFF", surface: "EDF2F4", ink: "2B2D42", muted: "6C7489", accent: "2B2D42", accent2: "EF233C",
		onAccent: "FFFFFF", line: "D5DBE1", chart: ["2B2D42", "EF233C", "8D99AE", "F4A261", "2A9D8F", "C0C7D1"],
		headFont: "Georgia", bodyFont: "Aptos",
	},
	wellness: {
		bg: "FFFFFF", surface: "EDF6F9", ink: "1F3B40", muted: "5E7C80", accent: "006D77", accent2: "E29578",
		onAccent: "FFFFFF", line: "CFE3E6", chart: ["006D77", "E29578", "83C5BE", "FFDDD2", "3D5A80", "A3B8BB"],
		headFont: "Georgia", bodyFont: "Aptos",
	},
	eco: {
		bg: "FBFAF5", surface: "ECEFE4", ink: "263A2E", muted: "66755F", accent: "344E41", accent2: "DDA15E",
		onAccent: "FFFFFF", line: "DAD7CD", chart: ["344E41", "588157", "A3B18A", "DDA15E", "BC6C25", "B7B7A4"],
		headFont: "Georgia", bodyFont: "Aptos",
	},
	luxury: {
		bg: "F7F3F0", surface: "EDE4DF", ink: "22223B", muted: "6E6A80", accent: "22223B", accent2: "B08968",
		onAccent: "F2E9E4", line: "DCD2CC", chart: ["22223B", "B08968", "4A4E69", "9A8C98", "C9ADA7", "D6CCC2"],
		headFont: "Georgia", bodyFont: "Aptos",
	},
	coastal: {
		bg: "FFFFFF", surface: "F1FAF9", ink: "123B47", muted: "5B7C85", accent: "0081A7", accent2: "F07167",
		onAccent: "FFFFFF", line: "D3E9EC", chart: ["0081A7", "F07167", "00AFB9", "FED9B7", "FDB833", "9FB7BD"],
		headFont: "Aptos Display", bodyFont: "Aptos",
	},
	insight: {
		bg: "FFFFFF", surface: "F4F1EA", ink: "1E2F36", muted: "5F6F75", accent: "264653", accent2: "E76F51",
		onAccent: "FFFFFF", line: "DDD8CC", chart: ["264653", "2A9D8F", "E9C46A", "F4A261", "E76F51", "9AA5A8"],
		headFont: "Aptos Display", bodyFont: "Aptos",
	},
	platinum: {
		bg: "FFFFFF", surface: "F5F5F5", ink: "0A0A0A", muted: "737373", accent: "0A0A0A", accent2: "D4AF37",
		onAccent: "FFFFFF", line: "E5E5E5", chart: ["0A0A0A", "0070F3", "D4AF37", "737373", "A3A3A3", "D4D4D4"],
		headFont: "Aptos Display", bodyFont: "Aptos",
	},
};

type Bullet = string | { text: string; sub?: string[] };
type ChartType = "bar" | "column" | "stacked_bar" | "stacked_column" | "line" | "area" | "pie" | "doughnut";

export interface SlideSpec {
	layout: string;
	title?: string;
	kicker?: string; // small uppercase label above the title
	subtitle?: string;
	notes?: string; // speaker notes
	source?: string; // footer source line
	[k: string]: unknown;
}

export interface DeckSpec {
	title: string;
	author?: string;
	date?: string;
	theme?: string;
	brand?: { accent?: string; accent2?: string; headFont?: string; bodyFont?: string; dark?: boolean };
	footer?: string;
	slides: SlideSpec[];
}

// ---------- grid (inches, 16:9 = 13.333 x 7.5) ----------

const W = 13.333;
const H = 7.5;
const MX = 0.65; // side margin
const CW = W - 2 * MX; // content width
const TITLE_Y = 0.42;
const BODY_Y = 1.62;
const BODY_H = 5.2;
const FOOT_Y = 7.02;

// ---------- text fitting ----------

/** Rough line count for a text at a font size inside a width (inches). Avg glyph ~0.5 em. */
function lines(text: string, pt: number, widthIn: number, em = 0.5): number {
	const perLine = Math.max(1, Math.floor((widthIn * 72) / (pt * em)));
	return text.split("\n").reduce((n, para) => n + Math.max(1, Math.ceil(para.length / perLine)), 0);
}

/** Largest size between max and min where the paragraphs fit the box; also reports overflow. */
function fit(paras: string[], widthIn: number, heightIn: number, max: number, min: number, gap = 0.5, em = 0.5): { pt: number; overflow: boolean } {
	for (let pt = max; pt >= min; pt -= 1) {
		const n = paras.reduce((s, p) => s + lines(p, pt, widthIn, em), 0);
		const h = (n * pt * 1.22 + paras.length * pt * gap) / 72;
		if (h <= heightIn) return { pt, overflow: false };
	}
	return { pt: min, overflow: true };
}

const hex = (s: string | undefined) => (s && /^#?[0-9a-f]{6}$/i.test(s) ? s.replace("#", "").toUpperCase() : undefined);

// ---------- renderer ----------

interface Ctx {
	pptx: any;
	t: Theme;
	deck: DeckSpec;
	workspace: string;
	warn: (slide: number, msg: string) => void;
	resolve: (p: string) => string;
}

function bg(slide: any, color: string) {
	slide.background = { color };
}

function footer(c: Ctx, slide: any, s: SlideSpec, n: number, onDark = false) {
	const color = onDark ? c.t.onAccent : c.t.muted;
	const src = s.source ? String(s.source).replace(/^\s*(fontes?|sources?)\s*:\s*/i, "") : "";
	const left = [src ? `Fonte: ${src}` : "", c.deck.footer ?? ""].filter(Boolean).join("   ·   ");
	if (left) slide.addText(left, { x: MX, y: FOOT_Y, w: CW - 1, h: 0.3, fontFace: c.t.bodyFont, fontSize: 9, color, margin: 0 });
	slide.addText(String(n), { x: W - MX - 0.8, y: FOOT_Y, w: 0.8, h: 0.3, fontFace: c.t.bodyFont, fontSize: 9, color, align: "right", margin: 0 });
}

function header(c: Ctx, slide: any, s: SlideSpec, n: number, width = CW) {
	let y = TITLE_Y;
	if (s.kicker) {
		slide.addText(String(s.kicker).toUpperCase(), { x: MX, y, w: width, h: 0.3, fontFace: c.t.bodyFont, fontSize: 11, bold: true, color: c.t.accent, charSpacing: 1.5, margin: 0 });
		y += 0.32;
	}
	const title = s.title ?? "";
	if (title.length > 90) c.warn(n, `title has ${title.length} chars; keep action titles under ~90`);
	const f = fit([title], width, s.kicker ? 0.8 : 1.05, 30, 20, 0, 0.56);
	if (f.overflow) c.warn(n, "title does not fit in two lines; shorten it");
	slide.addText(title, { x: MX, y, w: width, h: s.kicker ? 0.85 : 1.05, fontFace: c.t.headFont, fontSize: f.pt, bold: true, color: c.t.ink, valign: "top", margin: 0, fit: "shrink" });
	if (s.subtitle) slide.addText(String(s.subtitle), { x: MX, y: BODY_Y - 0.42, w: width, h: 0.36, fontFace: c.t.bodyFont, fontSize: 14, color: c.t.muted, margin: 0 });
}

function bulletRuns(c: Ctx, items: Bullet[], pt: number, color: string) {
	const runs: any[] = [];
	for (const b of items) {
		const text = typeof b === "string" ? b : b.text;
		runs.push({ text: richless(text), options: { bullet: { code: "25A0", indent: pt * 1.1 }, fontSize: pt, color, paraSpaceAfter: pt * 0.55, breakLine: true, bold: false } });
		for (const sub of typeof b === "string" ? [] : (b.sub ?? [])) {
			runs.push({ text: richless(sub), options: { bullet: { indent: pt * 1.1 }, indentLevel: 1, fontSize: pt - 3, color: c.t.muted, paraSpaceAfter: pt * 0.4, breakLine: true } });
		}
	}
	return runs;
}

/** Bold runs from **markdown** inside a string (the only inline markup supported). */
function rich(text: string, base: Record<string, unknown>) {
	return text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part) =>
		part.startsWith("**") ? { text: part.slice(2, -2), options: { ...base, bold: true } } : { text: part, options: base },
	);
}
const richless = (s: string) => s.replace(/\*\*/g, "");

function bulletParas(items: Bullet[]): string[] {
	return items.flatMap((b) => (typeof b === "string" ? [b] : [b.text, ...(b.sub ?? [])]));
}

function bulletsBox(c: Ctx, slide: any, n: number, items: Bullet[], x: number, y: number, w: number, h: number, max = 22) {
	if (items.length > 6) c.warn(n, `${items.length} bullets; use at most 6 (split the slide or use two_column)`);
	for (const p of bulletParas(items)) if (p.length > 160) c.warn(n, `bullet over 160 chars: "${p.slice(0, 40)}..."`);
	const f = fit(bulletParas(items), w - 0.3, h, max, 14);
	if (f.overflow) c.warn(n, "bullets overflow the box even at 14 pt; cut text");
	slide.addText(bulletRuns(c, items, f.pt, c.t.ink), { x, y, w, h, fontFace: c.t.bodyFont, valign: "top", margin: 0, fit: "shrink" });
}

function card(c: Ctx, slide: any, x: number, y: number, w: number, h: number, fill = c.t.surface) {
	slide.addShape(c.pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: fill }, line: { color: fill }, rectRadius: 0.08 });
}

/** Lucide icon by name; unknown names become a lint warning with suggestions. */
function icon(c: Ctx, slide: any, n: number, name: unknown, x: number, y: number, size: number, color: string): boolean {
	if (!name) return false;
	const nm = String(name);
	if (!hasIcon(nm)) {
		c.warn(n, `unknown icon "${nm}"${suggestIcons(nm).length ? ` (try: ${suggestIcons(nm).join(", ")})` : ""}`);
		return false;
	}
	return addIcon(c.pptx, slide, nm, x, y, size, color);
}

/** Icon inside a soft round badge (accent tint), used by cards, kpis, timeline. */
function badge(c: Ctx, slide: any, n: number, name: unknown, x: number, y: number, d: number, onDark = false) {
	if (!name) return false;
	slide.addShape(c.pptx.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color: onDark ? c.t.onAccent : c.t.accent, transparency: onDark ? 80 : 88 }, line: { type: "none" } });
	return icon(c, slide, n, name, x + d * 0.25, y + d * 0.25, d * 0.5, onDark ? c.t.onAccent : c.t.accent);
}

/** Background + colors for full-bleed slides (title, section, statement, closing). */
function cover(c: Ctx, slide: any): { fg: string; hi: string } {
	if (c.t.darkCover) {
		bg(slide, c.t.bg);
		rings(c, slide, c.t.accent);
		return { fg: c.t.ink, hi: c.t.accent };
	}
	bg(slide, c.t.accent);
	rings(c, slide, c.t.onAccent);
	return { fg: c.t.onAccent, hi: c.t.onAccent };
}

/** Large translucent rings bleeding off the right edge: depth without clip art. */
function rings(c: Ctx, slide: any, color: string) {
	slide.addShape(c.pptx.ShapeType.ellipse, { x: 8.6, y: -1.6, w: 7.2, h: 7.2, fill: { color, transparency: 90 }, line: { type: "none" } });
	slide.addShape(c.pptx.ShapeType.ellipse, { x: 10.4, y: 3.3, w: 5.2, h: 5.2, fill: { color, transparency: 93 }, line: { type: "none" } });
	slide.addShape(c.pptx.ShapeType.ellipse, { x: 9.3, y: -0.9, w: 5.8, h: 5.8, fill: { type: "none" }, line: { color, width: 1, transparency: 70 } });
}

const LAYOUTS: Record<string, (c: Ctx, slide: any, s: SlideSpec, n: number) => Promise<void> | void> = {
	title(c, slide, s) {
		const { fg, hi } = cover(c, slide);
		if (s.kicker) slide.addText(String(s.kicker).toUpperCase(), { x: MX, y: 1.4, w: 11, h: 0.45, fontFace: c.t.bodyFont, fontSize: 13, bold: true, color: hi, charSpacing: 2, margin: 0 });
		slide.addShape(c.pptx.ShapeType.rect, { x: MX, y: 2.05, w: 1.1, h: 0.09, fill: { color: hi }, line: { color: hi } });
		const f = fit([s.title ?? c.deck.title], 10.5, 2.2, 48, 32, 0);
		slide.addText(s.title ?? c.deck.title, { x: MX, y: 2.35, w: 10.5, h: 2.3, fontFace: c.t.headFont, fontSize: f.pt, bold: true, color: fg, valign: "top", margin: 0, fit: "shrink" });
		if (s.subtitle) slide.addText(String(s.subtitle), { x: MX, y: 4.75, w: 10.5, h: 0.9, fontFace: c.t.bodyFont, fontSize: 20, color: fg, valign: "top", margin: 0, transparency: 10 });
		const meta = [c.deck.author, c.deck.date].filter(Boolean).join("   ·   ");
		if (meta) slide.addText(meta, { x: MX, y: 6.55, w: 10, h: 0.35, fontFace: c.t.bodyFont, fontSize: 12, color: fg, margin: 0 });
	},

	section(c, slide, s, n) {
		const { fg, hi } = cover(c, slide);
		const num = (s.number as string | number | undefined) ?? "";
		if (num !== "") slide.addText(String(num).padStart(2, "0"), { x: MX, y: 1.9, w: 3, h: 1.3, fontFace: c.t.headFont, fontSize: 72, bold: true, color: hi, margin: 0, transparency: c.t.darkCover ? 0 : 35 });
		slide.addText(s.title ?? "", { x: MX, y: 3.25, w: 11, h: 1.4, fontFace: c.t.headFont, fontSize: 40, bold: true, color: fg, valign: "top", margin: 0, fit: "shrink" });
		if (s.subtitle) slide.addText(String(s.subtitle), { x: MX, y: 4.7, w: 11, h: 0.8, fontFace: c.t.bodyFont, fontSize: 18, color: fg, margin: 0 });
		footer(c, slide, { layout: "section" }, n, !c.t.darkCover);
	},

	agenda(c, slide, s, n) {
		header(c, slide, s, n);
		const items = (s.items as string[]) ?? [];
		if (items.length > 7) c.warn(n, `agenda with ${items.length} items; keep it under 7`);
		const rowH = Math.min(0.78, BODY_H / Math.max(1, items.length));
		items.forEach((it, i) => {
			const y = BODY_Y + i * rowH;
			slide.addText(String(i + 1).padStart(2, "0"), { x: MX, y, w: 0.9, h: rowH, fontFace: c.t.headFont, fontSize: 24, bold: true, color: c.t.accent, valign: "middle", margin: 0 });
			slide.addText(it, { x: MX + 1.0, y, w: CW - 1.0, h: rowH, fontFace: c.t.bodyFont, fontSize: 20, color: c.t.ink, valign: "middle", margin: 0 });
			slide.addShape(c.pptx.ShapeType.line, { x: MX + 1.0, y: y + rowH, w: CW - 1.0, h: 0, line: { color: c.t.line, width: 0.75 } });
		});
	},

	bullets(c, slide, s, n) {
		header(c, slide, s, n);
		const items = (s.bullets as Bullet[]) ?? [];
		const callout = s.callout as string | undefined;
		const w = callout ? CW * 0.6 : CW * 0.85;
		bulletsBox(c, slide, n, items, MX, BODY_Y, w, BODY_H);
		if (callout) calloutBox(c, slide, n, callout, MX + CW * 0.64, BODY_Y, CW * 0.36, 2.6);
	},

	two_column(c, slide, s, n) {
		header(c, slide, s, n);
		const cols = [s.left, s.right] as { heading?: string; bullets?: Bullet[]; text?: string }[];
		const colW = (CW - 0.5) / 2;
		cols.forEach((col, i) => {
			if (!col) return;
			const x = MX + i * (colW + 0.5);
			let y = BODY_Y;
			if (col.heading) {
				slide.addText(col.heading, { x, y, w: colW, h: 0.45, fontFace: c.t.headFont, fontSize: 18, bold: true, color: c.t.accent, margin: 0 });
				slide.addShape(c.pptx.ShapeType.line, { x, y: y + 0.5, w: colW, h: 0, line: { color: c.t.line, width: 1 } });
				y += 0.7;
			}
			if (col.bullets) bulletsBox(c, slide, n, col.bullets, x, y, colW, BODY_H - (y - BODY_Y), 20);
			else if (col.text) paragraph(c, slide, n, col.text, x, y, colW, BODY_H - (y - BODY_Y), 18);
		});
	},

	kpis(c, slide, s, n) {
		header(c, slide, s, n);
		const items = (s.items as { value: string; label: string; delta?: string; trend?: "up" | "down" | "flat"; good?: boolean; icon?: string }[]) ?? [];
		if (items.length < 2 || items.length > 4) c.warn(n, `kpis works with 2 to 4 items, got ${items.length}`);
		const k = Math.max(1, Math.min(items.length, 4));
		const gap = 0.35;
		const cw = (CW - gap * (k - 1)) / k;
		const ch = s.takeaway ? 2.6 : 3.0;
		// One size for every value, so the cards read as a set.
		const vpt = Math.min(...items.slice(0, 4).map((it) => fit([it.value], cw - (it.icon ? 1.05 : 0.6), 0.85, 54, 22, 0, 0.6).pt));
		items.slice(0, 4).forEach((it, i) => {
			const x = MX + i * (cw + gap);
			card(c, slide, x, BODY_Y + 0.2, cw, ch);
			slide.addShape(c.pptx.ShapeType.rect, { x, y: BODY_Y + 0.2, w: 0.09, h: ch, fill: { color: c.t.accent }, line: { color: c.t.accent } });
			if (it.icon) icon(c, slide, n, it.icon, x + cw - 0.75, BODY_Y + 0.45, 0.42, c.t.accent);
			slide.addText(it.value, { x: x + 0.35, y: BODY_Y + 0.45, w: cw - (it.icon ? 1.05 : 0.6), h: 1.0, fontFace: c.t.headFont, fontSize: vpt, bold: true, color: c.t.ink, margin: 0, valign: "bottom" });
			slide.addText(it.label, { x: x + 0.35, y: BODY_Y + 1.5, w: cw - 0.6, h: 0.8, fontFace: c.t.bodyFont, fontSize: 15, color: c.t.muted, margin: 0, valign: "top", fit: "shrink" });
			if (it.delta) {
				const good = it.good ?? it.trend !== "down";
				const arrow = it.trend === "down" ? "▼ " : it.trend === "flat" ? "■ " : "▲ ";
				slide.addText(arrow + it.delta, { x: x + 0.35, y: BODY_Y + ch - 0.4, w: cw - 0.6, h: 0.4, fontFace: c.t.bodyFont, fontSize: 14, bold: true, color: good ? "12B76A" : "F04438", margin: 0 });
			}
		});
		if (s.takeaway) paragraph(c, slide, n, String(s.takeaway), MX, BODY_Y + ch + 0.6, CW, 1.3, 18, c.t.ink);
	},

	chart(c, slide, s, n) {
		header(c, slide, s, n);
		const takeaway = s.takeaway as string | undefined;
		const w = takeaway ? CW * 0.66 : CW;
		addChart(c, slide, n, s.chart as ChartSpec, MX, BODY_Y, w, BODY_H);
		if (takeaway) calloutBox(c, slide, n, takeaway, MX + CW * 0.69, BODY_Y + 0.2, CW * 0.31, 3.2);
	},

	table(c, slide, s, n) {
		header(c, slide, s, n);
		const columns = (s.columns as string[]) ?? [];
		const rows = (s.rows as (string | number)[][]) ?? [];
		const hi = s.highlight_row as number | undefined;
		if (rows.length > 10) c.warn(n, `${rows.length} table rows; show at most ~10 and put the rest in an appendix or xlsx`);
		if (columns.length > 7) c.warn(n, `${columns.length} columns; keep tables under 7 columns`);
		const numeric = columns.map((_, j) => rows.length > 0 && rows.every((r) => typeof r[j] === "number" || /^[-+]?[R$€%\d.,\s]+%?$/.test(String(r[j] ?? "")))) ;
		const pt = rows.length > 8 ? 12 : 14;
		const head = columns.map((h, j) => ({ text: h, options: { bold: true, color: c.t.onAccent, fill: { color: c.t.accent }, align: numeric[j] ? "right" : "left" } }));
		const dec = columns.map((_, j) => Math.max(0, ...rows.map((r) => (typeof r[j] === "number" ? (String(r[j]).split(".")[1]?.length ?? 0) : 0))));
		const body = rows.map((r, i) =>
			columns.map((_, j) => ({
				text: fmt(r[j], Math.min(dec[j], 2)),
				options: {
					align: numeric[j] ? "right" : "left",
					bold: i === hi,
					fill: { color: i === hi ? tint(c.t.accent2) : i % 2 ? c.t.surface : c.t.bg },
					color: c.t.ink,
				},
			})),
		);
		slide.addTable([head, ...body], {
			x: MX, y: BODY_Y, w: CW, fontFace: c.t.bodyFont, fontSize: pt, margin: [4, 8, 4, 8],
			border: { type: "solid", pt: 0.5, color: c.t.line }, rowH: Math.min(0.5, BODY_H / (rows.length + 1)), autoPage: false,
		});
	},

	quote(c, slide, s, n) {
		bg(slide, c.t.surface);
		slide.addText("“", { x: MX, y: 0.9, w: 2, h: 1.6, fontFace: "Georgia", fontSize: 140, color: c.t.accent, margin: 0 });
		const q = String(s.quote ?? "");
		const f = fit([q], 10.8, 3.2, 34, 22, 0);
		if (f.overflow) c.warn(n, "quote too long; cut it");
		slide.addText(q, { x: MX + 0.9, y: 2.2, w: 10.8, h: 3.3, fontFace: c.t.headFont, fontSize: f.pt, italic: true, color: c.t.ink, valign: "top", margin: 0, fit: "shrink" });
		if (s.author) slide.addText(`— ${s.author}`, { x: MX + 0.9, y: 5.7, w: 10.8, h: 0.5, fontFace: c.t.bodyFont, fontSize: 16, bold: true, color: c.t.muted, margin: 0 });
	},

	statement(c, slide, s, n) {
		const dark = s.dark !== false;
		let color = c.t.ink;
		let hi = c.t.accent;
		if (dark) ({ fg: color, hi } = cover(c, slide));
		else bg(slide, c.t.bg);
		if (s.icon) icon(c, slide, n, s.icon, MX, 1.0, 0.75, hi);
		const text = String(s.title ?? "");
		const f = fit([text], 11, 3, 44, 28, 0);
		if (f.overflow) c.warn(n, "statement too long; it should be one sentence");
		slide.addText(rich(text, { color, bold: true }), { x: MX, y: 1.9, w: 11, h: 3, fontFace: c.t.headFont, fontSize: f.pt, valign: "middle", margin: 0, fit: "shrink" });
		if (s.subtitle) slide.addText(String(s.subtitle), { x: MX, y: 5.1, w: 11, h: 0.8, fontFace: c.t.bodyFont, fontSize: 18, color, margin: 0, transparency: 15 });
	},

	timeline(c, slide, s, n) {
		header(c, slide, s, n);
		const steps = (s.steps as { label?: string; title: string; text?: string }[]) ?? [];
		if (steps.length < 3 || steps.length > 6) c.warn(n, `timeline works with 3 to 6 steps, got ${steps.length}`);
		const k = Math.max(1, steps.length);
		const sw = CW / k;
		const lineY = BODY_Y + 1.5;
		slide.addShape(c.pptx.ShapeType.line, { x: MX, y: lineY, w: CW, h: 0, line: { color: c.t.line, width: 2 } });
		steps.forEach((st, i) => {
			const x = MX + i * sw;
			if (st.label) slide.addText(st.label, { x, y: lineY - 0.85, w: sw - 0.2, h: 0.5, fontFace: c.t.headFont, fontSize: 20, bold: true, color: c.t.accent, margin: 0 });
			if ((st as { icon?: string }).icon) {
				slide.addShape(c.pptx.ShapeType.ellipse, { x, y: lineY - 0.3, w: 0.6, h: 0.6, fill: { color: c.t.accent }, line: { color: c.t.bg, width: 3 } });
				icon(c, slide, n, (st as { icon?: string }).icon, x + 0.15, lineY - 0.15, 0.3, c.t.onAccent);
			} else slide.addShape(c.pptx.ShapeType.ellipse, { x, y: lineY - 0.14, w: 0.28, h: 0.28, fill: { color: c.t.accent }, line: { color: c.t.bg, width: 2 } });
			slide.addText(st.title, { x, y: lineY + 0.45, w: sw - 0.25, h: 0.8, fontFace: c.t.headFont, fontSize: 20, bold: true, color: c.t.ink, valign: "top", margin: 0, fit: "shrink" });
			if (st.text) paragraph(c, slide, n, st.text, x, lineY + 1.3, sw - 0.25, 2.2, 16, c.t.muted);
		});
	},

	comparison(c, slide, s, n) {
		header(c, slide, s, n);
		const opts = (s.options as { name: string; points: string[]; highlight?: boolean; verdict?: string; icon?: string }[]) ?? [];
		if (opts.length < 2 || opts.length > 4) c.warn(n, `comparison works with 2 to 4 options, got ${opts.length}`);
		const k = Math.max(1, Math.min(opts.length, 4));
		const gap = 0.35;
		const cw = (CW - gap * (k - 1)) / k;
		// Cards as tall as the fullest option (no big empty boxes), same height for all.
		const pt = Math.min(...opts.slice(0, 4).map((o) => fit(o.points, cw - 0.9, BODY_H - 2.2, 19, 12).pt));
		const textH = Math.max(...opts.slice(0, 4).map((o) => o.points.reduce((h, p) => h + lines(p, pt, cw - 0.9) * pt * 1.22 + 6, 0) / 72));
		const cardH = Math.min(BODY_H - 0.1, 1.0 + textH + 1.15);
		opts.slice(0, 4).forEach((o, i) => {
			const x = MX + i * (cw + gap);
			const hi = !!o.highlight;
			card(c, slide, x, BODY_Y, cw, cardH, hi ? c.t.accent : c.t.surface);
			const ink = hi ? c.t.onAccent : c.t.ink;
			const ix = o.icon && icon(c, slide, n, o.icon, x + 0.3, BODY_Y + 0.33, 0.42, hi ? c.t.onAccent : c.t.accent) ? 0.6 : 0;
			slide.addText(o.name, { x: x + 0.3 + ix, y: BODY_Y + 0.25, w: cw - 0.6 - ix, h: 0.6, fontFace: c.t.headFont, fontSize: 20, bold: true, color: ink, margin: 0, fit: "shrink" });
			const f = { pt, overflow: 1.0 + textH + 1.15 > BODY_H };
			if (f.overflow) c.warn(n, `option "${o.name}" has too much text`);
			slide.addText(
				o.points.map((p) => ({ text: richless(p), options: { bullet: { code: "2022", indent: 14 }, breakLine: true, paraSpaceAfter: 6 } })),
				{ x: x + 0.3, y: BODY_Y + 1.0, w: cw - 0.6, h: cardH - 2.0, fontFace: c.t.bodyFont, fontSize: f.pt, color: ink, valign: "top", margin: 0, fit: "shrink" },
			);
			if (o.verdict) slide.addText(o.verdict, { x: x + 0.3, y: BODY_Y + cardH - 0.85, w: cw - 0.6, h: 0.6, fontFace: c.t.bodyFont, fontSize: 14, bold: true, color: hi ? c.t.onAccent : c.t.accent, margin: 0, valign: "bottom", fit: "shrink" });
		});
	},

	async image(c, slide, s, n) {
		header(c, slide, s, n);
		const path = String(s.path ?? "");
		const bullets = s.bullets as Bullet[] | undefined;
		const w = bullets ? CW * 0.6 : CW;
		try {
			const data = await readFile(c.resolve(path));
			const ext = extname(path).slice(1).toLowerCase().replace("jpg", "jpeg");
			slide.addImage({ data: `image/${ext};base64,${data.toString("base64")}`, x: MX, y: BODY_Y, w, h: BODY_H - 0.45, sizing: { type: "contain", w, h: BODY_H - 0.45 } });
		} catch (e) {
			c.warn(n, `image ${path} not loaded: ${(e as Error).message}`);
		}
		if (s.caption) slide.addText(String(s.caption), { x: MX, y: BODY_Y + BODY_H - 0.4, w, h: 0.35, fontFace: c.t.bodyFont, fontSize: 11, italic: true, color: c.t.muted, margin: 0 });
		if (bullets) bulletsBox(c, slide, n, bullets, MX + CW * 0.64, BODY_Y, CW * 0.36, BODY_H, 18);
	},

	big_number(c, slide, s, n) {
		// One number that carries the slide: 120 pt hero figure, label, context.
		const dark = !!s.dark;
		let ink = c.t.ink;
		let hi = c.t.accent;
		if (dark) ({ fg: ink, hi } = cover(c, slide));
		else bg(slide, c.t.bg);
		const value = String(s.value ?? "");
		if (s.kicker) slide.addText(String(s.kicker).toUpperCase(), { x: MX, y: 0.9, w: 11, h: 0.4, fontFace: c.t.bodyFont, fontSize: 13, bold: true, color: hi, charSpacing: 3, margin: 0 });
		const f = fit([value], 11.5, 2.4, 150, 72, 0, 0.55);
		if (value && String(s.title ?? "").includes(value)) c.warn(n, `big_number title repeats the value "${value}"; the title should continue the number ("é o mercado...")`);
		slide.addText(value, { x: MX - 0.05, y: 1.35, w: 11.8, h: 2.5, fontFace: c.t.headFont, fontSize: f.pt, bold: true, color: hi, margin: 0, valign: "bottom" });
		slide.addText(String(s.title ?? ""), { x: MX, y: 4.0, w: 10.5, h: 1.1, fontFace: c.t.headFont, fontSize: 28, bold: true, color: ink, valign: "top", margin: 0, fit: "shrink" });
		if (s.text) paragraph(c, slide, n, String(s.text), MX, 5.15, 9.5, 1.3, 18, dark ? ink : c.t.muted);
		if (!dark) slide.addShape(c.pptx.ShapeType.rect, { x: MX, y: 3.92, w: 1.2, h: 0.07, fill: { color: c.t.accent2 }, line: { type: "none" } });
		if (s.source || c.deck.footer) footer(c, slide, s, n, dark && !c.t.darkCover);
	},

	cards(c, slide, s, n) {
		// 3 to 6 cards: icon badge, short heading, one or two lines of text.
		header(c, slide, s, n);
		const items = (s.items as { icon?: string; title: string; text?: string }[]) ?? [];
		if (items.length < 2 || items.length > 6) c.warn(n, `cards works with 2 to 6 items, got ${items.length}`);
		const k = Math.max(1, Math.min(items.length, 6));
		const cols = k <= 3 ? k : k === 4 ? 2 : 3;
		const rows = Math.ceil(k / cols);
		const gap = 0.3;
		const cw = (CW - gap * (cols - 1)) / cols;
		const textMax = rows > 1 ? 15 : 17;
		// Card height follows the fullest card instead of filling the slide.
		const hasIcon = items.some((it) => it.icon);
		const textH = Math.max(0, ...items.slice(0, 6).map((it) => (it.text ? (lines(it.text, textMax, cw - 0.6) * textMax * 1.22) / 72 : 0)));
		const need = 0.3 + (hasIcon ? 0.85 : 0) + 0.55 + textH + 0.45;
		const chh = Math.min((BODY_H - 0.1 - gap * (rows - 1)) / rows, Math.max(need, 2.2));
		// Short grids sit a little above the optical centre of the body instead of hugging the title.
		const top = BODY_Y + Math.max(0, (BODY_H - (rows * chh + (rows - 1) * gap)) * 0.4);
		items.slice(0, 6).forEach((it, i) => {
			const x = MX + (i % cols) * (cw + gap);
			const y = top + Math.floor(i / cols) * (chh + gap);
			card(c, slide, x, y, cw, chh);
			let ty = y + 0.3;
			if (it.icon && badge(c, slide, n, it.icon, x + 0.3, y + 0.3, 0.7)) ty = y + 1.15;
			slide.addText(it.title, { x: x + 0.3, y: ty, w: cw - 0.6, h: 0.5, fontFace: c.t.headFont, fontSize: rows > 1 ? 17 : 20, bold: true, color: c.t.ink, margin: 0, valign: "top", fit: "shrink" });
			if (it.text) paragraph(c, slide, n, it.text, x + 0.3, ty + 0.55, cw - 0.6, y + chh - (ty + 0.55) - 0.2, textMax, c.t.muted);
		});
	},

	closing(c, slide, s, n) {
		const { fg } = cover(c, slide);
		slide.addText(s.title ?? "Obrigado", { x: MX, y: 1.5, w: 11, h: 1.4, fontFace: c.t.headFont, fontSize: 40, bold: true, color: fg, margin: 0, fit: "shrink" });
		const items = (s.bullets as Bullet[]) ?? [];
		if (items.length) slide.addText(bulletRuns(c, items, 20, fg), { x: MX, y: 3.1, w: 11, h: 3.2, fontFace: c.t.bodyFont, valign: "top", margin: 0, fit: "shrink" });
		if (s.subtitle) slide.addText(String(s.subtitle), { x: MX, y: 6.4, w: 11, h: 0.5, fontFace: c.t.bodyFont, fontSize: 14, color: fg, margin: 0 });
		footer(c, slide, { layout: "closing" }, n, !c.t.darkCover);
	},
};

const NO_FOOTER = new Set(["title", "section", "closing", "statement", "quote", "big_number"]);

function paragraph(c: Ctx, slide: any, n: number, text: string, x: number, y: number, w: number, h: number, max: number, color = c.t.ink) {
	const f = fit([text], w, h, max, 12, 0);
	if (f.overflow) c.warn(n, `text block too long: "${text.slice(0, 40)}..."`);
	slide.addText(rich(text, { color }), { x, y, w, h, fontFace: c.t.bodyFont, fontSize: f.pt, valign: "top", margin: 0, fit: "shrink", paraSpaceAfter: 6 });
}

function calloutBox(c: Ctx, slide: any, n: number, text: string, x: number, y: number, w: number, h: number) {
	card(c, slide, x, y, w, h);
	slide.addShape(c.pptx.ShapeType.rect, { x, y, w: 0.08, h, fill: { color: c.t.accent2 }, line: { color: c.t.accent2 } });
	const f = fit([text], w - 0.6, h - 0.5, 20, 13, 0);
	if (f.overflow) c.warn(n, "takeaway/callout too long; one or two sentences");
	slide.addText(rich(text, { color: c.t.ink }), { x: x + 0.3, y: y + 0.25, w: w - 0.55, h: h - 0.5, fontFace: c.t.bodyFont, fontSize: f.pt, valign: "middle", margin: 0, fit: "shrink" });
}

function fmt(v: unknown, decimals = 0): string {
	if (typeof v === "number") return v.toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
	return String(v ?? "");
}

/** Light tint of a color (mix with white), for highlighted table rows. */
function tint(color: string, k = 0.82): string {
	const c = parseInt(color, 16);
	const mix = (v: number) => Math.round(v + (255 - v) * k);
	return [(c >> 16) & 255, (c >> 8) & 255, c & 255].map((v) => mix(v).toString(16).padStart(2, "0")).join("").toUpperCase();
}

interface ChartSpec {
	type: ChartType;
	categories: string[];
	series: { name: string; values: number[] }[];
	number_format?: string; // Excel format, e.g. "#,##0", "0.0%", "R$ #,##0"
	highlight?: string | number; // category name or index: that bar in accent, others muted
	show_values?: boolean;
	y_title?: string;
}

function addChart(c: Ctx, slide: any, n: number, ch: ChartSpec | undefined, x: number, y: number, w: number, h: number) {
	if (!ch || !Array.isArray(ch.series) || !Array.isArray(ch.categories)) {
		c.warn(n, "chart needs {type, categories, series:[{name, values}]}");
		return;
	}
	const T = c.pptx.ChartType;
	const kind: Record<ChartType, [string, Record<string, unknown>]> = {
		bar: [T.bar, { barDir: "bar" }],
		column: [T.bar, { barDir: "col" }],
		stacked_bar: [T.bar, { barDir: "bar", barGrouping: "stacked" }],
		stacked_column: [T.bar, { barDir: "col", barGrouping: "stacked" }],
		line: [T.line, { lineSize: 3, lineDataSymbol: "circle", lineDataSymbolSize: 7 }],
		area: [T.area, {}],
		pie: [T.pie, {}],
		doughnut: [T.doughnut, { holeSize: 62 }],
	};
	const [type, extra] = kind[ch.type] ?? kind.column;
	const pie = ch.type === "pie" || ch.type === "doughnut";
	const points = ch.categories.length;
	if (pie && points > 6) c.warn(n, `${ch.type} with ${points} slices; use a bar chart above 6`);
	if (ch.series.length > 5) c.warn(n, `${ch.series.length} series; more than 5 is unreadable`);
	for (const s of ch.series) if (s.values.length !== points) c.warn(n, `series "${s.name}" has ${s.values.length} values for ${points} categories`);

	let colors = c.t.chart;
	let legend = ch.series.length > 1 || pie;
	if (ch.highlight !== undefined && ch.series.length === 1 && !pie) {
		const idx = typeof ch.highlight === "number" ? ch.highlight : ch.categories.indexOf(String(ch.highlight));
		if (idx < 0) c.warn(n, `highlight "${ch.highlight}" is not a category`);
		colors = ch.categories.map((_, i) => (i === idx ? c.t.accent : tint(c.t.muted, 0.45)));
		legend = false;
	}
	// Horizontal bars read top-down in category order.
	const reverse = ch.type === "bar" || ch.type === "stacked_bar";
	const data = ch.series.map((s) => ({ name: s.name, labels: ch.categories, values: s.values }));
	const showValues = ch.show_values ?? (pie || (ch.series.length === 1 && points <= 12));
	slide.addChart(type, data, {
		x, y, w, h,
		...extra,
		chartColors: colors,
		catAxisOrientation: reverse ? "maxMin" : "minMax",
		valAxisHidden: showValues && !pie && ch.series.length === 1,
		valGridLine: { style: showValues && ch.series.length === 1 ? "none" : "solid", color: c.t.line, size: 0.5 },
		catGridLine: { style: "none" },
		catAxisLineShow: !pie,
		catAxisLineColor: c.t.line,
		catAxisLabelColor: c.t.muted,
		valAxisLabelColor: c.t.muted,
		catAxisLabelFontSize: 12,
		valAxisLabelFontSize: 11,
		catAxisLabelFontFace: c.t.bodyFont,
		valAxisLabelFontFace: c.t.bodyFont,
		valAxisLabelFormatCode: ch.number_format ?? "#,##0",
		valAxisTitle: ch.y_title,
		showValAxisTitle: !!ch.y_title,
		valAxisTitleColor: c.t.muted,
		valAxisTitleFontSize: 11,
		showValue: showValues && !pie,
		showPercent: pie,
		showLabel: false,
		dataLabelFormatCode: pie ? "0%" : (ch.number_format ?? "#,##0"),
		dataLabelColor: pie ? "FFFFFF" : c.t.ink,
		dataLabelFontSize: pie ? 13 : 12,
		dataLabelFontBold: pie,
		dataLabelFontFace: c.t.bodyFont,
		dataLabelPosition: pie ? "ctr" : ch.type.startsWith("stacked") ? "ctr" : ch.type === "line" ? "t" : "outEnd",
		barGapWidthPct: 55,
		showLegend: legend,
		legendPos: pie ? "r" : "t",
		legendFontSize: pie ? 14 : 12,
		legendFontFace: c.t.bodyFont,
		legendColor: c.t.muted,
		plotArea: { fill: { color: c.t.bg } },
	});
}

// Common pt-BR words that are only written without accents by mistake (ASCII-only output).
const ACCENTLESS = new Set("nao ja voce voces sao entao tambem ate apos acao acoes solucao solucoes informacao decisao operacao integracao satisfacao mitigacao recomendacao regulatorio relatorio rapido rapida tres mes paises negocio negocios area areas inteligencia experiencia estrategia estrategico estrategica historico unico unica proximo proximos proxima ultimo ultimos ultima possivel disponivel periodo previsao projecao gestao reducao producao".split(" "));

function accentlessWords(deck: DeckSpec): string[] {
	const text = JSON.stringify(deck.slides).toLowerCase();
	if (!/[ãõçáéíóúâêô]/.test(text) && !/\b(de|para|com|que|em)\b/.test(text)) return [];
	const found = new Set<string>();
	for (const w of text.match(/[a-zà-ú]+/g) ?? []) if (ACCENTLESS.has(w)) found.add(w);
	return [...found];
}

export interface RenderResult {
	bytes: Buffer;
	slides: number;
	warnings: string[];
}

export async function renderDeck(deck: DeckSpec, opts: { workspace: string; resolve: (p: string) => string }): Promise<RenderResult> {
	if (!deck || !Array.isArray(deck.slides) || deck.slides.length === 0) throw new Error("spec needs {title, slides:[...]}");
	const base = THEMES[deck.theme ?? "executive"] ?? THEMES.executive;
	const b = deck.brand ?? {};
	const t: Theme = {
		...base,
		...(b.dark ? { bg: "0F172A", surface: "1E293B", ink: "E2E8F0", muted: "94A3B8", line: "334155" } : {}),
		accent: hex(b.accent) ?? base.accent,
		accent2: hex(b.accent2) ?? base.accent2,
		headFont: b.headFont ?? base.headFont,
		bodyFont: b.bodyFont ?? base.bodyFont,
	};
	if (hex(b.accent)) t.chart = [t.accent, t.accent2, ...base.chart.slice(2)];

	const pptx = new PptxGenJS();
	pptx.layout = "LAYOUT_WIDE";
	pptx.title = deck.title;
	if (deck.author) pptx.author = deck.author;
	pptx.theme = { headFontFace: t.headFont, bodyFontFace: t.bodyFont };

	const warnings: string[] = [];
	const noNotes: number[] = [];
	const c: Ctx = { pptx, t, deck, workspace: opts.workspace, resolve: opts.resolve, warn: (n, m) => warnings.push(`slide ${n}: ${m}`) };

	for (const [i, s] of deck.slides.entries()) {
		const n = i + 1;
		const layout = LAYOUTS[s.layout];
		const slide = pptx.addSlide();
		bg(slide, t.bg);
		if (!layout) {
			warnings.push(`slide ${n}: unknown layout "${s.layout}" (use one of ${Object.keys(LAYOUTS).join(", ")}); rendered as bullets`);
			LAYOUTS.bullets(c, slide, { ...s, bullets: (s.bullets as Bullet[]) ?? [] }, n);
		} else {
			await layout(c, slide, s, n);
		}
		if (!NO_FOOTER.has(s.layout)) footer(c, slide, s, n);
		if (s.notes) slide.addNotes(String(s.notes));
		else if (!["title", "section", "closing"].includes(s.layout)) noNotes.push(n);
	}
	const plain = accentlessWords(deck);
	if (plain.length) warnings.push(`text without Portuguese accents (${plain.slice(0, 8).join(", ")}): rewrite with correct accents (não, já, ação, três, rápido...)`);
	if (noNotes.length) warnings.push(`slides ${noNotes.join(", ")}: no speaker notes (add "notes")`);
	const bytes = (await pptx.write({ outputType: "nodebuffer", compression: true })) as Buffer;
	return { bytes, slides: deck.slides.length, warnings };
}

export const LAYOUT_NAMES = Object.keys(LAYOUTS);
