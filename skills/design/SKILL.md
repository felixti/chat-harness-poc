---
name: design
description: Visual design rules for anything the user will look at - slide decks, reports, documents, spreadsheets, charts. Use together with the pptx, docx, pdf or xlsx-csv skills whenever the output is a designed file.
---

# Design

The renderers already apply a grid, a type scale and color themes. Your job is the decisions
they cannot make: what to emphasize, what to cut, which form fits the data.

## 1. Pick a theme or brand

- Company or client named, or a logo/template uploaded: use their colors in `brand.accent`
  (main) and `brand.accent2` (highlight). Ask for the hex only if the user cares about brand.
- Otherwise pick by topic and audience (full table in the `pptx` skill `reference.md`):
  board/finance -> `executive` or `authority`; research and data stories -> `insight`;
  AI/tech keynote -> `tech_night`; engineering -> `midnight`; premium -> `platinum` or `luxury`;
  health/HR -> `wellness`; ESG -> `eco`; consumer/CX -> `coastal`; culture -> `warm`.
- One deck, one theme. Never mix.

## 2. Hierarchy: one thing first

- Each slide or page has one focal point: the number, the highlighted bar, the recommended
  option. Everything else supports it.
- Emphasis budget: one highlight per slide (`highlight` in a chart, `highlight_row` in a table,
  `highlight: true` in a comparison, `**bold**` for 2 to 5 words in a takeaway).
- Color means something: accent = "look here"; grey = context; green/red only for good/bad.

## 3. Choose the form from the data

| You want to show | Use |
|---|---|
| 1 to 4 headline numbers | `kpis` |
| Ranking of categories | horizontal `bar`, sorted, top item highlighted |
| Change over time | `line` (many points) or `column` (up to 8 periods) |
| Part of a whole | `doughnut` up to 5 slices, else `stacked_bar` |
| Exact values to look up | `table` (and the full set in xlsx) |
| Options and trade-offs | `comparison` |
| Sequence or plan | `timeline` |
| One idea that must stick | `statement` |

## 4. Icons, not decoration

- Icons label parallel items (cards, KPIs, steps, options) so the eye finds them fast. Choose
  the literal meaning (`wallet` for cost, `timer` for time, `shield-check` for security).
- Every item in a group gets an icon, or none does. Never an icon alone as ornament.
- No photos or clip art: they age fast, and web images bring copyright risk.

## 5. Less text

- Slide text is for reading in 5 seconds. Cut adjectives, "importante", "vale ressaltar".
- Numbers with units and context: "R$ 4,1 mi (+12% a/a)", not "4100000".
- Round to what matters: 2 to 3 significant digits on slides; exact values in tables or xlsx.
- Parallel phrasing in lists (all start with a verb, or all are nouns).

## 6. Rhythm and white space

- Alternate dense and light slides: chart -> statement -> table -> kpis -> big_number.
- At least one "breathing" slide (big_number, statement or quote) every 4 to 5 slides.
- Empty space is fine. Never fill it with decoration, icons or clip art.
- Section dividers only in decks over 12 slides.

## 7. Final check before you answer

1. Read only the titles: do they tell the story?
2. Every number has a unit and a source.
3. Every slide has one obvious focal point.
4. The lint said "clean", or you can justify each remaining warning.
