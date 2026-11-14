// generate_pptx / generate_docx / generate_xlsx: in-process Office writers (pure JS libraries,
// no subprocess, no binaries). The model writes a spec file, the tool renders it and returns
// lint warnings so the model can fix the content and render again.
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { insideWorkspace } from "../tools.ts";
import { join } from "node:path";
import { config } from "../config.ts";
import { renderDeck, loadThemes, LAYOUT_NAMES } from "./pptx.ts";
import { contactSheet } from "./preview.ts";
import { imageTool } from "./image.ts";
import { renderDashboard, loadTable, describe, runQuery, type DashboardSpec } from "./dashboard.ts";
import { markdownToDocx } from "./docx.ts";
import { renderWorkbook } from "./xlsx.ts";

const MAX_SPEC = 2_000_000;
const MAX_PREVIEWS = 20; // images per tool result

function text(t: string) {
	return { content: [{ type: "text" as const, text: t }], details: undefined };
}

async function readSpec(workspace: string, path: string): Promise<unknown> {
	const file = insideWorkspace(workspace, path);
	if ((await stat(file)).size > MAX_SPEC) throw new Error("spec file over 2 MB");
	const raw = await readFile(file, "utf8");
	try {
		return JSON.parse(raw);
	} catch (e) {
		throw new Error(`invalid JSON in ${path}: ${(e as Error).message}`);
	}
}

async function save(workspace: string, output: string, bytes: Buffer, ext: string) {
	if (!output.toLowerCase().endsWith(ext)) throw new Error(`output must end with ${ext}`);
	const out = insideWorkspace(workspace, output);
	await mkdir(dirname(out), { recursive: true });
	await writeFile(out, bytes);
}

const report = (what: string, output: string, bytes: number, warnings: string[]) =>
	`${what} written: ${output} (${Math.round(bytes / 1024)} KiB). The user can download it from the files panel.` +
	(warnings.length
		? `\n\nDesign lint (${warnings.length}) - fix the spec and render again before you answer:\n- ${warnings.join("\n- ")}`
		: "\n\nDesign lint: clean.");

export function officeTools(workspace: string) {
	const themesDir = join(config.skillsDir, "pptx", "themes");
	const pptx = defineTool({
		name: "generate_pptx",
		label: "generate_pptx",
		description:
			"Render a PowerPoint deck from a JSON spec file in the workspace. Read the `pptx` and `design` skills " +
			`first. Layouts: ${LAYOUT_NAMES.join(", ")}. Themes: the files in the pptx skill's themes/ folder, ` +
			"a .json theme file, or an inline theme. Returns design lint warnings (measured overflow, collisions, " +
			"contrast, bad charts) and a PNG preview of every slide: look at them, fix the spec and render again.",
		promptSnippet: "generate_pptx: deck spec JSON -> .pptx + slide previews to review (read skill pptx)",
		parameters: Type.Object({
			spec: Type.String({ description: "Deck spec JSON file, relative to the workspace (e.g. outputs/deck.json)" }),
			output: Type.String({ description: ".pptx path to create, e.g. outputs/deck.pptx" }),
			preview_slides: Type.Optional(
				Type.Array(Type.Integer({ minimum: 1 }), {
					description: "Slide numbers whose preview image you want back (default: all). After a fix, ask only for the slides you changed.",
				}),
			),
		}),
		async execute(_id, params) {
			const deck = (await readSpec(workspace, params.spec)) as Parameters<typeof renderDeck>[0];
			const themes = await loadThemes(themesDir);
			const r = await renderDeck(deck, { workspace, resolve: (p) => insideWorkspace(workspace, p), themes });
			await save(workspace, params.output, r.bytes, ".pptx");
			const sheet = params.output.replace(/\.pptx$/i, ".preview.png");
			if (r.previews.length) await save(workspace, sheet, await contactSheet(r.previews), ".png");
			const want = new Set(params.preview_slides?.length ? params.preview_slides : r.previews.map((_, i) => i + 1));
			const images = r.previews
				.map((png, i) => ({ png, n: i + 1 }))
				.filter((p) => want.has(p.n))
				.slice(0, MAX_PREVIEWS);
			const head =
				report(`Deck (${r.slides} slides)`, params.output, r.bytes.length, r.warnings) +
				(images.length
					? `\n\nPreview (approximate rendering, open fonts): ${images.map((p) => `image ${images.indexOf(p) + 1} = slide ${p.n}`).join(", ")}. ` +
						"Review each image with the checklist in the pptx skill (step 6) before you answer. " +
						`Thumbnails for the user: ${sheet}.`
					: "");
			return {
				content: [
					{ type: "text" as const, text: head },
					...images.map((p) => ({ type: "image" as const, data: p.png.toString("base64"), mimeType: "image/png" })),
				],
				details: undefined,
			};
		},
	});

	const docx = defineTool({
		name: "generate_docx",
		label: "generate_docx",
		description:
			"Render a markdown file from the workspace to an editable Word document (.docx) with real styles: " +
			"title block, Heading 1-3, lists, tables, quotes, code, page numbers, optional table of contents. Read skill `docx` first.",
		promptSnippet: "generate_docx: markdown file -> styled .docx",
		parameters: Type.Object({
			source: Type.String({ description: "Markdown file, relative to the workspace" }),
			output: Type.String({ description: ".docx path to create, e.g. outputs/report.docx" }),
			title: Type.Optional(Type.String()),
			subtitle: Type.Optional(Type.String()),
			author: Type.Optional(Type.String()),
			date: Type.Optional(Type.String()),
			accent: Type.Optional(Type.String({ description: "Hex color for headings and table headers" })),
			toc: Type.Optional(Type.Boolean({ description: "Insert a table of contents (Word fills it on open)" })),
			header: Type.Optional(Type.String({ description: "Running header text, e.g. Confidencial" })),
		}),
		async execute(_id, p) {
			const md = await readFile(insideWorkspace(workspace, p.source), "utf8");
			const bytes = await markdownToDocx(md, p);
			await save(workspace, p.output, bytes, ".docx");
			return text(report("Word document", p.output, bytes.length, []));
		},
	});

	const xlsx = defineTool({
		name: "generate_xlsx",
		label: "generate_xlsx",
		description:
			"Render an Excel workbook from a JSON spec file: typed columns (text, integer, decimal, currency, percent, date), " +
			"formulas (values starting with =), totals row, frozen header, filters, data bars. Rows inline or from a CSV in the " +
			"workspace (rows_csv). Read skill `xlsx-csv` first.",
		promptSnippet: "generate_xlsx: workbook spec JSON (rows or CSV) -> formatted .xlsx",
		parameters: Type.Object({
			spec: Type.String({ description: "Workbook spec JSON file, relative to the workspace" }),
			output: Type.String({ description: ".xlsx path to create, e.g. outputs/data.xlsx" }),
		}),
		async execute(_id, params) {
			const spec = (await readSpec(workspace, params.spec)) as Parameters<typeof renderWorkbook>[0];
			const r = await renderWorkbook(spec, (p) => readFile(insideWorkspace(workspace, p), "utf8"));
			await save(workspace, params.output, r.bytes, ".xlsx");
			return text(report("Workbook", params.output, r.bytes.length, r.warnings));
		},
	});

	const dashboard = defineTool({
		name: "generate_dashboard",
		label: "generate_dashboard",
		description:
			"Render an interactive HTML dashboard or a printable one-page summary from a JSON spec: KPIs, charts, tables " +
			"and text computed from Excel/CSV files in the workspace, with global filters. One self-contained .html " +
			"(works offline). Read skill `dashboard` first. Returns lint warnings and the computed numbers to check.",
		promptSnippet: "generate_dashboard: spec JSON + xlsx/csv -> interactive .html dashboard or one-pager (read skill dashboard)",
		parameters: Type.Object({
			spec: Type.String({ description: "Dashboard spec JSON file, relative to the workspace (e.g. outputs/painel.json)" }),
			output: Type.String({ description: ".html path to create, e.g. outputs/painel.html" }),
		}),
		async execute(_id, params) {
			const spec = (await readSpec(workspace, params.spec)) as DashboardSpec;
			const themes = await loadThemes(themesDir);
			const r = await renderDashboard(spec, { resolve: (p) => insideWorkspace(workspace, p), themes });
			const bytes = Buffer.from(r.html, "utf8");
			await save(workspace, params.output, bytes, ".html");
			return text(
				report(spec.format === "onepage" ? "One-page summary" : "Dashboard", params.output, bytes.length, r.warnings) +
					`\n\nComputed values (unfiltered) - check them against the question before you answer:\n- ${r.summary.join("\n- ")}`,
			);
		},
	});

	const describeData = defineTool({
		name: "describe_data",
		label: "describe_data",
		description:
			"Profile a spreadsheet (.xlsx) or .csv in the workspace: sheets, row count, and per column the type, range or " +
			"top values, distinct count and fill rate. Use it before writing a dashboard or analysing a file.",
		promptSnippet: "describe_data: xlsx/csv -> sheets, columns, types, ranges, top values",
		parameters: Type.Object({
			path: Type.String({ description: "File relative to the workspace" }),
			sheet: Type.Optional(Type.String({ description: "Sheet name (default: first)" })),
			header_row: Type.Optional(Type.Integer({ minimum: 1, description: "Header row number when the table does not start at the top" })),
		}),
		async execute(_id, p) {
			const f = await loadTable(insideWorkspace(workspace, p.path), p.sheet, p.header_row);
			const head = [`${p.path}${f.sheets ? ` - sheets: ${f.sheets.join(", ")} (showing ${p.sheet ?? f.sheets[0]})` : ""}`];
			if (f.truncated) head.push("(only the first 200,000 rows were read)");
			return text([...head, ...describe(f.ds)].join("\n"));
		},
	});

	const queryData = defineTool({
		name: "query_data",
		label: "query_data",
		description:
			"Filter, group and aggregate a spreadsheet (.xlsx) or .csv in the workspace without code: where (values, " +
			"periods like \"2026\" or \"2026-03\" on date columns, ranges {from,to}), group_by (+ month/quarter/year " +
			"buckets for dates), measures (sum, avg, count, distinct, min, max), sort, top. Returns a table; " +
			"optionally saves it as CSV for generate_xlsx. Run describe_data first to see the columns.",
		promptSnippet: "query_data: xlsx/csv -> filtered group-by with sum/avg/count (exact numbers, no code)",
		parameters: Type.Object({
			path: Type.String({ description: "File relative to the workspace" }),
			sheet: Type.Optional(Type.String()),
			header_row: Type.Optional(Type.Integer({ minimum: 1 })),
			where: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: '{"Região": "Sul", "Data": "2026", "Receita": {"from": 1000}}' })),
			group_by: Type.Optional(Type.String()),
			bucket: Type.Optional(Type.Union([Type.Literal("month"), Type.Literal("quarter"), Type.Literal("year")], { description: "Group a date column by period" })),
			measures: Type.Optional(
				Type.Array(
					Type.Object({
						field: Type.Optional(Type.String()),
						agg: Type.Optional(Type.Union(["sum", "avg", "count", "distinct", "min", "max"].map((a) => Type.Literal(a)))),
						label: Type.Optional(Type.String()),
					}),
					{ description: "Default: row count" },
				),
			),
			sort: Type.Optional(Type.Union([Type.Literal("desc"), Type.Literal("asc"), Type.Literal("x")], { description: "By the first measure (default desc), or by the group (x)" })),
			top: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Default 50" })),
			output_csv: Type.Optional(Type.String({ description: "Also save the result as CSV, e.g. outputs/receita-regiao.csv" })),
		}),
		async execute(_id, p) {
			const f = await loadTable(insideWorkspace(workspace, p.path), p.sheet, p.header_row);
			const r = runQuery(f.ds, { where: p.where, group_by: p.group_by, x_bucket: p.bucket, measures: p.measures as never, sort: p.sort, top: p.top });
			if (r.missing.length) return text(`Unknown column(s): ${r.missing.join(", ")}. Columns: ${f.ds.cols.join(", ")}`);
			const cell = (v: unknown) => (typeof v === "number" ? v.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : String(v ?? ""));
			const md = [`| ${r.head.join(" | ")} |`, `|${r.head.map(() => "---").join("|")}|`, ...r.rows.map((row) => `| ${row.map(cell).join(" | ")} |`)];
			let note = `${r.matched} of ${f.ds.rows.length} rows matched${p.group_by ? `; ${r.rows.length} of ${r.groups} groups shown` : ""}.`;
			if (p.output_csv) {
				const q = (v: unknown) => (typeof v === "number" ? String(v) : `"${String(v ?? "").replace(/"/g, '""')}"`);
				await save(workspace, p.output_csv, Buffer.from([r.head.map(q).join(","), ...r.rows.map((row) => row.map(q).join(","))].join("\n"), "utf8"), ".csv");
				note += ` Saved ${p.output_csv}.`;
			}
			return text(`${md.join("\n")}\n\n${note}`);
		},
	});

	return [pptx, docx, xlsx, dashboard, describeData, queryData, imageTool(workspace, themesDir)];
}
