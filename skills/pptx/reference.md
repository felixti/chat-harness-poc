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

- `theme`: `executive` (navy/teal, default), `midnight` (dark, tech), `warm` (serif titles, orange),
  `mono` (black + one red highlight, minimal), `fresh` (green/blue, sustainability, HR).
- `brand` overrides the theme: company colors (hex) and fonts. Use it when the user names a brand
  color or uploads a template. `dark: true` switches content slides to a dark background.

Every slide accepts: `layout` (required), `title`, `kicker` (small uppercase label above the
title, e.g. the section name), `subtitle`, `notes` (speaker notes), `source` (footer line,
"Fonte: ..." is added).

## Layout fields

```json
{"layout": "title", "title": "O lucro de 2014 está concentrado em dois mercados", "subtitle": "Análise por país, segmento e produto"}
{"layout": "agenda", "title": "Agenda", "items": ["Contexto", "Resultados", "Recomendação"]}
{"layout": "section", "number": 2, "title": "Resultados", "subtitle": "Onde ganhamos dinheiro"}
{"layout": "kpis", "title": "Receita cresceu 18% com margem estável",
 "items": [{"value": "R$ 118,7 mi", "label": "Receita líquida", "delta": "+18% vs 2013", "trend": "up"},
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
 "steps": [{"label": "Q1", "title": "Revisar preços", "text": "Teto de desconto"}]}
{"layout": "statement", "title": "Recomendação: **focar EUA e Canadá** em 2015", "subtitle": "Protege 45% do lucro", "dark": true}
{"layout": "quote", "quote": "...", "author": "Diretoria Financeira"}
{"layout": "image", "title": "...", "path": "outputs/chart.png", "caption": "...", "bullets": ["..."]}
{"layout": "closing", "title": "Próximos passos", "bullets": ["Aprovar teto de desconto (Ana, 15/12)"], "subtitle": "Contato: fpa@empresa.com"}
```

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
| title over ~90 chars / does not fit | Shorter sentence; move detail to `subtitle` or notes |
| more than 6 bullets / bullet over 160 chars | Split the slide or move detail to `notes` |
| text overflows even at the minimum size | Cut text; `bullets` -> `two_column`; split slide |
| pie with more than 6 slices | `bar` sorted by value, or group the tail as "Outros" |
| more than 5 series | Keep the 2 or 3 that matter, or split into small charts |
| table over 10 rows | Top rows + "Outros"; full data goes to an xlsx (`generate_xlsx`) |
| no speaker notes | Add `notes` with what the presenter should say |
