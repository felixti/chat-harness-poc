# Chat harness: feature architecture

Status: 2026-11-16. This document maps each feature to the parts that implement it.
- Section 1 is the end-to-end system design blueprint.
- Section 2 maps the features onto it.
- Section 3 covers the functional side: what the user gets and how it works.
- Section 4 covers the non-functional side: security, reliability, scale, cost and operations.

Related documents:
- Infrastructure blueprint: [architecture.md](architecture.md).
- Decisions and the reasons behind them: [design.md](design.md). Every `H` number below refers to an entry there.

## 1. System design blueprint (end to end)

```
                                   ┌──────────────────────┐
                                   │  User (browser)      │  portal: React SPA served by chat-api
                                   └──────────┬───────────┘
                                              │ HTTPS  chat.20-121-208-105.sslip.io
                                              ▼
 ┌───────────────┐   OIDC login /    ┌────────────────────────────────────────────────────────────────────────┐
 │  Entra ID     │◄──token refresh───│ Azure Load Balancer (public IP)                                        │
 │  tenant       │   (offline_access)│   ▼                                                                    │
 │  · chat app   │                   │ ┌───────────────────────────── Envoy Gateway "public" ───────────────┐ │
 │    (assigned  │   JWKS            │ │ SecurityPolicy chat-auth: OIDC (cookies) → JWT check (iss, aud)    │ │
 │    users and  │◄──────────────────│ │ oid → x-user-oid · name → x-user-name · fetch w/o session → 401    │ │
 │    guests)    │                   │ └──────────────────────────────┬─────────────────────────────────────┘ │
 │  · connector  │                   │                                │ only ingress allowed (NetworkPolicy)  │
 │    apps (ADO, │                   │  AKS aks-lab (eastus)          ▼                                       │
 │    Microsoft) │                   │ ┌──────────────────────────── namespace chat ────────────────────────┐ │
 └───────▲───────┘                   │ │                                                                    │ │
         │ workload identity         │ │  ┌─────────────── chat-api ×2 (Node 24 distroless) ────────────┐   │ │
         │ (federated token)         │ │  │ HTTP server · AG-UI SSE · REST · static portal              │   │ │
         └───────────────────────────┼─┼──│ turn runner: lease → hydrate /tmp → Pi agent → upload → wipe│   │ │
                                     │ │  │ tools (confined FS, emulated bash, office writers, canvas)  │   │ │
                                     │ │  │ Gate (approvals, loop breaker) · usage ledger · MCP client  │   │ │
                                     │ │  │ connectors vault (AES-GCM) · memory (core/graph/curator)    │   │ │
                                     │ │  │ /tmp emptyDir 4Gi · secrets as files /var/run/secrets/chat  │   │ │
                                     │ │  └───┬──────────┬──────────────┬──────────────┬────────────────┘   │ │
                                     │ │      │HTTP      │HTTP          │Mongo wire    │                    │ │
                                     │ │      ▼          ▼              ▼              │                    │ │
                                     │ │  ┌────────┐ ┌───────────┐ ┌────────────────┐  │  ┌──────────────┐  │ │
                                     │ │  │ parser │ │ brave-mcp │ │ ferretdb       │  │  │ CronJob      │  │ │
                                     │ │  │ md conv│ │ Brave key │ │  └► postgres-  │◄─┼──│ memory-      │  │ │
                                     │ │  │ no net │ │ 443 out   │ │   documentdb   │  │  │ curator 03:00│  │ │
                                     │ │  └────────┘ └─────┬─────┘ │   (PVC 4 GiB)  │  │  └──────┬───────┘  │ │
                                     │ │                   │       │ conversations, │  │         │          │ │
                                     │ │                   │       │ usage, feedback│  │         │          │ │
                                     │ │                   │       └────────────────┘  │         │          │ │
                                     │ └───────────────────┼───────────────────────────┼─────────┼──────────┘ │
                                     │                     │                           ▼         ▼            │
                                     │                     │        ┌────────────── Envoy "llm-gateway" ────┐ │
                                     │                     │        │ injects OpenRouter key (from KV)      │ │
                                     │ ┌─ ESO ───────────┐ │        └──────────────────┬────────────────────┘ │
                                     │ │External Secrets │ │                           │                      │
                                     │ │KV → k8s Secrets │ │  ┌─ Argo CD ───────────┐  │                      │
                                     │ └───────▲─────────┘ │  │ syncs deploy/*.yaml │  │                      │
                                     └─────────┼───────────┼──┴──────────▲──────────┴──┼──────────────────────┘
                                               │           │             │             │ HTTPS
          ┌────────────────────────────────────┘           │             │             ▼
          │                                                ▼             │    ┌──────────────────┐
 ┌────────┴────────┐  ┌─────────────────────────┐  ┌───────────────┐     │    │ OpenRouter       │
 │ Key Vault       │  │ Blob stagentpocjt75      │  │ Brave Search  │     │    │ DeepSeek · Haiku │
 │ kv-agentpoc-jt75│  │ (Entra auth, no keys)   │  │ API           │     │    │ Gemini · MiniMax │
 │ · openrouter    │  │ · chat-workspaces       │  └───────────────┘     │    │ H3 (images)      │
 │ · connectors-   │  │   <oid>/<conv>/uploads, │                        │    └──────────────────┘
 │   master-key    │  │   outputs, work, _locks │  ┌──────────────────────────────────────────────┐
 │ · oauth secrets │  │ · chat-credentials      │  │ Remote MCP / APIs (HTTPS 443 from chat-api)  │
 │ · brave, crawl- │  │   sealed tokens         │  │ · Context7 · CrawlForge (x-api-key)          │
 │   forge keys    │  │ · chat-memory (sealed)  │  │ · GitHub MCP · Azure DevOps MCP (user token) │
 └─────────────────┘  │ · skills/ (from CI)     │  │ · Microsoft Graph (OneDrive / SharePoint)    │
                      └─────────────────────────┘  └──────────────────────────────────────────────┘

 Delivery:  git push ─► GitHub Actions ─► build ─► Trivy (block HIGH/CRITICAL) ─► GHCR
            ─► commit image sha in deploy/*.yaml ─► Argo CD sync ─► rolling update (2 replicas)
            skills/ ─► CI ─► Blob skills/ (read-only for the agent)
```

### 1.1 Request path, step by step

| # | Hop | What happens |
|---|---|---|
| 1 | Browser → Envoy `public` | First visit: OIDC login with Entra. Only users assigned to the chat app, guests included, can sign in |
| 2 | Envoy | Validates the ID token (issuer, audience, JWKS) and sets `x-user-oid`. A portal call without a session gets 401 |
| 3 | chat-api | Takes the Blob lease for the conversation, downloads its files to `/tmp`, and loads history and memory |
| 4 | chat-api → `llm-gateway` → OpenRouter | The model runs. Envoy adds the OpenRouter key, so chat-api never holds it |
| 5 | chat-api → tools | Tools run in process (files, office writers, canvas), on `parser` (documents), on `brave-mcp`, or on remote MCP servers with the user's sealed token |
| 6 | chat-api → browser | AG-UI events stream over SSE: text, tool steps, canvas versions, cost |
| 7 | chat-api → stores | Uploads changed files to Blob, saves the versioned history and the usage row, wipes `/tmp` and releases the lease |
| 8 | Background | The curator updates memory right after the answer; the CronJob catches up at 03:00 UTC |

### 1.2 Trust boundaries

```
 [Internet] ──► (1) Envoy public: authentication ──► (2) chat-api: authorization by oid prefix
                                                         │
             (3) agent sandbox-in-process: confined FS, no subprocess, tokens out of reach
                                                         │
             (4) network: default-deny NetworkPolicies; parser offline; 443 out only
                                                         │
             (5) data: per-user AES-GCM sealing; Key Vault holds every key
```

## 2. Feature map

```
 ┌──────────────────────────────── Portal (React, served by chat-api) ─────────────────────────────────┐
 │ Chat & history │ Model + effort │ Cost chips │ Composer (/skills @files 📎) │ Drawer │ Canvas panel    │
 │ tool steps     │ picker         │ conversa/mês│ OneDrive picker             │ Memória│ live pages      │
 │ approvals card │ theme switch   │ logo        │ ask_user options            │ Arquivos│ versions/state │
 └───────┬──────────────────────────────────────────────────────────────────────────────────┬─────────┘
         │ AG-UI over SSE (POST /api/chat)                         REST (/api/conversations,  │
         ▼                                                          /files, /memory, ...)    ▼
 ┌──────────────────────────────────── chat-api (Pi 1.5 agent, stateless) ─────────────────────────────┐
 │                                                                                                      │
 │  Turn runner ─► Pi session ─► model ⇄ tools                                                          │
 │                                                                                                      │
 │  Built-in tools            Deliverables            Memory               Connectors / MCP             │
 │  ├ read/write/edit/ls      ├ generate_pptx         ├ memory (core)      ├ Brave (web search)         │
 │  ├ bash (emulated)         ├ generate_docx         ├ remember/recall/   ├ Context7 (docs)            │
 │  ├ parse_document          ├ generate_xlsx         │ forget (graph)     ├ CrawlForge (crawl/research)│
 │  ├ describe/query_data     ├ generate_pdf          ├ session_search     ├ GitHub      (per user)     │
 │  ├ my_files/attach_file    ├ generate_dashboard    ├ skill_save         ├ Azure DevOps(per user)     │
 │  ├ canvas                  └ generate_image        └ curator (async)    └ OneDrive    (per user)     │
 │  └ ask_user                                                                                          │
 │                                                                                                      │
 │  Cross-cutting: Gate (approvals + loop breaker) · usage ledger · cross-model history · skills        │
 └──────┬──────────────────┬─────────────────────┬────────────────────┬──────────────────┬──────────────┘
        ▼                  ▼                     ▼                    ▼                  ▼
   LLM gateway        Blob storage           FerretDB             parser             remote MCP
   (OpenRouter)       workspaces/memory/     conversations,       doc → markdown     servers
                      credentials            usage, feedback
```

## 3. Functional architecture

### 3.1 Chat turn and protocol (H35, H45)

Every turn goes through the same path. The wire protocol is AG-UI, so any AG-UI client can drive
the harness, not only our portal.

```
 portal                         chat-api                                  stores / services
   │  RunAgentInput               │                                              │
   │  {threadId, messages,        │                                              │
   │   forwardedProps:{model,     │                                              │
   │   effort, skills, edit},     │                                              │
   │   resume[]}                  │                                              │
   │─────────────────────────────►│ lease _locks/<oid>/<conv> ──────────────────►│ Blob (409 if busy)
   │                              │ hydrate /tmp from Blob ◄─────────────────────│ Blob
   │                              │ load history (version n) ◄───────────────────│ FerretDB
   │                              │ build prompt: core memory + recent           │
   │                              │   summaries + matching facts + skills        │
   │◄── RUN_STARTED ──────────────│                                              │
   │◄── TEXT_MESSAGE_* ───────────│ Pi loop: model ⇄ tools ⇄ MCP ───────────────►│ LLM gateway / MCP
   │◄── TOOL_CALL_* ──────────────│                                              │
   │◄── CUSTOM canvas/usage/ ─────│                                              │
   │    memory_used/files         │                                              │
   │◄── RUN_FINISHED ─────────────│ upload diff, save history (if version n) ───►│ Blob / FerretDB
   │    outcome: success|interrupt│ usage row ──────────────────────────────────►│ FerretDB usage
   │                              │ curator (async, after the answer) ──────────►│ chat-memory
```

| Event | Carries |
|---|---|
| `TEXT_MESSAGE_*` | Streaming answer text |
| `TOOL_CALL_START/ARGS/END/RESULT` | Each tool step, which the portal shows with a pt-BR label |
| `CUSTOM memory_used` / `memory_saved` | The "Memória usada" chip and the `memória: …` line |
| `CUSTOM files` | Files changed in the turn |
| `CUSTOM canvas` | A new canvas version, sent live before it is saved to Blob |
| `CUSTOM usage` | Turn, conversation and month cost |
| `CUSTOM model_error` | A provider failure, explained in plain language |
| `RUN_FINISHED{outcome: interrupt}` | An approval or a question is waiting for the user |

### 3.2 Portal (H41, H49, H50, H53, H55, H59)

```
 ┌ Sidebar ──────────────┐ ┌ Header: [logo/title]  [Conversa: R$ x]  [DeepSeek · Equilibrado ▾] ┐ ┌ Drawer / Canvas ┐
 │ + Nova conversa       │ │                                                                    │ │ Memória         │
 │ 🔍 buscar             │ │  messages: markdown, code, tables (copy to Excel),                 │ │ Arquivos        │
 │ history (rename,      │ │  mermaid/SVG (fit column, zoom), images,                           │ │ Conectores      │
 │  delete, multi-select)│ │  tool steps collapsed ("Lendo kubernetes.io")                      │ │   — or —        │
 │                       │ │  approval card / ask_user options                                  │ │ Canvas panel    │
 │ Gasto em novembro: R$ │ │                                                                    │ │ preview/código  │
 │ Claro│Escuro│Sistema  │ │ ┌ composer: 📎 (computer | OneDrive)  /skills  @files  ■ stop ┐    │ │ versões, baixar │
 │ Atalhos (vim)         │ │ └──────────────────────────────────────────────────────────────┘    │ │                 │
 └───────────────────────┘ └────────────────────────────────────────────────────────────────────┘ └─────────────────┘
```

| Feature | How it works |
|---|---|
| History | `GET/PATCH/DELETE /api/conversations/:id`; bulk delete `POST /api/conversations/delete` (1 to 100 ids) |
| Stop / edit / regenerate | Stop aborts the stream; `edit: true` replaces the last user message |
| Renders | react-markdown + highlight; mermaid lazy-loaded and scaled to the column, with a full-screen view |
| Theme | `:root[data-theme]`, chosen before first paint; mermaid and canvas re-render on change |
| Keyboard | Optional vim mode (`j/k`, `gg/G`, `dd`, `v`), stored per browser |
| Session expiry | Envoy renews the token silently (`offline_access`). API calls get a 401 instead of a redirect, and the portal keeps the conversation and the draft across the login reload |
| Feedback | Thumbs up or down, stored in the `feedback` collection |

### 3.3 Models, reasoning effort and cost (H57, H58)

```
 portal picker ──forwardedProps.model/effort──► chat-api
                                                 │ validate against LLM_MODELS
                                                 │ effort → pi thinking level → OpenRouter reasoning.effort
                                                 │ history from another model → <context> text (crossmodel.ts)
                                                 ▼
                                        LLM gateway ──► OpenRouter
                                                 │ last stream chunk: usage.cost (billed USD)
                                                 ▼
                         usage ledger (FerretDB `usage`): {user, conv, at, usd, tokens, model, images}
                                                 │
                     ┌───────────────────────────┴────────────────────────────┐
                     ▼                                                        ▼
         "Conversa: R$ x" (header)                          "Gasto em <mês>: R$ y" (sidebar)
```

| Model | Role | Relative cost |
|---|---|---|
| DeepSeek V4.1 Flash | Default | 1× |
| Claude Haiku 5.5 | Mid tier | ~5× |
| Gemini 4 Hydrogen | Most capable | ~75× |

The ledger records the amount OpenRouter billed. The price list is used only when a call reports
no cost. Values are shown in BRL at the `USD_BRL` rate set in the deployment. Rows stay in the
ledger when a conversation is deleted, because the money was already spent.

### 3.4 Files and documents (H10, H11, H39, H40, H42)

```
 upload (button, drag, paste) ──► chat-api ──► Blob chat-workspaces/<oid>/<conv>/uploads/
 OneDrive/SharePoint picker  ──► Graph (server-side token) ─┘
                                                     │
                                       parser pod (no network): file → uploads/<f>.md
                                                     │
                     agent reads slices (read/grep/parse_document), never the whole file
                                                     │
            outputs/  deliverables the user asked for  ──► download, "Abrir no Word/Excel online",
            work/     agent support files (hidden)          "Salvar no OneDrive" (Assistente/)
```

| Feature | How it works |
|---|---|
| Workspace | Folders `uploads/`, `outputs/` and `work/` per conversation. Blob is the truth, and `/tmp` holds one turn |
| Large files | The document is turned into markdown once and read in slices |
| Excel questions without a sandbox | `describe_data` profiles the columns; `query_data` filters, groups and aggregates (exceljs) |
| Files across conversations | "Meus arquivos" and `my_files` list them; "Usar" and `attach_file` copy one in. Nothing is mounted automatically |
| Retention | Files are deleted 30 days after the last access, and the panel shows "expira em N d" |

### 3.5 Deliverables (H14, H24, H26 to H32)

All writers run in process as pure JavaScript, with no subprocess and no sandbox.

```
 model ──spec (JSON)──► generate_pptx ──► pptxgenjs ──► .pptx ─┐
                        │  themes (skills/pptx/themes/*.json) │
                        │  styles: classic/editorial/modern/  │
                        │          outline                    │
                        └► recorded calls redrawn on a pure-JS canvas
                             → PNG per slide back to the model (visual self-review)
                             → lint: overflow, collisions, contrast, picture budget
 model ──spec──► generate_docx  (docx)    ──► .docx
 model ──spec──► generate_xlsx  (exceljs) ──► .xlsx
 model ──md────► generate_pdf   (pdfmake) ──► .pdf
 model ──spec + xlsx/csv──► generate_dashboard ──► self-contained .html (ECharts, CSP, filters, print)
 model ──prompt──► generate_image (MiniMax H3 1K, Gemini fallback) ──► covers, section openers
```

### 3.6 Canvas: live interactive pages (H52, H54)

```
 model ── canvas{create|edit|update|read} ──► work/canvas/<name>/v<n>.html + meta.json
                       │ streamed as CUSTOM canvas (live, before the Blob upload)
                       ▼
 portal: fragment + theme CSS + ECharts (bundled) + runtime (canvas.state/save/chart/send)
         ──► <iframe sandbox="allow-scripts" srcdoc>   CSP: no network, opaque origin
                       │ canvas.save(state) ──► PUT .../canvas/<name>/state (≤ 256 KB) ──► state.json
                       │ canvas.send(text)  ──► the user's composer
                       └ page error ──► "Pedir correção"
```

Changes go through `edit` with exact replacements. When a call is missing its arguments, the tool
returns instructions for recovering instead of a bare error.

### 3.7 Skills, clarifying questions and approvals (H3, H46, H47)

```
 skills/ (git) ──CI──► Blob /skills/ ──► Pi progressive disclosure (description in prompt, body on demand)
   canvas · clarify · dashboard · design · docx · pdf · pptx · research · xlsx-csv  + personal my-* (H36)

 ask_user / connector write
          │
          ▼
   Gate (tool_call hook) ── records interrupt {id, reason, tool, args} on the conversation
          │
          ▼
   RUN_FINISHED{outcome: interrupt} ──► portal card: Aprovar / Recusar  (or clickable options)
          │
          ▼
   resume[{interruptId, approved}] ──► chat-api runs exactly the approved call (callMcpTool,
                                       canonical-JSON hash, once) ──► model reports the result
```

### 3.8 Web research and MCP servers (H25, H48, H60)

| Server | Kind | Credential | Exposure |
|---|---|---|---|
| Brave Search | Own pod `brave-mcp` | Brave key, held only in that pod | Deferred (`tool_search`) |
| Context7 | Remote, shared | App key | Deferred |
| CrawlForge | Remote, shared | `x-api-key` from Key Vault | Deferred; 150 s per-call timeout |
| GitHub | Remote, per user | User OAuth token | Direct (declared every turn) |
| Azure DevOps | Remote, per user | User Entra token, refreshed at turn start | Direct |

Two fixes keep MCP tools working across turns:
- Any server the conversation already used is declared directly in later turns.
- A circuit breaker ends loops: more than 15 calls to one tool, more than 5 memory calls, or 4 failures in a row end the turn.

### 3.9 Connectors (H33, H42, H43)

```
 "Conectar" ──► GET /api/connectors/<id>/authorize
                 state = HMAC(oid, connector, nonce, exp 10 min), PKCE S256 derived from state
            ──► provider login (GitHub / Entra) ──► /callback ──► token exchange
            ──► AES-256-GCM seal (AAD = <oid>/<connector>, master key from Key Vault)
            ──► Blob chat-credentials/<oid>/<connector>.json   (agent cannot read it)

 each turn: unseal ──► refresh if < 1 min left ──► MCP header Authorization: Bearer …
 disconnect: delete blob + revoke grant (GitHub)
```

| Connector | Access | Writes |
|---|---|---|
| GitHub | Repos, issues, PRs, code, Actions | Read-only (`X-MCP-Readonly`) |
| Azure DevOps | Work items, repos, pipelines, wiki, test plans | Allowed; each write waits for approval |
| OneDrive / SharePoint | Picker and import; save deliverables to `Assistente/` | Only the user's own drive |

### 3.10 Memory (H36, H37, H44)

```
 every turn  ──► [1] core USER.md + MEMORY.md (≤ 3.5 KB)  ┐
             ──► 5 latest conversations + summaries        ├─► system prompt (~3 KB cap, framed as data)
             ──► [3] graph facts about entities named      ┘
 tools       ──► memory · session_search [2] · remember/recall/forget [3] · skill_save [4]
 after answer──► curator (async, cheap model): ≤ 2 core entries, ≤ 5 facts, 1-2 sentence summary
 03:00 UTC   ──► CronJob memory-curator: conversations not curated in the last 48 h

 Blob chat-memory/<oid>/  (sealed per user, source of truth)
   core/ · events/<yyyy-mm>.jsonl (append) · graph/snapshot (derived) · skills/index.json
```

The Memória panel lists core entries and facts with a forget action, shows a graph view, and lists
personal skills. A forgotten fact is recorded as an event, so the history of what the agent
believed is kept.

## 4. Non-functional architecture

### 4.1 Security

```
 Internet ─► Envoy (OIDC + JWT, oid → x-user-oid) ─► chat-api ─► tools confined to the turn workspace
                │                                       │
                │ NetworkPolicy: only Envoy reaches     │ secrets as files (0440), never env vars
                │ chat-api; default deny elsewhere      │ tokens sealed in a separate container
                ▼                                       ▼
         parser: no network          brave-mcp: holds its key     canvas/dashboards: CSP, sandbox
```

| Threat | Control |
|---|---|
| Unauthenticated access | Entra OIDC at Envoy. The JWT is validated there, and chat-api is reachable only from Envoy |
| Spoofed identity | `x-user-oid` comes from the validated token, and any client value is overwritten |
| Cross-user access | Per-user Blob prefixes. File tools resolve real paths, symlinks included, and the emulated bash has a virtual FS |
| Token theft through prompt injection | Tokens never reach the workspace or the model. They are sealed with AES-GCM in their own container and used only as MCP headers |
| Unwanted writes by the agent | Every write needs an approval tied to the exact arguments (hash) and runs once |
| Hostile generated pages | Canvas and dashboards run in a sandboxed iframe with an opaque origin, and the CSP blocks all network |
| Secret sprawl | Key Vault → External Secrets → projected files. Nothing in git or env vars |
| Lateral movement | Default-deny NetworkPolicies. The parser has no network at all |

### 4.2 Compliance with the company runtime (Prisma Cloud)

| Rule | How the harness complies |
|---|---|
| Read-only root filesystem, `/tmp` only | Each turn runs in `/tmp` (emptyDir, 4 Gi), and Blob is durable |
| No subprocess or CLI | Pi's bash is replaced by just-bash (emulated); all writers and the slide preview are pure JS; `no-subprocess.ts` guards it in code |
| No runtime downloads | Everything is baked into images, including ECharts and fonts; no CDN |
| No HIGH/CRITICAL CVEs | Distroless and scratch images. Trivy in CI blocks the push, and overrides fix advisories |
| Licenses | Only MIT, Apache-2.0, BSD, ISC and OFL. No BSL, SSPL or RSAL. The repository itself is MIT |

### 4.3 Reliability and consistency

| Concern | Design |
|---|---|
| Any pod, any turn | Stateless replicas (2). A turn wipes and rehydrates `/tmp` from Blob |
| Concurrent turns on one conversation | Blob lease per conversation (60 s, renewed every 20 s). A second turn gets 409 |
| Lost updates | History is versioned (conditional replace), and memory writes use ETags |
| Pod dies mid-turn | Only that turn is lost. The lease expires and the next turn starts from Blob |
| Model loops | Circuit breaker in the Gate. If the model wrote nothing, the server adds an explanation |
| Provider errors | `model_error` event with a plain message. The user retries |
| Background memory | Async curator plus a nightly CronJob as the safety net |

Not covered yet:
- A turn that survives a pod restart. This needs a queue and a resumable stream.
- Long jobs over about 2 min, such as CrawlForge async.

### 4.4 Scalability and performance

| Item | Today | Scales by |
|---|---|---|
| chat-api | 2 replicas, 100m CPU / 384 Mi requested, 1.5 Gi limit | More replicas; no affinity needed |
| Prompt size | Memory capped at ~3 KB; MCP tools deferred behind `tool_search` | Already bounded |
| Large documents | Parsed once, read in slices | Independent of file size up to 100 MB |
| Slide preview | ~0.1 s per slide, in process | CPU per replica |
| Long tool calls | MCP timeout of 60 s by default, 150 s for CrawlForge | Async jobs (planned) |

### 4.5 Cost

| Item | Value |
|---|---|
| AKS cluster `aks-lab` | ~R$2.16/h when on; R$137.76 in November up to 2026-11-16 |
| Default model | DeepSeek V4.1 Flash, about US$0.002 to 0.012 per turn in tests |
| Images | MiniMax H3 1K, ~US$0.021 each |
| Storage | Cents per month, with 30-day retention |
| Visibility | Cost per conversation and per month in the portal, from the billed amounts |

The ledger does not count the memory curator's calls.

### 4.6 Privacy (LGPD)

- Data minimization: workspace files expire 30 days after the last access, and old blob versions of credentials and memory are purged after 7 days.
- User control: memory is visible and can be forgotten item by item, connectors can be disconnected (the grant is revoked), and conversations can be deleted with their files.
- Memory only takes facts from the user's own messages. Documents, web pages and tool output are never a source.

### 4.7 Operability

| Area | Today |
|---|---|
| Delivery | GitHub Actions → Trivy → GHCR. A commit bumps `deploy/*.yaml`, and Argo CD syncs it |
| Configuration | Environment variables (12-factor); features switch off when a variable or key is missing |
| Secrets rotation | Update the Key Vault secret. External Secrets syncs it within 1 h, or right away with `force-sync` |
| Probes | HTTP `/healthz` only, no exec probes |
| Logs | Container stdout and a per-turn MCP log |

Gaps:
- No metrics, traces or alerts yet.
- The OpenRouter key expiry is not monitored. It expired on 2026-11-15.

### 4.8 Portability to the company implementation

| PoC piece | Company equivalent |
|---|---|
| OpenRouter via `llm-gateway` | The company AI gateway (Pi supports Azure OpenAI natively) |
| FerretDB | The company MongoDB, with the same driver |
| markitdown parser | The company parser (markitdown + Cohere + Document Intelligence) |
| Personal OneDrive, tenant `/common` | The company tenant, plus `Sites.Read.All` for SharePoint |
| Context (planned) | Microsoft Work IQ API |
| Code interpreter (phase 3) | ACA dynamic sessions or agent-sandbox + Kata |
