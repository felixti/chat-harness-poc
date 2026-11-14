# Spike: Relate as the engine of memory layer 3

Date: 2026-11-14. Scripts: `spikes/relate/` (run against `npm install --ignore-scripts
@relate/relate@1.0.1 @relate/relate-wasm@1.0.1` in a scratch folder). Laptop, Node 26.

## Question

Can Relate (Apache-2.0, embedded Cypher graph, v1.0.1, repo created 2026-11-04) serve the facts
graph of [architecture.md](architecture.md) §6 inside a stateless pod: rebuilt per turn from Blob,
typed queries, within the Prisma rules?

## Results

Synthetic graph: entities = events / 6, one relationship per event with `type`, `at`, `src`.
Queries: neighbors by time, 2-hop co-occurrence, latest decision about an entity.

| Engine | Events | Rebuild from events | 3 queries | Extra RSS |
|---|---|---|---|---|
| WASM (`@relate/relate-wasm`) | 5,000 | 346 ms | 8.5 ms | 126 MB |
| WASM | 20,000 | 946 ms | 7.3 ms | 138 MB |
| Native (`@relate/relate`, N-API) | 5,000 | 139 ms | 1.2 ms | 48 MB |
| Native | 20,000 | 529 ms | 2.1 ms | 66 MB |
| Native, **reopen a checkpointed snapshot** | 20,000 | **22 ms** | - | - |

Snapshot on disk for 20,000 relationships: 504 KB (`manifest.json`, `nodes/`, `relationships/`, `wal/`).

## Findings

1. **WASM works in Node but only in memory** (persistence is OPFS, browser-only): every turn would
   replay all events. ~1 s and ~130 MB per concurrent turn at 20k facts: too heavy for a shared pod.
2. **Native + snapshot fits the design**: compactor checkpoints to a folder, uploads it to
   `chat-memory/<oid>/graph/`; a turn downloads ~0.5 MB, opens in ~22 ms and replays only the
   events after the snapshot. Queries in 1-2 ms.
3. **Prisma rules**: in-process N-API library, no subprocess, no runtime download (installed at
   build with `--ignore-scripts`; the platform package is an optional dependency). Distroless
   Node is glibc, matching `relate-linux-x64`. Adds 24 MB to the image.
4. **Risks**:
   - The engine is a prebuilt Rust library. Trivy sees the npm package but not the Rust crates
     inside it, so a CVE in a bundled crate would go unnoticed by our scan.
   - The project is 10 days old: v1.0.0 shipped 3 days ago, it has 548 ADRs and changes daily.
   - Opening the same store twice in one process fails with a generic "internal error". This is
     documented as single-process, but the error message gives no hint.
5. The model never writes Cypher (typed `remember`/`recall` tools), so the dialect risk is gone.

## Recommendation

Use the **native** binding for layer 3 behind the `GraphEngine` interface, with the events in
Blob as the truth and the snapshot as a cache that is safe to delete. Pin the exact version, check
the release notes before each bump, and keep the FerretDB fallback implementable behind the same
interface. Decision pending with the user.
