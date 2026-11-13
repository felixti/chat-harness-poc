---
name: docx
description: Create Word documents (.docx) - reports, memos, proposals, minutes - or read uploaded Word files. Use when the user asks for a Word/DOCX file or an editable document.
---

# Word documents

## Reading

`parse_document` on the `.docx`, then read the markdown (in slices if large).

## Creating

1. Write the content as markdown in `outputs/<name>.md`: `#` for chapters, `##`/`###` for
   sections, pipe tables (align numbers right with `--:`), lists, `>` for callouts. Do not repeat
   the document title as `#` at the top: pass it as `title`.
2. `generate_docx` with `source`, `output: outputs/<name>.docx`, `title`, `subtitle`, `author`,
   `date`; `toc: true` for documents over ~5 pages; `header: "Confidencial"` when relevant;
   `accent` with the brand color (hex) if known.
3. Tell the user the file name. The document uses real Word styles (Heading 1-3, lists), so they
   can keep editing it and refresh the table of contents.

## Style

- Start with a 3 to 5 line summary (the answer first), then the detail.
- Short paragraphs (up to 4 sentences), one idea each. Tables for numbers.
- Read the `design` skill for emphasis and number formatting.
