# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React + Vite (TypeScript) for the chat portal, built into the chat-api image and served by it
(no CDN at runtime). Chosen by the user over Preact for ecosystem and team familiarity.
Backend: Node chat-api (Pi agent harness) with SSE streaming. Libraries must be open source with
permissive licenses (MIT, Apache-2.0, BSD, ISC); no BSL/SSPL/RSAL.

## Users

All company employees, mostly non-technical (sales, finance, HR, marketing, operations), plus a
technical minority (engineering, data). They use the assistant during the workday to produce and
understand work material. Desktop first (work laptop); phone must work but is not the priority.
Interface language: Brazilian Portuguese.

## Product Purpose

An internal assistant ("Assistente") that replaces the company's previous ReAct chat. It answers
questions and produces real deliverables: slide decks (pptx), Word documents, spreadsheets,
HTML dashboards and one-pagers, PDFs, images for slides; reads uploaded files (PDF, Excel, Word,
PowerPoint); searches the web; works with connected tools (GitHub first) through MCP; and
remembers the user across conversations. Success: employees get a usable file or a correct,
short answer without knowing prompts, tools or skills.

## Positioning

Runs inside the company's own cluster under its security rules (read-only containers, no
subprocesses), with company skills, fixed document layouts and themes, per-user memory the user
can see and edit, and connectors acting as the signed-in user.

## Operating Context

- One conversation = one workspace: `uploads/` (user files), `outputs/` (deliverables), `work/`
  (agent support files, hidden).
- Turns stream over SSE: text deltas, tool calls (start/end), a curator "memory saved" event,
  and `done` with the deliverable list.
- Side features: conversation history; "Meus arquivos" (files from other conversations, 30-day
  retention after last access, attach or remove); Memória (core entries, relations graph,
  personal procedures `my-*`); Conectores (OAuth, e.g. GitHub, read-only by default).
- Company skills (pptx, docx, pdf, xlsx-csv, dashboard, design, research) can be pinned.

## Capabilities and Constraints

- Answers contain markdown, tables, code, mermaid, SVG, ASCII diagrams and image references; all
  must render and be copyable.
- Model output is untrusted content (it can echo web pages). PoC level: no raw HTML execution,
  SVG shown as image, HTML deliverables only in a sandboxed frame. Stricter hardening (CSP,
  sanitizer) is deferred to the company rollout.
- One turn per conversation at a time (a second tab gets "conversa ocupada").
- Identity comes from the company SSO at the gateway; the portal has no login screen of its own.

## Brand Commitments

Name shown to users: "Assistente" (neutral until the company picks an internal brand). Tone:
direct, short, no hype, pt-BR. Standing preference (user, 2026-11-14): "uma lean e clean seriam
legais, gosto bastante do estilo do chatgpt" — the familiar chat convention executed at full
fidelity; craft bar: ChatGPT and Claude.ai web apps.

## Evidence on Hand

No logos, brand palette or user research yet. Real flows proven in the PoC cluster (decks,
dashboards, memory, connectors) can be used as examples; do not invent metrics or testimonials.

## Product Principles

1. The answer and the file are the product; chrome stays out of the way.
2. Show what the assistant is doing in plain words; technical detail only on demand.
3. The user controls their data: memory, files and connectors are visible, editable, removable.
4. Familiar chat patterns over novelty: people should know how to use it on first sight.
5. Everything the assistant produces can be copied or downloaded in one action.

## Accessibility & Inclusion

Broad non-technical audience: readable type sizes, keyboard use (Enter, Shift+Enter, Esc to
stop), visible focus, sufficient contrast in light and dark, respect for reduced motion.
