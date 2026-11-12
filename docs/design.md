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
| H10 | Files | Blob container `chat-workspaces`, prefix `<user-oid>/<conversation-id>/`, lifecycle 30 days; `/tmp/<conversation>` as working copy during a request; uploads go **directly** browser → Blob with a short SAS, 100 MB/file to start | Pods stay stateless; uploads never pass through the agent. |
| H11 | Uploaded documents | Parser service turns a file into markdown, saved next to the original (`/docs/<file>.md`); the agent reads it in slices (`grep`/`read`), never whole into the prompt. Also exposed as tool `parse_document(path, pages, mode)` | Same pattern as large-context assistants. PoC parser: **markitdown** (MIT); company: their parser (markitdown + Cohere + Document Intelligence). Docling is the upgrade path. |
| H12 | Code interpreter | Remote sandbox, one per conversation, created on first use, destroyed after 15 min idle; outputs copied to Blob after each execution; **no internet egress**; image pre-baked with pandas, matplotlib, reportlab, python-docx, openpyxl, pypdf | Same model as ChatGPT/claude.ai (code + skills in a sandbox). |
| H13 | Sandbox options (benchmark) | **A:** Azure Container Apps dynamic sessions (built-in Python code interpreter; custom container only if packages are missing). **B:** agent-sandbox + Kata on AKS (`SandboxWarmPool` + `SandboxClaim`) | A is managed (preview); B is open source and already proven in agent-platform-poc. |
| H14 | PDF/DOCX | Main path: skill + sandbox. Fallback: in-process `generate_pdf` (pdfmake, MIT, markdown → PDF) | Chromium-based HTML→PDF is a subprocess. Fallback works where no sandbox is approved. |
| H15 | LLM | Existing `llm-gateway` (OpenRouter, key injected by Envoy) | Company: their AI gateway; Pi supports Azure OpenAI natively. |
| H16 | Front end | Streaming HTTP API (SSE) like the company chat would call, plus a minimal web page (chat, upload, download), behind Envoy Gateway with Entra OIDC | Company chat is proprietary. |
| H17 | Supply chain | Trivy (Apache-2.0) in CI fails on HIGH/CRITICAL; pinned lockfiles; minimal base images | Company: twistcli with the runtime rules. |
| H18 | Placement | New repo `chat-harness-poc`, same `aks-lab` cluster, Argo CD; existing storage account `stagentpocjt75` | Reuses ingress, Entra, CNPG, Kata pool, llm-gateway. |

## 4. Architecture

```
browser ──OIDC──► Envoy Gateway ──► chat-api (Node, Pi SDK, stateless, N replicas)
   │                                   │  skills  ◄── Blob /skills/ (CI publishes from Git)
   │ SAS upload                        │  files   ◄─► Blob chat-workspaces/<oid>/<conv>/  (+ /tmp copy)
   ▼                                   │  history ◄─► FerretDB (CNPG) conversations, encrypted tokens
 Blob ──► parser (markitdown) ──md──►  │  LLM     ──► llm-gateway ──► OpenRouter
                                       │  MCP     ──► Context7 | own MCP (Entra OBO) | GitHub (OAuth)
                                       │  bash    = just-bash (in process)
                                       └─ code    ──► sandbox A: ACA dynamic sessions
                                                      sandbox B: agent-sandbox + Kata (no egress)
```

## 5. Benchmark A vs B

| Metric | How |
|---|---|
| Ready time | First `run` on a new conversation: cold and warm (pool) |
| Execution latency | Same pandas script (100k rows groupby + chart) |
| Document generation | 20-page PDF with tables and charts |
| Cost | R$/h idle and in use |
| Isolation | Egress blocked? IMDS reachable? Other conversations' files reachable? |
| Operations | Moving parts, upgrades, failure modes |
| Prisma visibility | What runtime defense sees in each (in B the microVM is opaque to node agents) |

## 6. Open risks

- Pi 1.5 SDK API changes between minor releases: pin versions.
- just-bash is beta: keep it to file operations; real work runs in the sandbox.
- ACA dynamic sessions is in preview and custom containers need Dedicated E16 compute (expensive).
- FerretDB compatibility with the driver's explicit encryption: verified in phase 1.
