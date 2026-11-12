---
name: pdf
description: Create PDF reports and documents, or read and extract content from PDF files. Use when the user asks for a PDF, a report to download, or uploads a PDF to analyze.
---

# PDF

## Reading a PDF

1. `parse_document` on the file (for example `uploads/contract.pdf`). It saves `uploads/contract.pdf.md`.
2. Check the size it reports. Under ~400 lines: `read` it. Bigger: `bash` with `grep -n` for the
   terms you need, then `read` with `offset`/`limit` around the hits. Do not load the whole file.
3. Quote page or section names when you answer.

## Creating a PDF

Preferred, when the `run_code` tool exists (Python sandbox):

1. Write a Python script with `reportlab` (layout, tables) and `matplotlib` (charts).
2. Save to `/workspace/outputs/<name>.pdf` inside the sandbox; the file appears in `outputs/`.
3. Check it: open it with `pypdf` and print the page count.

Fallback, always available:

1. Write the content as markdown in `outputs/<name>.md`: `#` title, `##` sections, tables in pipe
   syntax, bullet lists. No HTML, no images.
2. `generate_pdf` with `source: outputs/<name>.md`, `output: outputs/<name>.pdf`.
3. Tell the user the file name; the chat shows a download link.

## Style

- Title, date and a one-paragraph summary at the top.
- Tables for numbers; at most 6 columns on A4 portrait.
- Write in the user's language.
