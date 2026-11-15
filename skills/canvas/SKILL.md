---
name: canvas
description: Build live interactive pages in the chat's side panel with the canvas tool - calculators, simulators, what-if models, interactive charts, checklists the user ticks, timelines, step-by-step guides, decision trees, multi-step forms, small tools. Use when the user asks for something to play with, fill in, tick or explore on screen, or says canvas, widget, simulador, calculadora, checklist interativo, linha do tempo.
---

# Canvas

A canvas is one HTML fragment the portal runs in a sandboxed panel next to the chat. The user sees
it update live and can switch between versions. Use it for things people **interact with**. Use
the `dashboard` skill for dashboards built from Excel/CSV files, and the document skills for files
to download.

## Workflow

1. **Name and title.** `name` is a slug (`simulador-roi`), `title` is what the user reads, in
   their language.
2. **Create** with `canvas {action: "create", name, title, html}`. One self-contained fragment:
   markup, one `<style>`, one `<script>`. No `<html>`/`<head>`.
3. **Change** with `canvas {action: "edit", name, edits: [{old, new}], note}` for small fixes (each
   `old` must appear exactly once), or `update` to replace the page. Each one is a new version.
4. **When the user says they changed or ticked something** ("atualize o checklist", "use os
   valores que coloquei"), first `canvas {action: "read", name}`: it returns the code and the state
   the page saved.
5. **Reply** in one or two sentences: what the page does and how to use it. Never paste the code
   in the chat.

## What the page has

- **No network.** No `fetch`, no CDN, no external images or fonts (the policy blocks them). Embed
  data in the script. Images: inline SVG or `data:` URLs.
- **Vanilla JS** (modern browsers). No React, no build step.
- **Apache ECharts** as the global `echarts`. Prefer the helper:
  `canvas.chart(element, option)` creates the chart with the theme colors (SVG renderer), resizes
  it with the panel and returns the instance (`chart.setOption(...)` to update).
- **Theme** already applied. CSS variables: `--bg`, `--surface`, `--fg`, `--fg-2`, `--fg-3`,
  `--line`, `--accent`, `--good`, `--bad`, `--radius`. Default styles exist for `body`, `h1`–`h3`,
  `p`, `button`, `button.primary`, `input`, `select`, `textarea`, `label`, `table`, `.card`,
  `.grid` (auto columns), `.row` (flex, wraps), `.muted`, `.big` (large tabular number). Use them
  and keep custom CSS short. `canvas.theme` is `"light"` or `"dark"`; `canvas.colors` is the chart
  palette.
- **State that persists** (checked items, inputs, chosen options):
  - `canvas.state`: the object saved last time (`{}` the first time).
  - `canvas.save(obj)`: replace and persist it (debounced; up to 256 KB of JSON).
  - On load, always render from `canvas.state` so the user's marks come back.
- **Talk back to the chat:** `canvas.send(text)` puts text in the user's message box (the user
  sends it). Use it for a button such as "Pedir ajuste" or "Enviar respostas".

## Craft

- **Start with the answer.** Put the result (total, recommendation, next step) at the top in
  `.big`, and the controls below it.
- **Update everything on `input`.** There is no submit button for calculations.
- **Real labels and units:** `R$`, `%`, `meses`. Format with `toLocaleString("pt-BR")`.
- **Accessibility:** every control has a `<label>`, buttons have text, and color is never the only
  signal.
- **Fit the panel.** It is 420 to 900 px wide: one column under 560 px (`.grid` already does this).
- **Assumptions** go in one `.muted` line under the result, never in a wall of text.

## Example

```html
<div class="card">
  <p class="muted">Retorno em 12 meses</p>
  <div class="big" id="roi">–</div>
  <p class="muted" id="payback"></p>
</div>
<div class="grid">
  <label>Investimento (R$)<input id="inv" type="number" value="50000" min="0"></label>
  <label>Ganho mensal (R$)<input id="gain" type="number" value="6000" min="0"></label>
</div>
<div id="chart" style="height:260px"></div>
<script>
  const s = Object.assign({ inv: 50000, gain: 6000 }, canvas.state);
  inv.value = s.inv; gain.value = s.gain;
  const chart = canvas.chart(document.getElementById("chart"), {});
  function draw() {
    const i = +inv.value, g = +gain.value;
    const months = Array.from({ length: 12 }, (_, m) => g * (m + 1) - i);
    roi.textContent = ((g * 12 - i) / i * 100).toFixed(0) + "%";
    payback.textContent = g > 0 ? `Payback em ${Math.ceil(i / g)} meses` : "Sem payback";
    chart.setOption({ xAxis: { type: "category", data: months.map((_, m) => `M${m + 1}`) }, yAxis: { type: "value" }, series: [{ type: "bar", data: months }] });
    canvas.save({ inv: i, gain: g });
  }
  inv.oninput = gain.oninput = draw;
  draw();
</script>
```
