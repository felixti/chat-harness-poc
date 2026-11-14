---
name: xlsx-csv
description: Analyze spreadsheets and tabular data (XLSX, CSV) - summaries, filters, group-bys, pivots and formatted exports. Use when the user uploads a spreadsheet or asks for numbers from tabular data.
---

# Spreadsheets and CSV

## Look before computing

1. `describe_data` on the file: sheets, row count, and per column the type, range or top values.
   For a table that does not start at the top, pass `header_row`; for another sheet, `sheet`.
2. Small files can also be read whole: `parse_document` turns every sheet into markdown.

## Compute

- **`query_data`** answers most questions with exact numbers and no code: filter (`where`,
  including periods like `"2026"` or `"2026-03"` and ranges `{"from", "to"}`), group
  (`group_by`, `bucket` month/quarter/year for dates), aggregate (`sum`, `avg`, `count`,
  `distinct`, `min`, `max`), `sort`, `top`. `output_csv` saves the result for `generate_xlsx`.
- **Anything else** (ratios between results, custom logic): `bash` with `python3` (standard
  library only: `csv`, `statistics`, `datetime`; no pandas) on a CSV, for example one saved by
  `query_data`.
- **Charts and dashboards:** the `dashboard` skill. For one chart in a deck, the `pptx` skill.

## Answer

- State the numbers with units and the filter you applied.
- Say how many rows were ignored and why (blank, invalid).

## Creating a workbook

`generate_xlsx` renders a formatted workbook from a JSON spec (`outputs/<name>.json`):

```json
{"currency": "R$", "accent": "#0B3B75", "sheets": [{
  "name": "Lucro por país", "title": "Lucro por país - 2014",
  "columns": [{"header": "País"}, {"header": "Receita", "format": "currency"},
              {"header": "Lucro", "format": "currency"}, {"header": "Margem", "format": "percent"}],
  "rows": [["EUA", 25029830.18, 2995534.62, "=C4/B4"]],
  "totals": true, "data_bars": ["Lucro"]}]}
```

- `format`: `text`, `integer`, `decimal`, `currency`, `percent` (fractions: 0.12 = 12%), `date`
  (ISO `2026-11-13`).
- Many rows: save them as CSV (`query_data` `output_csv`, or `bash`/python) and use `"rows_csv": "outputs/data.csv"`
  (first line is the header and is skipped) instead of `rows`.
- Formulas: strings starting with `=` in A1 notation. With `title`, the header is row 3 and
  data starts at row 4; without it, header row 1, data from row 2.
- One sheet per table; put a "Resumo" sheet first when there are several.
- Header is frozen and filterable; totals use SUBTOTAL so they follow the filter.
