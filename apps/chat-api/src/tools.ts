// Custom tools that replace anything which would need a subprocess.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, relative, basename } from "node:path";
import { createRequire } from "node:module";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Bash, InMemoryFs, MountableFs, OverlayFs, ReadWriteFs } from "just-bash";
import { Type } from "typebox";
import { config } from "./config.ts";
import { markdownToPdfDoc } from "./pdf.ts";

const require = createRequire(import.meta.url);
const PdfPrinter = require("pdfmake");

function text(t: string) {
	return { content: [{ type: "text" as const, text: t }], details: undefined };
}

/** Keeps every path inside the workspace (no ../ escapes, no absolute paths elsewhere). */
export function insideWorkspace(workspace: string, p: string): string {
	const full = resolve(workspace, p);
	if (relative(workspace, full).startsWith("..")) throw new Error(`path outside workspace: ${p}`);
	return full;
}

/**
 * Emulated bash (just-bash): a TypeScript interpreter, no process is created. The workspace is
 * mounted read-write at its real path and the skills read-only at theirs, so paths match the
 * built-in read/write/edit tools. No network (curl stays disabled).
 */
export function bashTool(workspace: string) {
	const fs = new MountableFs({ base: new InMemoryFs() });
	fs.mount(workspace, new ReadWriteFs({ root: workspace }));
	fs.mount(config.skillsDir, new OverlayFs({ root: config.skillsDir, readOnly: true, mountPoint: "/" }));
	const bash = new Bash({ fs, cwd: workspace, python: true, env: { HOME: workspace } });
	return defineTool({
		name: "bash",
		label: "bash",
		description:
			"Run a bash script in an emulated shell over the conversation workspace. Supports the usual " +
			"file and text utilities (ls, cat, grep, find, sed, awk, jq, sort, head, tail, wc, diff, tar...) " +
			"and python3 (standard library only). No network, no package installs, no other programs. " +
			"For pandas, charts or documents use run_code when available.",
		promptSnippet: "bash: emulated shell over the workspace (coreutils, grep, jq, python3 stdlib)",
		parameters: Type.Object({
			command: Type.String({ description: "Bash script to run" }),
			timeout: Type.Optional(Type.Number({ description: "Seconds, default 60" })),
		}),
		async execute(_id, params, signal) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), (params.timeout ?? 60) * 1000);
			signal?.addEventListener("abort", () => controller.abort());
			try {
				const r = await bash.exec(params.command, { signal: controller.signal });
				const out = [r.stdout, r.stderr && `[stderr]\n${r.stderr}`, `[exit ${r.exitCode}]`].filter(Boolean).join("\n");
				return text(out.length > 30000 ? `${out.slice(0, 30000)}\n[truncated: write long output to a file]` : out);
			} finally {
				clearTimeout(timer);
			}
		},
	});
}

/** In-process markdown -> PDF (pdfmake, pure JS). Fallback when no code sandbox is available. */
export function generatePdfTool(workspace: string) {
	const printer = new PdfPrinter({
		Helvetica: { normal: "Helvetica", bold: "Helvetica-Bold", italics: "Helvetica-Oblique", bolditalics: "Helvetica-BoldOblique" },
		Courier: { normal: "Courier", bold: "Courier-Bold", italics: "Courier-Oblique", bolditalics: "Courier-BoldOblique" },
	});
	return defineTool({
		name: "generate_pdf",
		label: "generate_pdf",
		description:
			"Render a markdown file from the workspace to PDF (headings, paragraphs, bold/italic, lists, " +
			"tables, code blocks). Write the markdown first, then call this. Returns the PDF path.",
		promptSnippet: "generate_pdf: markdown file -> PDF in the workspace",
		parameters: Type.Object({
			source: Type.String({ description: "Markdown file path, relative to the workspace" }),
			output: Type.String({ description: "PDF path to create, relative to the workspace" }),
			title: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			const src = insideWorkspace(workspace, params.source);
			const out = insideWorkspace(workspace, params.output);
			const doc = markdownToPdfDoc(await readFile(src, "utf8"), params.title ?? basename(params.output, ".pdf"));
			const pdf = printer.createPdfKitDocument(doc);
			const chunks: Buffer[] = [];
			const done = new Promise<Buffer>((ok, fail) => {
				pdf.on("data", (c: Buffer) => chunks.push(c));
				pdf.on("end", () => ok(Buffer.concat(chunks)));
				pdf.on("error", fail);
			});
			pdf.end();
			const bytes = await done;
			await mkdir(dirname(out), { recursive: true });
			await writeFile(out, bytes);
			return text(`PDF written: ${params.output} (${bytes.length} bytes). The user can download it from the files panel.`);
		},
	});
}

/** Sends a workspace file to the document parser service and stores the markdown next to it. */
export function parseDocumentTool(workspace: string) {
	return defineTool({
		name: "parse_document",
		label: "parse_document",
		description:
			"Convert a document in the workspace (PDF, DOCX, XLSX, PPTX, HTML, images) to markdown with the " +
			"document parser service. Saves `<file>.md` next to it and returns its path and size. Then read " +
			"it in slices with read (offset/limit) or grep it with bash; do not read huge files at once.",
		promptSnippet: "parse_document: document -> markdown file (then read it in slices)",
		parameters: Type.Object({ path: Type.String({ description: "File path relative to the workspace" }) }),
		async execute(_id, params, signal) {
			if (!config.parserUrl) return text("parser service not configured");
			const file = insideWorkspace(workspace, params.path);
			const body = new FormData();
			body.append("file", new Blob([await readFile(file)]), basename(file));
			const res = await fetch(`${config.parserUrl}/convert`, { method: "POST", body, signal });
			if (!res.ok) return text(`parser error ${res.status}: ${await res.text()}`);
			const md = await res.text();
			const target = `${file}.md`;
			await writeFile(target, md);
			const lines = md.split("\n").length;
			return text(`Saved ${relative(workspace, target)} (${md.length} chars, ${lines} lines).`);
		},
	});
}
