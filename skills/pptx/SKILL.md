---
name: pptx
description: Create PowerPoint presentations (.pptx) - executive decks, results reviews, proposals, training, pitch - or read uploaded decks. Use whenever the user asks for slides, a presentation, a deck or a PowerPoint.
---

# PowerPoint decks

You write the story and the content. The `generate_pptx` tool owns positions, sizes and type, so
never try to place things yourself. Read the `design` skill too: it has the rules for theme,
emphasis, chart choice, icons, pictures and words. This skill adds only what is specific to decks.

## Reading a deck

`parse_document` on the `.pptx`, then read the markdown (one section per slide).

## Workflow

1. **Brief.** Know the audience, the message or decision, and the length. No length given: 8 to
   12 slides. Ask at most one question, and only when the goal is unclear.
2. **Facts.** Read the uploads with `parse_document`; compute with `bash` (python3, standard
   library). For a topic without uploads, research it: `tool_search` "brave" loads the web search
   tools; run 3 to 6 searches (`brave_web_search`, `brave_news_search` for recent facts,
   `brave_llm_context` to read the best pages). Write each number with its source and year in
   `outputs/notes.md`. Never invent numbers.
3. **Storyline.** Pick a structure in `storylines.md` (this folder) and write every action title
   as a list. Read only the titles: they must tell the story.
4. **Spec.** Pick a layout per slide (table below) and write `outputs/<name>.json`. Read
   `reference.md` (this folder) before the first spec of the conversation.
5. **Pictures (optional, at most 3 per deck).** For the `title` slide, `section` slides or a `split` slide, call
   `generate_image` with `theme` = the deck theme and a prompt for a calm scene about the topic
   (abstract, landscape, architecture, objects). Look at the image it returns: if it shows text,
   faces or clutter, generate once more with a clearer prompt, or skip it. Then set
   `"background_image": "<path>"` on `title`/`section`, or `"path"` on `split`.
6. **Render:** `generate_pptx` with `spec` and `output: outputs/<name>.pptx`. It returns the lint
   and one preview image per slide.
7. **Review like a designer.** Fix every lint warning ("(measured)" ones come from the drawn
   slide: overflow, collisions, contrast). Then look at each preview:
   - Nothing overlaps or is cut; no text runs into the footer.
   - Squint test: the eye lands first on what proves the title.
   - Balance: no big empty area beside a crowded one; cards and columns look even.
   - Readable from the back of the room: no small text, no wall of text.
   Edit the spec and render again with `preview_slides` set to the slides you changed. At most
   3 renders; then run the final check in the `design` skill.
8. **Answer** with the file name, the slide count and the storyline in 3 to 5 lines. The user
   also gets `outputs/<name>.preview.png` (thumbnails). The preview uses open fonts, so
   PowerPoint looks slightly different.

## Layouts

| Layout | Use for | Limits |
|---|---|---|
| `title` | First slide: the main message as a sentence, scope in the subtitle | always first |
| `agenda` | The parts of the deck | 3 to 6 items; decks over 12 slides only |
| `section` | Divider between parts | decks over 12 slides only |
| `big_number` | One figure that carries the slide: the stakes, the result | at most 2 per deck |
| `kpis` | Headline numbers with deltas and icons, plus one takeaway | 2 to 4 numbers |
| `cards` | Parallel ideas: pillars, features, findings | 2 to 6 items (3 or 4 read best); at most 2 per deck |
| `chart` | One chart plus a takeaway | see `reference.md` |
| `table` | Exact values; highlight the row that matters | up to 10 rows x 6 columns |
| `bullets` | Arguments or findings, optional callout | 3 to 5 bullets; at most a third of the slides |
| `two_column` | Before/after, problem/solution, risks/mitigation | |
| `comparison` | Options side by side; highlight the recommended one | 2 to 4 options |
| `timeline` | Plan, roadmap, history | 3 to 6 steps |
| `statement` | One sentence: the key insight or the recommendation | |
| `numbered` | 2 to 4 priorities, steps or findings led by large numerals | 2 to 4 items |
| `split` | Half-page picture beside a title and short text or bullets | counts in the 3 pictures |
| `quote` | A customer's or leader's own words, with the author | real quotes only |
| `image` | A picture the user gave (photo, screenshot, product) or a generated illustration | never a picture of a chart: use `chart` |
| `closing` | Next steps with owners and dates | always last |

The lint warns when a limit is broken.

## Deck rules

- **Action titles:** each title is a full sentence with the conclusion ("EUA e Canadá geram 45%
  do lucro"), never a topic ("Lucro por país"). Under 90 characters.
- **One message per slide.** Two takeaways means two slides.
- **Show, do not list:** numbers become `kpis` or `chart`, options `comparison`, plans `timeline`.
- **Text budget:** bullets of up to ~15 words. Detail goes to `notes`.
- **Speaker notes** on every slide except `title`, `section` and `closing`: what to say, in 2 to
  4 sentences.
- **Rhythm:** at most 3 slides of the same layout in a row; a light slide (`statement`,
  `big_number`, `quote`, `split`) after every 3 or 4 dense ones.
- **Open and close strong:** `title` with the main message; the stakes early (`big_number` or
  `statement`); `closing` with owners and dates.
- **Bold** with `**...**` works in body text only: `takeaway`, `callout`, card, step and column
  `text`, `big_number` `text`, and the `statement` title. Not in other titles or bullets.
- **`kicker`** (small label above a title) only when it adds information: the section name in
  decks with sections, or the client or event on the `title` slide. Otherwise leave it out.
- **`big_number`:** the `title` continues the number ("é o custo anual..."); never repeat it.
- **`source`:** only the origin ("Zendesk CX Trends 2026"); the footer adds "Fonte:".
- **Language:** the user's language, with correct accents (não, já, três, ação) and number
  formats (pt-BR: 1.234,5). The lint flags text written without accents.
