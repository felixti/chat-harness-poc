---
name: xlsx-csv
description: Analyze spreadsheets and tabular data (XLSX, CSV, TSV) - summaries, filters, group-bys, pivots, charts, and cleaned exports. Use when the user uploads a spreadsheet or asks for numbers from tabular data.
---

# Spreadsheets and CSV

## Look before computing

1. CSV/TSV: `bash` with `head -5 file.csv` and `wc -l file.csv` to see columns and size.
2. XLSX: `parse_document` turns every sheet into a markdown table (good for small files and for
   reading). For real computation use `run_code`.

## Compute

With `run_code` (Python sandbox: pandas, openpyxl, matplotlib):

```python
import pandas as pd
df = pd.read_excel("/workspace/uploads/sales.xlsx", sheet_name=None)  # dict of sheets
for name, sheet in df.items():
    print(name, sheet.shape); print(sheet.head())
```

- Print shapes and `head()` first, then the answer. Keep printed output short (`.head(20)`).
- Charts: `matplotlib`, save PNG to `/workspace/outputs/`, mention the file.
- Exports: save a CSV and use `generate_xlsx` (below) for a formatted workbook.

Without `run_code`, small CSVs only: `bash` with `python3` (standard library `csv` module, no pandas)
or `awk`/`sort`/`uniq -c`.

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
- Many rows: write them to a CSV with `bash`/python and use `"rows_csv": "outputs/data.csv"`
  (first line is the header and is skipped) instead of `rows`.
- Formulas: strings starting with `=` in A1 notation. With `title`, the header is row 3 and
  data starts at row 4; without it, header row 1, data from row 2.
- One sheet per table; put a "Resumo" sheet first when there are several.
- Header is frozen and filterable; totals use SUBTOTAL so they follow the filter.
