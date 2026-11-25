// Data analysis with DuckDB (H70): views from workspace files, exact SQL results, exports, charts,
// and the lock-down (no other paths, no network, no extensions, no configuration changes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeDataTool, chartOption, dataFiles, openAnalysis, runSql, viewName } from "../src/data.ts";
import { config } from "../src/config.ts";
import { writeSalesWorkbook } from "./sales-fixture.ts";

type Exec = (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const ws = await mkdtemp(join(tmpdir(), "data-"));
await mkdir(join(ws, "uploads"), { recursive: true });
await mkdir(join(ws, "project"), { recursive: true });
await writeSalesWorkbook(join(ws, "uploads", "Vendas 2026.xlsx"), 500);
await writeFile(join(ws, "uploads", "metas.csv"), "Região,meta\nSudeste,100000\nSul,50000\n");
await writeFile(join(ws, "project", "eventos.jsonl"), '{"dia":"2026-01-02","n":3}\n{"dia":"2026-01-03","n":5}\n');
await writeFile(join(ws, "uploads", "notas.txt"), "texto livre, sem tabela\n");
const run = (p: Record<string, unknown>) => (analyzeDataTool(ws).execute as unknown as Exec)("c1", p).then((r) => r.content[0].text);

test("view names are SQL-safe and unique", () => {
	const t = new Set<string>();
	assert.equal(viewName("uploads/Vendas 2026.xlsx", t), "vendas_2026");
	assert.equal(viewName("outputs/vendas-2026.csv", t), "vendas_2026_2");
	assert.equal(viewName("2026 metas.csv", t), "t_2026_metas");
	assert.equal(viewName("Relatório Ação.csv", t), "relatorio_acao");
});

test("data files are found in uploads, project and work; tool output is skipped", async () => {
	await mkdir(join(ws, "work", "tool-output"), { recursive: true });
	await writeFile(join(ws, "work", "tool-output", "x.csv"), "a\n1\n");
	const files = await dataFiles(ws);
	assert.ok(files.includes("uploads/Vendas 2026.xlsx") && files.includes("project/eventos.jsonl") && files.includes("uploads/metas.csv"));
	assert.ok(!files.some((f) => f.includes("tool-output")));
});

test("no sql lists the views with rows and columns", async () => {
	const out = await run({});
	assert.match(out, /vendas_2026 <- uploads\/Vendas 2026\.xlsx \[Vendas\] · 500 rows · Data DATE/);
	assert.match(out, /metas <- uploads\/metas\.csv · 2 rows/);
	assert.match(out, /eventos <- project\/eventos\.jsonl/);
	assert.doesNotMatch(out, /notas/);
});

test("SQL joins a spreadsheet with a CSV and gives exact totals; save_as and chart", async () => {
	const sql = `SELECT v."Região" AS regiao, round(sum(v."Receita (R$)"), 2) AS receita, any_value(m.meta) AS meta
		FROM vendas_2026 v LEFT JOIN metas m ON m."Região" = v."Região" GROUP BY ALL ORDER BY receita DESC`;
	const out = await run({ sql, save_as: "outputs/receita-regiao.csv", chart: { type: "bar", x: "regiao", y: ["receita"], title: "Receita" } });
	assert.match(out, /^5 row\(s\):/);
	assert.match(out, /\| regiao \| receita \| meta \|/);
	assert.match(out, /Saved the full result to outputs\/receita-regiao\.csv/);
	assert.match(out, /```echarts\n\{"title":\{"text":"Receita"\}/);
	const csv = await readFile(join(ws, "outputs", "receita-regiao.csv"), "utf8");
	assert.equal(csv.split("\n")[0], "regiao,receita,meta");
	assert.equal(csv.trim().split("\n").length, 6);
});

test("the model's SQL cannot reach other files, the network, extensions or the settings", async () => {
	const a = await openAnalysis(ws);
	try {
		for (const q of [
			"SELECT * FROM read_csv('/etc/passwd')",
			"SELECT * FROM read_text('/proc/self/environ')",
			"SELECT * FROM read_csv('https://example.com/x.csv')",
			"COPY (SELECT 1) TO '/tmp/escape.csv'",
			"ATTACH '/tmp/other.db'",
			"INSTALL httpfs",
			"LOAD httpfs",
			"SET enable_external_access = true",
			"SET allowed_directories = ['/']",
		])
			await assert.rejects(runSql(a.connection, q), /Permission|disabled|Cannot change|lock/i, q);
		const ok = await runSql(a.connection, "SELECT count(*) FROM metas");
		assert.equal(String(ok.rows[0][0]), "2");
	} finally {
		await a.close();
	}
	// The scratch folder (xlsx sheets as CSV) is removed after each call.
	assert.deepEqual(await readdir(join(config.tmpRoot, "duckdb")).catch(() => []), []);
});

test("errors and limits come back as messages the model can act on", async () => {
	await assert.rejects(run({ sql: "SELECT * FROM nao_existe" }), /nao_existe/);
	await assert.rejects(run({ sql: "SELECT 1", save_as: "../fora.csv" }), /save_as/);
	assert.throws(() => chartOption(["a", "b"], [[1, 2]], { type: "line", x: "a", y: ["c"] }), /unknown column/);
	const big = await run({ sql: "SELECT range AS i FROM range(5000)" });
	assert.match(big, /^1000\+ row\(s\), first 50 shown/);
});
