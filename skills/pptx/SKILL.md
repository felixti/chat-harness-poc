---
name: pptx
description: Create PowerPoint presentations (.pptx) - executive decks, results reviews, proposals, training, pitch - or read uploaded decks. Use whenever the user asks for slides, a presentation, a deck or a PowerPoint.
---

# PowerPoint decks

You write the story and the content. The `generate_pptx` tool owns the visual design (grid, type
scale, themes, charts), so never try to position things yourself. Also read the `design` skill.

## Reading a deck

`parse_document` on the `.pptx`, then read the markdown (one section per slide).

## Workflow

1. **Brief.** Know the audience, the decision or message, and the length. If the user gave no
   length: 8 to 12 slides. Ask at most one question, only when the goal is unclear.
2. **Get the facts.** Read the uploads (`parse_document`), compute numbers with `bash`/python.
   Never invent numbers; put the origin in `source`.
3. **Storyline first.** Write the action titles of every slide as a list, one line each. Read only
   the titles: they must tell the whole story (situation -> insight -> recommendation -> next steps).
4. **Pick a layout per slide** (table below) and write the spec to `outputs/<name>.json`.
   Full field reference with examples: `reference.md` in this skill folder. Read it before the
   first spec of the conversation.
5. **Render:** `generate_pptx` with `spec: outputs/<name>.json`, `output: outputs/<name>.pptx`.
6. **Fix every lint warning** by editing the spec (cut text, split slides, change layout), then
   render again. Repeat until "Design lint: clean" or only deliberate warnings remain.
7. Answer with the file name, the slide count and the storyline in 3 to 5 lines.

## Layouts

| Layout | Use for |
|---|---|
| `title` | First slide: the deck's main message as a sentence, subtitle with scope |
| `agenda` | 3 to 6 parts, only for decks over 10 slides |
| `section` | Divider between parts of a long deck |
| `kpis` | 2 to 4 headline numbers with deltas, plus one takeaway |
| `chart` | One chart + takeaway callout. bar, column, stacked_*, line, area, pie, doughnut |
| `table` | Exact values, up to ~8 rows x 6 columns; highlight the row that matters |
| `bullets` | Arguments or findings, 3 to 5 bullets, optional callout |
| `two_column` | Before/after, problem/solution, risks/mitigation |
| `comparison` | 2 to 4 options side by side; highlight the recommended one |
| `timeline` | Plan, roadmap, history: 3 to 6 steps |
| `statement` | One big sentence: the key insight or the recommendation |
| `quote` | Customer or leadership voice |
| `image` | A chart image or picture from the workspace, optional bullets |
| `closing` | Next steps with owners and dates |

## Rules that make decks good

- **Action titles**: every title is a full sentence with the conclusion ("EUA e Canadá geram 45%
  do lucro"), never a topic ("Lucro por país"). Under ~90 characters.
- **One message per slide.** If a slide needs two takeaways, it is two slides.
- **Show, do not list**: numbers become `kpis` or a `chart`; options become `comparison`; plans
  become `timeline`. Use `bullets` for at most a third of the slides.
- **Charts**: one series + `highlight` on the category that proves the title. Sort bars by
  value. Pie/doughnut only for parts of a whole with up to 5 slices. Lines for time.
- **Text budget**: bullets up to ~15 words, at most 5 per slide. Details go to `notes`.
- **Speaker notes on every content slide**: what to say, in 2 to 4 sentences.
- **Vary the rhythm**: do not use the same layout three slides in a row.
- Bold inside text with `**...**` (only in takeaway, callout, statement, paragraphs).
- Write in the user's language, including dates and number formats (pt-BR: 1.234,5).
