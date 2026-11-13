// Lucide icons (ISC, assets/LUCIDE-LICENSE) as native PowerPoint vector shapes.
// pptxgenjs cannot embed SVG from Node (the PNG fallback comes out broken), so each icon's SVG
// elements are converted to custom geometry: moveTo / lnTo / cubic / close, arcs as cubics.
// Result: crisp, recolorable icons that render in PowerPoint, Keynote, Google Slides, LibreOffice.
import { readFileSync } from "node:fs";

type El = [string, Record<string, string>];
const ICONS: Record<string, El[]> = JSON.parse(readFileSync(new URL("../../assets/lucide-icons.json", import.meta.url), "utf8"));

const TAGS: Record<string, string[]> = JSON.parse(readFileSync(new URL("../../assets/lucide-tags.json", import.meta.url), "utf8"));

export const ICON_NAMES = Object.keys(ICONS);
export const hasIcon = (name: string) => name in ICONS;

/** Closest icon names, for lint messages: shared words first, then small typos. */
export function suggestIcons(name: string, n = 4): string[] {
	const q = name.toLowerCase();
	const parts = q.split(/[-_\s]+/).filter((p) => p.length > 2);
	const hit = (w: string) => parts.some((p) => w.length > 2 && (p === w || (p.length > 3 && w.startsWith(p))));
	const words = ICON_NAMES.filter((k) => k.split("-").some(hit));
	const tagged = ICON_NAMES.filter((k) => (TAGS[k] ?? []).some((t) => t.split(/\s+/).some(hit)));
	const dist = ICON_NAMES.map((k) => [k, distance(q, k)] as const);
	const close = dist.filter(([, d]) => d <= 1).map(([k]) => k);
	const far = dist.filter(([, d]) => d === 2).map(([k]) => k);
	return [...new Set([...close, ...words, ...tagged, ...far])].slice(0, n);
}

function distance(a: string, b: string): number {
	if (Math.abs(a.length - b.length) > 2) return 9;
	const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
	for (let j = 1; j <= b.length; j++) d[0][j] = j;
	for (let i = 1; i <= a.length; i++)
		for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
	return d[a.length][b.length];
}

type Pt = { x: number; y: number; moveTo?: boolean; curve?: { type: "cubic"; x1: number; y1: number; x2: number; y2: number } } | { close: true };

/** SVG endpoint arc -> cubic bezier segments (W3C SVG implementation notes, F.6). */
function arcToCubics(x1: number, y1: number, rx: number, ry: number, phi: number, fa: number, fs: number, x2: number, y2: number): number[][] {
	if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
	const rad = (phi * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const dx = (x1 - x2) / 2;
	const dy = (y1 - y2) / 2;
	const x1p = cos * dx + sin * dy;
	const y1p = -sin * dx + cos * dy;
	rx = Math.abs(rx);
	ry = Math.abs(ry);
	const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
	if (lam > 1) {
		rx *= Math.sqrt(lam);
		ry *= Math.sqrt(lam);
	}
	const sign = fa === fs ? -1 : 1;
	const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
	const co = sign * Math.sqrt(Math.max(0, num / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
	const cxp = (co * rx * y1p) / ry;
	const cyp = (-co * ry * x1p) / rx;
	const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
	const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
	const ang = (ux: number, uy: number, vx: number, vy: number) => {
		const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
		return a;
	};
	const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
	let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
	if (!fs && dt > 0) dt -= 2 * Math.PI;
	if (fs && dt < 0) dt += 2 * Math.PI;
	const segs = Math.ceil(Math.abs(dt) / (Math.PI / 2));
	const d = dt / segs;
	const k = (4 / 3) * Math.tan(d / 4);
	const out: number[][] = [];
	let t = t1;
	const at = (tt: number) => [cx + rx * Math.cos(tt) * cos - ry * Math.sin(tt) * sin, cy + rx * Math.cos(tt) * sin + ry * Math.sin(tt) * cos];
	const der = (tt: number) => [-rx * Math.sin(tt) * cos - ry * Math.cos(tt) * sin, -rx * Math.sin(tt) * sin + ry * Math.cos(tt) * cos];
	for (let i = 0; i < segs; i++) {
		const [ax, ay] = at(t);
		const [bx, by] = at(t + d);
		const [dax, day] = der(t);
		const [dbx, dby] = der(t + d);
		out.push([ax + k * dax, ay + k * day, bx - k * dbx, by - k * dby, bx, by]);
		t += d;
	}
	return out;
}

/** Path data -> absolute points (in the 24x24 icon space). */
function pathPoints(d: string): Pt[] {
	const toks = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g) ?? [];
	const pts: Pt[] = [];
	let i = 0;
	let cmd = "";
	let x = 0, y = 0, sx = 0, sy = 0;
	let lcx = 0, lcy = 0; // last control point (S/T reflection)
	let lastCmd = "";
	const num = () => Number(toks[i++]);
	const flag = () => {
		// arc flags may be packed ("011"): take one digit
		const t = toks[i];
		if (t.length > 1 && /^[01]/.test(t)) {
			toks[i] = t.slice(1);
			return Number(t[0]);
		}
		i++;
		return Number(t);
	};
	const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
		pts.push({ x: ex, y: ey, curve: { type: "cubic", x1, y1, x2, y2 } });
		lcx = x2; lcy = y2; x = ex; y = ey;
	};
	while (i < toks.length) {
		if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
		const rel = cmd === cmd.toLowerCase();
		const C = cmd.toUpperCase();
		const ox = rel ? x : 0;
		const oy = rel ? y : 0;
		switch (C) {
			case "M": {
				x = ox + num(); y = oy + num(); sx = x; sy = y;
				pts.push({ x, y, moveTo: true });
				cmd = rel ? "l" : "L"; // following pairs are lineto
				break;
			}
			case "L": x = ox + num(); y = oy + num(); pts.push({ x, y }); break;
			case "H": x = (rel ? x : 0) + num(); pts.push({ x, y }); break;
			case "V": y = (rel ? y : 0) + num(); pts.push({ x, y }); break;
			case "C": { const a = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()]; cubic(a[0], a[1], a[2], a[3], a[4], a[5]); break; }
			case "S": {
				const [rx1, ry1] = /[CS]/i.test(lastCmd) ? [2 * x - lcx, 2 * y - lcy] : [x, y];
				const a = [ox + num(), oy + num(), ox + num(), oy + num()];
				cubic(rx1, ry1, a[0], a[1], a[2], a[3]);
				break;
			}
			case "Q": case "T": {
				let qx: number, qy: number;
				if (C === "Q") { qx = ox + num(); qy = oy + num(); }
				else [qx, qy] = /[QT]/i.test(lastCmd) ? [2 * x - lcx, 2 * y - lcy] : [x, y];
				const ex = ox + num(), ey = oy + num();
				cubic(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
				lcx = qx; lcy = qy;
				break;
			}
			case "A": {
				const rx = num(), ry = num(), phi = num(), fa = flag(), fs = flag();
				const ex = ox + num(), ey = oy + num();
				for (const c of arcToCubics(x, y, rx, ry, phi, fa, fs, ex, ey)) cubic(c[0], c[1], c[2], c[3], c[4], c[5]);
				x = ex; y = ey;
				break;
			}
			case "Z": pts.push({ close: true }); x = sx; y = sy; break;
			default: i++; // unknown token: skip
		}
		lastCmd = C;
	}
	return pts;
}

const K = 0.5522847498; // circle to cubic constant

function ellipse(cx: number, cy: number, rx: number, ry: number): string {
	return `M${cx - rx} ${cy}C${cx - rx} ${cy - K * ry} ${cx - K * rx} ${cy - ry} ${cx} ${cy - ry}C${cx + K * rx} ${cy - ry} ${cx + rx} ${cy - K * ry} ${cx + rx} ${cy}C${cx + rx} ${cy + K * ry} ${cx + K * rx} ${cy + ry} ${cx} ${cy + ry}C${cx - K * rx} ${cy + ry} ${cx - rx} ${cy + K * ry} ${cx - rx} ${cy}Z`;
}

function rectPath(a: Record<string, string>): string {
	const x = +(a.x ?? 0), y = +(a.y ?? 0), w = +a.width, h = +a.height;
	const r = Math.min(+(a.rx ?? a.ry ?? 0), w / 2, h / 2);
	if (!r) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
	return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

function elementPath([tag, a]: El): string {
	switch (tag) {
		case "path": return a.d ?? "";
		case "circle": return ellipse(+a.cx, +a.cy, +a.r, +a.r);
		case "ellipse": return ellipse(+a.cx, +a.cy, +a.rx, +a.ry);
		case "rect": return rectPath(a);
		case "line": return `M${a.x1} ${a.y1}L${a.x2} ${a.y2}`;
		case "polyline": return `M${a.points}`;
		case "polygon": return `M${a.points}Z`;
		default: return "";
	}
}

/** Adds an icon as one custom-geometry shape (stroke only, like Lucide). Returns false if unknown. */
export function addIcon(pptx: any, slide: any, name: string, x: number, y: number, size: number, color: string, strokePx = 2): boolean {
	const els = ICONS[name];
	if (!els) return false;
	const s = size / 24;
	const points = els.flatMap((el) => pathPoints(elementPath(el))).map((p) => {
		if ("close" in p) return p;
		const q: Record<string, unknown> = { x: p.x * s, y: p.y * s };
		if (p.moveTo) q.moveTo = true;
		if (p.curve) q.curve = { type: "cubic", x1: p.curve.x1 * s, y1: p.curve.y1 * s, x2: p.curve.x2 * s, y2: p.curve.y2 * s };
		return q;
	});
	slide.addShape(pptx.ShapeType.custGeom, {
		x, y, w: size, h: size, points,
		line: { color, width: Math.max(0.75, strokePx * s * 72) }, // no fill option -> <a:noFill/>
	});
	return true;
}
