// Markdown -> DOCX with the `docx` library (pure JS). Real Word styles (Title, Heading 1-3,
// lists, tables), so the user can keep editing and generate a table of contents in Word.
import { marked, type Token, type Tokens } from "marked";
import {
	AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, Header, HeadingLevel, LevelFormat, Packer, PageNumber,
	Paragraph, ShadingType, Table, TableCell, TableOfContents, TableRow, TextRun, WidthType,
	type IRunOptions, type ParagraphChild,
} from "docx";

export interface DocOptions {
	title?: string;
	subtitle?: string;
	author?: string;
	date?: string;
	accent?: string; // hex, headings and table header
	toc?: boolean; // table of contents field (Word fills it on open / F9)
	header?: string; // running header text
}

const FONT = "Aptos";
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function runs(tokens: Token[] | undefined, style: IRunOptions = {}): ParagraphChild[] {
	if (!tokens) return [];
	return tokens.flatMap((t): ParagraphChild[] => {
		switch (t.type) {
			case "strong":
				return runs((t as Tokens.Strong).tokens, { ...style, bold: true });
			case "em":
				return runs((t as Tokens.Em).tokens, { ...style, italics: true });
			case "del":
				return runs((t as Tokens.Del).tokens, { ...style, strike: true });
			case "codespan":
				return [new TextRun({ ...style, text: decode((t as Tokens.Codespan).text), font: "Consolas", shading: { type: ShadingType.CLEAR, fill: "F2F4F7", color: "auto" } })];
			case "link": {
				const l = t as Tokens.Link;
				return [new ExternalHyperlink({ link: l.href, children: [new TextRun({ ...style, text: decode(l.text), style: "Hyperlink" })] })];
			}
			case "br":
				return [new TextRun({ break: 1 })];
			case "text": {
				const tt = t as Tokens.Text;
				return tt.tokens ? runs(tt.tokens, style) : [new TextRun({ ...style, text: decode(tt.text) })];
			}
			default:
				return [new TextRun({ ...style, text: decode("text" in t ? String((t as { text: string }).text) : t.raw) })];
		}
	});
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

function blocks(tokens: Token[], accent: string, level = 0): (Paragraph | Table)[] {
	const out: (Paragraph | Table)[] = [];
	for (const t of tokens) {
		switch (t.type) {
			case "heading": {
				const h = t as Tokens.Heading;
				out.push(new Paragraph({ heading: HEADINGS[h.depth], children: runs(h.tokens) }));
				break;
			}
			case "paragraph":
				out.push(new Paragraph({ children: runs((t as Tokens.Paragraph).tokens) }));
				break;
			case "list": {
				const l = t as Tokens.List;
				for (const item of l.items) {
					const inlineTok = item.tokens.filter((x) => x.type === "text" || x.type === "paragraph") as Tokens.Text[];
					const inline = inlineTok.flatMap((x) => runs(x.tokens ?? []));
					out.push(new Paragraph({ children: inline, numbering: { reference: l.ordered ? "numbers" : "bullets", level: Math.min(level, 2) } }));
					const nested = item.tokens.filter((x) => x.type === "list");
					out.push(...blocks(nested, accent, level + 1));
				}
				break;
			}
			case "table": {
				const tb = t as Tokens.Table;
				const header = new TableRow({
					tableHeader: true,
					children: tb.header.map((c) => new TableCell({
						shading: { type: ShadingType.CLEAR, fill: accent, color: "auto" },
						children: [new Paragraph({ alignment: align(c.align), children: runs(c.tokens, { bold: true, color: "FFFFFF" }) })],
					})),
				});
				const rows = tb.rows.map((r, i) => new TableRow({
					children: r.map((c) => new TableCell({
						shading: i % 2 ? { type: ShadingType.CLEAR, fill: "F2F4F7", color: "auto" } : undefined,
						children: [new Paragraph({ alignment: align(c.align), children: runs(c.tokens) })],
					})),
				}));
				const hair = { style: BorderStyle.SINGLE, size: 4, color: "D0D5DD" };
				const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
				out.push(new Table({
					width: { size: 100, type: WidthType.PERCENTAGE },
					borders: { top: hair, bottom: hair, left: none, right: none, insideHorizontal: hair, insideVertical: none },
					margins: { top: 60, bottom: 60, left: 100, right: 100 },
					rows: [header, ...rows],
				}));
				out.push(new Paragraph({ children: [] }));
				break;
			}
			case "code":
				for (const line of (t as Tokens.Code).text.split("\n"))
					out.push(new Paragraph({ style: "Code", children: [new TextRun({ text: line, font: "Consolas" })] }));
				break;
			case "blockquote":
				for (const x of (t as Tokens.Blockquote).tokens)
					if (x.type === "paragraph") out.push(new Paragraph({ style: "Quote", children: runs((x as Tokens.Paragraph).tokens) }));
					else out.push(...blocks([x], accent, level));
				break;
			case "hr":
				out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "D0D5DD", space: 1 } }, children: [] }));
				break;
			case "space":
				break;
			default:
				if ("tokens" in t && Array.isArray(t.tokens)) out.push(new Paragraph({ children: runs(t.tokens as Token[]) }));
				else if (t.raw.trim()) out.push(new Paragraph({ children: [new TextRun(decode(t.raw))] }));
		}
	}
	return out;
}

function align(a: string | null | undefined) {
	return a === "right" ? AlignmentType.RIGHT : a === "center" ? AlignmentType.CENTER : AlignmentType.LEFT;
}

export async function markdownToDocx(md: string, o: DocOptions = {}): Promise<Buffer> {
	const accent = (o.accent ?? "0B3B75").replace("#", "").toUpperCase();
	const tokens = marked.lexer(md);
	const cover: (Paragraph | TableOfContents)[] = [];
	if (o.title) {
		cover.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(o.title)] }));
		if (o.subtitle) cover.push(new Paragraph({ style: "Subtitle", children: [new TextRun(o.subtitle)] }));
		const meta = [o.author, o.date].filter(Boolean).join("  ·  ");
		if (meta) cover.push(new Paragraph({ style: "Meta", children: [new TextRun(meta)] }));
	}
	if (o.toc) cover.push(new TableOfContents("Sumário", { hyperlink: true, headingStyleRange: "1-3" }), new Paragraph({ pageBreakBefore: true, children: [] }));

	const doc = new Document({
		creator: o.author ?? "Assistente",
		title: o.title,
		features: { updateFields: !!o.toc },
		styles: {
			default: { document: { run: { font: FONT, size: 22, color: "1D2939" }, paragraph: { spacing: { after: 140, line: 300 } } } },
			paragraphStyles: [
				{ id: "Title", name: "Title", basedOn: "Normal", run: { size: 52, bold: true, color: accent }, paragraph: { spacing: { after: 120 } } },
				{ id: "Subtitle", name: "Subtitle", basedOn: "Normal", run: { size: 28, color: "667085" }, paragraph: { spacing: { after: 120 } } },
				{ id: "Meta", name: "Meta", basedOn: "Normal", run: { size: 20, color: "667085" }, paragraph: { spacing: { after: 360 }, border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: accent, space: 8 } } } },
				{ id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 32, bold: true, color: accent }, paragraph: { spacing: { before: 360, after: 120 }, keepNext: true } },
				{ id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 26, bold: true, color: "1D2939" }, paragraph: { spacing: { before: 240, after: 80 }, keepNext: true } },
				{ id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 23, bold: true, color: "475467" }, paragraph: { spacing: { before: 200, after: 60 }, keepNext: true } },
				{ id: "Code", name: "Code", basedOn: "Normal", run: { font: "Consolas", size: 19 }, paragraph: { spacing: { after: 0, line: 260 }, shading: { type: ShadingType.CLEAR, fill: "F2F4F7", color: "auto" } } },
				{ id: "Quote", name: "Quote", basedOn: "Normal", run: { italics: true, color: "475467" }, paragraph: { indent: { left: 400 }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: accent, space: 12 } } } },
			],
		},
		numbering: {
			config: [
				{ reference: "bullets", levels: [0, 1, 2].map((level) => ({ level, format: LevelFormat.BULLET, text: ["•", "–", "·"][level], alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } } })) },
				{ reference: "numbers", levels: [0, 1, 2].map((level) => ({ level, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level], text: `%${level + 1}.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 300 } } } })) },
			],
		},
		sections: [{
			properties: { page: { margin: { top: 1300, bottom: 1300, left: 1300, right: 1300 } } },
			headers: o.header ? { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: o.header, size: 16, color: "98A2B3" })] })] }) } : undefined,
			footers: {
				default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES], size: 16, color: "98A2B3" })] })] }),
			},
			children: [...cover, ...blocks(tokens, accent)],
		}],
	});
	return Packer.toBuffer(doc);
}
