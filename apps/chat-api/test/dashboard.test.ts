// Dashboard renderer: data loading, numbers, lint, and a safe self-contained page.
import "../src/no-subprocess.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDashboard, loadTable, toNumber, describe, runQuery, type DashboardSpec } from "../src/office/dashboard.ts";
import { loadThemes } from "../src/office/pptx.ts";
import * as rt from "../src/office/dashboard-runtime.js";
import { writeSalesWorkbook } from "./sales-fixture.ts";

const themes = await loadThemes(new URL("../../../skills/pptx/themes", import.meta.url).pathname);
const dir = await mkdtemp(join(tmpdir(), "dash-"));
await writeSalesWorkbook(join(dir, "vendas.xlsx"));
await writeFile(join(dir, "metas.csv"), "Região;Meta;Atingido\nSudeste;R$ 12.000.000,00;95%\nSul;5.500.000;101,5%\n");
const resolve = (p: string) => join(dir, p);

test("numbers in pt-BR and en formats", () => {
	assert.equal(toNumber("R$ 1.234,56"), 1234.56);
	assert.equal(toNumber("1,234.5"), 1234.5);
	assert.equal(toNumber("12,5%"), 0.125);
	assert.equal(toNumber("abc"), undefined);
	assert.equal(rt.fmt(15_200_000, "currency"), "R$ 15,2 mi");
	assert.equal(rt.fmt(0.297, "percent"), "29,7%");
});

test("xlsx header found below a title row; csv typed; describe profiles columns", async () => {
	const x = await loadTable(join(dir, "vendas.xlsx"));
	assert.deepEqual(x.ds.cols, ["Data", "Região", "Produto", "Canal", "Receita (R$)", "Unidades"]);
	assert.equal(x.ds.rows.length, 3000);
	assert.match(String(x.ds.rows[0][0]), /^\d{4}-\d{2}-\d{2}$/);
	const c = await loadTable(join(dir, "metas.csv"));
	assert.deepEqual(c.ds.rows[0], ["Sudeste", 12_000_000, 0.95]);
	assert.match(describe(x.ds).join("\n"), /Data: date, 2025-01-01 to 2026-10-\d\d/);
});

test("periods and ranges on date columns", async () => {
	const { ds } = await loadTable(join(dir, "vendas.xlsx"));
	const y26 = rt.where(ds, ds.rows, { Data: "2026" }).length;
	const y25 = rt.where(ds, ds.rows, { Data: "2025" }).length;
	assert.equal(y25 + y26, 3000);
	assert.equal(rt.where(ds, ds.rows, { Data: { from: "2026-01", to: "2026-03" } }).length, rt.where(ds, ds.rows, { Data: "2026-T1" }).length);
});

const spec = (over: Partial<DashboardSpec> = {}): DashboardSpec => ({
	title: "Receita cresce em 2026",
	source: "ERP",
	data: { vendas: { file: "vendas.xlsx" }, metas: { file: "metas.csv" } },
	filters: [{ field: "Região" }],
	items: [
		{ type: "kpi", label: "Receita jan-out/2026", field: "Receita (R$)", format: "currency", where: { Data: { from: "2026-01", to: "2026-10" } }, compare: { where: { Data: { from: "2025-01", to: "2025-10" } }, label: "vs 2025" } },
		{ type: "chart", chart: "bar", title: "Sudeste lidera", x: "regiao", y: "Receita (R$)", highlight: "Sudeste" },
		{ type: "table", title: "Metas por região", data: "metas", columns: ["Região", { field: "Atingido", format: "percent" }] },
	],
	...over,
});

test("dashboard renders with computed values and a clean lint", async () => {
	const r = await renderDashboard(spec(), { resolve, themes });
	assert.deepEqual(r.warnings, []);
	assert.match(r.summary[0], /^KPI Receita jan-out\/2026: R\$ [\d,]+ mi \(\+[\d,]+% vs 2025\)$/);
	assert.match(r.summary[1], /^Chart Sudeste lidera \(bar, 5 categories\): Sudeste /);
	assert.match(r.html, /Content-Security-Policy" content="default-src 'none'/);
	assert.ok(r.html.includes("echarts"));
	// Only used columns are embedded; "Produto" and "Canal" are not referenced.
	const payload = JSON.parse(r.html.split('<script id="payload" type="application/json">')[1].split("</script>")[0]);
	assert.deepEqual(payload.data.vendas.cols, ["Data", "Região", "Receita (R$)"]);
});

test("lint: unknown column lists the real ones; text injection stays text", async () => {
	const r = await renderDashboard(
		spec({ title: "</script><script>alert(1)</script>", items: [{ type: "chart", chart: "pie", title: "x", x: "Ano", y: "Receita (R$)" }] }),
		{ resolve, themes },
	);
	assert.match(r.warnings[0], /column "Ano" not in "vendas" \(columns: Data, Região, Produto, Canal, Receita \(R\$\), Unidades\)/);
	assert.ok(!r.html.includes("<script>alert(1)"));
});

test("lint: pie slices, long tables, one-page overflow", async () => {
	const r = await renderDashboard(
		spec({
			format: "onepage",
			items: [
				{ type: "chart", chart: "pie", title: "Produtos", x: "Produto", y: "Receita (R$)" },
				{ type: "table", title: "Vendas", columns: ["Data", "Produto", "Receita (R$)"] },
				{ type: "chart", chart: "line", title: "Mensal", x: "Data", x_bucket: "month", y: "Receita (R$)", span: 4 },
				{ type: "chart", chart: "column", title: "Canal", x: "Canal", y: "Receita (R$)", span: 4 },
			],
		}),
		{ resolve, themes },
	);
	const w = r.warnings.join("\n");
	assert.match(w, /7 slices; set "top": 5/);
	assert.match(w, /3000 rows; set "top"/);
	assert.match(w, /one-page content is ~\d+% of an A4 page/);
});

test("query_data engine: group-by with buckets, totals, unknown columns", async () => {
	const { ds } = await loadTable(join(dir, "vendas.xlsx"));
	const total = runQuery(ds, { measures: [{ field: "Receita (R$)" }, { agg: "count" }] });
	assert.equal(total.rows[0][1], 3000);
	const byYear = runQuery(ds, { group_by: "Data", x_bucket: "year", measures: [{ field: "Receita (R$)", agg: "sum" }], sort: "x" });
	assert.deepEqual(byYear.rows.map((r) => r[0]), ["2025", "2026"]);
	assert.ok(Math.abs((byYear.rows[0][1] as number) + (byYear.rows[1][1] as number) - (total.rows[0][0] as number)) < 0.01);
	const sul = runQuery(ds, { where: { regiao: "sul" }, group_by: "Produto", top: 3 });
	assert.equal(sul.rows.length, 3);
	assert.equal(sul.groups, 7);
	assert.deepEqual(runQuery(ds, { group_by: "Ano" }).missing, ["Ano"]);
});
