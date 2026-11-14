# Deck spec reference (`generate_pptx`)

Top level:

```json
{
  "title": "Deck title (file metadata and title slide fallback)",
  "author": "Team or person", "date": "Novembro 2026",
  "theme": "executive",
  "brand": {"accent": "#0B3B75", "accent2": "#0E9384", "headFont": "Aptos Display", "bodyFont": "Aptos", "dark": false},
  "footer": "Confidencial",
  "slides": [ ... ]
}
```

- `theme` (pick by topic and audience; see the `design` skill). Three forms:
  1. A name: one of the files in `themes/` in this skill folder (each has `look` and `good_for`).
  2. An inline theme that starts from one: `{"extends": "insight", "accent": "#7A1F5C"}`.
  3. A theme file in the workspace: `"outputs/brand-theme.json"` (same fields as `themes/*.json`).

| Theme | Look | Good for |
|---|---|---|
| `executive` (default) | navy + teal, white | board, finance, strategy |
| `authority` | charcoal + red, serif titles | annual reports, government, risk |
| `insight` | deep teal + coral/sand chart palette | market analysis, research, data stories |
| `platinum` | black + gold, minimal | premium brands, fintech, luxury |
| `midnight` | dark slate + sky blue | engineering, product, data platforms |
| `tech_night` | near-black + gold/cyan | tech launches, AI, keynotes |
| `coastal` | ocean blue + coral | travel, consumer, customer experience |
| `wellness` | teal + peach, serif titles | health, HR, wellbeing |
| `eco` | forest green + ochre, serif | ESG, agriculture, sustainability |
| `warm` | orange + teal, serif titles | culture, marketing, storytelling |
| `luxury` | ink + bronze on ivory | consulting, hospitality, high-end |
| `mono` | black + one red highlight | design audiences, minimal decks |
| `fresh` | green + blue | people, operations, internal comms |

Theme fields (hex colors): `bg` (slides), `surface` (cards, zebra rows), `ink` (text), `muted`
(secondary text), `accent` (titles bar, highlights, covers), `accent2` (second highlight),
`onAccent` (text on accent), `line` (hairlines), `chart` (3+ series colors), `headFont`,
`bodyFont`, optional `darkCover` (dark themes), `good`/`bad` (delta colors). The renderer checks
contrast (text 4.5:1, muted 3:1) and warns; a custom theme must pass before you answer.

- `brand` overrides the theme: company colors (hex) and fonts. Use it when the user names a brand
  color or uploads a template. `dark: true` switches content slides to a dark background.

Every slide accepts: `layout` (required), `title`, `kicker` (small uppercase label above the
title; when to use it is in the `pptx` skill), `subtitle`, `notes` (speaker notes), `source`
(footer line; "Fonte:" is added).

## Layout fields

```json
{"layout": "title", "title": "O lucro de 2014 está concentrado em dois mercados", "subtitle": "Análise por país, segmento e produto"}
{"layout": "agenda", "title": "Agenda", "items": ["Contexto", "Resultados", "Recomendação"]}
{"layout": "section", "number": 2, "title": "Resultados", "subtitle": "Onde ganhamos dinheiro"}
{"layout": "big_number", "value": "R$ 42 mi",
 "title": "é o custo anual do atendimento que pode ser automatizado",
 "text": "68% dos contatos são **perguntas repetitivas**.", "source": "Base interna, 2026", "dark": false}
{"layout": "cards", "title": "Quatro frentes concentram 80% do ganho",
 "items": [{"icon": "message-square", "title": "Autoatendimento", "text": "Agente responde 2ª via e status 24/7"},
           {"icon": "headset", "title": "Copiloto", "text": "Sugere respostas ao atendente"}]}
{"layout": "kpis", "title": "Receita cresceu 18% com margem estável",
 "items": [{"value": "R$ 118,7 mi", "label": "Receita líquida", "delta": "+18% vs 2013", "trend": "up", "icon": "trending-up"},
           {"value": "14,2%", "label": "Margem", "delta": "-0,4 p.p.", "trend": "down", "good": false}],
 "takeaway": "O crescimento veio de **volume**, não de preço."}
{"layout": "chart", "title": "EUA e Canadá respondem por 45% do lucro",
 "chart": {"type": "bar", "categories": ["EUA", "Canadá", "França"],
           "series": [{"name": "Lucro (R$ mi)", "values": [4.1, 3.5, 3.4]}],
           "number_format": "0.0", "highlight": "EUA", "y_title": "R$ mi"},
 "takeaway": "Focar o time comercial em **EUA e Canadá** protege quase metade do lucro.",
 "source": "ERP, dez/2014"}
{"layout": "table", "title": "Paseo lidera em lucro", "columns": ["Produto", "Receita", "Margem"],
 "rows": [["Paseo", 33.0, "14,5%"], ["VTT", 20.5, "14,6%"]], "highlight_row": 0}
{"layout": "bullets", "title": "Três fatores explicam a queda de margem",
 "bullets": ["Descontos subiram 2 p.p.", {"text": "Mix pior", "sub": ["Enterprise cresceu 30%"]}],
 "callout": "Sem os descontos, a margem teria **subido** 1 p.p."}
{"layout": "two_column", "title": "Riscos e mitigação",
 "left": {"heading": "Riscos", "bullets": ["..."]}, "right": {"heading": "Mitigação", "bullets": ["..."]}}
{"layout": "comparison", "title": "Três caminhos para 2015",
 "options": [{"name": "Manter", "points": ["..."], "verdict": "Baixo risco"},
             {"name": "Focar EUA", "points": ["..."], "verdict": "Recomendado", "highlight": true}]}
{"layout": "timeline", "title": "Plano em quatro etapas",
 "steps": [{"label": "Q1", "title": "Revisar preços", "text": "Teto de desconto", "icon": "tag"}]}
{"layout": "statement", "title": "Recomendação: **focar EUA e Canadá** em 2015", "subtitle": "Protege 45% do lucro", "dark": true}
{"layout": "quote", "quote": "...", "author": "Diretoria Financeira"}
{"layout": "image", "title": "...", "path": "uploads/fabrica.jpg", "caption": "...", "bullets": ["..."]}
{"layout": "closing", "title": "Próximos passos", "bullets": ["Aprovar teto de desconto (Ana, 15/12)"], "subtitle": "Contato: fpa@empresa.com"}
```

`background_image` (`title` and `section` only): a `.png`/`.jpg` from the workspace, usually
made by `generate_image`. It fills the slide under a strong layer of the cover color, so the text
stays readable. On other layouts it is ignored with a warning.

```json
{"layout": "title", "title": "IA generativa no Brasil em 2026", "subtitle": "Onde está o valor", "background_image": "outputs/img/cover.jpg"}
```

## Icons

Lucide icon names (2,275 available, https://lucide.dev/icons). Common ones:

- Business: `briefcase`, `building-2`, `handshake`, `target`, `flag`, `award`, `trophy`, `badge-check`
- Money: `wallet`, `banknote`, `piggy-bank`, `credit-card`, `coins`, `receipt`, `tag`, `percent`
- Growth/data: `trending-up`, `trending-down`, `chart-line`, `chart-bar`, `chart-pie`, `gauge`, `activity`
- People: `users`, `user-check`, `user-plus`, `smile`, `heart-handshake`, `graduation-cap`, `headset`
- Tech: `cpu`, `brain`, `cloud`, `database`, `server`, `code`, `bot`, `sparkles`, `zap`, `workflow`, `layers`
- Risk/ops: `shield-check`, `lock`, `key-round`, `triangle-alert`, `settings`, `wrench`, `clock`, `timer`
- Comms/docs: `mail`, `message-square`, `phone`, `file-text`, `file-search`, `search`, `megaphone`
- World/logistics: `globe`, `map-pin`, `truck`, `plane`, `package`, `shopping-cart`, `store`
- Nature/health: `leaf`, `sun`, `droplet`, `recycle`, `heart-pulse`, `stethoscope`, `pill`
- Ideas/actions: `lightbulb`, `rocket`, `flask-conical`, `puzzle`, `check-circle`, `arrow-right`, `refresh-cw`

## Charts

- `type`: `bar` (horizontal, best for ranked categories and long labels), `column` (vertical,
  few categories or time), `stacked_bar` / `stacked_column` (composition), `line` (time series,
  up to 5 series), `area`, `pie` / `doughnut` (share of a whole, up to 5 slices).
- `values` are numbers, never strings. Same length as `categories`.
- `number_format`: Excel format code for labels and axis: `"#,##0"`, `"0.0"`, `"0%"` (values as
  fractions, 0.12 = 12%), `"\"R$\" #,##0"`.
- `highlight`: category name or index; only for a single series in bar/column. Others turn grey.
- Values are shown on the bars for a single series with up to 12 points; `show_values` overrides.

## Lint messages and fixes

| Warning | Fix |
|---|---|
| title over 90 chars / does not fit | Shorter sentence; move detail to `subtitle` or `notes` |
| more than 5 bullets / bullet over 160 chars | Split the slide or move detail to `notes` |
| text overflows even at the minimum size | Cut text; `bullets` -> `two_column`; split the slide |
| pie with more than 5 slices | `bar` sorted by value, or group the tail as "Outros" |
| more than 5 series | Keep the 2 or 3 that matter, or split into small charts |
| table over 10 rows / 6 columns | Top rows + "Outros"; full data goes to an xlsx (`generate_xlsx`) |
| same layout 4 slides in a row | Change one to another form or add a light slide |
| bullets on over a third of the slides | Numbers -> `kpis`/`chart`, options -> `comparison`, plans -> `timeline` |
| cards or big_number on more than 2 slides | Keep the 2 that matter most; turn the rest into other forms |
| emoji or pictographs in the text | Delete them; use the `icon` field |
| no speaker notes | Add `notes` with what the presenter should say |
| "(measured)" overflow / collision / contrast | Shorten the text or choose a layout with more room; the preview shows where |
