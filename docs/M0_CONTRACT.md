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

### M3 timeline target-chapter and reserved context inputs amendment (2026-08-16)

- `writing_explore` accepts an optional `targetChapter` (integer, 1 to 1,000,000). It applies only to the `timeline` operation and is ignored by every other operation.
- With `targetChapter`, the timeline projection keeps only temporal items valid at that 1-based chapter position: `valid_from_chapter` position is at most the anchor and `valid_to_chapter` position is at least the anchor. An absent `valid_from_chapter` means the book start; an absent `valid_to_chapter` means the book end. Items anchored to chapters that do not exist in the projection are never valid at a real anchor. Diagnostics report the anchor in `TIMELINE_PROJECTION` or `NO_RESULTS`.
- `writing_context` accepts reserved inputs `targetChapter`, `entityRefs`, `documentRefs`, and `excludeRefs`, and its description marks them and `taskType` as reserved: they are validated but do not change assembly until the M4 amendment. No packet shape, status, or estimator changes here.
- This amendment supersedes the chapter-tense filtering deferral recorded in the M3 query-correctness amendment.
- Open TODO (AUD-012 remainder, M4 scope): the reserved `writing_context` inputs are not yet wired into assembly. Before M4 closes, `taskType` must drive a deterministic source strategy, `targetChapter` must scope assembly to a chapter anchor, `entityRefs`/`documentRefs` must resolve directly into blocks like `requiredRefs`, and `excludeRefs` must remove matching candidates. Until then every reserved input stays validated-and-ignored, and removing or repurposing any of them requires a new amendment.

### M3 search source-trust ranking amendment (2026-08-16)

- Search ranking operationalizes the "Source trust order" clause: a row that matches at least one analyzed query term (labeled `deterministic`) receives a fixed +0.25 score bonus; alias-only rows (labeled `heuristic`) receive none.
- The bonus is added after the existing deterministic score components (coverage, alias boost, proximity, heading matches, normalized BM25). The candidate set, stable tie-break ordering, and diagnostics are unchanged.
- A full re-ranking remains deferred until after M4 with a representative corpus (AUD-012 remainder); this is the only search ranking change inside M3.

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

### M0.1 capture bounded-refs amendment (2026-08-16)

- Development capture events additionally store a bounded `outputHits` view of which refs a call returned: for `results`/`ambiguous`/`blocks` each entry keeps `ref`, `kind`, `sourceKind`, `score`, a SHA-256 hash of its locators, and for blocks the assembly fields `layer`/`tokens`/`required`; `omitted` entries keep `ref`/`reason`/`tokens`; resolve candidates keep `workRef`/`adapter`.
- Each hit list is capped at 100 entries. Titles, excerpts, paths, and locator content itself never enter this view; locators are observable only through their hash.
- The general JSONL history, per-call reports, usage-mode inspect, and the `PostCallDiagnostic` returned to callers are unchanged (counts only). This amendment adds detail to development captures only.

### M0.1 general JSONL serialization amendment (2026-08-16)

- Every append to the general `diagnostics.jsonl` history runs inside a per-directory serial queue together with its rotation check; concurrent records can no longer interleave a rotation rewrite with appends, lose events, or produce interleaved lines.
- Rotation limits (1,000 events / 5 MiB by default) remain unchanged in production and are injectable for tests; rotation still retains the newest half of events.
- A general-history write failure still never replaces a successful business result: persistence degrades to `failed` with a `persistenceError` code in the returned diagnostic.

### M0.1 protocol error boundary amendment (2026-08-17)

- Each tool's declared output data schema is the single source of truth: the registered `outputSchema` envelope and the server-side self-validation inside the diagnostic wrapper are built from the same exported data schema, so the two can never drift.
- Before recording a success, the wrapper self-validates the business result against that data schema. A mismatch raises the new stable error code `OUTPUT_SCHEMA_MISMATCH`, is recorded as a `failure` diagnostic, and is returned as the standard failure envelope with `isError: true`. This keeps the envelope and the SDK's own post-handler output validation consistent; a caller can never observe a recorded success that the protocol layer would reject.
- `OUTPUT_SCHEMA_MISMATCH` is a server-side contract defect indicator, never a caller error; its `recovery` instructs reporting the traceId and retrying after a server update. It is additive: no existing code, envelope shape, or schema changes.
- Observation boundary: SDK-level input rejections (invalid arguments) happen before any tool handler runs, so they are outside the `mcp_calls_only` observation scope by definition. They return the SDK's bare error result (`isError: true`, no `structuredContent`) and must not produce any diagnostic record.
- Protocol/transport-layer errors that never reach a tool handler (unknown message types, transport failures) surface through an injected `onerror` hook; the stdio entrypoint logs them to stderr prefixed `[writing-mcp][protocol]`. stderr is the only observability exit for this layer; MCP stdout remains reserved for protocol messages.

### M1 generic work boundary amendment (2026-08-17)

- Generic discovery defines a deterministic work boundary: a direct file is one work; in a directory each `.epub` file is a self-contained book container and becomes its own candidate with the same `workRef`/`rootPath` as resolving that file directly, while the remaining Markdown/TXT files merge into one directory work.
- A directory holding several independent books therefore returns multiple candidates and resolves as `ambiguous` instead of one silently merged work; the existing `resolved`/`ambiguous`/`unsupported` statuses and `ResolveResult` shape are unchanged.
- `capabilities` are derived from the actual input: generic works always declare `documents` and `full_text`, and declare `epub` only when the work actually contains an EPUB file. All declared values stay inside the frozen `WORK_CAPABILITIES` vocabulary.
- A directory work without the `epub` capability never loads EPUB files even if such files exist under the directory; text-only directory behavior is otherwise unchanged.

### M1 chapter-number syntax amendment (2026-08-17)

- Supported chapter-number syntax is explicit and deterministic for TXT headings and Markdown/generic document titles: Arabic digits, Chinese numerals from 一 up to 九百九十九 (百 composition, including 第一百零三/第一百一十章 forms), and canonical roman numerals `i`…`mmmcmxcix` after `chapter`.
- Headings that match the heading shape but carry an unsupported or malformed number (for example `chapter im`) are deterministically skipped and absorbed into the previous chapter's content; the parser never guesses a number.
- Volume-reset inference (numbering restart implies a new volume) applies equally to digits, Chinese numerals, and roman numerals; locator format `v<volume>-c<local>` is unchanged.

### M1 EPUB resource limits amendment (2026-08-17)

- EPUB ingestion enforces deterministic resource limits before and during ZIP expansion: ZIP entry count (`maxEntries`), per-document decoded size including the OPF package (`maxDocumentBytes`), and total decoded spine size (`maxTotalBytes`). Defaults: 4096 entries, 16 MiB per document, 64 MiB total.
- Every breach is a stable coded error — `EPUB_TOO_MANY_ENTRIES`, `EPUB_DOCUMENT_TOO_LARGE`, `EPUB_TOTAL_TOO_LARGE` — never a hang or unbounded memory growth.
- Limits are injectable for tests via `new GenericAdapter({ epub: Partial<EpubLimits> })`; `DEFAULT_EPUB_LIMITS` is exported from `@writing-mcp/adapter-generic`. No other interface changes.

### M1 snapshot consistency amendment (2026-08-17)

- Every adapter read is bracketed by source fingerprint checks (names + mtime + size of all files under the work root): if the fingerprint differs after the read, the service retries the read exactly once, then fails with stable code `SOURCE_CHANGED_DURING_READ`. A snapshot is never built from mixed-time source state; the client should retry the operation.
- Text ingestion is bounded deterministically: per-file `maxDocumentBytes` (breach: `SOURCE_FILE_TOO_LARGE`) and per-work cumulative `maxTotalBytes` (breach: `SOURCE_TOTAL_TOO_LARGE`), defaults 16 MiB / 64 MiB. Injectable via `new GenericAdapter({ text: Partial<TextLimits> })`; `DEFAULT_TEXT_LIMITS` is exported. EPUB sizes remain governed by the EPUB resource limits amendment.

### M1 span hard cap amendment (2026-08-17)

- `splitDocument` enforces the span size cap as a hard limit: a single line longer than `maxChars` is hard-split into bounded chunk spans that all share that one source line (startLine = endLine, locators included); no span content can ever exceed `maxChars`.
- Locator exactness: blank lines trimmed from span edges are excluded from startLine/endLine and all locators; a locator range always covers exactly the lines its content contains.
- Boundary evidence is contiguous without overlap: adjacent spans tile the document's non-blank content with `next.startLine = previous.endLine + 1` (blank-only gaps excepted), and concatenating span contents reconstructs the trimmed document content. Overlap was evaluated and rejected because duplicating lines double-counts deterministic mentions/edge evidence.

### M1 process lifecycle amendment (2026-08-17)

- The stdio server shuts down gracefully and deterministically: SIGINT, SIGTERM, and stdin EOF (client disconnect) all route through one shutdown chain — close the MCP server (transport) before closing the `WritingService` — then exit with code 0. A 5-second grace guard forces termination, so a long synchronous SQLite operation that cannot be cancelled can never keep the process alive indefinitely.
- stdout is reserved for JSON-RPC messages only: lifecycle and shutdown diagnostics go to stderr (`[writing-mcp][lifecycle]` prefix); every stdout line must parse as a JSON-RPC message.
- `createStdioRuntime(service, options?)` exposes the `{ server, shutdown }` pair so the shutdown chain is testable in process; `shutdown` is idempotent.

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
