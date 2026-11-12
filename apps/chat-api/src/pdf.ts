// Markdown -> pdfmake document definition. Covers what reports need: headings, paragraphs,
// emphasis, inline code, lists, tables, code blocks, quotes, rules.
import { marked, type Token, type Tokens } from "marked";

type Inline = string | { text: Inline[] | string; bold?: boolean; italics?: boolean; font?: string; link?: string; color?: string };

function inline(tokens: Token[] | undefined): Inline[] {
	if (!tokens) return [];
	return tokens.flatMap((t): Inline[] => {
		switch (t.type) {
			case "strong":
				return [{ text: inline((t as Tokens.Strong).tokens), bold: true }];
			case "em":
				return [{ text: inline((t as Tokens.Em).tokens), italics: true }];
			case "codespan":
				return [{ text: (t as Tokens.Codespan).text, font: "Courier" }];
			case "link":
				return [{ text: inline((t as Tokens.Link).tokens), link: (t as Tokens.Link).href, color: "#1a56db" }];
			case "br":
				return ["\n"];
			case "text":
				return (t as Tokens.Text).tokens ? inline((t as Tokens.Text).tokens) : [decode((t as Tokens.Text).text)];
			default:
				return ["raw" in t ? decode(String(t.raw)) : ""];
		}
	});
}

function decode(s: string): string {
	return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

const headingSize = [0, 20, 16, 14, 12, 11, 10];

function block(t: Token): unknown[] {
	switch (t.type) {
		case "heading": {
			const h = t as Tokens.Heading;
			return [{ text: inline(h.tokens), fontSize: headingSize[h.depth], bold: true, headlineLevel: h.depth, margin: [0, h.depth <= 2 ? 12 : 8, 0, 4] }];
		}
		case "paragraph":
			return [{ text: inline((t as Tokens.Paragraph).tokens), margin: [0, 0, 0, 6] }];
		case "list": {
			const l = t as Tokens.List;
			const items = l.items.map((i) => i.tokens.flatMap((x) => (x.type === "text" ? [{ text: inline((x as Tokens.Text).tokens ?? [x]) }] : block(x))));
			return [{ [l.ordered ? "ol" : "ul"]: items, margin: [0, 0, 0, 6] }];
		}
		case "table": {
			const tb = t as Tokens.Table;
			const header = tb.header.map((c) => ({ text: inline(c.tokens), bold: true, fillColor: "#eeeeee" }));
			const rows = tb.rows.map((r) => r.map((c) => ({ text: inline(c.tokens) })));
			return [{ table: { headerRows: 1, widths: tb.header.map(() => "*"), body: [header, ...rows] }, layout: "lightHorizontalLines", fontSize: 9, margin: [0, 4, 0, 8] }];
		}
		case "code":
			return [{ text: (t as Tokens.Code).text, font: "Courier", fontSize: 8, background: "#f5f5f5", margin: [0, 2, 0, 8] }];
		case "blockquote":
			return [{ stack: (t as Tokens.Blockquote).tokens.flatMap(block), italics: true, color: "#555555", margin: [12, 0, 0, 6] }];
		case "hr":
			return [{ canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: "#999999" }], margin: [0, 6, 0, 6] }];
		case "space":
			return [];
		default:
			return "raw" in t ? [{ text: decode(String(t.raw)) }] : [];
	}
}

export function markdownToPdfDoc(markdown: string, title: string) {
	return {
		info: { title },
		pageSize: "A4",
		pageMargins: [40, 50, 40, 50],
		defaultStyle: { font: "Helvetica", fontSize: 10, lineHeight: 1.2 },
		footer: (page: number, pages: number) => ({ text: `${page} / ${pages}`, alignment: "center", fontSize: 8, color: "#888888" }),
		content: marked.lexer(markdown).flatMap(block),
		// Keep headings with their first paragraph (no orphan heading at a page bottom).
		pageBreakBefore: (node: { headlineLevel?: number }, following: unknown[]) => Boolean(node.headlineLevel) && following.length === 0,
	};
}
