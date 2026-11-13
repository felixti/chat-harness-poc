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

	return [pptx, docx, xlsx];
}
