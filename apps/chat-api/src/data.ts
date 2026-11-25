// Data analysis with SQL (H70): DuckDB in process (@duckdb/node-api, MIT; native addon, no
// subprocess). Every call opens a fresh in-memory database, registers the workspace's data files as
// views (CSV/TSV, Parquet, JSON, and XLSX sheets converted to CSV with exceljs), then locks DuckDB
// down before the model's SQL runs: file access only inside the turn workspace and a scratch folder,
// no network, no extension install or load, configuration locked. Each query has a time limit; the
// result comes back as a table, can be saved to outputs/ or work/, and can be drawn as a chart.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { config } from "./config.ts";
import { insideWorkspace } from "./tools.ts";
import { loadTable } from "./office/dashboard.ts";

export const DATA_LIMITS = { files: 40, sheets: 5, rowsShown: 50, rowsRead: 1000, seconds: 60, memory: "512MB", threads: "2" };
const SCAN = ["uploads", "outputs", "project", "work"];
const DIRECT = new Set([".csv", ".tsv", ".parquet", ".json", ".jsonl", ".ndjson"]);
const SHEETS = new Set([".xlsx", ".xlsm"]);

/** SQL-safe view name from a file name: lowercase ASCII, digits and _, not starting with a digit. */
export function viewName(file: string, taken: Set<string>): string {
	const base =
		basename(file, extname(file))
			.normalize("NFD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "") || "data";
	let name = /^[0-9]/.test(base) ? `t_${base}` : base;
	for (let n = 2; taken.has(name); n++) name = `${/^[0-9]/.test(base) ? `t_${base}` : base}_${n}`;
	taken.add(name);
	return name;
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function walk(dir: string, root: string, out: string[]) {
	for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name !== "tool-output" && !e.name.startsWith(".")) await walk(full, root, out);
		} else if (e.isFile() && (DIRECT.has(extname(e.name).toLowerCase()) || SHEETS.has(extname(e.name).toLowerCase()))) out.push(relative(root, full));
	}
}

/** Data files the model can query, relative to the workspace. */
export async function dataFiles(workspace: string): Promise<string[]> {
	const out: string[] = [];
	for (const d of SCAN) await walk(join(workspace, d), workspace, out);
	return out.sort().slice(0, DATA_LIMITS.files);
}

const csvCell = (v: unknown) => {
	if (v === null || v === undefined) return "";
	if (v instanceof Date) return v.toISOString().replace(/T00:00:00\.000Z$/, "");
	const s = typeof v === "object" ? JSON.stringify(v) : String(v);
	return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function reader(abs: string): string {
	const ext = extname(abs).toLowerCase();
	if (ext === ".parquet") return `read_parquet(${sqlString(abs)})`;
	if (ext === ".json" || ext === ".jsonl" || ext === ".ndjson") return `read_json_auto(${sqlString(abs)})`;
	return `read_csv(${sqlString(abs)}, auto_detect = true, sample_size = 20000)`;
}

export interface Registered {
	view: string;
	file: string;
	sheet?: string;
}

/** Opens a locked-down DuckDB with one view per data file (and per sheet). */
export async function openAnalysis(workspace: string) {
	const scratch = join(config.tmpRoot, "duckdb", randomUUID());
	await mkdir(scratch, { recursive: true });
	const db = await DuckDBInstance.create(":memory:", {
		threads: DATA_LIMITS.threads,
		memory_limit: DATA_LIMITS.memory,
		temp_directory: scratch,
		autoinstall_known_extensions: "false",
		autoload_known_extensions: "false",
	});
	const c = await db.connect();
	const views: Registered[] = [];
	const notes: string[] = [];
	const taken = new Set<string>();
	try {
		for (const file of await dataFiles(workspace)) {
			const abs = join(workspace, file);
			const ext = extname(file).toLowerCase();
			try {
				if (SHEETS.has(ext)) {
					const first = await loadTable(abs);
					const sheets = (first.sheets ?? [undefined]).slice(0, DATA_LIMITS.sheets);
					for (const [i, sheet] of sheets.entries()) {
						const t = i === 0 ? first : await loadTable(abs, sheet);
						const csv = join(scratch, `${randomUUID()}.csv`);
						await writeFile(csv, [t.ds.cols.map(csvCell).join(","), ...t.ds.rows.map((r) => r.map(csvCell).join(","))].join("\n"));
						const view = viewName(sheets.length > 1 && sheet ? `${basename(file, ext)} ${sheet}` : file, taken);
						await c.run(`CREATE VIEW "${view}" AS SELECT * FROM ${reader(csv)}`);
						views.push({ view, file, sheet });
						if (t.truncated) notes.push(`${file}${sheet ? ` (${sheet})` : ""}: only the first 200,000 rows`);
					}
				} else {
					const view = viewName(file, taken);
					await c.run(`CREATE VIEW "${view}" AS SELECT * FROM ${reader(abs)}`);
					views.push({ view, file });
				}
			} catch (e) {
				notes.push(`${file}: not readable as a table (${(e as Error).message.split("\n")[0].slice(0, 160)})`);
			}
		}
		// From here on the model's SQL runs: only the workspace and the scratch folder, nothing else.
		await c.run(`SET allowed_directories = [${sqlString(`${workspace}/`)}, ${sqlString(`${scratch}/`)}]`);
		await c.run("SET enable_external_access = false");
		await c.run("SET lock_configuration = true");
	} catch (e) {
		c.closeSync();
		db.closeSync();
		await rm(scratch, { recursive: true, force: true });
		throw e;
	}
	return {
		connection: c,
		views,
		notes,
		async close() {
			c.closeSync();
			db.closeSync();
			await rm(scratch, { recursive: true, force: true });
		},
	};
}

const fmt = (v: unknown) => {
	if (v === null || v === undefined) return "";
	if (typeof v === "number") return v.toLocaleString("pt-BR", { maximumFractionDigits: 4 });
	if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) && v.length < 16) return Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 4 });
	return (typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 120);
};

/** Runs one statement with a time limit; returns columns and up to rowsRead rows (JSON-safe). */
export async function runSql(conn: Awaited<ReturnType<typeof openAnalysis>>["connection"], sql: string) {
	const timer = setTimeout(() => conn.interrupt(), DATA_LIMITS.seconds * 1000);
	try {
		const r = await conn.runAndReadUntil(sql, DATA_LIMITS.rowsRead + 1);
		const cols = r.columnNames();
		const rows = r.getRowsJson() as unknown[][];
		return { cols, rows: rows.slice(0, DATA_LIMITS.rowsRead), more: rows.length > DATA_LIMITS.rowsRead || !r.done };
	} catch (e) {
		const msg = (e as Error).message;
		throw new Error(/INTERRUPT/i.test(msg) ? `query stopped after ${DATA_LIMITS.seconds} s: aggregate more or add LIMIT` : msg.split("\n").slice(0, 3).join(" "));
	} finally {
		clearTimeout(timer);
	}
}

export function markdownTable(cols: string[], rows: unknown[][], max = DATA_LIMITS.rowsShown): string {
	const head = `| ${cols.map(fmt).join(" | ")} |\n|${cols.map(() => "---").join("|")}|`;
	return [head, ...rows.slice(0, max).map((r) => `| ${r.map(fmt).join(" | ")} |`)].join("\n");
}

export type ChartSpec = { type: "bar" | "line" | "pie"; x: string; y: string[]; title?: string };

/** ECharts option for a small result (the portal draws ```echarts blocks). */
export function chartOption(cols: string[], rows: unknown[][], spec: ChartSpec) {
	const xi = cols.indexOf(spec.x);
	const yi = spec.y.map((y) => cols.indexOf(y));
	const missing = [spec.x, ...spec.y].filter((c) => !cols.includes(c));
	if (missing.length) throw new Error(`chart: unknown column(s) ${missing.join(", ")}; columns: ${cols.join(", ")}`);
	const data = rows.slice(0, 200);
	const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
	const title = spec.title ? { text: spec.title } : undefined;
	if (spec.type === "pie")
		return { title, tooltip: { trigger: "item" }, series: [{ type: "pie", radius: ["40%", "70%"], data: data.map((r) => ({ name: String(r[xi]), value: num(r[yi[0]]) })) }] };
	return {
		title,
		tooltip: { trigger: "axis" },
		legend: spec.y.length > 1 ? { top: title ? 28 : 0 } : undefined,
		xAxis: { type: "category", data: data.map((r) => String(r[xi])) },
		yAxis: { type: "value" },
		series: spec.y.map((y, i) => ({ name: y, type: spec.type, data: data.map((r) => num(r[yi[i]])) })),
	};
}

export function analyzeDataTool(workspace: string): ToolDefinition {
	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
	return defineTool({
		name: "analyze_data",
		label: "analyze_data",
		description:
			"Analyze data files with SQL (DuckDB). Every CSV, TSV, Parquet, JSON/JSONL and XLSX sheet in uploads/, outputs/, " +
			"project/ and work/ is a view named after the file (\"Vendas 2026.xlsx\" -> vendas_2026; several sheets -> " +
			"<file>_<sheet>). Call with no sql to list the views and their columns. Write one DuckDB SQL statement: joins, " +
			"window functions, GROUP BY ALL, date_trunc, PIVOT, SUMMARIZE <view>, percentiles, regr_slope. Exact numbers come " +
			"from here, never from mental math. save_as writes the full result (csv, parquet or json) to outputs/ (a " +
			"deliverable) or work/ (intermediate). chart returns an ```echarts block: paste it unchanged in your reply to " +
			"show the chart. Only these files are reachable: no network, no other paths.",
		promptSnippet: "analyze_data: SQL (DuckDB) over the conversation's csv/xlsx/parquet/json files; tables, exports, charts",
		parameters: Type.Object({
			sql: Type.Optional(Type.String({ description: "One DuckDB SQL statement. Omit to list the views and columns." })),
			save_as: Type.Optional(Type.String({ description: "outputs/<name>.csv|.parquet|.json or work/<name>.csv|..." })),
			chart: Type.Optional(
				Type.Object({
					type: Type.Union([Type.Literal("bar"), Type.Literal("line"), Type.Literal("pie")]),
					x: Type.String({ description: "Category or date column" }),
					y: Type.Array(Type.String(), { minItems: 1, maxItems: 6, description: "Numeric column(s); pie uses the first" }),
					title: Type.Optional(Type.String()),
				}),
			),
		}),
		async execute(_id, p) {
			const a = await openAnalysis(workspace);
			try {
				if (!a.views.length) return text(`No data files found in ${SCAN.join("/, ")}/. Supported: csv, tsv, parquet, json, jsonl, xlsx.${a.notes.length ? `\n${a.notes.join("\n")}` : ""}`);
				if (!p.sql?.trim()) {
					const out: string[] = ["Views:"];
					for (const v of a.views) {
						const d = await runSql(a.connection, `DESCRIBE "${v.view}"`).catch(() => undefined);
						const count = await runSql(a.connection, `SELECT count(*) FROM "${v.view}"`).catch(() => undefined);
						out.push(`- ${v.view} <- ${v.file}${v.sheet ? ` [${v.sheet}]` : ""} · ${count?.rows[0]?.[0] ?? "?"} rows · ${d ? d.rows.map((r) => `${r[0]} ${r[1]}`).join(", ") : "?"}`);
					}
					return text([...out, ...a.notes].join("\n"));
				}
				const r = await runSql(a.connection, p.sql);
				const parts = [`${r.rows.length}${r.more ? "+" : ""} row(s)${r.rows.length > DATA_LIMITS.rowsShown ? `, first ${DATA_LIMITS.rowsShown} shown` : ""}:`, markdownTable(r.cols, r.rows)];
				if (p.save_as) {
					const ext = extname(p.save_as).toLowerCase();
					if (!/^(outputs|work)\//.test(p.save_as) || ![".csv", ".parquet", ".json"].includes(ext)) throw new Error("save_as: outputs/ or work/, ending in .csv, .parquet or .json");
					const target = insideWorkspace(workspace, p.save_as);
					await mkdir(join(target, ".."), { recursive: true });
					const format = ext === ".csv" ? "(FORMAT csv, HEADER true)" : ext === ".parquet" ? "(FORMAT parquet)" : "(FORMAT json, ARRAY true)";
					await runSql(a.connection, `COPY (${p.sql.trim().replace(/;\s*$/, "")}) TO ${sqlString(target)} ${format}`);
					parts.push(`Saved the full result to ${p.save_as} (${(await stat(target)).size} bytes).`);
				}
				if (p.chart) {
					if (r.rows.length > 200) parts.push("Chart: more than 200 rows; aggregate first.");
					else parts.push("Paste this block unchanged where the chart should appear:\n```echarts\n" + JSON.stringify(chartOption(r.cols, r.rows, p.chart as ChartSpec)) + "\n```");
				}
				if (a.notes.length) parts.push(a.notes.join("\n"));
				return text(parts.join("\n\n"));
			} finally {
				await a.close();
			}
		},
	}) as ToolDefinition;
}
