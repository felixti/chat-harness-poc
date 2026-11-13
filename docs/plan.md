# Chat harness PoC: plan

Prices: Azure retail API, eastus, 2026-11-12, USD-BRL 5.58. Every `tofu apply` is approved
separately with its cost.

| Phase | What | Time | Infra cost |
|---|---|---|---|
| 0. Spike | Laptop only: Pi 1.5 SDK vs deepagents JS, same scenario (pinned skill + discovered skill, Context7 MCP, read a 50-page PDF via markdown slices, `generate_pdf` fallback). Pick the harness. | 1 day | R$0 (LLM tokens: cents) |
| 1. Core | Repo, CI (build + Trivy), chat-api (Pi SDK, SSE, just-bash, Blob workspace, history), FerretDB on CNPG, markitdown parser, Blob container + lifecycle + SAS upload, minimal web page, Entra app + HTTPRoute | 1.5 days | ~R$0.66/h while the cluster runs (likely a 2nd `platform` node; the first is at 97 % CPU requests). Storage, Entra: ~R$0 |
| 2. MCP + tokens | Own MCP (Entra OBO), GitHub OAuth App + per-user connect flow, token encryption (explicit FLE, local master key), 4 skills in `skills/` published to Blob | 1 day | R$0 (small pod on the same node) |
| 3A. Sandbox A | ACA dynamic sessions, built-in Python code interpreter pool, egress off, managed identity → Session Executor role; `run_code` tool + file sync | 0.5 day | R$0.17 per session-hour (USD 0.03). Custom container pool avoided: Dedicated E16 ≈ R$9/h |
| 3B. Sandbox B | agent-sandbox `SandboxTemplate` + `SandboxWarmPool` (size 1) on the Kata pool, default-deny egress, same `run_code` tool | 1 day | R$0.13 (Spot) to R$0.61 (on-demand) per hour while the warm sandbox exists |
| 4. Benchmark | 7 metrics of design §5, report in `docs/benchmark.md` | 0.5 day | Within 3A/3B |

Manual steps for the user (Claude stops and gives exact steps):

1. Phase 1: approve the Entra app registration / consent if the CLI asks.
2. Phase 2: create the GitHub OAuth App (Settings → Developer settings → OAuth Apps), ~3 min.
3. Phase 2: approve the Entra API permission for the OBO MCP.

Total, phases 1–4 with the cluster on 8 h/day for 5 days: about **R$40–60** on top of the
current ~R$1.50/h cluster cost.

## Progress

| Date | Phase | Done |
|---|---|---|
| 2026-11-12 | 0 | Pi 1.5 SDK confirmed (see `spike.md`); P31 (Envoy 15 s route timeout) fixed in agent-platform-poc. |
| 2026-11-12 | 1 | History in FerretDB (survives API restarts); Blob workspace sync (workload identity, container-scoped role); chat-api image on distroless debian13 and parser (markitdown) on Wolfi→scratch, both 0 HIGH/CRITICAL; CI build → Trivy → push; `tofu apply` (chat infra: identity, container; platform: Entra redirect URI, 30-day lifecycle) R$0; Argo app `chat-harness`; autoscaler added the 2nd `platform` node (~R$0.66/h while the cluster runs). |
| 2026-11-12 | 1 | In-cluster E2E passed: upload → `parse_document` (markitdown pod) → summary → `generate_pdf`; files restored from Blob and history from FerretDB after deleting the chat-api pod; other users see nothing; subprocess guard never fired. Fix on the way: P32 (Blob firewall ignores same-region IPs → AKS subnet service endpoint, R$0). |
| 2026-11-13 | 1 | Operator read access in the portal Storage Browser: `Storage Blob Data Reader` on `chat-workspaces` only (shared keys are off and Owner is control plane only); `operator_object_id` variable, R$0. |
| 2026-11-13 | 1 | Office writers: `generate_pptx` (deck spec → 14 layouts, 5 themes, native charts, lint), `generate_docx` (markdown → styled Word), `generate_xlsx` (typed columns, formulas, totals, data bars, CSV input); skills `pptx` (+ `reference.md`) and `design`; `docx` and `xlsx-csv` skills updated. Visual check via LibreOffice on the laptop only; `npm test` 4/4 with the subprocess guard on. Agent E2E pending (needs the cluster for the LLM gateway). |
| 2026-11-13 | 1 | Deck quality pass without changing the model: Brave Search MCP pod (key in Key Vault, Trivy clean), Lucide icons as native vectors, 13 themes, `big_number` and `cards`, research workflow and storylines in the `pptx` skill. Skill search (`npx skills find`): only MIT/Apache sources reused (minimax-ai/skills, ui-ux-pro-max-skill); Anthropic's pptx skill and unlicensed repos excluded. |
| 2026-11-13 | 1 | Agent E2E in cluster (muse-spark-1.3-contributor): 12 Brave searches, read 4 skills, theme `insight`, 9 distinct layouts, re-rendered once after lint, sources on every slide. Fixes from reviewing its deck: lint for pt-BR text without accents, `big_number` title repeating the value, duplicated "Fonte:", cards sized to content and centred. |
