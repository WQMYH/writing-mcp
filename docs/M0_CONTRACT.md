# M0 Contract v1.1

This document freezes the public and storage decisions for the MVP. Changes require a schema version bump or an ADR.

## Runtime and dependencies

- Node.js: `>=24 <25`.
- MCP SDK: `@modelcontextprotocol/sdk` 1.x.
- Storage: built-in `node:sqlite`, SQLite 3 with FTS5 trigram.
- EPUB: JSZip 3.x; local parsing only, no DRM support.
- Token fallback: `mixed-cjk-v1` (`ceil(CJK × 1.15 + non-CJK words × 1.3)`).

## Stable references

All references use `<kind>:<24 lowercase hex characters>`, derived from SHA-256 over NUL-separated canonical inputs.

- `workRef`: adapter kind + canonical project/work path + adapter-local work id.
- `documentRef`: workRef + normalized relative path; EPUB adds the spine entry path.
- `spanRef`: documentRef + zero-based stable ordinal.
- `entityRef`: entity kind + normalized canonical name.
- `edgeRef`: sourceRef + targetRef + relationship kind.

Moving a work or document intentionally changes its reference. Editing content without moving the document preserves its document and span references when section order is unchanged.

## Query limits

- `limit`: default 20, minimum 1, maximum 100.
- `maxHops`: default 2, minimum 0, maximum 3.
- MVP neighborhood expansion: maximum `limit - 1` adjacent results.
- Initial ranking: exact entity match 2; partial entity match 1; FTS uses BM25; graph expansion result 0.5.
- Source trust order: native > deterministic > heuristic.

### M3 query-limit amendment (2026-08-14)

- Neighborhood traversal uses stable breadth-first expansion for 0 to 3 hops.
- Per-node fan-out is capped at 64 edges and a query visits at most 512 distinct nodes.
- Each traversed step returns edge direction and source evidence; results also report candidate, returned, visited, hop, omission, truncation, and elapsed-time metrics.

## SQLite schema v1

Required tables: `metadata`, `revisions`, `documents`, `spans`, `spans_fts`, `entities`, `aliases`, `mentions`, `edges`, `unresolved_mentions`.

Required uniqueness:

- documents: `document_ref`, `relative_path`.
- spans: `span_ref`.
- entities: `entity_ref`.
- aliases: `(entity_ref, normalized_alias)`.
- mentions: `mention_ref`.
- edges: `edge_ref`.

Schema v1 is rebuildable derived state. It never owns source-of-truth writing data.

## SQLite schema v2 amendment (historical)

Schema v2 was an incompatible upgrade from schema v1; existing derived indexes were rebuilt from source files rather than semantically migrated. Schema v3 below is now active.

- `works` records the work, adapter, canonical source-path hash, schema/software versions, and current valid revision.
- `index_revisions` records source snapshot hash, build statistics, validity status, and software version.
- entities and edges add evidence content hash, optional chapter-reference validity range, optional narrative time, deterministic `properties_json`, and revision.
- mentions and unresolved mentions add revision.
- v2 adds indexes for source spans, endpoints/kinds, validity ranges, and revisions.

See `docs/adr/0003-schema-v2-temporal-evidence.md` for compatibility and scope decisions.

## SQLite schema v3 amendment

Schema v3 is the active implementation contract and remains disposable, rebuild-only derived state.

- `documents` stores separate source `content_hash` and `semantic_hash` values plus `source_ordinal` and `source_start_line`.
- The semantic hash covers identity-affecting source metadata and content, so metadata-only and order-only changes cannot be silently skipped.
- `writing_index(status)` compares the current adapter snapshot and returns `stale` with `INDEX_SOURCE_CHANGED` when it differs from the valid index.
- Writes for a work are serialized in-process and guarded by a cooperative per-work lock across Writing MCP processes. A live conflict returns `INDEX_BUSY`.
- Interrupted atomic replacement restores `.previous` before the next locked write and removes schema-owned orphan temporary files.
- The cache `.gitignore` is create-if-absent and never overwrites an existing file.

See `docs/adr/0004-schema-v3-source-freshness-and-writer-recovery.md`.

## MCP result rules

- Every call returns Markdown `content` and a JSON `structuredContent` envelope.
- Success uses `{ result: { ok: true, data, diagnostic } }`; failure uses `{ result: { ok: false, error, diagnostic } }`.
- Every tool advertises an `outputSchema`.
- Expected failures return `isError: true`; their error contains `code`, `message`, `traceId`, and optional `recovery`.
- Stack traces and paths outside the requested source are not returned.
- `budget_unsatisfiable` remains a successful business result, not an MCP execution error.

### M0.1 diagnostic amendment (2026-08-14)

- The public tool set is `writing_resolve`, `writing_index`, `writing_explore`, `writing_context`, and `writing_diagnose`.
- All five handlers pass through the same server-side post-call diagnostic hook on success and failure. This is a code invariant, not a prompt convention.
- Every response contains a concise `diagnostic` report with `traceId`, tool name, outcome, elapsed time, persistence status, an `executionSummary`, and an artifact reference when persistence succeeds.
- Detailed diagnostic input/output summaries are written silently under `.writing-index/<workId>/diagnostics/`; they are never written to MCP stdout.
- Each invocation writes a schema-versioned JSON report atomically and appends a redacted JSONL event. Diagnostic write failure does not replace a successful business result; it is disclosed in the returned diagnostic report.
- Existing business tools accept optional `diagnosticRunRef`. Explicit capture uses `writing_diagnose(start_capture)`, propagates the reference through later calls, and ends with `writing_diagnose(finish_capture)`.
- Capture reports observe MCP calls only. They do not claim access to agent reasoning, non-MCP tools, or user actions not submitted to this server.
- Default capture policy stores metadata, hashes, stable references, counts, errors, timings, revisions, evidence references, truncation, and token metrics. It does not store source text, returned excerpts, absolute paths, stack traces, SQL, keys, or tokens.
- `writing_diagnose` may write disposable diagnostic artifacts but cannot modify source works or index semantics and cannot automatically invoke index repair.
- Stable diagnostic errors include `INVALID_DIAGNOSTIC_REQUEST`, `DIAGNOSTIC_RUN_NOT_FOUND`, `DIAGNOSTIC_RUN_CLOSED`, and `DIAGNOSTIC_STORAGE_LIMIT`.

## Benchmark gate

- Dataset: `benchmarks/m0.json`, exactly 30 machine-readable tasks.
- Fact/token baseline: `benchmarks/baseline.json`; runner: `scripts/run-benchmark.mjs`.
- M0 gate: 100% pass on the deterministic fixture.
- The fixture gate validates test infrastructure, not the final product claim.
- The v1 product gates (90% fact recall, 100% evidence coverage, 60% token reduction) require representative real-work corpora in later milestones.

The frozen fixture baseline is 166 estimated full-book tokens, 10/10 expected facts recalled, 100% evidence coverage, and 64.33 average context tokens across three tasks (61.24% reduction). These numbers are reproducible engineering gates, not claims about real novels.

## Versioned decisions

- `docs/adr/0001-deterministic-local-core.md`: local deterministic TypeScript core and disposable index.
- `docs/adr/0002-epub-jszip.md`: JSZip 3.x under its MIT option, supported EPUB boundary and failure behavior.
- `docs/adr/0003-schema-v2-temporal-evidence.md`: incompatible derived-index upgrade, chapter-reference validity, and deferred semantic relationships.
- `docs/adr/0004-schema-v3-source-freshness-and-writer-recovery.md`: semantic source snapshots, truthful freshness, cooperative writer locking, and interrupted replacement recovery.
