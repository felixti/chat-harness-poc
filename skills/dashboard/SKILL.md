---
name: dashboard
description: Create interactive HTML dashboards and printable one-page summaries (one-pagers) from Excel or CSV data - sales, finance, operations, HR, KPIs. Use when the user asks for a dashboard, panel, painel, one-page, one-pager, resumo executivo em uma página, or an interactive report.
---

# Dashboards and one-pagers

You choose the question, the numbers and the form. `generate_dashboard` computes every value
from the data files, draws the page and checks it, so never type figures from the data by hand.
Read the `design` skill too (theme, focal point, chart choice, words).

- **Dashboard** (`"format": "dashboard"`, default): an interactive page, with global filters,
  tooltips and clickable legends, for people who explore the data on screen.
- **One-pager** (`"format": "onepage"`): one A4 portrait page, printable to PDF, for people who
  read one conclusion. No filters are needed; at most 4 KPIs.

The output is one `.html` file that works offline. The user downloads it and opens it in the
browser; Ctrl+P prints it (A4).

## Workflow

1. **Question and audience.** Which decision the page supports, and who opens it. No answer in
   the request: assume the manager of the area in the data.
2. **Know the data.** `describe_data` on each file (sheets, columns, types, ranges, top values).
   Use `query_data` to test the numbers you plan to show.
3. **Pick 3 to 5 messages** and write them as titles that state the finding ("Sudeste concentra
   45% da receita"), each backed by a `query_data` result.
4. **Spec** in `outputs/<name>.json` (reference below), then `generate_dashboard` with
   `output: outputs/<name>.html`.
5. **Check the result.** Fix every lint warning. Then read the "Computed values" list: every
   title must match its numbers (if the title says "lidera" and the value is second, rewrite the
   title). At most 3 renders.
6. **Answer** with the file name, the 3 to 5 findings in one line each, and how to use the
   filters (dashboard) or print (one-pager).

## Layout

The page is a 4-column grid; `span` sets the width of each item (1 to 4).

- **Top row:** 2 to 4 `kpi` items (span 1), the numbers that answer the question.
- **Then** 2 to 4 `chart` items (span 2 each, or a time series at span 4).
- **Then** at most one `table` (span 4, or 2 next to a `text`), for exact values to look up.
- **`text`:** only for the conclusion or the next step, up to 3 bullets.
- **Sections** (`sections: [{"title", "items"}]`) group items in pages with more than 8 items.
- Item titles state the finding of the whole data; filters change the numbers, not the titles.
  Write titles that stay true for any filter, or name the scope ("No total, ...").

## Spec reference

```json
{
  "title": "Receita cresce 30% em 2026, puxada pelo Sudeste",
  "subtitle": "Vendas por região, produto e canal, jan/2025 a out/2026",
  "author": "FP&A", "date": "Novembro 2026", "source": "ERP, extração de 10/11/2026",
  "format": "dashboard",
  "theme": "executive",
  "data": {"vendas": {"file": "uploads/vendas.xlsx", "sheet": "Vendas"}},
  "filters": [{"field": "Data", "bucket": "year", "label": "Ano"}, {"field": "Região"}],
  "sections": [{"items": [
    {"type": "kpi", "label": "Receita jan-out/2026", "field": "Receita (R$)", "format": "currency",
     "where": {"Data": {"from": "2026-01", "to": "2026-10"}},
     "compare": {"where": {"Data": {"from": "2025-01", "to": "2025-10"}}, "label": "vs jan-out/2025"}},
    {"type": "kpi", "label": "Ticket médio", "field": "Receita (R$)", "agg": "avg", "format": "currency"},
    {"type": "chart", "chart": "line", "title": "Receita mensal sobe desde jan/2026",
     "x": "Data", "x_bucket": "month", "y": "Receita (R$)", "format": "currency", "span": 4},
    {"type": "chart", "chart": "bar", "title": "Sudeste concentra 45% da receita",
     "x": "Região", "y": "Receita (R$)", "format": "currency", "highlight": "Sudeste"},
    {"type": "table", "title": "Enterprise lidera a receita", "group_by": "Produto",
     "columns": ["Produto", {"field": "Receita (R$)", "label": "Receita", "format": "currency"}],
     "sort": {"by": "Receita (R$)"}, "top": 10, "highlight_row": 0, "span": 2},
    {"type": "text", "title": "Próximo passo", "text": "- Levar o canal **Parceiros** ao Nordeste", "span": 2}
  ]}]
}
```

- **`data`:** one entry per table: `{"file": ".xlsx or .csv", "sheet", "header_row"}`. Items use
  the first one unless they set `"data": "<name>"`. Column names match without case or accents.
- **`where`** (any item) and `compare.where` (kpi):
  - a value, or a list of values;
  - on a date column, a period: `"2026"`, `"2026-03"` or `"2026-T1"`;
  - a range: `{"from": "2026-01", "to": "2026-10"}`, also for numbers.
- **`agg`:** `sum` (default for a field), `avg`, `count` (rows, no field needed), `distinct`,
  `min`, `max`.
- **`format`:** `currency` (R$), `percent` (values as fractions: 0.12 = 12%), `integer`,
  `decimal`, `compact` (4,1 mi; default for KPIs).
- **`kpi`:**
  - `label`, `field` + `agg`, optional `where`;
  - `compare` adds the change in %, colored by `good` (`"up"` default, `"down"` for costs);
  - a figure from outside the data goes in `value` (text) with the dashboard `source`.
- **`chart`:**
  - `chart`: `bar` (ranking), `column`, `line`/`area` (time), `pie`/`doughnut` (up to 5
    slices), `stacked_bar`/`stacked_column`;
  - `x` = category or date column (`x_bucket`: `month`, `quarter`, `year` for dates);
  - `y` = a field, or a list `[{"field", "agg", "label"}]` for several series; `series` = a
    column that splits one measure into series (up to 6);
  - `sort`: `desc` (default), `asc` or `x` (time is sorted by `x` already); `top` keeps the N
    largest (`"Outros"` in pies); `highlight` = the category that proves the title.
- **`table`:** `columns` (names or `{"field", "label", "format", "agg"}`), `group_by` to
  aggregate, `sort` `{"by", "desc"}`, `top` (up to 20; 10 on a one-pager), `highlight_row`. Up to 6 columns.
- **`filters`:** a dropdown per column, applied to every item whose data has that column;
  `bucket` for dates; `default` for the initial value.
- **`theme`:** the same themes as decks (the `pptx` skill `reference.md`). Light themes for pages
  that will be printed.

## Lint messages and fixes

| Warning | Fix |
|---|---|
| column "X" not in "data" (columns: ...) | Use a name from the list |
| no rows match "where" | Check values with `query_data`; dates use "2026", "2026-03" or ranges |
| not numeric; use agg "count" | Pick a numeric column, or count rows |
| N slices / N categories | Set `top`, or switch the pie to a sorted `bar` |
| N rows; set "top" / N columns | `top` (up to 20, 10 on a one-pager) with `sort`, or `group_by`; at most 6 columns |
| one-page content is ~N% of an A4 page | Remove the weakest item, lower `top`, or use `"format": "dashboard"` |
| highlight is not a category | Use one of the listed categories |
