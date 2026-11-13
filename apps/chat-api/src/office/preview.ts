// Deck preview without LibreOffice or any subprocess: every pptxgenjs call made by the renderer is
// recorded, then redrawn on a pure-JS canvas (pureimage) with open fonts metric-close to the deck
// fonts (Carlito ~ Calibri/Aptos, Gelasio ~ Georgia; OFL, assets/fonts). Two outputs:
//  - PNG per slide, returned to the (vision) model so it can review its own deck, like a designer;
//  - measured layout issues (text overflowing its box, text boxes colliding, content off the slide),
//    computed from real glyph widths instead of the character-count estimate the renderer uses.
// It is an approximation of PowerPoint (charts and tables are simplified) - good for layout review.
// The package main is a CJS bundle with its own opentype.js 0.4 (kerning crash); the ESM build uses the 1.3.4 override.
import * as PImage from "pureimage/dist/index.js";
import { PassThrough } from "node:stream";

type Opts = Record<string, any>;
export type Op =
	| { kind: "text"; text: unknown; o: Opts }
	| { kind: "shape"; type: string; o: Opts }
	| { kind: "chart"; type: string; data: any[]; o: Opts }
	| { kind: "table"; rows: any[][]; o: Opts }
	| { kind: "image"; o: Opts };

export interface Recorded {
	ops: Op[];
	bg: () => string;
}

/** Wraps a pptxgenjs slide so every add* call is also recorded for the preview. */
export function record(slide: any): Recorded {
	const ops: Op[] = [];
	const wrap = (name: string, f: (...a: any[]) => Op) => {
		const orig = slide[name].bind(slide);
		slide[name] = (...a: any[]) => {
			// Copy first: pptxgenjs rewrites the options it receives (e.g. table colW into EMU).
			ops.push(f(...a.map((v) => (v && typeof v === "object" ? structuredClone(v) : v))));
			return orig(...a);
		};
	};
	wrap("addText", (text, o) => ({ kind: "text", text, o: o ?? {} }));
	wrap("addShape", (type, o) => ({ kind: "shape", type: String(type), o: o ?? {} }));
	wrap("addChart", (type, data, o) => ({ kind: "chart", type: String(type), data, o: o ?? {} }));
	wrap("addTable", (rows, o) => ({ kind: "table", rows, o: o ?? {} }));
	wrap("addImage", (o) => ({ kind: "image", o: o ?? {} }));
	return { ops, bg: () => slide.background?.color ?? "FFFFFF" };
}

// ---------- fonts ----------

type Face = { font: any; fake: boolean; hscale: number };
let FONTS: Record<string, any> | undefined;

function fonts() {
	if (FONTS) return FONTS;
	const dir = new URL("../../assets/fonts/", import.meta.url).pathname;
	const reg = (file: string, fam: string) => {
		const f = PImage.registerFont(dir + file, fam);
		f.loadSync();
		return (f as any).font;
	};
	FONTS = {
		sans: reg("Carlito-Regular.ttf", "pv-sans"),
		sansBold: reg("Carlito-Bold.ttf", "pv-sans-bold"),
		sansItalic: reg("Carlito-Italic.ttf", "pv-sans-italic"),
		serif: reg("Gelasio.ttf", "pv-serif"),
	};
	return FONTS;
}

/** Deck font -> preview font. Aptos is ~5% wider than Carlito, so it is stretched to keep widths honest. */
function face(name: string | undefined, bold: boolean, italic: boolean): Face {
	const F = fonts();
	const n = (name ?? "").toLowerCase();
	if (/georgia|serif|garamond|times|cambria|playfair|merriweather/.test(n)) return { font: F.serif, fake: bold, hscale: bold ? 1.04 : 1 };
	const hscale = n.startsWith("aptos") ? 1.05 : 1;
	if (bold) return { font: F.sansBold, fake: false, hscale };
	if (italic) return { font: F.sansItalic, fake: false, hscale };
	return { font: F.sans, fake: false, hscale };
}

// ---------- drawing primitives ----------

const PX = 80; // pixels per inch: 13.333 x 7.5 in -> 1067 x 600
const W_IN = 13.333;
const H_IN = 7.5;

function rgba(hex: string | undefined, transparency = 0): string {
	const h = (hex ?? "000000").replace("#", "");
	const n = parseInt(h.length === 6 ? h : "000000", 16);
	return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, 1 - transparency / 100))})`;
}

const K = 0.5522847498;
function ellipsePath(c: any, x: number, y: number, w: number, h: number) {
	const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
	c.beginPath();
	c.moveTo(cx - rx, cy);
	c.bezierCurveTo(cx - rx, cy - K * ry, cx - K * rx, cy - ry, cx, cy - ry);
	c.bezierCurveTo(cx + K * rx, cy - ry, cx + rx, cy - K * ry, cx + rx, cy);
	c.bezierCurveTo(cx + rx, cy + K * ry, cx + K * rx, cy + ry, cx, cy + ry);
	c.bezierCurveTo(cx - K * rx, cy + ry, cx - rx, cy + K * ry, cx - rx, cy);
	c.closePath();
}

function roundRectPath(c: any, x: number, y: number, w: number, h: number, r: number) {
	r = Math.min(r, w / 2, h / 2);
	c.beginPath();
	c.moveTo(x + r, y);
	c.lineTo(x + w - r, y);
	c.quadraticCurveTo(x + w, y, x + w, y + r);
	c.lineTo(x + w, y + h - r);
	c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	c.lineTo(x + r, y + h);
	c.quadraticCurveTo(x, y + h, x, y + h - r);
	c.lineTo(x, y + r);
	c.quadraticCurveTo(x, y, x + r, y);
	c.closePath();
}

function rectPath(c: any, x: number, y: number, w: number, h: number) {
	c.beginPath();
	c.moveTo(x, y);
	c.lineTo(x + w, y);
	c.lineTo(x + w, y + h);
	c.lineTo(x, y + h);
	c.closePath();
}

/** Splits a string into runs the font can draw and single symbols it lacks (▲ ▼ ■ ● → ...). */
function pieces(f: Face, s: string): { text: string; symbol: boolean }[] {
	const out: { text: string; symbol: boolean }[] = [];
	for (const ch of s) {
		const symbol = f.font.charToGlyphIndex(ch) === 0 && !/\s/.test(ch);
		const last = out[out.length - 1];
		if (last && !symbol && !last.symbol) last.text += ch;
		else out.push({ text: ch, symbol });
	}
	return out;
}

const SYMBOL_EM = 0.72;

/** Fallback drawing for symbols missing from the open fonts: simple filled shapes. */
function symbol(c: any, ch: string, x: number, y: number, px: number) {
	const s = px * 0.62, top = y - px * 0.62, cx = x + (px * SYMBOL_EM) / 2;
	c.beginPath();
	if ("▲△▴⬆↑".includes(ch)) { c.moveTo(cx, top); c.lineTo(cx + s / 2, top + s); c.lineTo(cx - s / 2, top + s); }
	else if ("▼▽▾⬇↓".includes(ch)) { c.moveTo(cx - s / 2, top); c.lineTo(cx + s / 2, top); c.lineTo(cx, top + s); }
	else if ("→➜►▶".includes(ch)) { c.moveTo(cx - s / 2, top); c.lineTo(cx + s / 2, top + s / 2); c.lineTo(cx - s / 2, top + s); }
	else if ("●•◆".includes(ch)) return ellipsePath(c, cx - s / 3, top + s / 6, (s * 2) / 3, (s * 2) / 3), c.fill();
	else { c.moveTo(cx - s / 3, top + s / 6); c.lineTo(cx + s / 3, top + s / 6); c.lineTo(cx + s / 3, top + (s * 5) / 6); c.lineTo(cx - s / 3, top + (s * 5) / 6); }
	c.closePath();
	c.fill();
}

/** Draws a string. One path per glyph: the rasterizer scans each path's bounding box against all its
 * edges, so a whole line as one path is quadratic (and filling contour by contour fills the holes of o/a/e). */
function glyphs(c: any, f: Face, s: string, x: number, y: number, px: number, color: string) {
	if (!s.trim()) return;
	c.fillStyle = color;
	let ox = x;
	for (const piece of pieces(f, s)) {
		if (piece.symbol) {
			symbol(c, piece.text, ox, y, px);
			ox += px * SYMBOL_EM;
			continue;
		}
		const X = (v: number) => ox + v * f.hscale;
		const Y = (v: number) => y + v;
		f.font.forEachGlyph(piece.text, 0, 0, px, undefined, (g: any, gx: number, gy: number) => {
			const cmds = g.getPath(gx, gy, px).commands;
			if (!cmds.length) return;
			c.beginPath();
			for (const k of cmds) {
				if (k.type === "M") c.moveTo(X(k.x), Y(k.y));
				else if (k.type === "L") c.lineTo(X(k.x), Y(k.y));
				else if (k.type === "Q") c.quadraticCurveTo(X(k.x1), Y(k.y1), X(k.x), Y(k.y));
				else if (k.type === "C") c.bezierCurveTo(X(k.x1), Y(k.y1), X(k.x2), Y(k.y2), X(k.x), Y(k.y));
				else if (k.type === "Z") c.closePath();
			}
			c.fill();
			if (f.fake) {
				c.strokeStyle = color;
				c.lineWidth = Math.max(0.6, px * 0.035);
				c.stroke();
			}
		});
		ox += f.font.getAdvanceWidth(piece.text, px) * f.hscale;
	}
}

const advance = (f: Face, s: string, px: number) =>
	pieces(f, s).reduce((w, p) => w + (p.symbol ? px * SYMBOL_EM : f.font.getAdvanceWidth(p.text, px) * f.hscale), 0);

// ---------- text layout ----------

interface Run { text: string; face: Face; px: number; color: string; underline?: boolean }
interface Para { runs: Run[]; align: string; bullet?: string; indent: number; after: number }
interface Line { runs: { run: Run; text: string; w: number }[]; w: number; h: number; para: Para; first: boolean }

const PT = PX / 72; // pixels per point

function paragraphs(text: unknown, o: Opts): Para[] {
	const items: { text: string; options: Opts }[] = Array.isArray(text)
		? text.map((t) => (typeof t === "string" ? { text: t, options: {} } : { text: String(t?.text ?? ""), options: t?.options ?? {} }))
		: [{ text: String(text ?? ""), options: {} }];
	const paras: Para[] = [];
	let cur: Para | undefined;
	const start = (op: Opts) => {
		const bulletOpt = op.bullet ?? o.bullet;
		const bullet = bulletOpt ? (bulletOpt === true ? "•" : bulletOpt.code ? String.fromCharCode(parseInt(bulletOpt.code, 16)) : bulletOpt.characterCode ? String.fromCharCode(parseInt(bulletOpt.characterCode, 16)) : "•") : undefined;
		const size = op.fontSize ?? o.fontSize ?? 18;
		const ind = bullet ? (typeof bulletOpt === "object" && bulletOpt.indent ? bulletOpt.indent : size * 1.1) : 0;
		cur = { runs: [], align: op.align ?? o.align ?? "left", bullet, indent: (ind + (op.indentLevel ?? 0) * size * 1.6) * PT, after: (op.paraSpaceAfter ?? o.paraSpaceAfter ?? 0) * PT };
		paras.push(cur);
	};
	for (const it of items) {
		const op = { ...o, ...it.options };
		const chunks = it.text.split("\n");
		chunks.forEach((chunk, i) => {
			if (!cur || i > 0) start(op);
			const size = op.fontSize ?? 18;
			cur!.runs.push({ text: chunk, face: face(op.fontFace, !!op.bold, !!op.italic), px: size * PT, color: rgba(op.color ?? "000000", op.transparency ?? 0) });
		});
		if (it.options.breakLine) cur = undefined;
	}
	return paras;
}

function layoutLines(paras: Para[], width: number, lineSpacing = 1.2): Line[] {
	const lines: Line[] = [];
	for (const p of paras) {
		const avail = Math.max(10, width - p.indent);
		let line: Line = { runs: [], w: 0, h: 0, para: p, first: true };
		const push = () => {
			if (!line.h) line.h = Math.max(...p.runs.map((r) => r.px), 1) * lineSpacing;
			lines.push(line);
			line = { runs: [], w: 0, h: 0, para: p, first: false };
		};
		for (const run of p.runs) {
			const words = run.text.split(/(\s+)/).filter((w) => w !== "");
			for (const word of words) {
				let ww = advance(run.face, word, run.px);
				if (/^\s+$/.test(word) && line.w === 0) continue;
				if (line.w + ww > avail && line.w > 0 && !/^\s+$/.test(word)) {
					// trim trailing space of the line
					const last = line.runs[line.runs.length - 1];
					if (last && /\s$/.test(last.text)) {
						const t = last.text.replace(/\s+$/, "");
						line.w -= last.w - advance(last.run.face, t, last.run.px);
						last.w = advance(last.run.face, t, last.run.px);
						last.text = t;
					}
					push();
				}
				const prev = line.runs[line.runs.length - 1];
				if (prev && prev.run === run) {
					prev.text += word;
					prev.w += ww;
				} else line.runs.push({ run, text: word, w: ww });
				line.w += ww;
				line.h = Math.max(line.h, run.px * lineSpacing);
			}
		}
		push();
		lines[lines.length - 1].h += p.after;
	}
	return lines;
}

interface Box { x: number; y: number; w: number; h: number }
interface TextResult { box: Box; ink: Box | undefined; overflow: number; label: string }

function drawText(c: any, text: unknown, o: Opts, draw = true): TextResult {
	const x = (o.x ?? 0) * PX, y = (o.y ?? 0) * PX, w = (o.w ?? 1) * PX, h = (o.h ?? 0.5) * PX;
	// margin: pptxgenjs text = [left, right, bottom, top] in points; absent = PowerPoint default 0.1in / 0.05in
	let [ml, mr, mb, mt] = [0.1 * PX, 0.1 * PX, 0.05 * PX, 0.05 * PX];
	if (typeof o.margin === "number") ml = mr = mb = mt = o.margin * PT;
	else if (Array.isArray(o.margin)) [ml, mr, mb, mt] = o.margin.map((v: number) => (v ?? 0) * PT);
	const paras = paragraphs(text, o);
	const lines = layoutLines(paras, w - ml - mr, o.lineSpacingMultiple ?? 1.2);
	const total = lines.reduce((s, l) => s + l.h, 0);
	const inner = h - mt - mb;
	const valign = o.valign ?? "middle";
	let cy = y + mt + (valign === "top" ? 0 : valign === "bottom" ? inner - total : (inner - total) / 2);
	if (valign !== "top" && total > inner) cy = y + mt + (valign === "bottom" ? inner - total : (inner - total) / 2);
	let ink: Box | undefined;
	for (const l of lines) {
		const p = l.para;
		const avail = w - ml - mr - p.indent;
		const left = x + ml + p.indent + (p.align === "center" ? (avail - l.w) / 2 : p.align === "right" ? avail - l.w : 0);
		const lineH = l.h - (l === lines[lines.length - 1] || lines[lines.indexOf(l) + 1]?.para !== p ? p.after : 0);
		const base = cy + lineH * 0.8;
		if (draw && l.first && p.bullet && p.runs[0]) {
			const r = p.runs[0];
			glyphs(c, r.face, p.bullet, left - p.indent + (p.indent - advance(r.face, p.bullet, r.px)) / 2 - 2, base, r.px, r.color);
		}
		let cx = left;
		for (const seg of l.runs) {
			if (draw) glyphs(c, seg.run.face, seg.text, cx, base, seg.run.px, seg.run.color);
			cx += seg.w;
		}
		if (l.w > 0) {
			const b = { x: left, y: cy, w: l.w, h: lineH };
			ink = ink ? union(ink, b) : b;
		}
		cy += l.h;
	}
	const label = (Array.isArray(text) ? text.map((t: any) => (typeof t === "string" ? t : t?.text)).join(" ") : String(text ?? "")).trim().slice(0, 40);
	return { box: { x, y, w, h }, ink, overflow: total > inner + 2 ? total / Math.max(1, inner) : 0, label };
}

const union = (a: Box, b: Box): Box => {
	const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
	return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const overlap = (a: Box, b: Box) => {
	const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
	return w > 0 && h > 0 ? w * h : 0;
};

// ---------- shapes ----------

function drawShape(c: any, type: string, o: Opts) {
	const x = (o.x ?? 0) * PX, y = (o.y ?? 0) * PX, w = (o.w ?? 0) * PX, h = (o.h ?? 0) * PX;
	const fill = o.fill && o.fill.type !== "none" && o.fill.color ? rgba(o.fill.color, o.fill.transparency ?? 0) : undefined;
	const ln = o.line && o.line.type !== "none" && o.line.color ? o.line : undefined;
	const stroke = () => {
		if (!ln) return;
		c.strokeStyle = rgba(ln.color, ln.transparency ?? 0);
		c.lineWidth = Math.max(0.75, (ln.width ?? 1) * PT);
		c.stroke();
	};
	if (type === "line") {
		c.beginPath();
		c.moveTo(x, y);
		c.lineTo(x + w, y + h);
		stroke();
		return;
	}
	if (type === "custGeom") {
		c.beginPath();
		let lx = NaN, ly = NaN;
		const same = (ax: number, ay: number) => Math.abs(ax - lx) < 0.01 && Math.abs(ay - ly) < 0.01;
		for (const p of o.points ?? []) {
			if (p.close) {
				c.closePath();
				continue;
			}
			const px = x + p.x * PX, py = y + p.y * PX;
			if (p.moveTo) c.moveTo(px, py);
			else if (p.curve) {
				const [ax, ay, bx, by] = [x + p.curve.x1 * PX, y + p.curve.y1 * PX, x + p.curve.x2 * PX, y + p.curve.y2 * PX];
				if (same(px, py) && same(ax, ay) && same(bx, by)) continue; // zero-length: the rasterizer logs and skips it
				c.bezierCurveTo(ax, ay, bx, by, px, py);
			} else if (!same(px, py)) c.lineTo(px, py);
			else continue;
			lx = px;
			ly = py;
		}
		if (fill) {
			c.fillStyle = fill;
			c.fill();
		}
		stroke();
		return;
	}
	if (type === "ellipse" || type === "oval") ellipsePath(c, x, y, w, h);
	else if (type === "roundRect") roundRectPath(c, x, y, w, h, (o.rectRadius ?? 0.08) * PX);
	else rectPath(c, x, y, w, h);
	if (fill) {
		c.fillStyle = fill;
		c.fill();
	}
	stroke();
}

// ---------- charts (simplified) ----------

function fmtNum(v: number, code: string | undefined): string {
	const f = code ?? "#,##0";
	const pct = f.includes("%");
	const dec = (f.split(".")[1] ?? "").replace(/[^0#]/g, "").length;
	const n = pct ? v * 100 : v;
	const s = n.toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
	const lit = (re: RegExp) => (f.match(re)?.[1] ?? "").replace(/\\/g, "");
	return `${lit(/^"([^"]*)"/)}${s}${pct ? "%" : ""}${lit(/"([^"]*)"$/)}`;
}

function drawChart(c: any, type: string, data: any[], o: Opts) {
	const x = (o.x ?? 0) * PX, y = (o.y ?? 0) * PX, w = (o.w ?? 4) * PX, h = (o.h ?? 3) * PX;
	const colors: string[] = o.chartColors ?? ["4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5"];
	const F = face(o.catAxisLabelFontFace, false, false);
	const labelPx = (o.catAxisLabelFontSize ?? 12) * PT;
	const muted = rgba(o.catAxisLabelColor ?? "666666");
	const cats: string[] = data[0]?.labels ?? [];
	const pie = type === "pie" || type === "doughnut";
	let top = y, bottom = y + h, left = x, right = x + w;
	if (o.showLegend && !pie && data.length > 1) {
		let lx = x;
		for (const [i, s] of data.entries()) {
			c.fillStyle = rgba(colors[i % colors.length]);
			c.fillRect(lx, y + 4, 10, 10);
			glyphs(c, F, String(s.name), lx + 14, y + 14, labelPx, muted);
			lx += 30 + advance(F, String(s.name), labelPx);
		}
		top += 24;
	}
	if (pie) {
		const vals: number[] = data[0]?.values ?? [];
		const sum = vals.reduce((a, b) => a + (Number(b) || 0), 0) || 1;
		const legendW = o.showLegend ? Math.min(w * 0.4, 200) : 0;
		const d = Math.min(w - legendW, h) * 0.9;
		const cx = x + (w - legendW) / 2, cy = y + h / 2, r = d / 2;
		let a = -Math.PI / 2;
		vals.forEach((v, i) => {
			const da = ((Number(v) || 0) / sum) * Math.PI * 2;
			c.fillStyle = rgba(colors[i % colors.length]);
			c.beginPath();
			c.moveTo(cx, cy);
			const steps = Math.max(2, Math.ceil(da / 0.05));
			for (let k = 0; k <= steps; k++) c.lineTo(cx + r * Math.cos(a + (da * k) / steps), cy + r * Math.sin(a + (da * k) / steps));
			c.closePath();
			c.fill();
			const mid = a + da / 2;
			const lr = type === "doughnut" ? r * 0.81 : r * 0.62;
			const lbl = `${Math.round(((Number(v) || 0) / sum) * 100)}%`;
			const lp = (o.dataLabelFontSize ?? 13) * PT;
			if (da > 0.25) glyphs(c, face(o.dataLabelFontFace, true, false), lbl, cx + lr * Math.cos(mid) - advance(F, lbl, lp) / 2, cy + lr * Math.sin(mid) + lp / 3, lp, rgba(o.dataLabelColor ?? "FFFFFF"));
			a += da;
		});
		if (type === "doughnut") {
			c.fillStyle = rgba(o.plotArea?.fill?.color ?? "FFFFFF");
			ellipsePath(c, cx - r * (o.holeSize ?? 50) / 100, cy - r * (o.holeSize ?? 50) / 100, (2 * r * (o.holeSize ?? 50)) / 100, (2 * r * (o.holeSize ?? 50)) / 100);
			c.fill();
		}
		if (o.showLegend) {
			const lp = (o.legendFontSize ?? 14) * PT;
			cats.forEach((cat, i) => {
				const ly = cy - (cats.length * lp * 1.6) / 2 + i * lp * 1.6;
				c.fillStyle = rgba(colors[i % colors.length]);
				c.fillRect(x + w - legendW, ly, lp * 0.7, lp * 0.7);
				glyphs(c, F, String(cat), x + w - legendW + lp, ly + lp * 0.7, lp, rgba(o.legendColor ?? "666666"));
			});
		}
		return;
	}
	const horizontal = o.barDir === "bar";
	const stacked = o.barGrouping === "stacked";
	const n = cats.length;
	const totals = cats.map((_, j) => (stacked ? data.reduce((s, d) => s + Math.max(0, Number(d.values[j]) || 0), 0) : Math.max(...data.map((d) => Number(d.values[j]) || 0))));
	const max = Math.max(...totals, 1e-9);
	const showVal = !!o.showValue;
	const vp = (o.dataLabelFontSize ?? 12) * PT;
	if (horizontal) {
		const catW = Math.min(w * 0.35, Math.max(...cats.map((s) => advance(F, String(s), labelPx))) + 10);
		left += catW;
		const band = (bottom - top) / n;
		const reverse = o.catAxisOrientation !== "maxMin" ? true : false; // maxMin -> first category on top
		cats.forEach((cat, j) => {
			const row = reverse ? n - 1 - j : j;
			const by = top + row * band;
			glyphs(c, F, String(cat), x + catW - 8 - advance(F, String(cat), labelPx), by + band / 2 + labelPx / 3, labelPx, muted);
			let acc = 0;
			data.forEach((d, i) => {
				const v = Math.max(0, Number(d.values[j]) || 0);
				const bw = (v / max) * (right - left - (showVal ? 60 : 0));
				const bh = stacked ? band * 0.65 : (band * 0.65) / data.length;
				const yy = by + band * 0.175 + (stacked ? 0 : i * bh);
				c.fillStyle = rgba(colors[(data.length === 1 && colors.length >= n ? j : i) % colors.length]);
				c.fillRect(left + acc, yy, bw, bh);
				if (showVal) glyphs(c, F, fmtNum(v, o.dataLabelFormatCode), left + acc + bw + 4, yy + bh / 2 + vp / 3, vp, rgba(o.dataLabelColor ?? "333333"));
				if (stacked) acc += bw;
			});
		});
		return;
	}
	bottom -= labelPx * 2;
	const band = (right - left) / n;
	c.strokeStyle = rgba(o.catAxisLineColor ?? "CCCCCC");
	c.lineWidth = 1;
	c.beginPath();
	c.moveTo(left, bottom);
	c.lineTo(right, bottom);
	c.stroke();
	const plotH = bottom - top - (showVal ? vp * 1.6 : 4);
	cats.forEach((cat, j) => {
		const lw = advance(F, String(cat), labelPx);
		glyphs(c, F, String(cat), left + j * band + band / 2 - Math.min(lw, band) / 2, bottom + labelPx * 1.3, labelPx, muted);
	});
	if (type === "line" || type === "area") {
		data.forEach((d, i) => {
			const pts = cats.map((_, j) => [left + j * band + band / 2, bottom - ((Number(d.values[j]) || 0) / max) * plotH]);
			c.strokeStyle = rgba(colors[i % colors.length]);
			c.lineWidth = (o.lineSize ?? 2) * PT;
			c.beginPath();
			pts.forEach(([px, py], k) => (k ? c.lineTo(px, py) : c.moveTo(px, py)));
			if (type === "area") {
				c.lineTo(pts[pts.length - 1][0], bottom);
				c.lineTo(pts[0][0], bottom);
				c.closePath();
				c.fillStyle = rgba(colors[i % colors.length], 30);
				c.fill();
			} else c.stroke();
			pts.forEach(([px, py], j) => {
				c.fillStyle = rgba(colors[i % colors.length]);
				ellipsePath(c, px - 4, py - 4, 8, 8);
				c.fill();
				if (showVal) {
					const s = fmtNum(Number(d.values[j]) || 0, o.dataLabelFormatCode);
					glyphs(c, F, s, px - advance(F, s, vp) / 2, py - 8, vp, rgba(o.dataLabelColor ?? "333333"));
				}
			});
		});
		return;
	}
	cats.forEach((_, j) => {
		let acc = 0;
		data.forEach((d, i) => {
			const v = Math.max(0, Number(d.values[j]) || 0);
			const bh = (v / max) * plotH;
			const bw = stacked ? band * 0.65 : (band * 0.65) / data.length;
			const bx = left + j * band + band * 0.175 + (stacked ? 0 : i * bw);
			c.fillStyle = rgba(colors[(data.length === 1 && colors.length >= n ? j : i) % colors.length]);
			c.fillRect(bx, bottom - acc - bh, bw, bh);
			if (showVal) {
				const s = fmtNum(v, o.dataLabelFormatCode);
				glyphs(c, F, s, bx + bw / 2 - advance(F, s, vp) / 2, stacked ? bottom - acc - bh / 2 + vp / 3 : bottom - bh - 5, vp, rgba(stacked ? "FFFFFF" : o.dataLabelColor ?? "333333"));
			}
			if (stacked) acc += bh;
		});
	});
}

// ---------- tables ----------

function drawTable(c: any, rows: any[][], o: Opts): Box {
	const x = (o.x ?? 0) * PX, y0 = (o.y ?? 0) * PX, w = (o.w ?? 10) * PX;
	const ncol = Math.max(...rows.map((r) => r.length), 1);
	const colW: number[] = Array.isArray(o.colW) ? o.colW.map((v: number) => v * PX) : Array(ncol).fill(w / ncol);
	const minH = (Array.isArray(o.rowH) ? o.rowH[0] : o.rowH ?? 0.4) * PX;
	const m = Array.isArray(o.margin) ? o.margin.map((v: number) => v * PT) : [4 * PT, 6 * PT, 4 * PT, 6 * PT]; // t r b l
	let y = y0;
	for (const r of rows) {
		const cells = r.map((cell) => (typeof cell === "object" && cell !== null ? cell : { text: String(cell ?? ""), options: {} }));
		const heights = cells.map((cell, j) => {
			const op = { ...o, ...cell.options, margin: [m[3] / PT, m[1] / PT, m[2] / PT, m[0] / PT], x: 0, y: 0, w: colW[j] / PX, h: 100, valign: "top" };
			const t = drawText(c, cell.text, op, false);
			return (t.ink?.h ?? 0) + m[0] + m[2];
		});
		const rh = Math.max(minH, ...heights);
		let cx = x;
		cells.forEach((cell, j) => {
			const op = { ...o, ...cell.options };
			if (op.fill?.color) {
				c.fillStyle = rgba(op.fill.color);
				c.fillRect(cx, y, colW[j], rh);
			}
			drawText(c, cell.text, { ...op, margin: [m[3] / PT, m[1] / PT, m[2] / PT, m[0] / PT], x: cx / PX, y: y / PX, w: colW[j] / PX, h: rh / PX, valign: op.valign ?? "middle" });
			cx += colW[j];
		});
		if (o.border?.color) {
			c.strokeStyle = rgba(o.border.color);
			c.lineWidth = 1;
			c.beginPath();
			c.moveTo(x, y + rh);
			c.lineTo(x + w, y + rh);
			c.stroke();
		}
		y += rh;
	}
	return { x, y: y0, w, h: y - y0 };
}

// ---------- images ----------

async function drawImage(c: any, o: Opts) {
	const m = /^(?:data:)?image\/(png|jpe?g);base64,(.*)$/s.exec(String(o.data ?? ""));
	if (!m) return;
	const buf = Buffer.from(m[2], "base64");
	const s = new PassThrough();
	s.end(buf);
	const img = m[1] === "png" ? await PImage.decodePNGFromStream(s) : await PImage.decodeJPEGFromStream(s);
	const bx = (o.x ?? 0) * PX, by = (o.y ?? 0) * PX, bw = (o.w ?? 1) * PX, bh = (o.h ?? 1) * PX;
	if (o.sizing?.type === "cover") {
		// Fill the box and crop the overflow: take the centered source window with the box's aspect.
		const k = Math.max(bw / img.width, bh / img.height);
		const sw = bw / k, sh = bh / k;
		c.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, bx, by, bw, bh);
		return;
	}
	const k = Math.min(bw / img.width, bh / img.height);
	const dw = img.width * k, dh = img.height * k;
	c.drawImage(img, 0, 0, img.width, img.height, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh);
}

// ---------- contrast (measured on the pixels behind the text) ----------

function lum(r: number, g: number, b: number): number {
	const f = (v: number) => {
		v /= 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function lowContrast(img: any, text: unknown, o: Opts): string | undefined {
	const first = Array.isArray(text) ? text.find((t: any) => typeof t === "object" && t?.text?.trim()) : undefined;
	const color = String((first as any)?.options?.color ?? o.color ?? "000000").replace("#", "");
	const transparency = (first as any)?.options?.transparency ?? o.transparency ?? 0;
	if (transparency >= 30) return undefined; // deliberate watermark-style text
	const t = drawText(null, text, o, false);
	if (!t.ink || t.label.length < 2) return undefined;
	// Background = most common color among samples inside the text area (before the text is drawn).
	const counts = new Map<number, number>();
	for (let i = 1; i <= 5; i++)
		for (let j = 1; j <= 3; j++) {
			const x = Math.round(t.ink.x + (t.ink.w * i) / 6), y = Math.round(t.ink.y + (t.ink.h * j) / 4);
			if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
			const px = img.getPixelRGBA(x, y) >>> 8; // drop alpha
			counts.set(px, (counts.get(px) ?? 0) + 1);
		}
	if (!counts.size) return undefined;
	const bgPx = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
	const n = parseInt(color.length === 6 ? color : "000000", 16);
	const fg = lum((n >> 16) & 255, (n >> 8) & 255, n & 255);
	const bg = lum((bgPx >> 16) & 255, (bgPx >> 8) & 255, bgPx & 255);
	const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
	if (ratio >= 3) return undefined;
	const hex = (v: number) => v.toString(16).padStart(6, "0").toUpperCase();
	return `text "${t.label}…" is hard to read: contrast ${ratio.toFixed(1)}:1 (#${color.toUpperCase()} on #${hex(bgPx)}); needs 3:1+`;
}

// ---------- slide ----------

export interface SlidePreview {
	png: Buffer;
	issues: string[];
}

export async function renderSlide(rec: Recorded): Promise<SlidePreview> {
	// pureimage console.warns "can't project the same paths" for harmless degenerate stroke joins.
	const warn = console.warn;
	console.warn = (...a: unknown[]) => (typeof a[0] === "string" && a[0].startsWith("can't project") ? undefined : warn(...a));
	try {
		return await drawSlide(rec);
	} finally {
		console.warn = warn;
	}
}

async function drawSlide(rec: Recorded): Promise<SlidePreview> {
	const img = PImage.make(Math.round(W_IN * PX), Math.round(H_IN * PX));
	const c = img.getContext("2d");
	c.fillStyle = rgba(rec.bg());
	c.fillRect(0, 0, img.width, img.height);
	const texts: TextResult[] = [];
	const issues: string[] = [];
	for (const op of rec.ops) {
		try {
			if (op.kind === "shape") drawShape(c, op.type, op.o);
			else if (op.kind === "text") {
				const low = lowContrast(img, op.text, op.o);
				if (low) issues.push(low);
				texts.push(drawText(c, op.text, op.o));
			}
			else if (op.kind === "chart") drawChart(c, op.type, op.data, op.o);
			else if (op.kind === "image") await drawImage(c, op.o);
			else if (op.kind === "table") {
				const b = drawTable(c, op.rows, op.o);
				if (b.y + b.h > 7.0 * PX) issues.push(`table runs ${((b.y + b.h) / PX - 7.0).toFixed(1)} in into the footer/off the slide: fewer rows or shorter cells`);
			}
		} catch (e) {
			issues.push(`preview could not draw a ${op.kind}: ${(e as Error).message}`);
		}
	}
	for (const t of texts) {
		if (t.overflow && t.label.length > 2) issues.push(`text "${t.label}…" overflows its box (${Math.round((t.overflow - 1) * 100)}% too tall): shorten it`);
		if (t.ink && (t.ink.x + t.ink.w > img.width + 2 || t.ink.y + t.ink.h > img.height + 2)) issues.push(`text "${t.label}…" runs off the slide`);
	}
	for (let i = 0; i < texts.length; i++)
		for (let j = i + 1; j < texts.length; j++) {
			const a = texts[i].ink, b = texts[j].ink;
			if (!a || !b) continue;
			const ov = overlap(a, b);
			if (ov > 0.15 * Math.min(a.w * a.h, b.w * b.h)) issues.push(`text "${texts[i].label}…" collides with "${texts[j].label}…"`);
		}
	const out = new PassThrough();
	const chunks: Buffer[] = [];
	out.on("data", (d) => chunks.push(d));
	await PImage.encodePNGToStream(img, out);
	return { png: Buffer.concat(chunks), issues };
}

/** Contact sheet (3 columns) of slide PNGs, for the user's files panel. */
export async function contactSheet(pngs: Buffer[]): Promise<Buffer> {
	const cols = 3, tw = 356, th = 200, gap = 12;
	const rows = Math.ceil(pngs.length / cols);
	const img = PImage.make(cols * tw + (cols + 1) * gap, rows * th + (rows + 1) * gap);
	const c = img.getContext("2d");
	c.fillStyle = "#E4E7EC";
	c.fillRect(0, 0, img.width, img.height);
	for (const [i, png] of pngs.entries()) {
		const s = new PassThrough();
		s.end(png);
		const src = await PImage.decodePNGFromStream(s);
		c.drawImage(src, 0, 0, src.width, src.height, gap + (i % cols) * (tw + gap), gap + Math.floor(i / cols) * (th + gap), tw, th);
	}
	const out = new PassThrough();
	const chunks: Buffer[] = [];
	out.on("data", (d) => chunks.push(d));
	await PImage.encodePNGToStream(img, out);
	return Buffer.concat(chunks);
}
