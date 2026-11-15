---
version: 1
slug: "apps-chat-web-src-app-tsx"
primary_target: "apps/chat-web/src/App.tsx"
related_targets: ["apps/chat-web/src/styles.css"]
---

# Surface: chat portal (apps/chat-web)

Mode: Operate. Audience: all employees, mostly non-technical, desktop first, pt-BR.
Task: ask, attach files, get answers and deliverables; revisit conversations; see and control memory, files and connectors.
Constraints: served by chat-api, no CDN at runtime; model output untrusted (PoC level: no raw HTML, SVG as image, HTML deliverables in sandboxed iframe).

## Direction contract

THESIS: The answer and the file are the product; the chat chrome disappears. Refuses dashboards-around-a-chat: no permanent side panels, settings walls or feature tiles competing with the conversation.

OWN-WORLD: Neutral warm-gray surfaces (#fff / #f8f8f7 sidebar), near-black ink, one blue accent only for links, focus and selection; system UI type, mono only for code; 12px radii, pill composer, user turns in soft bubbles, assistant turns as open prose; light by default, OS dark mode.

STORY: The visitor recognizes a familiar chat, asks in plain Portuguese, watches plain-language steps while the assistant works, and leaves with a copyable answer or a downloadable file; memory and files are visible and removable on demand.

FIRST VIEWPORT: Left 264px sidebar (brand, new chat, search, dated history, Memória / Meus arquivos / Conectores at the foot). Center: "Como posso ajudar?" above a 768px pill composer (attach, textarea with / skills and @ files, round send) and four task starters. In a conversation the composer docks at the bottom of a 768px column.

FORM: The category standard (ChatGPT/Claude.ai web chat), pinned by the user. seed: none (pinned) — "uma lean e clean seriam legais, gosto bastante do estilo do chatgpt". Signature interaction: collapsed tool steps that read as plain-language progress and expand to technical detail; renders (mermaid, SVG, tables, ASCII) carry copy-as-image / copy-for-Excel actions.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
