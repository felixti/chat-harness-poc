// Dashboard spec (JSON) -> one self-contained HTML file: inline CSS, Apache ECharts and the data.
// Numbers are computed from the user's Excel/CSV by dashboard-runtime.js, the same code the page
// runs when a filter changes, so the model never copies figures by hand. No network at view time
// (CSP blocks it), no subprocess at build time.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname } from "node:path";
import ExcelJS from "exceljs";
import { parseCsv } from "./xlsx.ts";
import { resolveTheme, type Theme } from "./pptx.ts";
import * as rt from "./dashboard-runtime.js";
import type { Dataset } from "./dashboard-runtime.js";

const require = createRequire(import.meta.url);
const MAX_ROWS = 200_000;
const MAX_EMBED = 12_000_000; // chars of JSON data in the page

type Agg = "sum" | "avg" | "count" | "distinct" | "min" | "max";
type Fmt = "integer" | "decimal" | "currency" | "percent" | "compact";
type Measure = string | { field: string; agg?: Agg; label?: string };

export interface Widget {
	type: "kpi" | "chart" | "table" | "text";
	title?: string;
	data?: string;
	span?: 1 | 2 | 3 | 4;
	where?: Record<string, unknown>;
	note?: string;
	format?: Fmt;
	// kpi
	label?: string;
	field?: string;
	agg?: Agg;
	value?: string;
	caption?: string;
	compare?: { where: Record<string, unknown>; label?: string };
	good?: "up" | "down";
	// chart
	chart?: "bar" | "column" | "line" | "area" | "pie" | "doughnut" | "stacked_bar" | "stacked_column";
	x?: string;
	x_bucket?: "month" | "quarter" | "year";
	y?: Measure | Measure[];
	y_label?: string;
	series?: string;
	sort?: "desc" | "asc" | "x" | { by: string; desc?: boolean };
	top?: number;
	others?: boolean;
	highlight?: string | number;
	// table
	columns?: (string | { field: string; label?: string; format?: Fmt; agg?: Agg })[];
	group_by?: string;
	highlight_row?: number;
	// text
	text?: string;
}

export interface DashboardSpec {
	title: string;
	subtitle?: string;
	author?: string;
	date?: string;
	source?: string;
	format?: "dashboard" | "onepage";
	theme?: unknown;
	data: Record<string, { file?: string; sheet?: string; header_row?: number; rows?: Record<string, unknown>[] }>;
	filters?: { field: string; label?: string; bucket?: "month" | "quarter" | "year"; default?: string }[];
	sections?: { title?: string; items: Widget[] }[];
	items?: Widget[];
}

export interface DashboardResult {
	html: string;
	warnings: string[];
	summary: string[];
}

// ---------- data loading ----------

const PT_NUM = /^-?\d{1,3}(\.\d{3})+(,\d+)?$|^-?\d+,\d+$/;
const EN_NUM = /^-?\d{1,3}(,\d{3})+(\.\d+)?$|^-?\d+(\.\d+)?$/;

/** "R$ 1.234,56" / "1,234.56" / "12%" -> number; anything else -> undefined. */
export function toNumber(s: string): number | undefined {
	let t = s.trim().replace(/^R\$\s*/i, "").replace(/\s/g, "");
	const pct = t.endsWith("%");
	if (pct) t = t.slice(0, -1);
	let n: number | undefined;
	if (PT_NUM.test(t)) n = Number(t.replace(/\./g, "").replace(",", "."));
	else if (EN_NUM.test(t)) n = Number(t.replace(/,/g, ""));
	if (n === undefined || !Number.isFinite(n)) return undefined;
	return pct ? n / 100 : n;
}

/** "31/12/2026" or "2026-12-31T..." -> "2026-12-31". */
function toIsoDate(s: string): string | undefined {
	const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
	if (br) return `${br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
	const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim());
	return iso ? iso[1] : undefined;
}

/** Text columns where 90%+ of the filled cells are numbers (or dates) become typed columns. */
function coerceColumns(ds: Dataset): Dataset {
	for (let c = 0; c < ds.cols.length; c++) {
		const texts = ds.rows.map((r) => r[c]).filter((v): v is string => typeof v === "string" && v.trim() !== "");
		if (!texts.length) continue;
		for (const conv of [toNumber, toIsoDate] as ((s: string) => unknown)[]) {
			const ok = texts.filter((v) => conv(v) !== undefined).length;
			if (ok / texts.length >= 0.9) {
				for (const r of ds.rows) if (typeof r[c] === "string") r[c] = (r[c] as string).trim() === "" ? null : (conv(r[c] as string) ?? null);
				break;
			}
		}
	}
	return ds;
}

function cellValue(v: any): unknown {
	if (v === null || v === undefined) return null;
	if (v instanceof Date) return v.toISOString().slice(0, 10);
	if (typeof v === "object") {
		if ("result" in v) return cellValue(v.result);
		if ("richText" in v) return v.richText.map((p: any) => p.text).join("");
		if ("text" in v) return String(v.text);
		if ("error" in v) return null;
		return null;
	}
	return v;
}

function uniqueHeaders(raw: unknown[]): string[] {
	const seen = new Map<string, number>();
	return raw.map((h, i) => {
		let name = String(h ?? "").trim() || `Coluna ${i + 1}`;
		const n = seen.get(rt.norm(name)) ?? 0;
		seen.set(rt.norm(name), n + 1);
		if (n) name = `${name} (${n + 1})`;
		return name;
	});
}

export interface LoadedFile {
	ds: Dataset;
	sheets?: string[];
	truncated: boolean;
}

/** Reads a CSV or XLSX file into columns + rows. Header = `header_row` or the first row with 2+ filled cells. */
export async function loadTable(path: string, sheet?: string, headerRow?: number): Promise<LoadedFile> {
	const ext = extname(path).toLowerCase();
	let grid: unknown[][];
	let sheets: string[] | undefined;
	if (ext === ".csv" || ext === ".txt") {
		grid = parseCsv((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
	} else if (ext === ".xlsx" || ext === ".xlsm") {
		const wb = new ExcelJS.Workbook();
		await wb.xlsx.readFile(path);
		sheets = wb.worksheets.map((w) => w.name);
		const ws = sheet ? wb.worksheets.find((w) => rt.norm(w.name) === rt.norm(sheet)) : wb.worksheets[0];
		if (!ws) throw new Error(`sheet "${sheet}" not found (sheets: ${sheets.join(", ")})`);
		grid = [];
		ws.eachRow({ includeEmpty: true }, (row) => {
			const vals = (row.values as unknown[]).slice(1).map(cellValue);
			grid.push(vals);
		});
	} else {
		throw new Error(`unsupported data file ${path}: use .xlsx or .csv (convert .xls to .xlsx)`);
	}
	const h = headerRow ? headerRow - 1 : grid.findIndex((r) => r.filter((v) => v !== null && v !== "").length >= 2);
	if (h < 0 || !grid[h]) throw new Error(`no header row found in ${path}`);
	const cols = uniqueHeaders(grid[h]);
	let rows = grid.slice(h + 1).filter((r) => r.some((v) => v !== null && v !== ""));
	const truncated = rows.length > MAX_ROWS;
	rows = rows.slice(0, MAX_ROWS).map((r) => cols.map((_, i) => (r[i] === undefined ? null : r[i])));
	return { ds: coerceColumns({ cols, rows }), sheets, truncated };
}

/** Column profile for the model: type, fill, distinct values, range or top values. */
export function describe(ds: Dataset, maxCols = 60): string[] {
	const out = [`${ds.rows.length} rows, ${ds.cols.length} columns`];
	ds.cols.slice(0, maxCols).forEach((name, c) => {
		const vals = ds.rows.map((r) => r[c]).filter((v) => v !== null && v !== "");
		const nums = vals.filter((v): v is number => typeof v === "number");
		const dates = vals.filter((v): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
		const fill = ds.rows.length ? Math.round((vals.length / ds.rows.length) * 100) : 0;
		const distinct = new Set(vals.map((v) => rt.norm(v))).size;
		let info: string;
		if (nums.length && nums.length >= vals.length * 0.9) {
			info = `number, min ${rt.fmt(Math.min(...nums))}, max ${rt.fmt(Math.max(...nums))}, sum ${rt.fmt(nums.reduce((a, b) => a + b, 0))}`;
		} else if (dates.length && dates.length >= vals.length * 0.9) {
			const s = [...dates].sort();
			info = `date, ${s[0]} to ${s[s.length - 1]}`;
		} else {
			const counts = new Map<string, number>();
			for (const v of vals) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
			const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k.slice(0, 30)} (${n})`);
			info = `text, top: ${top.join(", ")}`;
		}
		out.push(`- ${name}: ${info}; ${distinct} distinct, ${fill}% filled`);
	});
	if (ds.cols.length > maxCols) out.push(`... and ${ds.cols.length - maxCols} more columns`);
	return out;
}

// ---------- query ----------

export interface Query {
	where?: Record<string, unknown>;
	group_by?: string;
	x_bucket?: "month" | "quarter" | "year";
	measures?: { field?: string; agg?: Agg; label?: string }[];
	sort?: "desc" | "asc" | "x";
	top?: number;
}

/** Group-by + aggregates over a table: the dashboard engine as an analysis tool. Returns header + rows. */
export function runQuery(ds: Dataset, q: Query): { head: string[]; rows: unknown[][]; matched: number; groups: number; missing: string[] } {
	const ms = q.measures?.length ? q.measures : [{ agg: "count" as Agg }];
	const fields = [q.group_by, ...ms.map((m) => m.field), ...Object.keys(q.where ?? {})].filter((f): f is string => !!f);
	const missing = fields.filter((f) => rt.col(ds, f) < 0);
	const rows = rt.where(ds, ds.rows, q.where);
	const name = (m: { field?: string; agg?: Agg; label?: string }) => m.label ?? `${m.agg ?? (m.field ? "sum" : "count")}${m.field ? ` ${m.field}` : ""}`;
	if (missing.length) return { head: [], rows: [], matched: rows.length, groups: 0, missing };
	if (!q.group_by) return { head: ms.map(name), rows: [ms.map((m) => rt.aggregate(ds, rows, m))], matched: rows.length, groups: 1, missing };
	const cd = rt.chartData(ds, rows, { x: q.group_by, x_bucket: q.x_bucket, y: ms.map((m) => ({ ...m, agg: m.agg ?? (m.field ? "sum" : "count") })), sort: q.sort, top: q.top ?? 50, chart: "column" });
	return {
		head: [q.group_by, ...ms.map(name)],
		rows: cd.labels.map((l, i) => [l, ...cd.series.map((s) => s.values[i])]),
		matched: rows.length,
		groups: new Set(rows.map((r) => String(rt.bucket(r[rt.col(ds, q.group_by!)], q.x_bucket)))).size,
		missing,
	};
}

// ---------- validation ----------

const CHARTS = new Set(["bar", "column", "line", "area", "pie", "doughnut", "stacked_bar", "stacked_column"]);
const TYPES = new Set(["kpi", "chart", "table", "text"]);

function fieldsOf(w: Widget): string[] {
	const f: string[] = [];
	const add = (v: unknown) => typeof v === "string" && f.push(v);
	add(w.field);
	add(w.x);
	add(w.series);
	add(w.group_by);
	for (const m of Array.isArray(w.y) ? w.y : w.y ? [w.y] : []) add(typeof m === "string" ? m : m.field);
	for (const c of w.columns ?? []) add(typeof c === "string" ? c : c.field);
	if (w.sort && typeof w.sort === "object") add(w.sort.by);
	Object.keys(w.where ?? {}).forEach(add);
	Object.keys(w.compare?.where ?? {}).forEach(add);
	return f;
}

// ---------- render ----------

export async function renderDashboard(
	spec: DashboardSpec,
	opts: { resolve: (p: string) => string; themes: Record<string, Theme> },
): Promise<DashboardResult> {
	if (!spec || typeof spec.title !== "string") throw new Error('spec needs {"title", "data", "sections" or "items"}');
	if (!spec.data || !Object.keys(spec.data).length) throw new Error('spec needs "data": {"<name>": {"file": "uploads/x.xlsx"}}');
	const warnings: string[] = [];
	const summary: string[] = [];
	const theme = await resolveTheme({ theme: spec.theme as never }, opts.themes, opts, warnings);

	const data: Record<string, Dataset> = {};
	for (const [name, src] of Object.entries(spec.data)) {
		if (Array.isArray(src.rows)) {
			const cols = [...new Set(src.rows.flatMap((r) => Object.keys(r)))];
			data[name] = coerceColumns({ cols, rows: src.rows.map((r) => cols.map((c) => r[c] ?? null)) });
		} else if (src.file) {
			const f = await loadTable(opts.resolve(src.file), src.sheet, src.header_row);
			if (f.truncated) warnings.push(`data "${name}": over ${MAX_ROWS} rows, only the first ${MAX_ROWS} are used; aggregate the file first`);
			data[name] = f.ds;
		} else throw new Error(`data "${name}" needs "file" or "rows"`);
	}
	const first = Object.keys(data)[0];
	const widgets = (spec.sections ?? [{ items: spec.items ?? [] }]).flatMap((s) => s.items ?? []);
	if (!widgets.length) throw new Error('no widgets: add "sections": [{"items": [...]}]');

	const used: Record<string, Set<number>> = Object.fromEntries(Object.keys(data).map((k) => [k, new Set<number>()]));
	const label = (w: Widget, i: number) => `${w.type} ${i + 1}${w.title || w.label ? ` "${(w.title ?? w.label)!.slice(0, 40)}"` : ""}`;

	for (const fl of spec.filters ?? []) {
		const hits = Object.entries(data).filter(([, d]) => rt.col(d, fl.field) >= 0);
		if (!hits.length) warnings.push(`filter "${fl.field}" is not a column of any data source`);
		for (const [k, d] of hits) used[k].add(rt.col(d, fl.field));
	}

	let kpis = 0;
	widgets.forEach((w, i) => {
		const name = label(w, i);
		if (!TYPES.has(w.type)) return warnings.push(`${name}: unknown type (use kpi, chart, table, text)`);
		if (w.type === "kpi") kpis++;
		if ((w.title ?? "").length > 90) warnings.push(`${name}: title over 90 chars`);
		if ((w.type === "chart" || w.type === "table") && !w.title) warnings.push(`${name}: add a title that states the finding`);
		if (w.type === "text") return;
		if (w.type === "kpi" && w.value !== undefined && !w.field) {
			if (!spec.source) warnings.push(`${name}: typed value "${w.value}" with no "source" on the dashboard; prefer a field from the data`);
			return;
		}
		const dn = w.data ?? first;
		const d = data[dn];
		if (!d) return warnings.push(`${name}: data "${dn}" not defined (use ${Object.keys(data).join(", ")})`);
		const missing = fieldsOf(w).filter((f) => rt.col(d, f) < 0);
		if (missing.length) return warnings.push(`${name}: column ${missing.map((m) => `"${m}"`).join(", ")} not in "${dn}" (columns: ${d.cols.join(", ")})`);
		fieldsOf(w).forEach((f) => used[dn].add(rt.col(d, f)));
		if (w.type === "table" && !w.columns) d.cols.forEach((_, c) => used[dn].add(c));
		const rows = rt.where(d, d.rows, w.where);
		if (!rows.length) return warnings.push(`${name}: no rows match "where" ${JSON.stringify(w.where)}`);

		if (w.type === "kpi") {
			const k = rt.kpiData(d, d.rows, w); // kpiData applies where and compare.where itself
			if (!Number.isFinite(k.value as number)) return warnings.push(`${name}: "${w.field}" is not numeric; use agg "count" or "distinct"`);
			const delta = Number.isFinite(k.delta) ? ` (${(k.delta as number) >= 0 ? "+" : ""}${rt.fmt(k.delta, "percent")} ${w.compare?.label ?? "vs compare"})` : "";
			if (w.compare && !Number.isFinite(k.delta)) warnings.push(`${name}: compare.where matches no rows or a zero base`);
			summary.push(`KPI ${w.label ?? w.title ?? ""}: ${rt.fmt(k.value, w.format ?? "compact")}${delta}`);
		} else if (w.type === "chart") {
			if (!w.chart || !CHARTS.has(w.chart)) return warnings.push(`${name}: chart must be one of ${[...CHARTS].join(", ")}`);
			if (!w.x) return warnings.push(`${name}: chart needs "x" (the category or date column)`);
			const cd = rt.chartData(d, rows, w);
			const vals = cd.series.flatMap((s) => s.values);
			if (!vals.some((v) => Number.isFinite(v))) return warnings.push(`${name}: values are not numeric; check "y" or use agg "count"`);
			if ((w.chart === "pie" || w.chart === "doughnut") && cd.cats.length > 6) warnings.push(`${name}: ${cd.cats.length} slices; set "top": 5 (the rest becomes "Outros") or use a bar chart`);
			if ((w.chart === "bar" || w.chart === "column") && !w.top && cd.cats.length > 15) warnings.push(`${name}: ${cd.cats.length} categories; set "top": 10 or filter with "where"`);
			if (w.series && cd.series.length > 6) warnings.push(`${name}: ${cd.series.length} series from "${w.series}"; keep at most 6 (filter with "where")`);
			if (w.highlight !== undefined && typeof w.highlight === "string" && !cd.cats.some((c) => rt.norm(c) === rt.norm(w.highlight))) warnings.push(`${name}: highlight "${w.highlight}" is not a category (${cd.labels.slice(0, 8).join(", ")})`);
			const pts = cd.labels.slice(0, 8).map((l, j) => `${l} ${rt.fmt(cd.series[0].values[j], w.format)}`).join("; ");
			summary.push(`Chart ${w.title ?? ""} (${w.chart}, ${cd.cats.length} categories${cd.series.length > 1 ? `, ${cd.series.length} series` : ""}): ${pts}${cd.cats.length > 8 ? "; ..." : ""}`);
		} else if (w.type === "table") {
			const td = rt.tableData(d, rows, w);
			if (td.head.length > 6) warnings.push(`${name}: ${td.head.length} columns; show at most 6`);
			const maxRows = spec.format === "onepage" ? 10 : 20;
			if (Math.min(td.total, w.top ?? td.total) > maxRows) warnings.push(`${name}: ${td.total} rows; set "top" (at most ${maxRows}) and sort, or group with "group_by"`);
			summary.push(`Table ${w.title ?? ""}: ${Math.min(td.total, w.top ?? td.total)} of ${td.total} rows; first: ${td.rows[0]?.map((v, j) => rt.fmt(v, td.formats[j])).join(" | ") ?? "-"}`);
		}
	});

	const onepage = spec.format === "onepage";
	if (kpis > 4) warnings.push(`${kpis} KPIs; keep 4 or fewer: the ones that answer the question`);
	if (onepage) {
		const height = estimateHeight(widgets);
		if (height > 980) warnings.push(`one-page content is ~${Math.round((height / 980) * 100)}% of an A4 page; cut widgets or use "format": "dashboard"`);
	}
	const emoji = JSON.stringify({ ...spec, data: undefined }).match(/(?![\u00A9\u00AE\u2122])\p{Extended_Pictographic}/gu);
	if (emoji) warnings.push(`emoji in the text (${[...new Set(emoji)].join(" ")}); remove them`);

	// Only the columns the page uses are embedded.
	const embed: Record<string, Dataset> = {};
	for (const [k, d] of Object.entries(data)) {
		const keep = [...used[k]].sort((a, b) => a - b);
		embed[k] = { cols: keep.map((c) => d.cols[c]), rows: d.rows.map((r) => keep.map((c) => r[c])) };
	}
	const json = JSON.stringify({ spec: { ...spec, data: undefined, generated: Date.now() }, data: embed, theme });
	if (json.length > MAX_EMBED) throw new Error(`data too large for one page (${Math.round(json.length / 1e6)} MB); aggregate it first or use fewer columns`);

	return { html: await page(spec, theme, json, onepage), warnings, summary };
}

/** Rough print height (px at 96 dpi) of the widgets packed in the 4-column grid. */
function estimateHeight(ws: Widget[]): number {
	let total = 150; // header
	let rowW = 0;
	let rowH = 0;
	for (const w of ws) {
		const span = w.span ?? (w.type === "kpi" ? 1 : w.type === "table" ? 4 : 2);
		const h = w.type === "kpi" ? 110 : w.type === "chart" ? 290 : w.type === "table" ? 70 + 30 * Math.min(w.top ?? 10, 20) : 60 + 22 * String(w.text ?? "").split("\n").length;
		if (rowW + span > 4) {
			total += rowH + 12;
			rowW = 0;
			rowH = 0;
		}
		rowW += span;
		rowH = Math.max(rowH, h);
	}
	return total + rowH + 50;
}

const runtimeSource = async () =>
	(await readFile(new URL("./dashboard-runtime.js", import.meta.url), "utf8")).replace(/^export /gm, "");

let echartsSource: string | undefined;
async function echarts(): Promise<string> {
	echartsSource ??= (await readFile(require.resolve("echarts/dist/echarts.min.js"), "utf8")).replace(/<\/script/gi, "<\\/script");
	return echartsSource;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function isDark(hex: string): boolean {
	const n = parseInt(hex, 16);
	return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) < 128;
}

function mix(a: string, b: string, k: number): string {
	const x = parseInt(a, 16), y = parseInt(b, 16);
	return [16, 8, 0].map((s) => Math.round(((x >> s) & 255) * (1 - k) + ((y >> s) & 255) * k).toString(16).padStart(2, "0")).join("");
}

async function page(spec: DashboardSpec, t: Theme, json: string, onepage: boolean): Promise<string> {
	const font = (f: string) => `"${f}", "Segoe UI", system-ui, -apple-system, sans-serif`;
	const css = `
:root{color-scheme:${isDark(t.bg) ? "dark" : "light"};--bg:#${t.bg};--surface:#${t.surface};--ink:#${t.ink};--muted:#${t.muted};--accent:#${t.accent};--line:#${t.line};--good:#${t.good};--bad:#${t.bad};--hi:#${mix(t.accent2, t.bg, 0.8)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 ${font(t.bodyFont)};-webkit-font-smoothing:antialiased}
#app{max-width:${onepage ? "calc(186mm + 64px)" : "1400px"};margin:0 auto;padding:${onepage ? "28px 32px" : "36px 40px 28px"}}
header h1{font:700 ${onepage ? 24 : 28}px/1.2 ${font(t.headFont)};margin:0 0 6px;letter-spacing:-.01em;text-wrap:balance}
header .sub{color:var(--muted);font-size:16px;margin:0}
header .meta{color:var(--muted);font-size:13px;margin:6px 0 0}
.filters{display:flex;flex-wrap:wrap;gap:12px;margin-top:18px;align-items:flex-end}
.filters label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
select{font:inherit;font-size:14px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:6px 10px;min-width:170px}
select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:${onepage ? 12 : 16}px;margin-top:${onepage ? 18 : 24}px}
.span-1{grid-column:span 1}.span-2{grid-column:span 2}.span-3{grid-column:span 3}.span-4{grid-column:span 4}
h2.section{grid-column:1/-1;font:600 17px ${font(t.headFont)};margin:${onepage ? 6 : 14}px 0 0}
.w{background:var(--surface);border-radius:10px;padding:${onepage ? "12px 14px" : "16px 18px"};min-width:0}
.w h3{font:600 15px/1.3 ${font(t.headFont)};margin:0 0 10px;text-wrap:balance}
.w-chart .body{height:${onepage ? 230 : 300}px}
.w-kpi .label{font-size:13px;color:var(--muted)}
.w-kpi .value{font:700 ${onepage ? 26 : 30}px/1.15 ${font(t.headFont)};margin-top:4px;font-variant-numeric:tabular-nums}
.delta{font-size:13px;margin-top:6px;color:var(--muted)}.delta.good{color:var(--good)}.delta.bad{color:var(--bad)}
.w-text p{margin:0 0 8px}.w-text ul{margin:0;padding-left:18px}.w-text li{margin:0 0 6px}
table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}
th{text-align:left;color:var(--muted);font-weight:600;font-size:13px;border-bottom:1px solid var(--line);padding:6px 8px}
td{padding:6px 8px;border-bottom:1px solid var(--line)}
tr:last-child td{border-bottom:0}
.num{text-align:right}
tr.hi td{background:var(--hi);font-weight:600}
.note{font-size:12px;color:var(--muted);margin:8px 0 0}
footer{display:flex;flex-wrap:wrap;gap:8px 24px;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:24px;padding-top:12px;border-top:1px solid var(--line)}
.print-only{display:none}
@media screen and (max-width:1000px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.span-3,.span-4{grid-column:1/-1}}
@media screen and (max-width:640px){#app{padding:20px 16px}.grid{grid-template-columns:1fr}.w,.span-2{grid-column:1/-1}}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}#app{max-width:none;padding:0}.filters label{display:none}.print-only{display:block;font-size:12px;color:var(--muted)}.w,h2.section{break-inside:avoid}}
@page{size:A4 ${onepage ? "portrait" : "landscape"};margin:${onepage ? 12 : 10}mm}`;
	return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(spec.title)}</title>
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<script id="payload" type="application/json">${json.replace(/</g, "\\u003c")}</script>
<script>${await echarts()}</script>
<script>
${await runtimeSource()}
const P = JSON.parse(document.getElementById("payload").textContent);
mount(P.spec, P.data, P.theme);
</script>
</body>
</html>
`;
}

