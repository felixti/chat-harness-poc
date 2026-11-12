---
name: docx
description: Create Word documents (.docx) - reports, memos, proposals, minutes - or read uploaded Word files. Use when the user asks for a Word/DOCX file or an editable document.
---

# Word documents

## Reading

`parse_document` on the `.docx`, then read the markdown (in slices if large).

## Creating

With `run_code` (Python sandbox, `python-docx`):

```python
from docx import Document
from docx.shared import Pt
doc = Document()
doc.add_heading("Title", level=0)
doc.add_paragraph("Summary paragraph.")
table = doc.add_table(rows=1, cols=3, style="Light List Accent 1")
for cell, text in zip(table.rows[0].cells, ["Item", "Qty", "Total"]):
    cell.text = text
doc.save("/workspace/outputs/report.docx")
```

- One heading per section, short paragraphs, tables for numbers.
- Save under `/workspace/outputs/`; tell the user the file name.

Without `run_code`: say that editable Word files need the code sandbox, and offer a PDF instead
(skill `pdf`, fallback path).
