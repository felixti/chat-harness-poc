---
name: Assistente
description: Lean, familiar chat for every employee; the answer and the file are the product.
colors:
  bg: "#ffffff"
  bg-side: "#f8f8f7"
  bg-hover: "#efefed"
  bg-active: "#e7e7e4"
  bg-bubble: "#f2f2f0"
  bg-code: "#f6f6f4"
  fg: "#141413"
  fg-2: "#4a4a47"
  fg-3: "#6b6b67"
  line: "#e4e4e1"
  line-strong: "#d3d3cf"
  accent: "#1d5fd1"
  accent-soft: "#e8effc"
  danger: "#b42318"
  ok: "#187a3d"
  send: "#141413"
  send-fg: "#ffffff"
  dark-bg: "#1d1d1c"
  dark-bg-side: "#161615"
  dark-bg-raised: "#262625"
  dark-bg-bubble: "#2c2c2a"
  dark-fg: "#ececea"
  dark-fg-3: "#9a9a95"
  dark-line: "#2f2f2d"
  dark-accent: "#7aa7f5"
typography:
  body:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  welcome:
    fontFamily: "{typography.body.fontFamily}"
    fontSize: "28px"
    fontWeight: 600
    letterSpacing: "-0.02em"
  h2:
    fontSize: "19px"
    fontWeight: 600
    letterSpacing: "-0.015em"
  meta:
    fontSize: "12px"
    fontWeight: 500
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Cascadia Code, JetBrains Mono, Menlo, Consolas, monospace"
    fontSize: "13px"
    lineHeight: 1.55
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  bubble: "18px"
  composer: "26px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  column: "768px"
  sidebar: "264px"
  drawer: "380px"
components:
  composer:
    backgroundColor: "{colors.bg}"
    rounded: "{rounded.composer}"
    padding: "10px 10px 10px 12px"
    width: "{spacing.column}"
  send-button:
    backgroundColor: "{colors.send}"
    textColor: "{colors.send-fg}"
    rounded: "{rounded.pill}"
    size: "36px"
  user-bubble:
    backgroundColor: "{colors.bg-bubble}"
    textColor: "{colors.fg}"
    rounded: "{rounded.bubble}"
    padding: "10px 16px"
  block:
    backgroundColor: "{colors.bg-code}"
    rounded: "{rounded.lg}"
  chip:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg-2}"
    rounded: "{rounded.pill}"
    height: "28px"
  conversation-item-active:
    backgroundColor: "{colors.bg-active}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    height: "36px"
  button-primary:
    backgroundColor: "{colors.send}"
    textColor: "{colors.send-fg}"
    rounded: "{rounded.pill}"
    height: "34px"
---

# Assistente design system

Source of truth: `apps/chat-web/src/styles.css` (tokens on `:root`, dark values under
`prefers-color-scheme: dark`). Product context: [PRODUCT.md](PRODUCT.md). Direction contract:
`.impeccable/surfaces/apps-chat-web-src-app-tsx.md`.

## Overview

The category standard for chat, executed carefully: the user asked for "lean e clean, estilo
ChatGPT", and the craft bar is ChatGPT and Claude.ai on the web. Operate mode, so it aims for
precision, restraint and familiar patterns rather than expression. Light by default (office
laptops in daylight); dark follows the OS.

## Colors

Restrained. Warm neutral grays carry every surface, near-black ink carries text and the primary
action (send), and one blue accent marks links, focus rings, selection and active toggles. Danger
red and success green only carry state. Data visualizations (memory graph legend) may use
categorical colors; chrome never does.

## Typography

One system sans for all UI and prose; mono only for code, language names of code blocks and
technical tool details. Fixed rem scale, tight ratio (15 → 16.5 → 19 → 22px headings in answers,
28px welcome line). Tabular numerals in tables and code.

## Layout

Three columns: 264px sidebar (history, Memória / Meus arquivos / Conectores at the foot), a
centered 768px conversation column, and an on-demand 380px drawer. The composer docks at the
bottom of the column, and on the welcome screen it sits centered above four task starters, at
the same 768px width. Below 860px the sidebar and the drawer become overlays.

## Elevation & Depth

Flat. Borders separate regions. Shadows appear only on floating things: the focused composer,
popovers and menus, dialogs, and the toast (`0 1px 2px` plus a `6–8px / 24–28px` soft blur).

## Shapes

12px radius for cards and blocks, 18px for user bubbles, a 26px pill for the composer, and full
pills for chips, buttons and the round send button. 6–8px for list rows and icon buttons.

## Components

- **Turns:** user turns are right-aligned bubbles; assistant turns are open prose.
- **Tool steps:** a single line collapses all steps. While running it shows a pulsing present-tense
  label; when finished it shows a past-tense summary with the step count, and opens to show each
  step's plain label and its technical detail.
- **Blocks** (code, mermaid, SVG, table, ASCII):
  - Each block has a header with its label and actions: copy, copy image, copy for Excel, download.
  - Diagrams render at natural size and scroll horizontally.
  - Exports always use the light theme.
- **Actions under answers:** shown on hover (always on the last answer and on mobile): copy,
  regenerate, thumbs up and down, and a "Memória usada (n)" chip.
- **Composer:** attach, autosizing textarea, "/" opens the skills menu (pt-BR names), "@" opens the
  user's files menu, and the send button turns into a stop button while a turn runs.
- **Drawer:** tabs for Memória, Arquivos and Conectores. Rows show their actions on hover.

## Do's and Don'ts

- Do keep chrome out of the conversation; new features go into the drawer or a menu.
- Do write UI copy in plain pt-BR verbs; never show raw tool or skill IDs as the primary label.
- Do theme browser surfaces (selection, focus, scrollbars) from the tokens.
- Don't add gradient text, glass, colored side borders, emoji icons or decorative motion.
- Don't shrink diagrams below natural size, and don't render model HTML or SVG as live DOM.
- Don't introduce a second accent or a display face.
