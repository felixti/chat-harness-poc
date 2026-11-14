# Chat harness: end-to-end architecture

Status: 2026-11-14. Blueprint of what runs today and what is being built (marked **planned**).
Decisions and their reasons live in [design.md](design.md) (H-numbers below); progress in
[plan.md](plan.md).

## 1. Principles

| Principle | What it means in practice |
|---|---|
| Stateless compute | Any chat-api replica serves any request. `/tmp` holds one turn and is wiped after it. (H35) |
| Blob is the source of truth | Workspaces, connector tokens and memory live in Azure Blob; pods keep no durable state. |
| Identity comes only from the gateway | Envoy validates the Entra ID token and sets `x-user-oid`; no tool takes a user or a path outside the turn. |
| Defense in depth for tenants | Per-user Blob prefixes, file tools confined to the turn workspace (H34), per-user AES-GCM sealing (AAD = `oid`) for tokens and memory. |
| Company runtime rules (Prisma) | Read-only rootfs, `/tmp` only, no subprocess, no runtime downloads, images scanned in CI. |
| Open licenses only | Apache-2.0, MIT, BSD; no BSL/SSPL/RSAL. |

## 2. Components

```
                                  Internet
                                     │ HTTPS
                     ┌───────────────▼────────────────┐
                     │ Envoy Gateway "public"         │  Entra ID OIDC login, JWT validation,
                     │ (envoy-gateway-system)         │  oid claim -> x-user-oid header
                     └───────────────┬────────────────┘
                                     │ only path into chat-api (NetworkPolicy)
 ┌───────────────────────────────────▼──────────────────────────────────────────── namespace chat ─┐
 │  chat-api  x2 replicas (Node 24 distroless, Pi 1.5 SDK)                                         │
 │   ├─ web UI (public/index.html): chat, files, connectors panel                                  │
 │   ├─ turn runner: lease -> hydrate -> Pi session -> diff upload -> wipe (H35)                    │
 │   ├─ tools: confined read/write/edit/ls (H34), just-bash (emulated), parse_document,            │
 │   │         generate_pdf, pptx/docx/xlsx, dashboards, describe/query_data, generate_image       │
 │   ├─ MCP client (deferred, tool_search): Context7, Brave, per-user connectors (GitHub)          │
 │   ├─ connectors: OAuth + PKCE, sealed token vault (H33)                                          │
 │   └─ memory: core, episodic search, fact graph, learned skills (H36, planned)                   │
 │                                                                                                 │
 │  parser      document -> markdown (no network at all)                                           │
 │  brave-mcp   web/news search MCP, holds the Brave key, HTTPS out only                           │
 │  ferretdb -> chat-pg   conversation history (Mongo API on Postgres)                             │
 └──────┬──────────────────────────┬─────────────────────────────┬────────────────────────────────┘
        │ HTTP                     │ HTTPS 443                   │ HTTPS 443
        ▼                          ▼                             ▼
 Envoy "llm-gateway"        Azure Blob stagentpocjt75       Remote MCP servers
 injects the OpenRouter     (workload identity, no keys)    Context7, api.githubcopilot.com
 key -> OpenRouter LLMs     ├─ chat-workspaces              (user token in header)
 and image models           ├─ chat-credentials
                            └─ chat-memory (planned)

 Key Vault kv-agentpoc-jt75 ──External Secrets──► k8s Secrets ──projected files──► /var/run/secrets/chat
 GitHub Actions: build, Trivy scan, push to GHCR ──► deploy/*.yaml bump ──► Argo CD sync
```

## 3. One chat turn

```
browser            Envoy            chat-api (any pod)                     Blob / FerretDB / LLM
   │ POST /api/chat  │                    │                                       │
   │────────────────►│ OIDC + JWT          │                                       │
   │                 │──x-user-oid────────►│ acquire lease _locks/<oid>/<conv>     │
   │                 │                    │──────────────────────────────────────►│ 409 if held
   │                 │                    │ wipe /tmp/chat/ws/<oid>/<conv>        │
   │                 │                    │ download <oid>/<conv>/*  ◄────────────│
   │                 │                    │ load history (version n) ◄────────────│ FerretDB
   │                 │                    │ load core memory (planned) ◄──────────│ chat-memory
   │◄──SSE deltas────│◄───────────────────│ Pi loop: model ⇄ tools ⇄ MCP ─────────►│ LLM gateway
   │                 │                    │ upload changed, delete removed ──────►│
   │                 │                    │ save history if still version n ─────►│ else 409
   │◄──done + files──│◄───────────────────│ wipe /tmp, release lease              │
```

Each turn renews its lease every 20 s (60 s lease). A pod that dies mid-turn loses that turn
only; the lease expires and the next turn starts from Blob.

## 4. Storage layout

| Where | Path | Content | Written by |
|---|---|---|---|
| Blob `chat-workspaces` | `<oid>/<conv>/uploads/…`, `outputs/…` | user uploads, generated files | turn diff upload, upload endpoint |
| Blob `chat-workspaces` | `_locks/<oid>/<conv>` | empty blob holding the turn lease | turn runner |
| Blob `chat-credentials` | `<oid>/<connector>.json` | OAuth token, AES-256-GCM, AAD `<oid>/<connector>` | connectors |
| Blob `chat-memory` (planned) | `<oid>/core/USER.md`, `core/MEMORY.md` | core memory, sealed | `memory` tool (ETag) |
| Blob `chat-memory` (planned) | `<oid>/events/<yyyy-mm>.jsonl` | fact events, sealed per line | `remember`, curator (append) |
| Blob `chat-memory` (planned) | `<oid>/graph/snapshot` | derived graph, safe to delete | compactor (lease) |
| Blob `chat-memory` (planned) | `<oid>/skills/<name>/SKILL.md` | learned procedures | `skill_save` (ETag) |
| FerretDB `conversations` | `{_id, user, title, entries, version}` | Pi session entries | turn runner (versioned) |
| Key Vault | `connectors-master-key`, `github-oauth-client-secret`, … | secrets | operator |

## 5. Security layers

| Threat | Control |
|---|---|
| Unauthenticated access | Envoy OIDC + JWT; chat-api reachable only from the public Envoy |
| Spoofed user | `x-user-oid` set by Envoy from the validated token (client value overwritten) |
| Agent reads another user's files or pod secrets | File tools confined to the turn workspace; emulated bash has a virtual FS; secrets are files, not env vars |
| Two turns overwrite each other | Lease per conversation, versioned history |
| Token theft through prompt injection | Tokens never in the workspace; sealed in a separate container; only sent as the MCP header |
| Blob leak | Per-user AES-GCM with AAD; master key only in Key Vault |
| Over-privileged connector | GitHub MCP read-only by default (`X-MCP-Readonly`) |
| Lateral movement | Default-deny NetworkPolicies; parser has no network; Brave key only in brave-mcp |
| Vulnerable dependencies | Pinned versions, Trivy in CI, overrides for advisories |

Not covered yet: process/VM isolation per user (phase 3: ACA dynamic sessions or Kata), turns
that survive a pod restart (queue + resumable stream).

## 6. Memory (H36)

Four layers, inspired by Hermes Agent. The Blob log is the truth; anything in memory of a pod
is derived and disposable.

```
                       ┌──────────────────────────── chat-api (any pod, stateless) ──────────────────────────────┐
  user ──► Envoy ──►   │                                                                                         │
  (oid from JWT)       │  turn start                                                                             │
                       │   ├─► [1] CORE  USER.md + MEMORY.md ──────────────► system prompt (always, ≤ 3 KB)      │
                       │   │                                                                                     │
                       │   └─► Pi agent ──tools──┬─ memory(add|replace|remove)      → [1] core (ETag write)      │
                       │                         ├─ session_search(query)           → [2] episodic               │
                       │                         ├─ remember(subject, rel, object)  → [3] append event           │
                       │                         ├─ recall(entity | question)       → [3] graph query            │
                       │                         └─ skill_save(name, steps)         → [4] procedural             │
                       │                                                                                         │
                       │  [3] Relate (WASM, in process, per turn, only if recall/remember is called)             │
                       │       load snapshot ──► replay newer events ──► typed Cypher (we write it, not the LLM) │
                       │                                                                                         │
                       │  turn end ──► curator (cheap model): extract facts/decisions → events [3], updates [1]  │
                       └──────────┬───────────────────────────┬───────────────────────────┬─────────────────────┘
                                  │ ETag / If-Match           │ append (atomic)           │ read
                                  ▼                           ▼                           ▼
  ┌──────────── Azure Blob: chat-memory/<oid>/  (source of truth, AES-GCM per user) ─────┐   ┌── FerretDB ───────┐
  │ [1] core/USER.md  core/MEMORY.md                                                     │   │ [2] conversations │
  │ [3] events/2026-11.jsonl   (append blob: remember/forget, with source + timestamp)   │   │  entries + text   │
  │     graph/snapshot         (derived; rebuilt by the compactor, safe to delete)       │   │  index → search   │
  │ [4] skills/<name>/SKILL.md                                                           │   └───────────────────┘
  │ _locks/<oid>/compact   (lease: only one compactor per user)                          │
  └──────────────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Holds | Read | Written | Consistency |
|---|---|---|---|---|
| 1 Core | who the user is, preferences, standing facts (≤ 3 KB) | every turn, in the system prompt | `memory` tool, curator | ETag (If-Match), retry on 412 |
| 2 Episodic | past conversations | `session_search` | turn runner (already) | versioned history |
| 3 Facts graph | entities, relations, decisions, with source and time | `recall` | `remember`, curator | append-only events; graph rebuilt from snapshot + events |
| 4 Procedural | procedures that worked | listed like skills | `skill_save` | ETag |

Rules: the model never writes Cypher or paths (typed tools only); every fact keeps its source
(conversation, message) and time; `forget` is an event too, so "what did the agent believe on
date X" stays answerable; the graph engine is replaceable (Relate spike; fallback FerretDB).

Status 2026-11-14: layers 1, 2 and 3 and the curator are implemented (`src/memory.ts`,
`src/graph-memory.ts`, `src/curator.ts`). Layer 4 is next.

Curator: after the answer streams and before `done`, the curator makes one JSON call to
`CURATOR_MODEL` (default: the chat model). Only the **user's message** is a source of facts; the
assistant reply is context, and documents, web pages and tool output are never shown to it.
- Output: at most 2 core entries and 5 facts.
- These go through the same checks as the tools: `checkEntry`, ETag writes, and duplicates
  skipped by key and relation.
- The UI shows a `memória: …` line for what was saved.
- `MEMORY_CURATOR=false` turns it off.
- Cost: about US$0.0003 per turn on deepseek-flash.

Memória panel: core entries (forget each, or clear all). Relations come grouped by subject, each
with a "forget" action that writes a `forget` event, so history is kept. "Ver grafo" opens an SVG
force layout of the newest 100 facts, colored by entity kind. It uses no library; the API is
`GET /api/memory/graph` and `DELETE /api/memory/graph/<factId>`.

Layer 3 implementation notes:
- Engine: Relate native (`@relate/relate` 1.0.1, pinned), not WASM (see [spike-relate.md](spike-relate.md)).
- The JS binding has no `close()`. `graph-memory.ts` calls `relate_database_close` and
  `relate_disconnect` from the C ABI through koffi, which is already a dependency of the
  binding. Without these calls every turn leaked its graph: +140 MB after 60 opens, against +28 MB
  with them.
- Graph model: `(:Entity {key, name, kind})-[:FACT {id, rel, at, src, note, forgotten_at}]->(:Entity)`.
  `key` is `kind:` plus the folded name (no accents, lower case).
- Events: append blob per month, one sealed line per event (one append block, atomic).
- Snapshot: compacted when 50 or more events are not in it yet. Only one compactor runs per user
  (`_locks/<oid>/compact` lease). The pointer `graph/current.json` is written with an ETag, and
  the snapshot files are sealed. If the snapshot is missing or corrupt, the graph is rebuilt from
  the events.
- Tools: `remember(subject, subject_kind, relation, object, object_kind, note)`,
  `recall(about, as_of, limit)` and `forget(fact_id, reason)`. All Cypher is parameterized.

## 7. Scale and cost (PoC)

| Item | Today |
|---|---|
| chat-api | 2 replicas, 100m CPU / 384 Mi requested each, one `platform` node |
| Cluster | aks-lab, ~R$2.16/h when on |
| LLM | deepseek-v4.1-flash via OpenRouter (US$0.038 / 0.50 per M tokens) |
| Images | MiniMax H3 at 1K, ~US$0.021 each |
| Storage | Blob cents/month; 30-day lifecycle on the account |
