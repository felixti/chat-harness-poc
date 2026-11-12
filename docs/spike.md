# Phase 0 spike: Pi 1.5 SDK (2026-11-12)

Local `chat-api` (Node 26) against the cluster `llm-gateway` (port-forward), model
`meta/muse-spark-1.3-contributor`, with a guard that throws on any `child_process` call
(`src/no-subprocess.ts`, mirrors the Prisma "no CLI" rule).

| Check | Result |
|---|---|
| Skills discovery (progressive disclosure) | Only name + description in the prompt; the model `read`s `SKILL.md` when needed. Catalog limited to `skills/` via `skillsOverride` (a same-named skill in `~/.agents/skills` won a collision locally; containers have no home skills). |
| Pinned skill (old API `skills: [ids]`) | `/skill:research <message>`: the model read the skill first. |
| MCP, deferred | Context7 over streamable HTTP, `exposure: deferred`: `tool_search` → `mcp__context7__resolve_library_id` → `query_docs`; answer cited current Envoy Gateway docs. |
| Emulated shell | just-bash: `mkdir`, `date`, `cat`, `ls`, and `python3` (CPython WASM, stdlib) inside the process. |
| PDF (fallback path) | markdown → `generate_pdf` (pdfmake, standard fonts): 2-page A4 report with tables, accents OK. |
| No subprocess | Guard never fired during the runs; a direct `execSync` is blocked. Pi built-ins that spawn (`grep` → rg, `find` → fd, `bash`) are excluded or replaced. |
| Supply chain | `npm audit --omit=dev`: 0 after overriding `undici` 7.29.0 → 7.30.1 under `just-bash > guarded-fetch`. npm 11 skips install scripts (optional native `node-liblzma`, `@mongodb-js/zstd` not built). |

Found on the way: the platform `llm-gateway` cut streamed answers at 15 s (Envoy default route
timeout); fixed in agent-platform-poc (P31, `timeouts.request: 600s`).

Decision: **Pi 1.5 SDK confirmed** (H1). The deepagents JS comparison was not needed: every
criterion passed with Pi.
