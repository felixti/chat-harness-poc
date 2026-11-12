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
- Exports: `df.to_excel("/workspace/outputs/<name>.xlsx", index=False)`.

Without `run_code`, small CSVs only: `bash` with `python3` (standard library `csv` module, no pandas)
or `awk`/`sort`/`uniq -c`.

## Answer

- State the numbers with units and the filter you applied.
- Say how many rows were ignored and why (blank, invalid).
