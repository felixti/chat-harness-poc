# Chat harness PoC: design

Status: agreed 2026-11-12 (grilling session). Owner: platform team.

## 1. Problem

The company's internal chat runs a hand-made ReAct agent (Node/TypeScript): API tools only,
skills fetched by id from a database and pasted into the system prompt. Compared with
ChatGPT, claude.ai or Copilot Chat it cannot discover skills, use MCP servers, work with
files, or run code.

Runtime constraints in the company AKS (Prisma Cloud / Defender):

| Rule | Consequence |
|---|---|
| Container filesystem is read-only, except `/tmp` and PVC mounts | Work files live in `/tmp`; durable files go to Blob |
| No binary downloads | No `pip install` / `npm install` at runtime; everything is baked into images |
| No CLI invocation, even CLIs shipped in the image | No subprocesses at all: no `bash`, `python`, `node`, `chromium` children |
| Pods with HIGH/CRITICAL vulnerable dependencies are killed | Small dependency trees, lockfiles, scan in CI |

Not needed: multi-tenancy (one company, many employees) and durable execution (chat is on
demand; a failed turn is retried by the user).

## 2. Goal

Replace the harness with one that natively supports **skills (progressive disclosure),
MCP, tool calling and a code interpreter**, works with large files, and produces PDF/DOCX/XLSX,
without breaking the Prisma rules. Benchmark two remote-sandbox options for the code
interpreter.

## 3. Decisions

| # | Topic | Decision | Why |
|---|---|---|---|
| H1 | Harness | **Pi 1.5 SDK** (`@earendil-works/pi-coding-agent`, MIT) embedded in a Node API; `SessionManager.inMemory()` per request | Native skills, native MCP (stdio/HTTP, OAuth, `deferred` exposure via `tool_search`), codemode in QuickJS-WASM (no subprocess), small dependency tree. One-day spike against deepagents JS (MIT) on the same scenario before committing. |
| H2 | Rejected | Pi Durable (single writer per SQLite file, not needed); Vercel eve (full server framework with durable "worlds", RC); agent substrate (early development, needs GCS) | Durability and multi-tenancy are not requirements. |
| H3 | Skills | `SKILL.md` folders in a Git repo, published by CI to Blob `/skills/` (read-only); loaded with progressive disclosure. The API's `skills: [ids]` becomes pinned skills | Reviewable by PR; no more database lookup. |
| H4 | Initial skills | `pdf`, `xlsx-csv`, `docx`, `research` (written by us) | Anthropic's document skills are not open source. |
| H5 | MCP | Pi MCP extension, `deferred` exposure; per-session `loadConfig` injects the user's token. Test set: Context7 (app key), own MCP behind Entra (OBO), GitHub (per-user OAuth) | Covers the three credential paths the company has (ServiceNow/Salesforce = per-user OAuth, in-house = Entra OBO). Work IQ is excluded: billed by credits outside Microsoft harnesses. |
| H6 | Tokens at rest | MongoDB **explicit client-side field-level encryption** (`mongodb-client-encryption`, Apache-2.0), data keys in a key-vault collection, wrapped by a 96-byte local master key from a Kubernetes Secret | Key Vault is too bureaucratic in the company. `rewrapManyDataKey` moves to Key Vault later without re-encrypting. Risk: Secret + DB access opens tokens; mitigate with RBAC and rotation. |
| H7 | Database (PoC) | **FerretDB** (Apache-2.0) on the existing CloudNativePG; fallback MongoDB Community if it blocks | MongoDB Community is SSPL (forbidden by the PoC license rule). Encryption is client-side, so the server does not matter. |
| H8 | History | Collection `conversations`; session rebuilt from it each request | In the company this becomes a tool or extension over the existing memory service. |
| H9 | Shell | **just-bash** (Apache-2.0) as the `bash` tool over the conversation workspace; Pi's built-in `bash` disabled | Emulated bash, no subprocess. |
| H10 | Files | Blob container `chat-workspaces`, prefix `<user-oid>/<conversation-id>/`, lifecycle 30 days (account-wide rule, owned by agent-platform-poc); `/tmp/chat/ws/<user>/<conversation>` is a cache restored from Blob when a pod lacks it, changed files uploaded after each turn. Uploads go **through chat-api** (100 MB/file), not direct SAS | Pods stay stateless. Direct browser → Blob SAS was dropped: the account has shared keys disabled and a network allowlist (AKS egress IP only), so browsers cannot reach it. Company: same choice unless the storage is reachable from user networks. |
| H11 | Uploaded documents | Parser service turns a file into markdown, saved next to the original (`/docs/<file>.md`); the agent reads it in slices (`grep`/`read`), never whole into the prompt. Also exposed as tool `parse_document(path, pages, mode)` | Same pattern as large-context assistants. PoC parser: **markitdown** (MIT); company: their parser (markitdown + Cohere + Document Intelligence). Docling is the upgrade path. |
| H12 | Code interpreter | Remote sandbox, one per conversation, created on first use, destroyed after 15 min idle; outputs copied to Blob after each execution; **no internet egress**; image pre-baked with pandas, matplotlib, reportlab, python-docx, openpyxl, pypdf | Same model as ChatGPT/claude.ai (code + skills in a sandbox). |
| H13 | Sandbox options (benchmark) | **A:** Azure Container Apps dynamic sessions (built-in Python code interpreter; custom container only if packages are missing). **B:** agent-sandbox + Kata on AKS (`SandboxWarmPool` + `SandboxClaim`) | A is managed (preview); B is open source and already proven in agent-platform-poc. |
| H14 | PDF/DOCX | Main path: skill + sandbox. Fallback: in-process `generate_pdf` (pdfmake, MIT, markdown → PDF) | Chromium-based HTML→PDF is a subprocess. Fallback works where no sandbox is approved. |
| H15 | LLM | Existing `llm-gateway` (OpenRouter, key injected by Envoy) | Company: their AI gateway; Pi supports Azure OpenAI natively. |
| H16 | Front end | Streaming HTTP API (SSE) like the company chat would call, plus a minimal web page (chat, upload, download), behind Envoy Gateway with Entra OIDC | Company chat is proprietary. |
| H17 | Supply chain | Trivy (Apache-2.0) in CI fails on HIGH/CRITICAL; pinned lockfiles; minimal base images | Company: twistcli with the runtime rules. |
| H18 | Placement | New repo `chat-harness-poc`, same `aks-lab` cluster, Argo CD; existing storage account `stagentpocjt75` | Reuses ingress, Entra, CNPG, Kata pool, llm-gateway. |
| H19 | User identity | Route-level Envoy `SecurityPolicy` on the chat route: OIDC sign-in (same Entra app) with `forwardIDToken` → JWT validation of the Entra ID token (issuer, audience, JWKS) → `oid` claim to header `x-user-oid`. NetworkPolicy: only the public Envoy reaches chat-api | A route-level policy replaces the Gateway one, so it repeats OIDC. chat-api never parses tokens; the header is set by Envoy and cannot be injected from outside. |
| H20 | Base images | chat-api: `distroless/nodejs24-debian13` (debian12 had a CRITICAL + 6 HIGH in libssl3). Parser: Wolfi python 3.13 packages copied into `scratch` (no shell, no apk, no pip) | Debian python3.13/krb5 carry HIGHs without fixes; Chainguard's free python image is 3.15 and onnxruntime (markitdown → magika) has no 3.15 wheel. Both images: 0 HIGH/CRITICAL in Trivy. |
| H21 | History database | FerretDB 2.7 + `postgres-documentdb` in its own StatefulSet (4 GiB disk); password generated in-cluster by an External Secrets `Password` generator | The existing CNPG cluster has no DocumentDB extension. No secret in git or Key Vault. Company: their MongoDB, same driver. |
| H22 | Probes | HTTP/TCP probes only, no `exec` probes | Nothing is executed inside containers (same rule as the agent). |
| H23 | CI | Build → Trivy (pinned by digest, 0.69.3) → push with buildx; push only if the scan is clean | Plain `docker push` tried cross-repo blob mounts that ghcr denied. Trivy 0.69.4–0.69.6 images were compromised in 2026-03. |
| H24 | Office output (pptx/docx/xlsx) | In-process pure-JS writers: `pptxgenjs` 4.0.1, `docx` 9.14.0, `exceljs` 4.4.0 (all MIT) as tools `generate_pptx`/`generate_docx`/`generate_xlsx`. Design quality lives in the renderer (16:9 grid, type scale, 5 themes + brand override, 14 layouts, chart highlight, text fitting) plus lint warnings fed back to the model; skills `pptx` + `design` teach storyline and choices. Overrides `image-size` 2.0.4 and `uuid` 11.1.1 clear 2 HIGH + 2 moderate advisories | OfficeCli (Apache-2.0) is a CLI binary with embedded .NET: needs a binary download and a subprocess, both forbidden. Kept as a candidate for editing existing files inside the phase 3 sandboxes. Anthropic’s pptx skill is not open source, so ours is written from scratch. Editing existing docx/pptx is not covered (xlsx can be re-read with exceljs). |
| H25 | Web research | Brave Search MCP (upstream `@brave/brave-search-mcp-server` 2.1.4, MIT) as its own pod `brave-mcp`: HTTP transport, stateless, only `brave_web_search`, `brave_news_search`, `brave_llm_context` enabled; API key from Key Vault (`brave-search-api-key`) via External Secrets, mounted as a file; only chat-api may call it, it only reaches 443 out. Overrides `@modelcontextprotocol/sdk` 1.32.2 and `zod` 4.6.7 clear 2 HIGH advisories | Key stays out of chat-api; MCP keeps search swappable (company search, Bing) without code changes. The model loads the tools through `tool_search` (deferred). |
| H26 | Deck design upgrades | Lucide icons (ISC, 2,275, vendored as JSON + tags) drawn as native PowerPoint custom geometry (SVG paths, arcs and circles converted to cubics); 8 more palettes adapted from minimax-ai/skills (MIT); layouts `big_number` and `cards`; dark themes keep dark covers; storylines adapted from ui-ux-pro-max-skill (MIT) | pptxgenjs cannot embed SVG from Node (broken PNG fallback) and resvg-wasm is MPL-2.0, so icons are vectors the renderer draws itself: they render in PowerPoint, Keynote, Google Slides and LibreOffice and take theme colors. Model stays `muse-spark-1.3-contributor` (~R$0,10 per deck): quality comes from the harness (renderer, lint, skills, research), not a pricier model. |
| H27 | Deck themes in the skill + visual self-review without a sandbox | Themes are `skills/pptx/themes/*.json` read on every `generate_pptx` call; the spec can also name a workspace theme file or an inline `{extends, ...}` theme. Every pptxgenjs call is recorded and redrawn on a pure-JS canvas (`pureimage` 0.4.20 MIT, `opentype.js` forced to 1.3.4 MIT via overrides; open fonts Carlito + Gelasio, OFL) into one PNG per slide, returned to the model as tool-result images; the same drawing measures real overflow, text collisions and pixel contrast. Model switched to `deepseek/deepseek-v4.1-flash-1017` (vision, US$0.038/M in, 0.50/M out) | The common harness pattern (model writes code, a sandbox renders with LibreOffice, the model looks at images) needs a subprocess, which the company cluster forbids. Rendering our own recorded layout gives the same review loop in process, ~0.1 s per slide. Themes as data let a skill (or the user) add a brand without a code change. Measured checks already caught real defects: low-contrast delta colors in 12 of 13 themes and an unreadable highlighted table row on dark themes. Preview is approximate (charts/tables simplified, open fonts). `muse-spark-1.3-contributor` also accepts images; deepseek was chosen by the user to compare. |
