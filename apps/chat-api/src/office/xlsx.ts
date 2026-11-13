// Workbook spec (JSON) -> XLSX with exceljs (pure JS). Typed columns with real number formats,
// frozen header, autofilter, formulas, totals row, data bars: a spreadsheet people keep using.
import ExcelJS from "exceljs";

type Format = "text" | "integer" | "decimal" | "currency" | "percent" | "date";

export interface SheetSpec {
	name: string;
	title?: string; // optional title row above the table
	columns: { header: string; width?: number; format?: Format }[];
	rows?: unknown[][]; // values; strings starting with "=" are formulas (A1 refs)
	rows_csv?: string; // alternative: CSV file in the workspace (header row skipped)
	totals?: boolean; // SUM row under numeric columns
	data_bars?: string[]; // column headers that get in-cell data bars
}

export interface WorkbookSpec {
	sheets: SheetSpec[];
	accent?: string;
	currency?: string; // default "R$"
}

const NUMFMT = (cur: string): Record<Format, string | undefined> => ({
	text: "@",
	integer: "#,##0",
	decimal: "#,##0.00",
	currency: `"${cur}" #,##0.00`,
	percent: "0.0%",
	date: "dd/mm/yyyy",
});

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, commas or semicolons). */
export function parseCsv(text: string): string[][] {
	const sep = (text.split("\n")[0].match(/;/g)?.length ?? 0) > (text.split("\n")[0].match(/,/g)?.length ?? 0) ? ";" : ",";
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let q = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (q) {
			if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
			else if (ch === '"') q = false;
			else cell += ch;
		} else if (ch === '"') q = true;
		else if (ch === sep) { row.push(cell); cell = ""; }
		else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			row.push(cell); rows.push(row); row = []; cell = "";
		} else cell += ch;
	}
	if (cell || row.length) { row.push(cell); rows.push(row); }
	return rows.filter((r) => r.some((c) => c !== ""));
}

function coerce(v: unknown, f: Format | undefined): unknown {
	if (typeof v === "string" && v.startsWith("=")) return { formula: v.slice(1) };
	if (v === null || v === undefined || v === "") return null;
	if (f === "date") {
		const d = new Date(String(v));
		return Number.isNaN(+d) ? v : d;
	}
	if (f && f !== "text" && typeof v === "string") {
		// Accept "1.234,56", "1,234.56", "12%", "R$ 10".
		let s = v.replace(/[^\d,.\-%]/g, "");
		const pct = s.endsWith("%");
		s = s.replace("%", "");
		if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
		else s = s.replace(/,/g, "");
		const n = Number(s);
		if (!Number.isNaN(n) && s !== "") return pct ? n / 100 : n;
	}
	return v;
}

export async function renderWorkbook(spec: WorkbookSpec, readCsv: (p: string) => Promise<string>): Promise<{ bytes: Buffer; warnings: string[] }> {
	if (!spec || !Array.isArray(spec.sheets) || spec.sheets.length === 0) throw new Error("spec needs {sheets:[{name, columns, rows|rows_csv}]}");
	const accent = (spec.accent ?? "0B3B75").replace("#", "").toUpperCase();
	const fmt = NUMFMT(spec.currency ?? "R$");
	const wb = new ExcelJS.Workbook();
	wb.creator = "Assistente";
	const warnings: string[] = [];

	for (const sh of spec.sheets) {
		const name = sh.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
		const ws = wb.addWorksheet(name);
		let rows = sh.rows ?? [];
		if (sh.rows_csv) rows = parseCsv(await readCsv(sh.rows_csv)).slice(1);
		if (rows.length > 1_000_000) throw new Error(`sheet ${name}: over 1,000,000 rows`);
		const cols = sh.columns;
		let r0 = 1;
		if (sh.title) {
			ws.getCell(1, 1).value = sh.title;
			ws.getCell(1, 1).font = { size: 16, bold: true, color: { argb: `FF${accent}` } };
			ws.getRow(1).height = 26;
			r0 = 3;
		}
		const head = ws.getRow(r0);
		cols.forEach((c, j) => {
			const cell = head.getCell(j + 1);
			cell.value = c.header;
			cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
			cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${accent}` } };
			cell.alignment = { vertical: "middle", horizontal: c.format && c.format !== "text" ? "right" : "left", wrapText: true };
		});
		head.height = 22;
		rows.forEach((r, i) => {
			if (r.length !== cols.length) warnings.push(`${name} row ${i + 1}: ${r.length} values for ${cols.length} columns`);
			const row = ws.getRow(r0 + 1 + i);
			cols.forEach((c, j) => {
				const cell = row.getCell(j + 1);
				cell.value = coerce(r[j], c.format) as ExcelJS.CellValue;
				const nf = c.format ? fmt[c.format] : undefined;
				if (nf) cell.numFmt = nf;
				if (i % 2) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F4F7" } };
			});
		});
		const last = r0 + rows.length;
		if (sh.totals && rows.length) {
			const tr = ws.getRow(last + 1);
			tr.getCell(1).value = "Total";
			cols.forEach((c, j) => {
				if (j === 0 || !c.format || ["text", "date", "percent"].includes(c.format)) return;
				const col = ws.getColumn(j + 1).letter;
				const cell = tr.getCell(j + 1);
				cell.value = { formula: `SUBTOTAL(109,${col}${r0 + 1}:${col}${last})` };
				cell.numFmt = fmt[c.format] ?? "";
			});
			tr.font = { bold: true };
			tr.eachCell((cell) => { cell.border = { top: { style: "medium", color: { argb: `FF${accent}` } } }; });
		}
		// Widths: explicit, else from content (capped).
		cols.forEach((c, j) => {
			const sample = rows.slice(0, 200).map((r) => String(r[j] ?? "").length);
			const pad = c.format && c.format !== "text" ? 7 : 2; // thousands separators, currency symbol
			ws.getColumn(j + 1).width = c.width ?? Math.min(50, Math.max(10, c.header.length + 2, ...sample.map((n) => n + pad)));
		});
		ws.views = [{ state: "frozen", ySplit: r0, xSplit: 0 }];
		if (rows.length) ws.autoFilter = { from: { row: r0, column: 1 }, to: { row: last, column: cols.length } };
		for (const h of sh.data_bars ?? []) {
			const j = cols.findIndex((c) => c.header === h);
			if (j < 0) { warnings.push(`${name}: data_bars column "${h}" not found`); continue; }
			const col = ws.getColumn(j + 1).letter;
			ws.addConditionalFormatting({
				ref: `${col}${r0 + 1}:${col}${last}`,
				rules: [{ type: "dataBar", priority: 1, cfvo: [{ type: "min" }, { type: "max" }], color: { argb: `FF${accent}` }, gradient: false } as unknown as ExcelJS.ConditionalFormattingRule],
			});
		}
	}
	const bytes = Buffer.from(await wb.xlsx.writeBuffer());
	return { bytes, warnings };
}
