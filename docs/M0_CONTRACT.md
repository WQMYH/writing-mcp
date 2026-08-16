# M0 Contract v1.2

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
- `entityRef`: workRef + entity kind + identity key. Chapter identity uses its stable documentRef; canonical named entities use the normalized name within the work.
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

### M3 query-correctness amendment (2026-08-16)

- Search and context queries are limited to 2048 characters; deterministic analysis emits at most 48 unique terms.
- `requiredRefs` is limited to 128 values of at most 256 characters; `budgetTokens` is limited to 1 through 1,000,000.
- Serialized `writing_explore` payloads are capped at 200,000 bytes by default (injectable per store). A response that would exceed the cap is deterministically trimmed to fit, sets `truncated: true`, and reports `RESPONSE_TRUNCATED`; it never returns an over-limit payload.
- Unsegmented Chinese questions use deterministic normalization and transparent question-phrase removal before bounded CJK n-gram analysis. This does not invoke a model or infer user intent.
- Search returns `QUERY_ANALYZED`, `NO_MATCHING_TERMS`, `NO_RESULTS`, and `FTS_DEGRADED` diagnostics instead of silently turning analysis or FTS failures into ordinary empty success.
- Entity lookup uses persisted aliases. Duplicate canonical identities, alternative source definitions, and unresolved bracket references are returned through `ambiguous`; `AMBIGUOUS_ENTITY` prevents neighborhood expansion from choosing a candidate automatically.
- LIKE and document candidates are ordered by stable source/span keys before `LIMIT`; final ties use ordinal bytewise string comparison rather than host locale.
- `timeline` is an independent deterministic projection, not full-text search: it returns entities carrying temporal attributes (`valid_from_chapter`, `valid_to_chapter`, or `narrative_time`) plus `precedes` sequence relations, ordered by chapter position, then `valid_to_chapter` position, then `narrative_time`, then reference. An optional query filters the projection by name substring. Results report `TIMELINE_PROJECTION`; an empty projection reports `NO_RESULTS`.
- Chapter-tense filtering against a target chapter anchor is deferred until the target-chapter input exists (AUD-012); no new public parameter is introduced by this amendment.

### M4 requiredRefs amendment (2026-08-16)

- `writing_context` resolves every `requiredRefs` value directly against the index (entity, then span, then document) instead of only marking matches inside the search candidate pool.
- A required ref that resolves outside the pool is added to `blocks` with `required: true` and counts toward the required minimum before budget allocation.
- A required ref that resolves to nothing is reported in `omitted` with reason `not_found` and yields a `truncated` packet; it is never dropped silently.
- If the required minimum (pool and direct-resolved refs) exceeds `budgetTokens`, the packet status is `budget_unsatisfiable` and every required ref is listed in `omitted` with reason `required_minimum_exceeds_budget`.
- The `ContextPacket` shape, status vocabulary, and estimator are unchanged by this amendment.

### M3 graph vocabulary freeze amendment (2026-08-16)

- The deterministic-extraction vocabulary is frozen in `@writing-mcp/core` as `ENTITY_KINDS` (Character, Location, Item, Event, Fact, Foreshadow, Chapter, OutlineNode), `EDGE_KINDS` (contains, appears_in, precedes), and `WORK_CAPABILITIES` (documents, full_text, epub, chapters, characters, outline, state, foreshadow), with matching `EntityKind`, `EdgeKind`, and `WorkCapability` union types.
- Indexing only produces entity and edge kinds inside the frozen sets; adapters only declare capabilities inside the frozen set. Unimplemented relations are never advertised as existing capabilities.
- Extending any frozen set requires a new M0 contract amendment first.
- The wire format is unchanged: `capabilities` remains an array of strings in every response, and `EntityKind` gains `OutlineNode`, which indexing already produced before this amendment.

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

Schema v3 was the active freshness/recovery contract. Schema v4 below is now active; both remain disposable, rebuild-only derived state.

- `documents` stores separate source `content_hash` and `semantic_hash` values plus `source_ordinal` and `source_start_line`.
- The semantic hash covers identity-affecting source metadata and content, so metadata-only and order-only changes cannot be silently skipped.
- `writing_index(status)` compares the current adapter snapshot and returns `stale` with `INDEX_SOURCE_CHANGED` when it differs from the valid index.
- Writes for a work are serialized in-process and guarded by a cooperative per-work lock across Writing MCP processes. A live conflict returns `INDEX_BUSY`.
- Interrupted atomic replacement restores `.previous` before the next locked write and removes schema-owned orphan temporary files.
- The cache `.gitignore` is create-if-absent and never overwrites an existing file.

See `docs/adr/0004-schema-v3-source-freshness-and-writer-recovery.md`.

## SQLite schema v4 amendment

Schema v4 is the active implementation contract. It is an incompatible derived-index upgrade and is rebuilt only from authorized source works.

- `documents` adds `volume_number` and `local_chapter_number`; source order remains the authoritative ordering key for `precedes`.
- Chapter identity includes work and document identity, so duplicate display titles across volumes remain distinct.
- `entity_definitions` preserves every deterministic definition. `entities` selects the canonical definition by source ordinal, span ordinal, then stable definition ref; deleting it deterministically promotes the next definition without changing entity identity.
- Entity and edge rows separate `identity_hash` from full-source `evidence_hash`.
- `mentions` records every occurrence, not only the first occurrence in a span.
- `edge_evidence` stores all evidence occurrences for a stable relationship row, including span and offsets.
- `span_locators` stores one or more source segments. EPUB spans crossing spine entries therefore retain every XHTML entry path and line range.
- Public evidence includes a SHA-256 hash of the returned excerpt, its row/index revision, and optional source-segment locators.

See `docs/adr/0005-schema-v4-graph-identity-and-segmented-evidence.md`.

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
- `docs/adr/0005-schema-v4-graph-identity-and-segmented-evidence.md`: work-scoped identity, deterministic canonical definitions, multi-evidence relationships, and segmented EPUB locators.
