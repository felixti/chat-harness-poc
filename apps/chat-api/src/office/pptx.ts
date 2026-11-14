// Deck spec (JSON) -> PPTX with pptxgenjs, in process (no subprocess, no LibreOffice).
// Design quality lives here, not in the model: a fixed 16:9 grid, a type scale, curated themes,
// layout recipes, text fitting and lint warnings. The model only chooses content and layouts
// (skills `pptx` and `design` teach it how).
import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createRequire } from "node:module";
import { addIcon, hasIcon, suggestIcons } from "./icons.ts";
import { record, renderSlide, type Recorded } from "./preview.ts";

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
	/** Positive / negative deltas. Default: readable green/red for the background (light or dark). */
	good?: string;
	bad?: string;
	/** Art direction: classic (boxes, rings), editorial (paper, rules, serif display, no boxes),
	 *  modern (bold color blocks, geometric shapes, split covers). Default classic. */
	style?: "classic" | "editorial" | "modern";
}

/** Fallback when the skill's theme folder is missing (tests, local runs). Real themes live in skills/pptx/themes/*.json. */
export const DEFAULT_THEME: Theme = {
	bg: "FFFFFF", surface: "F2F4F7", ink: "1D2939", muted: "667085", accent: "0B3B75", accent2: "0E9384",
	onAccent: "FFFFFF", line: "D0D5DD", chart: ["0B3B75", "0E9384", "F79009", "7A5AF8", "EE46BC", "98A2B3"],
	headFont: "Aptos Display", bodyFont: "Aptos", good: "067647", bad: "C01048",
};

const COLOR_KEYS = ["bg", "surface", "ink", "muted", "accent", "accent2", "onAccent", "line"] as const;

/** Reads every <name>.json in a theme folder (the `pptx` skill owns them: add a file, get a theme). */
export async function loadThemes(dir: string): Promise<Record<string, Theme>> {
	const out: Record<string, Theme> = {};
	let files: string[] = [];
	try {
		files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
	} catch {
		return { executive: DEFAULT_THEME };
	}
	for (const f of files) {
		try {
			const t = JSON.parse(await readFile(join(dir, f), "utf8"));
			const problems = themeProblems(t);
			if (problems.length) console.warn(`theme ${f} ignored: ${problems.join("; ")}`);
			else out[basename(f, ".json")] = normalizeTheme(t);
		} catch (e) {
			console.warn(`theme ${f} ignored: ${(e as Error).message}`);
		}
	}
	if (!out.executive) out.executive = DEFAULT_THEME;
	return out;
}

function normalizeTheme(t: Record<string, any>): Theme {
	const o = { ...t } as Theme;
	for (const k of COLOR_KEYS) o[k] = hex(t[k])!;
	o.chart = (t.chart as string[]).map((c) => hex(c)!);
	const dark = contrast(o.bg, "000000") < contrast(o.bg, "FFFFFF");
	o.good = hex(t.good) ?? (dark ? "34D399" : "067647");
	o.bad = hex(t.bad) ?? (dark ? "F87171" : "C01048");
	return o;
}

function themeProblems(t: Record<string, any>): string[] {
	const p: string[] = [];
	for (const k of COLOR_KEYS) if (!hex(t?.[k])) p.push(`${k} must be a hex color like "#1D2939"`);
	if (!Array.isArray(t?.chart) || t.chart.length < 3 || t.chart.some((c: unknown) => !hex(c as string))) p.push("chart needs 3+ hex colors");
	if (typeof t?.headFont !== "string" || typeof t?.bodyFont !== "string") p.push("headFont and bodyFont are required");
	return p;
}

/** WCAG contrast ratio between two hex colors. */
function contrast(a: string, b: string): number {
	const lum = (h: string) => {
		const [r, g, bl] = [0, 2, 4].map((i) => {
			const v = parseInt(h.slice(i, i + 2), 16) / 255;
			return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
	};
	const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
	return (x + 0.05) / (y + 0.05);
}

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
	/** Theme name (skills/pptx/themes), a workspace .json file with a theme, or an inline theme ({extends?, ...fields}). */
	theme?: string | (Partial<Theme> & { extends?: string });
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
	/** Data URI of the current slide's background_image (cover layouts only). */
	bgImage?: string;
}

function bg(slide: any, color: string) {
	slide.background = { color };
}

/** Source and page number. `width` < CW keeps it in the text column (pictures fill the rest). */
function footer(c: Ctx, slide: any, s: SlideSpec, n: number, onDark = false, width = CW, x = MX) {
	const color = onDark ? c.t.onAccent : c.t.muted;
	const src = s.source ? String(s.source).replace(/^\s*(fontes?|sources?)\s*:\s*/i, "") : "";
	const left = [src ? `Fonte: ${src}` : "", c.deck.footer ?? ""].filter(Boolean).join("   ·   ");
	if (left) slide.addText(left, { x, y: FOOT_Y, w: width - 1, h: 0.3, fontFace: c.t.bodyFont, fontSize: 9, color, margin: 0 });
	slide.addText(String(n), { x: x + width - 0.8, y: FOOT_Y, w: 0.8, h: 0.3, fontFace: c.t.bodyFont, fontSize: 9, color, align: "right", margin: 0 });
}

const styleOf = (c: Ctx) => c.t.style ?? "classic";
const SERIF = /georgia|serif|garamond|times|cambria|playfair|merriweather|sitka|bodoni/i;
/** Serif display titles read best in regular weight; sans titles in bold. */
const headBold = (c: Ctx) => !SERIF.test(c.t.headFont);

function header(c: Ctx, slide: any, s: SlideSpec, n: number, width = CW, x = MX) {
	let y = TITLE_Y;
	const st = styleOf(c);
	if (st === "editorial") {
		// A short rule over the title: the editorial signature instead of boxes.
		slide.addShape(c.pptx.ShapeType.rect, { x, y: y - 0.06, w: 0.55, h: 0.035, fill: { color: c.t.accent2 }, line: { type: "none" } });
		y += 0.1;
	}
	if (s.kicker) {
		const kc = st === "modern" && contrast(c.t.accent2, c.t.bg) >= 3 ? c.t.accent2 : st === "editorial" ? c.t.muted : c.t.accent;
		slide.addText(String(s.kicker).toUpperCase(), { x, y, w: width, h: 0.3, fontFace: c.t.bodyFont, fontSize: 11, bold: true, color: kc, charSpacing: st === "editorial" ? 2.5 : 1.5, margin: 0 });
		y += 0.32;
	}
	const title = s.title ?? "";
	if (title.length > 90) c.warn(n, `title has ${title.length} chars; keep action titles under ~90`);
	const max = st === "classic" ? 30 : 32;
	const room = s.kicker ? 0.8 : st === "editorial" ? 0.98 : 1.05;
	const f = fit([title], width, room, max, 20, 0, 0.56);
	if (f.overflow) c.warn(n, "title does not fit in two lines; shorten it");
	slide.addText(title, { x, y, w: width, h: room + 0.05, fontFace: c.t.headFont, fontSize: f.pt, bold: headBold(c), color: c.t.ink, valign: "top", margin: 0, fit: "shrink" });
	if (s.subtitle) slide.addText(String(s.subtitle), { x, y: BODY_Y - 0.42, w: width, h: 0.36, fontFace: c.t.bodyFont, fontSize: 14, color: c.t.muted, margin: 0 });
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
	if (items.length > 5) c.warn(n, `${items.length} bullets; use at most 5 (split the slide or use two_column)`);
	for (const p of bulletParas(items)) if (p.length > 160) c.warn(n, `bullet over 160 chars: "${p.slice(0, 40)}..."`);
	const f = fit(bulletParas(items), w - 0.3, h, max, 14);
	if (f.overflow) c.warn(n, "bullets overflow the box even at 14 pt; cut text");
	slide.addText(bulletRuns(c, items, f.pt, c.t.ink), { x, y, w, h, fontFace: c.t.bodyFont, valign: "top", margin: 0, fit: "shrink" });
}

function card(c: Ctx, slide: any, x: number, y: number, w: number, h: number, fill = c.t.surface) {
	slide.addShape(c.pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: fill }, line: { color: fill }, rectRadius: styleOf(c) === "modern" ? 0.16 : 0.08 });
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

interface CoverLook {
	fg: string; // main text
	hi: string; // highlight (numerals, rules, kicker)
	textW: number; // width available to text from MX (split covers keep text off the picture)
	onColor: boolean; // background is the accent color (footer text uses onAccent)
}

/** Background + colors for full-bleed slides (title, section, statement, closing), by style. */
function cover(c: Ctx, slide: any): CoverLook {
	const st = styleOf(c);
	const img = c.bgImage;
	if (st === "classic") {
		if (img) {
			// Photo full bleed under a strong scrim of the cover color: text keeps its contrast.
			const base = c.t.darkCover ? c.t.bg : c.t.accent;
			bg(slide, base);
			slide.addImage({ data: img, x: 0, y: 0, w: W, h: H, sizing: { type: "cover", w: W, h: H } });
			slide.addShape(c.pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: H, fill: { color: base, transparency: 30 }, line: { type: "none" } });
			return c.t.darkCover ? { fg: c.t.ink, hi: c.t.accent, textW: 11, onColor: false } : { fg: c.t.onAccent, hi: c.t.onAccent, textW: 11, onColor: true };
		}
		if (c.t.darkCover) {
			bg(slide, c.t.bg);
			rings(c, slide, c.t.accent);
			return { fg: c.t.ink, hi: c.t.accent, textW: 11, onColor: false };
		}
		bg(slide, c.t.accent);
		rings(c, slide, c.t.onAccent);
		return { fg: c.t.onAccent, hi: c.t.onAccent, textW: 11, onColor: true };
	}
	if (st === "editorial") {
		// Paper background, a full-height rule, the picture as a clean half page.
		bg(slide, c.t.bg);
		slide.addShape(c.pptx.ShapeType.rect, { x: 0, y: 0, w: 0.16, h: H, fill: { color: c.t.accent }, line: { type: "none" } });
		if (img) {
			slide.addImage({ data: img, x: W * 0.52, y: 0, w: W * 0.48, h: H, sizing: { type: "cover", w: W * 0.48, h: H } });
			return { fg: c.t.ink, hi: c.t.accent, textW: W * 0.52 - MX - 0.55, onColor: false };
		}
		slide.addShape(c.pptx.ShapeType.line, { x: MX, y: H - 0.95, w: W - 2 * MX, h: 0, line: { color: c.t.line, width: 1 } });
		return { fg: c.t.ink, hi: c.t.accent, textW: 11, onColor: false };
	}
	// modern: a color block and one bold geometric form.
	const dark = !!c.t.darkCover;
	const base = dark ? c.t.bg : c.t.accent;
	const fg = dark ? c.t.ink : c.t.onAccent;
	const hi = dark ? c.t.accent : c.t.onAccent;
	bg(slide, base);
	if (img) {
		slide.addImage({ data: img, x: W * 0.55, y: 0, w: W * 0.45, h: H, sizing: { type: "cover", w: W * 0.45, h: H } });
		slide.addShape(c.pptx.ShapeType.rect, { x: W * 0.55 - 0.09, y: 0, w: 0.09, h: H, fill: { color: c.t.accent2 }, line: { type: "none" } });
		return { fg, hi, textW: W * 0.55 - MX - 0.5, onColor: !dark };
	}
	slide.addShape(c.pptx.ShapeType.ellipse, { x: 9.9, y: 3.6, w: 5.6, h: 5.6, fill: { color: c.t.accent2, transparency: dark ? 0 : 10 }, line: { type: "none" } });
	slide.addShape(c.pptx.ShapeType.ellipse, { x: 10.15, y: 2.2, w: 2.5, h: 2.5, fill: { type: "none" }, line: { color: hi, width: 1.5, transparency: 40 } });
	return { fg, hi, textW: 9.2, onColor: !dark };
}

/** Large translucent rings bleeding off the right edge: depth without clip art. */
function rings(c: Ctx, slide: any, color: string) {
	slide.addShape(c.pptx.ShapeType.ellipse, { x: 8.6, y: -1.6, w: 7.2, h: 7.2, fill: { color, transparency: 90 }, line: { type: "none" } });
	slide.addShape(c.pptx.ShapeType.ellipse, { x: 10.4, y: 3.3, w: 5.2, h: 5.2, fill: { color, transparency: 93 }, line: { type: "none" } });
	slide.addShape(c.pptx.ShapeType.ellipse, { x: 9.3, y: -0.9, w: 5.8, h: 5.8, fill: { type: "none" }, line: { color, width: 1, transparency: 70 } });
}

const LAYOUTS: Record<string, (c: Ctx, slide: any, s: SlideSpec, n: number) => Promise<void> | void> = {
	title(c, slide, s) {
		const k = cover(c, slide);
		const st = styleOf(c);
		const w = Math.min(10.5, k.textW);
		if (s.kicker) slide.addText(String(s.kicker).toUpperCase(), { x: MX, y: 1.4, w, h: 0.45, fontFace: c.t.bodyFont, fontSize: 13, bold: true, color: k.hi, charSpacing: st === "editorial" ? 3 : 2, margin: 0 });
		if (st !== "editorial") {
			const bar = st === "modern" ? c.t.accent2 : k.hi;
			slide.addShape(c.pptx.ShapeType.rect, { x: MX, y: 2.05, w: st === "modern" ? 1.6 : 1.1, h: st === "modern" ? 0.14 : 0.09, fill: { color: bar }, line: { type: "none" } });
		}
		const text = s.title ?? c.deck.title;
		const f = fit([text], w, 2.2, st === "modern" ? 54 : 48, 30, 0);
		slide.addText(text, { x: MX, y: 2.35, w, h: 2.3, fontFace: c.t.headFont, fontSize: f.pt, bold: headBold(c), color: k.fg, valign: "top", margin: 0, fit: "shrink" });
		if (s.subtitle) slide.addText(String(s.subtitle), { x: MX, y: 4.75, w, h: 0.9, fontFace: c.t.bodyFont, fontSize: 20, color: k.fg, valign: "top", margin: 0, transparency: 10 });
		const meta = [c.deck.author, c.deck.date].filter(Boolean).join("   ·   ");
		if (meta) slide.addText(meta, { x: MX, y: 6.55, w, h: 0.35, fontFace: c.t.bodyFont, fontSize: 12, color: st === "editorial" ? c.t.muted : k.fg, margin: 0 });
	},

	section(c, slide, s, n) {
		const k = cover(c, slide);
		const st = styleOf(c);
		const w = Math.min(11, k.textW);
		const num = (s.number as string | number | undefined) ?? "";
		if (num !== "") {
			const big = st === "classic" ? { pt: 72, bold: true, color: k.hi, transparency: c.t.darkCover ? 0 : 35 } : st === "editorial" ? { pt: 96, bold: false, color: c.t.accent2, transparency: 0 } : { pt: 120, bold: true, color: c.t.darkCover ? c.t.accent2 : k.hi, transparency: 0 };
			slide.addText(String(num).padStart(2, "0"), { x: MX, y: st === "classic" ? 1.9 : 1.05, w: 4, h: st === "classic" ? 1.3 : 2.1, fontFace: c.t.headFont, fontSize: big.pt, bold: big.bold, color: big.color, margin: 0, valign: "bottom", transparency: big.transparency });
		}
		slide.addText(s.title ?? "", { x: MX, y: 3.25, w, h: 1.4, fontFace: c.t.headFont, fontSize: 40, bold: headBold(c), color: k.fg, valign: "top", margin: 0, fit: "shrink" });
		if (s.subtitle) slide.addText(String(s.subtitle), { x: MX, y: 4.7, w, h: 0.8, fontFace: c.t.bodyFont, fontSize: 18, color: st === "editorial" ? c.t.muted : k.fg, margin: 0 });
		footer(c, slide, { layout: "section" }, n, k.onColor, w);
	},

	agenda(c, slide, s, n) {
		header(c, slide, s, n);
		const items = (s.items as string[]) ?? [];
		if (items.length > 6) c.warn(n, `agenda with ${items.length} items; use at most 6`);
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
		const st = styleOf(c);
		items.slice(0, 4).forEach((it, i) => {
			const x = MX + i * (cw + gap);
			if (st === "editorial") {
				// Open figures between hairlines, like a financial report.
				slide.addShape(c.pptx.ShapeType.line, { x, y: BODY_Y + 0.2, w: cw, h: 0, line: { color: c.t.ink, width: 1.25 } });
				slide.addShape(c.pptx.ShapeType.line, { x, y: BODY_Y + 0.2 + ch, w: cw, h: 0, line: { color: c.t.line, width: 0.75 } });
			} else {
				card(c, slide, x, BODY_Y + 0.2, cw, ch);
				if (st === "classic") slide.addShape(c.pptx.ShapeType.rect, { x, y: BODY_Y + 0.2, w: 0.09, h: ch, fill: { color: c.t.accent }, line: { color: c.t.accent } });
				else slide.addShape(c.pptx.ShapeType.rect, { x: x + 0.35, y: BODY_Y + 0.2, w: 0.7, h: 0.07, fill: { color: c.t.accent }, line: { type: "none" } });
			}
			if (it.icon) icon(c, slide, n, it.icon, x + cw - 0.75, BODY_Y + 0.45, 0.42, c.t.accent);
			slide.addText(it.value, { x: x + (st === "editorial" ? 0 : 0.35), y: BODY_Y + 0.45, w: cw - (it.icon ? 1.05 : 0.6), h: 1.0, fontFace: c.t.headFont, fontSize: vpt, bold: headBold(c), color: st === "modern" ? c.t.accent : c.t.ink, margin: 0, valign: "bottom" });
			slide.addText(it.label, { x: x + (st === "editorial" ? 0 : 0.35), y: BODY_Y + 1.5, w: cw - 0.6, h: 0.8, fontFace: c.t.bodyFont, fontSize: 15, color: c.t.muted, margin: 0, valign: "top", fit: "shrink" });
			if (it.delta) {
				const good = it.good ?? it.trend !== "down";
				const arrow = it.trend === "down" ? "▼ " : it.trend === "flat" ? "■ " : "▲ ";
				slide.addText(arrow + it.delta, { x: x + (st === "editorial" ? 0 : 0.35), y: BODY_Y + ch - 0.4, w: cw - 0.6, h: 0.4, fontFace: c.t.bodyFont, fontSize: 14, bold: true, color: good ? c.t.good : c.t.bad, margin: 0 });
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
		if (columns.length > 6) c.warn(n, `${columns.length} columns; use at most 6 (move the rest to an xlsx)`);
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
					fill: { color: i === hi ? tint(c.t.accent2, 0.78, c.t.bg) : i % 2 ? c.t.surface : c.t.bg },
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
		let w = 11;
		if (dark) {
			const k = cover(c, slide);
			({ fg: color, hi } = k);
			w = Math.min(11, k.textW);
		} else bg(slide, c.t.bg);
		if (s.icon) icon(c, slide, n, s.icon, MX, 1.0, 0.75, hi);
		const text = String(s.title ?? "");
		const f = fit([text], w, 3, 44, 28, 0);
		if (f.overflow) c.warn(n, "statement too long; it should be one sentence");
		slide.addText(rich(text, { color, bold: headBold(c) }), { x: MX, y: 1.9, w, h: 3, fontFace: c.t.headFont, fontSize: f.pt, valign: "middle", margin: 0, fit: "shrink" });
		if (s.subtitle) slide.addText(String(s.subtitle), { x: MX, y: 5.1, w, h: 0.8, fontFace: c.t.bodyFont, fontSize: 18, color, margin: 0, transparency: 15 });
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
		let onColor = false;
		if (dark) {
			const k = cover(c, slide);
			({ fg: ink, hi, onColor } = k);
		} else bg(slide, c.t.bg);
		const value = String(s.value ?? "");
		if (s.kicker) slide.addText(String(s.kicker).toUpperCase(), { x: MX, y: 0.9, w: 11, h: 0.4, fontFace: c.t.bodyFont, fontSize: 13, bold: true, color: hi, charSpacing: 3, margin: 0 });
		const f = fit([value], 11.5, 2.4, 150, 72, 0, 0.55);
		if (value && String(s.title ?? "").includes(value)) c.warn(n, `big_number title repeats the value "${value}"; the title should continue the number ("é o mercado...")`);
		slide.addText(value, { x: MX - 0.05, y: 1.35, w: 11.8, h: 2.5, fontFace: c.t.headFont, fontSize: f.pt, bold: headBold(c), color: hi, margin: 0, valign: "bottom" });
		slide.addText(String(s.title ?? ""), { x: MX, y: 4.0, w: 10.5, h: 1.1, fontFace: c.t.headFont, fontSize: 28, bold: headBold(c), color: ink, valign: "top", margin: 0, fit: "shrink" });
		if (s.text) paragraph(c, slide, n, String(s.text), MX, 5.15, 9.5, 1.3, 18, dark ? ink : c.t.muted);
		if (!dark) slide.addShape(c.pptx.ShapeType.rect, { x: MX, y: 3.92, w: 1.2, h: 0.07, fill: { color: c.t.accent2 }, line: { type: "none" } });
		if (s.source || c.deck.footer) footer(c, slide, s, n, onColor);
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
			const st = styleOf(c);
			// editorial: no box, a strong rule on top; modern: box with a solid icon tile; classic: box + soft badge.
			const px = st === "editorial" ? 0 : 0.3;
			if (st === "editorial") slide.addShape(c.pptx.ShapeType.line, { x, y, w: cw, h: 0, line: { color: c.t.ink, width: 1.25 } });
			else card(c, slide, x, y, cw, chh);
			let ty = y + 0.3;
			if (it.icon) {
				if (st === "editorial") {
					if (icon(c, slide, n, it.icon, x, y + 0.3, 0.42, c.t.accent2)) ty = y + 0.9;
				} else if (st === "modern") {
					slide.addShape(c.pptx.ShapeType.roundRect, { x: x + px, y: y + 0.3, w: 0.7, h: 0.7, fill: { color: c.t.accent }, line: { type: "none" }, rectRadius: 0.12 });
					if (icon(c, slide, n, it.icon, x + px + 0.17, y + 0.47, 0.36, c.t.onAccent)) ty = y + 1.15;
				} else if (badge(c, slide, n, it.icon, x + 0.3, y + 0.3, 0.7)) ty = y + 1.15;
			}
			slide.addText(it.title, { x: x + px, y: ty, w: cw - 2 * px, h: 0.5, fontFace: c.t.headFont, fontSize: rows > 1 ? 17 : 20, bold: headBold(c), color: c.t.ink, margin: 0, valign: "top", fit: "shrink" });
			if (it.text) paragraph(c, slide, n, it.text, x + px, ty + 0.55, cw - 2 * px, y + chh - (ty + 0.55) - 0.2, textMax, c.t.muted);
		});
	},

	async split(c, slide, s, n) {
		// Half-page picture (bleeds to the edge) beside the title and a short text or bullets.
		const right = s.side !== "left";
		const half = W / 2;
		const tx = right ? MX : half + 0.55;
		const tw = half - MX - 0.55;
		const path = String(s.path ?? "");
		try {
			const ext = extname(path).slice(1).toLowerCase().replace("jpg", "jpeg");
			if (ext !== "png" && ext !== "jpeg") throw new Error("use a .png or .jpg");
			const data = await readFile(c.resolve(path));
			slide.addImage({ data: `image/${ext};base64,${data.toString("base64")}`, x: right ? half : 0, y: 0, w: half, h: H, sizing: { type: "cover", w: half, h: H } });
		} catch (e) {
			c.warn(n, `split image ${path} not loaded: ${(e as Error).message}`);
		}
		header(c, slide, s, n, tw, tx);
		const items = s.bullets as Bullet[] | undefined;
		if (items?.length) bulletsBox(c, slide, n, items, tx, BODY_Y, tw, BODY_H - 0.3, 20);
		else if (s.text) paragraph(c, slide, n, String(s.text), tx, BODY_Y, tw, BODY_H - 0.3, 20);
		if (s.caption) slide.addText(String(s.caption), { x: right ? half + 0.25 : 0.25, y: H - 0.55, w: half - 0.5, h: 0.35, fontFace: c.t.bodyFont, fontSize: 10, color: "FFFFFF", margin: [2, 6, 2, 6], fill: { color: "000000", transparency: 45 }, fit: "shrink" });
		footer(c, slide, s, n, false, tw, tx);
	},

	numbered(c, slide, s, n) {
		// 2 to 4 points led by large numerals: priorities, steps, findings. Typographic, no boxes.
		header(c, slide, s, n);
		const items = (s.items as { title: string; text?: string }[]) ?? [];
		if (items.length < 2 || items.length > 4) c.warn(n, `numbered works with 2 to 4 items, got ${items.length}`);
		const k = Math.max(1, Math.min(items.length, 4));
		const gap = 0.45;
		const cw = (CW - gap * (k - 1)) / k;
		const st = styleOf(c);
		items.slice(0, 4).forEach((it, i) => {
			const x = MX + i * (cw + gap);
			const y = BODY_Y + 0.15;
			slide.addText(String(i + 1).padStart(2, "0"), { x, y, w: cw, h: 1.25, fontFace: c.t.headFont, fontSize: 66, bold: st !== "editorial", color: st === "modern" ? c.t.accent : c.t.accent2, margin: 0, valign: "bottom" });
			slide.addShape(c.pptx.ShapeType.line, { x, y: y + 1.4, w: cw, h: 0, line: { color: c.t.ink, width: 1.25 } });
			slide.addText(it.title, { x, y: y + 1.6, w: cw, h: 0.8, fontFace: c.t.headFont, fontSize: 20, bold: headBold(c), color: c.t.ink, valign: "top", margin: 0, fit: "shrink" });
			if (it.text) paragraph(c, slide, n, it.text, x, y + 2.45, cw, BODY_H - 2.7, 16, c.t.muted);
		});
	},

	closing(c, slide, s, n) {
		const k = cover(c, slide);
		const w = Math.min(11, k.textW);
		slide.addText(s.title ?? "Obrigado", { x: MX, y: 1.5, w, h: 1.4, fontFace: c.t.headFont, fontSize: 40, bold: headBold(c), color: k.fg, margin: 0, fit: "shrink" });
		const items = (s.bullets as Bullet[]) ?? [];
		if (items.length) slide.addText(bulletRuns(c, items, 20, k.fg), { x: MX, y: 3.1, w, h: 3.2, fontFace: c.t.bodyFont, valign: "top", margin: 0, fit: "shrink" });
		if (s.subtitle) slide.addText(String(s.subtitle), { x: MX, y: 6.4, w, h: 0.5, fontFace: c.t.bodyFont, fontSize: 14, color: k.fg, margin: 0 });
		footer(c, slide, { layout: "closing" }, n, k.onColor, w);
	},
};

const NO_FOOTER = new Set(["title", "section", "closing", "statement", "quote", "big_number", "split"]);

function paragraph(c: Ctx, slide: any, n: number, text: string, x: number, y: number, w: number, h: number, max: number, color = c.t.ink) {
	const f = fit([text], w, h, max, 12, 0);
	if (f.overflow) c.warn(n, `text block too long: "${text.slice(0, 40)}..."`);
	slide.addText(rich(text, { color }), { x, y, w, h, fontFace: c.t.bodyFont, fontSize: f.pt, valign: "top", margin: 0, fit: "shrink", paraSpaceAfter: 6 });
}

function calloutBox(c: Ctx, slide: any, n: number, text: string, x: number, y: number, w: number, h: number) {
	const st = styleOf(c);
	const f = fit([text], w - 0.6, h - 0.5, st === "editorial" ? 22 : 20, 13, 0);
	if (f.overflow) c.warn(n, "takeaway/callout too long; one or two sentences");
	if (st === "editorial") {
		// A pull quote: rule above, the display face, no box.
		slide.addShape(c.pptx.ShapeType.rect, { x, y, w: 0.55, h: 0.035, fill: { color: c.t.accent2 }, line: { type: "none" } });
		slide.addText(rich(text, { color: c.t.ink }), { x, y: y + 0.2, w, h: h - 0.2, fontFace: c.t.headFont, fontSize: f.pt, valign: "top", margin: 0, fit: "shrink" });
		return;
	}
	if (st === "modern") {
		card(c, slide, x, y, w, h, c.t.accent);
		slide.addText(rich(text, { color: c.t.onAccent }), { x: x + 0.3, y: y + 0.25, w: w - 0.55, h: h - 0.5, fontFace: c.t.bodyFont, fontSize: f.pt, valign: "middle", margin: 0, fit: "shrink" });
		return;
	}
	card(c, slide, x, y, w, h);
	slide.addShape(c.pptx.ShapeType.rect, { x, y, w: 0.08, h, fill: { color: c.t.accent2 }, line: { color: c.t.accent2 } });
	slide.addText(rich(text, { color: c.t.ink }), { x: x + 0.3, y: y + 0.25, w: w - 0.55, h: h - 0.5, fontFace: c.t.bodyFont, fontSize: f.pt, valign: "middle", margin: 0, fit: "shrink" });
}

function fmt(v: unknown, decimals = 0): string {
	if (typeof v === "number") return v.toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
	return String(v ?? "");
}

/** Light tint of a color (mix with white), for highlighted table rows. */
/** Mixes a color toward `toward` (the slide background, so tints stay readable on dark themes). */
function tint(color: string, k = 0.82, toward = "FFFFFF"): string {
	const c = parseInt(color, 16);
	const t = parseInt(toward, 16);
	return [16, 8, 0]
		.map((sh) => {
			const v = (c >> sh) & 255;
			return Math.round(v + (((t >> sh) & 255) - v) * k).toString(16).padStart(2, "0");
		})
		.join("")
		.toUpperCase();
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
	if (pie && points > 5) c.warn(n, `${ch.type} with ${points} slices; use a sorted bar chart above 5`);
	if (ch.series.length > 5) c.warn(n, `${ch.series.length} series; more than 5 is unreadable`);
	for (const s of ch.series) if (s.values.length !== points) c.warn(n, `series "${s.name}" has ${s.values.length} values for ${points} categories`);

	let colors = c.t.chart;
	let legend = ch.series.length > 1 || pie;
	if (ch.highlight !== undefined && ch.series.length === 1 && !pie) {
		const idx = typeof ch.highlight === "number" ? ch.highlight : ch.categories.indexOf(String(ch.highlight));
		if (idx < 0) c.warn(n, `highlight "${ch.highlight}" is not a category`);
		colors = ch.categories.map((_, i) => (i === idx ? c.t.accent : tint(c.t.muted, 0.45, c.t.bg)));
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

/** Deck-level habits that make decks look generated (adapted from pbakaus/impeccable, Apache-2.0). */
function deckLint(deck: DeckSpec): string[] {
	const out: string[] = [];
	const layouts = deck.slides.map((s) => s.layout);
	for (let i = 0; i < layouts.length; ) {
		let j = i;
		while (j + 1 < layouts.length && layouts[j + 1] === layouts[i]) j++;
		if (j - i + 1 >= 4) out.push(`slides ${i + 1}-${j + 1}: ${j - i + 1} "${layouts[i]}" slides in a row; break the run with a statement, big_number or another form`);
		i = j + 1;
	}
	const count = (l: string) => layouts.filter((x) => x === l).length;
	if (deck.slides.length >= 6 && count("bullets") * 3 > deck.slides.length) {
		out.push(`${count("bullets")} of ${deck.slides.length} slides are bullets; keep it to a third: turn numbers into kpis/chart, options into comparison, plans into timeline`);
	}
	if (count("cards") > 2) out.push(`${count("cards")} cards slides; use cards at most twice (icon grids everywhere look generated)`);
	if (count("big_number") > 2) out.push(`${count("big_number")} big_number slides; keep at most 2 so the big number stays special`);
	const emoji = deck.slides.flatMap((s, i) =>
		JSON.stringify({ ...s, icon: undefined, background_image: undefined, path: undefined }).match(/(?![\u00A9\u00AE\u2122])\p{Extended_Pictographic}/gu) ? [i + 1] : [],
	);
	if (emoji.length) out.push(`slides ${emoji.join(", ")}: emoji or pictographs in the text; remove them and use the "icon" field (Lucide) instead`);
	return out;
}

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
	/** One PNG per slide (when preview was requested), for the model to look at. */
	previews: Buffer[];
}

export interface RenderOptions {
	workspace: string;
	resolve: (p: string) => string;
	themes?: Record<string, Theme>;
	/** Draw slide PNGs and measure the real layout (overflow, collisions). Default true. */
	preview?: boolean;
}

/** Theme from a name, a workspace .json file or an inline {extends, ...} object (decks and dashboards). */
export async function resolveTheme(deck: Pick<DeckSpec, "theme">, themes: Record<string, Theme>, opts: Pick<RenderOptions, "resolve">, warnings: string[]): Promise<Theme> {
	const names = Object.keys(themes).join(", ");
	let spec: unknown = deck.theme ?? "executive";
	if (typeof spec === "string" && spec.endsWith(".json")) {
		try {
			spec = JSON.parse(await readFile(opts.resolve(spec), "utf8"));
		} catch (e) {
			warnings.push(`theme file ${deck.theme}: ${(e as Error).message}; used executive`);
			spec = "executive";
		}
	}
	if (typeof spec === "string") {
		if (!themes[spec]) warnings.push(`unknown theme "${spec}" (use one of ${names}, a .json theme file, or an inline theme object); used executive`);
		return themes[spec] ?? themes.executive ?? DEFAULT_THEME;
	}
	const custom = (spec ?? {}) as Record<string, any>;
	const base = themes[custom.extends ?? "executive"] ?? DEFAULT_THEME;
	if (custom.extends && !themes[custom.extends]) warnings.push(`theme.extends "${custom.extends}" unknown (use one of ${names})`);
	const merged = { ...base, ...custom };
	const problems = themeProblems(merged);
	if (problems.length) {
		warnings.push(`custom theme invalid (${problems.join("; ")}); used ${custom.extends ?? "executive"}`);
		return base;
	}
	return normalizeTheme(merged);
}

/** Readability lint for the final palette (custom themes and brand colors can break it). */
function paletteWarnings(t: Theme): string[] {
	const w: string[] = [];
	const check = (fg: string, bg: string, what: string, min: number) => {
		const r = contrast(fg, bg);
		if (r < min) w.push(`theme: ${what} contrast ${r.toFixed(1)}:1 is below ${min}:1; pick a darker/lighter color`);
	};
	check(t.ink, t.bg, "text on background", 4.5);
	check(t.muted, t.bg, "muted text on background", 3);
	check(t.ink, t.surface, "text on cards", 4.5);
	check(t.onAccent, t.accent, "text on accent (covers, headers)", 4.5);
	return w;
}

export async function renderDeck(deck: DeckSpec, opts: RenderOptions): Promise<RenderResult> {
	if (!deck || !Array.isArray(deck.slides) || deck.slides.length === 0) throw new Error("spec needs {title, slides:[...]}");
	const warnings: string[] = [];
	const base = await resolveTheme(deck, opts.themes ?? { executive: DEFAULT_THEME }, opts, warnings);
	const b = deck.brand ?? {};
	const t: Theme = {
		...base,
		...(b.dark ? { bg: "0F172A", surface: "1E293B", ink: "E2E8F0", muted: "94A3B8", line: "334155", good: "34D399", bad: "F87171" } : {}),
		accent: hex(b.accent) ?? base.accent,
		accent2: hex(b.accent2) ?? base.accent2,
		headFont: b.headFont ?? base.headFont,
		bodyFont: b.bodyFont ?? base.bodyFont,
	};
	if (hex(b.accent)) t.chart = [t.accent, t.accent2, ...base.chart.slice(2)];
	warnings.push(...paletteWarnings(t));

	const pptx = new PptxGenJS();
	pptx.layout = "LAYOUT_WIDE";
	pptx.title = deck.title;
	if (deck.author) pptx.author = deck.author;
	pptx.theme = { headFontFace: t.headFont, bodyFontFace: t.bodyFont };

	const noNotes: number[] = [];
	const recs: Recorded[] = [];
	const c: Ctx = { pptx, t, deck, workspace: opts.workspace, resolve: opts.resolve, warn: (n, m) => warnings.push(`slide ${n}: ${m}`) };

	const withImage = deck.slides.filter((s) => s.background_image || s.layout === "split").length;
	if (withImage > 3) warnings.push(`${withImage} slides with a large picture (background_image or split); use at most 3 so they stay special`);
	for (const [i, s] of deck.slides.entries()) {
		const n = i + 1;
		const layout = LAYOUTS[s.layout];
		c.bgImage = s.background_image ? await bgImage(c, s, n) : undefined;
		const slide = pptx.addSlide();
		recs.push(record(slide));
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
	warnings.push(...deckLint(deck));
	if (noNotes.length) warnings.push(`slides ${noNotes.join(", ")}: no speaker notes (add "notes")`);

	const previews: Buffer[] = [];
	if (opts.preview !== false) {
		for (const [i, r] of recs.entries()) {
			const p = await renderSlide(r);
			previews.push(p.png);
			for (const m of p.issues) warnings.push(`slide ${i + 1} (measured): ${m}`);
		}
	}
	const bytes = (await pptx.write({ outputType: "nodebuffer", compression: true })) as Buffer;
	return { bytes, slides: deck.slides.length, warnings, previews };
}

const IMAGE_COVERS = new Set(["title", "section"]);

async function bgImage(c: Ctx, s: SlideSpec, n: number): Promise<string | undefined> {
	const path = String(s.background_image);
	if (!IMAGE_COVERS.has(s.layout)) {
		c.warn(n, `background_image works on ${[...IMAGE_COVERS].join(", ")}; for "${s.layout}" use the image layout`);
		return undefined;
	}
	const ext = extname(path).slice(1).toLowerCase().replace("jpg", "jpeg");
	if (ext !== "png" && ext !== "jpeg") {
		c.warn(n, `background_image must be .png or .jpg (got ${path})`);
		return undefined;
	}
	try {
		return `image/${ext};base64,${(await readFile(c.resolve(path))).toString("base64")}`;
	} catch (e) {
		c.warn(n, `background_image ${path} not loaded: ${(e as Error).message}`);
		return undefined;
	}
}

export const LAYOUT_NAMES = Object.keys(LAYOUTS);
