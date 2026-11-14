---
name: design
description: Visual design rules for anything the user will look at - slide decks, dashboards, one-pagers, Word reports, PDFs, spreadsheets, charts. Read it together with the pptx, dashboard, docx, pdf or xlsx-csv skill whenever the output is a designed file.
---

# Design

The renderers own the grid, type scale, spacing and contrast. You own what they cannot decide:
what to emphasize, what to cut, which form fits the data. These rules apply to every output;
rules only for decks live in the `pptx` skill.

## 1. Theme and color

- **Brand colors only when known for sure:** the user gave the hex, or it is in an uploaded file
  or template. Decks: `brand.accent` and `brand.accent2`; Word: `accent`. Never guess a
  company's hex; use the closest theme instead.
- **Sober or modern comes from the audience.** Board, finance, legal, consulting, reports: sober
  (`editorial` style: `ivory`, `graphite`, `forest`; or the `classic` `executive`). Product,
  tech, marketing, launches, internal events: modern (`aurora`, `sunset`, `tech_night`,
  `midnight`, `volt`). Engineering and developer audiences, or "estilo GitHub": `repo_dark`,
  `repo_light`. The user's words ("sóbrio", "moderno", "tech", "elegante") win.
- **Light or dark comes from where it will be seen.** Lit meeting room, shared PDF or print:
  light. Stage, keynote, dark room: dark. Table of themes in the `pptx` skill `reference.md`.
- **No theme fits:** write an inline theme `{"extends": "<closest>", "accent": "#..."}` (fields
  in `reference.md`). The renderer checks contrast; fix every contrast warning.
- **One theme per file.**

## 2. One focal point

- Every slide, page and chart has one thing the eye lands on first: the number, the highlighted
  bar, the recommended option. Squint test: blur your eyes on the preview; the focal point is
  still what you see first.
- **Emphasis budget per slide:** one highlight (chart `highlight`, table `highlight_row`,
  comparison `highlight`) plus at most 2 to 5 words in `**bold**`. If everything stands out,
  nothing does.
- **Color has a job:** accent = look here; grey = context; good/bad colors only for better and
  worse. Never color as decoration.

## 3. Form follows the data

Names are deck layouts; dashboards use `kpi` items and the same chart types.

| You want to show | Use |
|---|---|
| 2 to 4 headline numbers | `kpis` |
| One number that carries the slide | `big_number` |
| Ranking of categories | horizontal `bar`, sorted, top item highlighted |
| Change over time | `line` (many points) or `column` (up to 8 periods) |
| Part of a whole | `doughnut` up to 5 slices; more: sorted `bar` |
| Exact values to look up | `table` up to 6 columns and 10 rows (20 in a dashboard); the full set in xlsx |
| Options and trade-offs | `comparison` |
| Sequence or plan | `timeline` |
| One idea that must stick | `statement` |

## 4. Icons and pictures

- **Icons** (the `icon` field, Lucide) label parallel items so the eye finds them. Use the
  literal meaning (`wallet` for cost, `timer` for time). Every item in a group gets an icon, or
  none does.
- **Never emoji or Unicode symbols** (✅ 🚀 ★) as icons or bullets: they render differently on
  every machine. The lint flags them.
- **Pictures:** only the user's own files, or `generate_image` for the `title`, `section` and
  `split` slides of a deck, at most 3 (rules in the `pptx` skill). Never images from the web (copyright), clip art, or generated
  charts, numbers, logos, text or people.

## 5. Words

- **Specific beats generic.** Name the market, the product, the number. Swap test: if you can
  replace the company or topic and the sentence still works, it says nothing; rewrite it with
  the facts.
- **Cut filler:** adjectives, "importante", "vale ressaltar", "é fundamental".
- **Numbers with unit and context:** "R$ 4,1 mi (+12% a/a)", not "4100000". Two or three
  significant digits on slides; exact values in tables and xlsx.
- **Parallel lists:** every item starts with a verb, or every item is a noun.
- **Plain language:** define unavoidable jargon once.

## 6. Space

- **About four per group** (cards, KPIs, options, steps): people hold about four things at once.
- **White space is a feature.** Never fill it with icons, shapes or pictures.

## 7. What makes a file look generated

Avoid these defaults. When you spot one, rewrite the element; do not soften it.

- Topic titles ("Visão geral do mercado") instead of the finding.
- Generic labels above titles ("Contexto", "Insights") that add no information.
- Icon cards as the container for everything.
- Every element the same weight, so there is no focal point.
- Emoji, sparkles and decorative pictures.
- Round numbers without a source, which read as invented.

Adapted from pbakaus/impeccable (Apache-2.0).

## 8. Final check before you answer

1. Read only the titles: they tell the whole story.
2. Every number has a unit and a source.
3. Every slide or page passes the squint test.
4. The lint is clean. If a warning remains when the render budget is spent, tell the user which
   one and why.
