# Test data

Public files for manual E2E tests. Run `./fetch.sh` to download them; the binaries are gitignored.

| File | Source | What it tests |
|---|---|---|
| `financial-sample.xlsx` (82 KiB, 1 sheet, ~700 rows) | Microsoft Power BI Financial Sample | small spreadsheet, aggregation in python |
| `anp-precos-resumo-2026-11-07.xlsx` (293 KiB, 5 sheets) | ANP weekly fuel price survey (gov.br, open data) | pt-BR, several sheets, header rows |
| `anp-precos-revendas-2026-11-07.xlsx` (1.9 MiB, 13 MiB unzipped) | ANP per-station prices | large spreadsheet: parser limits, chunked reading |
| `attention-is-all-you-need.pdf` (2.1 MiB, 15 pages) | arXiv 1706.03762 | English PDF with tables and formulas |
| `bcb-rpm-2026-09.pdf` (3 MiB) | Banco Central do Brasil, Relatório de Política Monetária Sep/2026 | long pt-BR PDF with charts: large-file reading, summarization |

Kaggle was not used: its downloads need a signed-in account.
