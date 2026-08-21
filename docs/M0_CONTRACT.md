# M0 Contract v1.3

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
- Core `writing_explore` keeps a defensive 200,000 UTF-8-byte pre-trim (injectable per store). It is not the wire-contract enforcer and does not treat its partial `{results, ambiguous}` JSON as the complete MCP result; the server-boundary limits and tool reducers are frozen by the response-size amendment below.
- Unsegmented Chinese questions use deterministic normalization and transparent question-phrase removal before bounded CJK n-gram analysis. This does not invoke a model or infer user intent.
- Search returns `QUERY_ANALYZED`, `NO_MATCHING_TERMS`, `NO_RESULTS`, and `FTS_DEGRADED` diagnostics instead of silently turning analysis or FTS failures into ordinary empty success.
- Entity lookup uses persisted aliases. Duplicate canonical identities, alternative source definitions, and unresolved bracket references are returned through `ambiguous`; `AMBIGUOUS_ENTITY` prevents neighborhood expansion from choosing a candidate automatically.
- LIKE and document candidates are ordered by stable source/span keys before `LIMIT`; final ties use ordinal bytewise string comparison rather than host locale.
- `timeline` is an independent deterministic projection, not full-text search: it returns entities carrying temporal attributes (`valid_from_chapter`, `valid_to_chapter`, or `narrative_time`) plus `precedes` sequence relations, ordered by chapter position, then `valid_to_chapter` position, then `narrative_time`, then reference. An optional query filters the projection by name substring. Results report `TIMELINE_PROJECTION`; an empty projection reports `NO_RESULTS`.
- Chapter-tense filtering against a target chapter anchor is deferred until the target-chapter input exists (AUD-012); no new public parameter is introduced by this amendment.

### M3 deterministic PRF candidate-expansion amendment (2026-08-21)

- Search may perform one deterministic pseudo-relevance-feedback (PRF) expansion after the existing first-pass ranking. PRF is a retrieval candidate mechanism owned by the MCP knowledge-access layer: it neither interprets authorial intent nor generates, reviews, revises, or writes creative content. It does not change any MCP input/output schema.
- The only releasable algorithm is a single-round, two-pass search. The first pass uses the frozen baseline ranking. Candidate expansion terms are extracted from the headings and excerpts of the first-pass top spans, then the second pass uses those terms only to widen candidate recall; original query terms remain the dominant scoring signal.
- The accepted production configuration must be selected from the frozen grid: first-pass top-k `{5, 8, 12}`, expansion-term count `{4, 6, 8}`, and bounded expansion weight `{0.15, 0.25, 0.35}`. Terms from the original query, persisted aliases, stopwords, and single-character terms are excluded; an expansion term must occur in at least two selected spans. Remaining terms are ordered by rank-weighted co-occurrence multiplied by corpus IDF, with ordinal bytewise tie-breaking.
- Configuration selection uses the training partition only, ordered by recall@5, then MRR, then lower complexity (`topK`, term count, and weight in ascending order). Holdout data validates the selected configuration but never participates in selection. Production behavior is enabled only after the selected configuration passes every frozen public, private, performance, determinism, and no-regression gate; otherwise baseline search remains active.
- Runtime search may read only the indexed corpus, persisted aliases, and statistics derived from that corpus. It must never read evaluator labels such as `expectedTerms`, `expectedChapters`, `evidenceQuotes`, expected/gold refs, required flags, or train/holdout membership. Evaluator-only experiment parameters remain outside MCP schemas, Zod definitions, tool descriptions, and normal `explore`/`context` calls.
- PRF does not modify the property graph, index revision, evidence chain, result shape, stable references, response caps, or source-trust rules. Every returned result still carries source evidence from the underlying indexed span, and identical revision and parameters produce identical ordering.

### M4 requiredRefs amendment (2026-08-16)

- `writing_context` resolves every `requiredRefs` value directly against the index (entity, then span, then document) instead of only marking matches inside the search candidate pool.
- A required ref that resolves outside the pool is added to `blocks` with `required: true` and counts toward the required minimum before budget allocation.
- A required ref that resolves to nothing is reported in `omitted` with reason `not_found` and yields a `truncated` packet; it is never dropped silently.
- If the required minimum (pool and direct-resolved refs) exceeds `budgetTokens`, the packet status is `budget_unsatisfiable` and every required ref is listed in `omitted` with reason `required_minimum_exceeds_budget`.
- The `ContextPacket` shape, status vocabulary, and estimator are unchanged by this amendment.

### M4 constraint-interface wiring amendment (2026-08-17)

- `writing_context` now wires the previously reserved inputs into assembly, superseding the "validated but do not change assembly yet" clause of the M3 timeline/reserved-inputs amendment:
  - `excludeRefs` removes matching candidates from the search pool before dedup; excluded refs are reported in `omitted` with reason `excluded`. `requiredRefs` win over `excludeRefs` when both name the same ref.
  - `entityRefs` and `documentRefs` resolve directly against the index (entity, then span, then document) like `requiredRefs`, enter `blocks` as non-required blocks with their semantic layer, and rank ahead of search hits within their layer. Review clarification (2026-08-18): explicit pins outrank `targetChapter` anchor proximity within a layer; a pinned ref already in the search pool keeps its search-hit rank; pinned blocks are not folded by evidence dedup. All four ref lists share the existing 128-item / 256-character validation (`CONTEXT_REFS_TOO_LARGE`).
  - `targetChapter` anchors assembly ordering: within each layer, blocks from the anchor chapter fill first, then earlier chapters by distance, then later chapters by distance, then blocks whose document carries no chapter number. Layer rank (L0 → L1 → L2 → L3) dominates; anchoring is a deterministic tie-breaker, not a filter.
  - `taskType` stays a reserved hint, value-open: its schema changed from a five-value enum to an open string (the five values `answer`/`revise`/`custom`/`continue_chapter`/`draft_chapter` remain documented conventions); unknown values are accepted, validated, and recorded in diagnostics, and never drive assembly (2026-08-17 direction: no taskType strategy engine).
- The previously drafted per-taskType layer-order strategy engine is intentionally absent from `@writing-mcp/core`; assembly fills L0 → L1 → L2 → L3 deterministically, with targetChapter anchoring and explicit pinning as tie-breakers.
- Omitted reasons always reflect the true omission cause. In `budget_unsatisfiable` only required candidates (pool hits and direct-resolved `requiredRefs`) carry `required_minimum_exceeds_budget`; excluded, folded, pinned, and unresolved entries keep their own reasons `excluded`, `duplicate_evidence`, `budget_limit`, and `not_found`.
- The `writing_context` tool description states the real precedence rule: `requiredRefs` win over `excludeRefs`, and `excludeRefs` win over `entityRefs`/`documentRefs` pins.
- No packet shape, status vocabulary, or estimator changes.
- Superseded by the 2026-08-21 context accounting-scope amendment: source-catalog observability is complete, and `mixed-cjk-v1` remains an explicit estimate rather than a model-token claim.

### M3 graph vocabulary freeze amendment (2026-08-16)

- The deterministic-extraction vocabulary is frozen in `@writing-mcp/core` as `ENTITY_KINDS` (Character, Location, Item, Event, Fact, Foreshadow, Chapter, OutlineNode), `EDGE_KINDS` (contains, appears_in, precedes), and `WORK_CAPABILITIES` (documents, full_text, epub, chapters, characters, outline, state, foreshadow), with matching `EntityKind`, `EdgeKind`, and `WorkCapability` union types.
- Indexing only produces entity and edge kinds inside the frozen sets; adapters only declare capabilities inside the frozen set. Unimplemented relations are never advertised as existing capabilities.
- Extending any frozen set requires a new M0 contract amendment first.
- The wire format is unchanged: `capabilities` remains an array of strings in every response, and `EntityKind` gains `OutlineNode`, which indexing already produced before this amendment.

### M3 `mentions` vocabulary alignment amendment (2026-08-21)

- `mentions` is added to the frozen public `EdgeKind` and `EDGE_KINDS` vocabulary. It already existed in schema-v4 derived data; this additive amendment aligns the public vocabulary with that persisted relationship rather than introducing a schema migration.
- A native `[[alias]]` reference resolves through the persisted alias table only when that normalized alias has exactly one canonical owner, then creates a `Document → Entity` `mentions` edge. A multi-owner alias writes `unresolved_mentions` with stable reason `AMBIGUOUS_ALIAS`; it never silently selects an owner or creates a deterministic-looking fact. Its edge evidence retains the source span, document locator, source kind, confidence, and index revision. This direction is distinct from the deterministic `Entity → Document` `appears_in` edge.
- Native alias evidence covers the trimmed alias capture only, not the surrounding `[[` / `]]` delimiters: offsets and evidence hash are computed from that exact captured substring and match between `mentions` and `edge_evidence`.
- Bounded `neighborhood` traversal (but not `entity`) may seed either a stable entity reference or a stable document reference, and exposes the same `mentions` edge as incoming or outgoing path evidence from the corresponding endpoint.
- The native grammar remains double-bracket `[[alias]]` only. This amendment adds no single-bracket grammar, source-file write path, Agent judgment, or inference beyond deterministic alias resolution.

### M3 timeline target-chapter and reserved context inputs amendment (2026-08-16)

- `writing_explore` accepts an optional `targetChapter` (integer, 1 to 1,000,000). It applies only to the `timeline` operation and is ignored by every other operation.
- With `targetChapter`, the timeline projection keeps only temporal items valid at that 1-based chapter position: `valid_from_chapter` position is at most the anchor and `valid_to_chapter` position is at least the anchor. An absent `valid_from_chapter` means the book start; an absent `valid_to_chapter` means the book end. Items anchored to chapters that do not exist in the projection are never valid at a real anchor. Diagnostics report the anchor in `TIMELINE_PROJECTION` or `NO_RESULTS`.
- `writing_context` accepts reserved inputs `targetChapter`, `entityRefs`, `documentRefs`, and `excludeRefs`, and its description marks them and `taskType` as reserved: they are validated but do not change assembly until the M4 amendment. No packet shape, status, or estimator changes here.
- This amendment supersedes the chapter-tense filtering deferral recorded in the M3 query-correctness amendment.
- Open TODO (AUD-012 remainder, M4 scope): the reserved `writing_context` inputs are not yet wired into assembly. **Direction amendment (2026-08-17): `taskType` no longer drives a deterministic source strategy** — MCP must not guess authoring intent (aligns with Reference §5.5's rejected smart-routing). Assembly remains deterministic constraint execution: the Agent expresses constraints via `query`, `requiredRefs`, `entityRefs`, `documentRefs`, `targetChapter`, `excludeRefs`, and `budgetTokens`; MCP executes retrieval, direct resolution, dedup, and budget-aware trimming only. Before M4 closes, `targetChapter` must scope assembly to a chapter anchor, `entityRefs`/`documentRefs` must resolve directly into blocks like `requiredRefs`, `excludeRefs` must remove matching candidates, and `taskType` stays a reserved hint (validated, non-driving) unless a later amendment re-purposes it. Until then every reserved input stays validated-and-ignored, and removing or repurposing any of them requires a new amendment.

### M3 search source-trust ranking amendment (2026-08-16)

- Search ranking operationalizes the "Source trust order" clause: a row that matches at least one analyzed query term (labeled `deterministic`) receives a fixed +0.25 score bonus; alias-only rows (labeled `heuristic`) receive none.
- The bonus is added after the existing deterministic score components (coverage, alias boost, proximity, heading matches, normalized BM25). The candidate set, stable tie-break ordering, and diagnostics are unchanged.
- A full re-ranking remains deferred until after M4 with a representative corpus (AUD-012 remainder); this is the only search ranking change inside M3.

### M4 complete re-ranking amendment (2026-08-19, REVERTED — validation void, NOT in force)

> **REVERTED 2026-08-19.** User review (R1–R5) invalidated the validation underpinning this amendment: the evaluation instrument was defective (`calculateRecallAtK` ignored `k`; hit was term co-occurrence, not golden-evidence retrieval; `checkExpectedChapters` was an always-false TODO; `limit=10` never tested recall@50), the 24-fact holdout was never run, and no golden-evidence gate script or `baseline.json` snapshot existed. The ranking formula was reverted to the validated 6-factor version (`coverage×4 + aliasBoost + proximity + headingMatches×0.5 + bm25 normalization + trustBonus`), and the two rewritten ranking tests were restored. **This amendment is NOT ratified.** Re-derivation requires a corrected golden-evidence instrument, a true baseline, published per-factor ablation data, and holdout validation. The original text below is retained for traceability only.

- Search ranking simplifies to three factors: `coverage × 4 + aliasBoost + proximity`. Coverage measures term length coverage normalized to 12 characters; aliasBoost caps at 0.75 from alias matches; proximity uses the existing term proximity algorithm.
- Three factors removed based on ablation testing (threshold: recall@5>2%/MRR>5%): `headingMatches × 0.5` (no significant impact), `bm25` normalization (disabled it improved MRR by 5.79%), and `trustBonus +0.25` (no significant impact).
- Ablation validation: baseline Recall@5=83.33%, MRR=0.4247 on 18 training facts (42-fact private annotation set, holdout 24 facts); optimized MRR=0.4493 (+5.79%), Recall unchanged; 30/30 public benchmark unchanged.
- The candidate set, stable tie-break ordering, and diagnostics remain unchanged.
- This supersedes the M3 search source-trust ranking amendment's +0.25 bonus.
- Holdout validation (first 3 + last 2 chapters, 24 facts) pending final verification before v1 release.

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

### M0 response-size amendment (2026-08-21)

- The compact JSON serialization of `structuredContent.result` is at most 200,000 UTF-8 bytes. This limit does not describe the whole JSON-RPC frame. The returned `PostCallDiagnostic` is independently limited to 8,192 UTF-8 bytes, and Markdown fallback text is independently limited to 16,384 UTF-8 bytes.
- The server validates business data, reserves a schema-valid full 8,192-byte synthetic diagnostic, then deterministically reduces business data before persistence. The recorder receives only the final reduced success data, or the final bounded error detail on failure. The synthetic reserve is never returned or persisted. The real diagnostic drops optional fields first, then bounded execution details/free text, while preserving required identity/outcome/persistence fields.
- `writing_explore` drops `ambiguous` tail entries before result tails, sets `truncated`, recomputes `returnedCount`, adds only newly dropped entries to `omittedEstimate`, and exposes one `RESPONSE_TRUNCATED` diagnostic. `writing_context` never drops required blocks; it removes optional L3→L2→L1→L0 tails, records one `response_limit` omission per removed ref, and recomputes `usedTokens`. Required-only context that cannot fit fails with `RESPONSE_TOO_LARGE` rather than disguising the response cap as a token-budget result.
- `writing_resolve` removes stable candidate tails without removing the selected candidate or changing `resolved`/`ambiguous`/`unsupported` truthfulness. `writing_diagnose` may remove `recentEvents` tails and mark truncation, but never rewrites capture artifacts. `writing_index` has no semantic reducer. Any tool unable to preserve a schema-valid result within the limit returns stable `RESPONSE_TOO_LARGE` with recovery guidance.
- Markdown fallback is a concise summary from the same reduced data and bounded diagnostic; it is not a pretty-printed copy of the structured payload. Dynamic fields are normalized to one line and CommonMark control characters are escaped, so returned values cannot forge headings, lists, links, or quotes. Every UTF-8 truncation ends on a complete code point. Core search/evaluator pre-trim uses `Buffer.byteLength(..., "utf8")` only as a protective optimization, follows the same ambiguous-tail-before-result-tail order, and adds every newly dropped item to `omittedEstimate`; the MCP server remains the final contract boundary.

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
- Stable diagnostic errors include `INVALID_DIAGNOSTIC_REQUEST`, `DIAGNOSTIC_RUN_NOT_FOUND`, and `DIAGNOSTIC_RUN_CLOSED`. The former hard-cap error `DIAGNOSTIC_STORAGE_LIMIT` is superseded by the 2026-08-21 retention amendment below.

### M0.1 capture bounded-refs amendment (2026-08-16)

- Development capture events additionally store a bounded `outputHits` view of which refs a call returned: for `results`/`ambiguous`/`blocks` each entry keeps `ref`, `kind`, `sourceKind`, `score`, a SHA-256 hash of its locators, and for blocks the assembly fields `layer`/`tokens`/`required`; `omitted` entries keep `ref`/`reason`/`tokens`; resolve candidates keep `workRef`/`adapter`.
- Each hit list is capped at 100 entries. Titles, excerpts, paths, and locator content itself never enter this view; locators are observable only through their hash.
- The general JSONL history, per-call reports, usage-mode inspect, and the `PostCallDiagnostic` returned to callers are unchanged (counts only). This amendment adds detail to development captures only.

### M0.1 general JSONL serialization amendment (2026-08-16)

- Every append to the general `diagnostics.jsonl` history runs inside a per-directory serial queue together with its rotation check; concurrent records can no longer interleave a rotation rewrite with appends, lose events, or produce interleaved lines.
- Rotation limits (1,000 events / 5 MiB by default) remain unchanged in production and are injectable for tests; rotation still retains the newest half of events.
- A general-history write failure still never replaces a successful business result: persistence degrades to `failed` with a `persistenceError` code in the returned diagnostic.

### M0.1 diagnostic retention amendment (2026-08-21)

- Diagnostic retention keeps a per-directory estimate and performs a real recursive scan on first use, after exactly 64 recorder-owned writes, after at least 1 MiB of estimated additions, or when the estimate crosses the 100 MiB target. Same-process maintenance for one directory is serialized, so concurrent first use coalesces rather than multiplying scans.
- Cleanup uses a non-blocking cooperative cross-process lock. A live owner defers cleanup and is disclosed as `DIAGNOSTIC_CLEANUP_DEFERRED`; dead, malformed, or truncated locks are recoverable without displacing a replacement live owner. Scan/delete disappearance races are tolerated.
- Candidates are ordered by mtime and then NFC-normalized Unicode code-point filename. Old per-call reports are removed before complete closed-capture groups. Active captures, `diagnostics.jsonl`, cleanup locks, and the artifact being returned by the current call are protected.
- 100 MiB is an eventual-convergence target, not an instantaneous hard cap: concurrent writers and protected/active artifacts may cause a temporary or irreducible overshoot. The recorder never claims otherwise and does not make a successful business result fail merely because another process currently owns cleanup.
- This amendment retires `DIAGNOSTIC_STORAGE_LIMIT`: `start_capture` runs the same cooperative maintenance path instead of performing an unconditional full-directory scan and rejecting at an inaccurately hard boundary.

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

- EPUB ingestion enforces deterministic resource limits before and during ZIP expansion: ZIP entry count (`maxEntries`), per-document decoded UTF-8 byte size including the OPF package (`maxDocumentBytes`), and total decoded spine UTF-8 byte size (`maxTotalBytes`). Defaults: 4096 entries, 16 MiB per document, 64 MiB total. These are `Buffer.byteLength(value, "utf8")` boundaries, not JavaScript UTF-16 character counts or compressed ZIP sizes.
- Every breach is a stable coded error — `EPUB_TOO_MANY_ENTRIES`, `EPUB_DOCUMENT_TOO_LARGE`, `EPUB_TOTAL_TOO_LARGE` — never a hang or unbounded memory growth.
- Limits are injectable for tests via `new GenericAdapter({ epub: Partial<EpubLimits> })`; `DEFAULT_EPUB_LIMITS` is exported from `@writing-mcp/adapter-generic`. No other interface changes.

### M1 snapshot consistency amendment (2026-08-17)

- Every adapter read is bracketed by source fingerprint checks (names + mtime + size of all files under the work root): if the fingerprint differs after the read, the service retries the read exactly once, then fails with stable code `SOURCE_CHANGED_DURING_READ`. A snapshot is never built from mixed-time source state; the client should retry the operation.
- Text ingestion is bounded deterministically: per-file `maxDocumentBytes` (breach: `SOURCE_FILE_TOO_LARGE`) and per-work cumulative `maxTotalBytes` (breach: `SOURCE_TOTAL_TOO_LARGE`), defaults 16 MiB / 64 MiB. Injectable via `new GenericAdapter({ text: Partial<TextLimits> })`; `DEFAULT_TEXT_LIMITS` is exported. EPUB sizes remain governed by the EPUB resource limits amendment.

### M1 SourceSnapshot freshness amendment (2026-08-21)

- Each adapter owns the exact enumeration of files it reads. A `SourceSnapshot` stores its real root plus deterministically sorted entries of normalized relative path, internal absolute path, byte size, and nanosecond mtime; its SHA-256 fingerprint is over structured full-path entry data, so equal basenames in different directories remain distinct. The Generic and InkOS adapters both validate every manifest entry's realpath and metadata immediately before reading it.
- The service uses one adapter snapshot for the read and takes a second adapter snapshot afterwards. A source mismatch retries the full operation once, then returns `SOURCE_CHANGED_DURING_READ`; it does not use an independent recursive scan, silently ignore source read/stat errors, or recompute a follow-up fingerprint after validation. EPUB manifests contain only the outer EPUB file, which is read once into the ZIP parser buffer.
- Per-work active state separates `loaded` (the parsed work held by the current store) from `indexed` (the source snapshot proven represented by a valid index). Only a successful incremental/rebuild or a fresh status advances `indexed`; stale, missing, and incompatible status may advance `loaded` only. Explore and context re-index whenever `indexed` differs from the current snapshot, while an unchanged indexed snapshot takes the fast path. A failed status/index operation closes the new store and retains the prior usable store and both freshness values.
- This is metadata freshness, not content-hash freshness. An in-place replacement that preserves both mtime and size can remain undetected until a later source change or process restart; no stronger detection is claimed. Tool shapes and derived-index schema are unchanged.

### M1 span hard cap amendment (2026-08-17)

- `splitDocument` enforces the span size cap as a hard limit: a single line longer than `maxChars` is hard-split into bounded chunk spans that all share that one source line (startLine = endLine, locators included); no span content can ever exceed `maxChars`.
- Locator exactness: blank lines trimmed from span edges are excluded from startLine/endLine and all locators; a locator range always covers exactly the lines its content contains.
- Boundary evidence is contiguous without overlap: adjacent spans tile the document's non-blank content with `next.startLine = previous.endLine + 1` (blank-only gaps excepted), and concatenating span contents reconstructs the trimmed document content. Overlap was evaluated and rejected because duplicating lines double-counts deterministic mentions/edge evidence.

### M1 process lifecycle amendment (2026-08-17)

- The stdio server shuts down gracefully and deterministically: SIGINT, SIGTERM, and stdin EOF (client disconnect) all route through one shutdown chain — close the MCP server (transport) before closing the `WritingService` — then exit with code 0. A 5-second grace guard forces termination, so a long synchronous SQLite operation that cannot be cancelled can never keep the process alive indefinitely.
- stdout is reserved for JSON-RPC messages only: lifecycle and shutdown diagnostics go to stderr (`[writing-mcp][lifecycle]` prefix); every stdout line must parse as a JSON-RPC message.
- `createStdioRuntime(service, options?)` exposes the `{ server, shutdown }` pair so the shutdown chain is testable in process; `shutdown` is idempotent.

### M1 process lifecycle hardening amendment (2026-08-21)

- This amendment supersedes the earlier unconditional “then exit with code 0” wording. SIGINT, SIGTERM, transport close from stdin EOF, and repeated triggers enter one memoized termination promise. Runtime shutdown itself also returns one memoized promise and always attempts `server.close()` before `service.close()`, collecting failures only after both attempts.
- Normal completion clears the fallback and lets Node exit naturally; it does not call `process.exit(0)`. A shutdown failure is reported only through stderr, sets a nonzero process exit status, and still completes the shared termination chain.
- `process.exit(1)` is reserved for the 5-second last-resort timer when shutdown remains unsettled. Repeated triggers cannot create extra close sequences or fallback timers, and stdout remains JSON-RPC-only.

### M4 context source registry amendment (2026-08-17)

- Context assembly assigns layers through a frozen source provider registry instead of candidate positions: Character/Fact/Foreshadow → L1, Chapter/Event/OutlineNode → L2, Location/Item and unknown kinds → L3; required blocks (pool-hit and direct-resolved `requiredRefs`) are promoted to L0 (task goals and mandatory constraints).
- Context candidates come from search rows whose `kind` is the lowercase document kind, so document kinds normalize to their entity counterparts before lookup (character→Character, state→Fact, foreshadow→Foreshadow, chapter→Chapter, outline→OutlineNode); `document` and unrecognized kinds stay L3. Without this normalization every block would silently fall back to L3.
- Candidates sharing an evidence excerpt hash are folded: the first occurrence survives under required-first, deterministic score order, and the folded refs appear in `omitted` with reason `duplicate_evidence`.
- Budget filling proceeds L0→L3 (layer rank, then score descending, then registry priority, then ref), implementing trim-from-L3 toward L0. Existing omitted reasons (`budget_limit`, `not_found`, `required_minimum_exceeds_budget`) and the `ContextPacket` shape are unchanged.
- Registry fields `minTokens`/`preferredTokens`/`maxTokens` remain reserved and are deliberately undeclared. Token accounting remains `mixed-cjk-v1` with `estimated: true`; its public excerpt-only scope is frozen by the 2026-08-21 accounting-scope amendment and is not an exact model-token claim.

### M4 `ContextPacket` accounting-scope amendment (2026-08-21)

- Every successful `writing_context` packet, including `budget_unsatisfiable`, carries required `accountingScope: "evidence_excerpts_only"`. The field is additive to the packet shape and is emitted by core, the MCP data schema, and the registered tool output schema.
- `usedTokens` remains exactly the sum of returned block `tokens`; each value is the `mixed-cjk-v1` estimate of that block's `evidence.excerpt` only. It excludes refs, headings, locators, omitted rows, diagnostics, JSON framing, and the Markdown fallback.
- This scope is material for external tokenizer evaluation: callers can compare the actual returned excerpt material with an external tokenizer without mistaking the built-in estimate for exact model tokens. No tokenizer-accuracy claim, model call, or additional source content accounting is introduced.

### M4 source directory observable amendment (2026-08-18)

- `writing_explore` with `operation: "stats"` now returns a `contextSources` field alongside the existing `documents`/`spans`/`entities`/`edges` counts.
- `contextSources` contains two breakdowns: `byLayer` (L1/L2/L3 document counts per semantic layer) and `byKind` (document counts per document kind, using the lowercase document kinds from the index).
- Layer assignment uses the same registry and normalization as context assembly: character/state/foreshadow → L1, chapter/outline → L2, location/document/unknown → L3. This lets the Agent see what kinds of context are available before calling `writing_context`, without guessing from raw entity/document counts.
- The feature is read-only and adds no new write paths, no new error codes, and no changes to `ContextPacket` shape.

### M4 status fast path and diagnose summary amendment (2026-08-18)

- `writing_index` with `mode: "status"` gains an optional `contextSources` field with the same `byLayer`/`byKind` breakdown as `writing_explore` stats, so a single status call doubles as the source-catalog check. Other modes do not carry the field.
- `writing_diagnose` with `action: "inspect"` now includes `contextSources` in its `index` summary digest (same shape, sourced from the status call it already performs). No new diagnose actions, inputs, or artifacts.
- Status mtime/size fast path: when the source fingerprint (file name+mtime+size directory, the same AUD-021 fingerprint that guards explore/context reuse) is unchanged since the store was last loaded, `status` reuses the existing store instead of re-reading every source file. Under normal operation the fingerprint change captures all parse-input changes, so reuse is best-effort safe; known edge cases (mtime granularity, sub-millisecond file replacement) can let content changes slip through until the next file modification or process restart. Any file change, first call in a process, or non-status mode falls through to the full semantic path; the store-level semantic snapshot comparison remains the sole authority for `stale`/`fresh` and is unchanged.
- No schema, error-code, freshness-vocabulary, or `IndexStats` shape changes; `contextSources` is additive and optional.

## Benchmark gate

### Reliability gate amendment (Task 2, 2026-08-21)

- `verify` is public/CI-safe and is read-only with respect to tracked files. `gold:gate` measures candidate gold-span gates and `gold:check` rejects only metric regressions against the committed snapshot; both are read-only.
- `gold:update` is the sole baseline writer. It writes the snapshot atomically and records the measured committed code hash; it is never included in a verify chain.
- Gold measurement and private acceptance require `WRITING_MCP_PRIVATE_ACCEPTANCE`; `private:measure` reports threshold misses without failing them, while `verify:private` is the hard top-20/required-recall acceptance chain. Corpus performance is independent: it requires `WRITING_MCP_PRIVATE_CORPUS` and `WRITING_MCP_CORPUS_TASKS` (and accepts `WRITING_MCP_PRIVATE_REPORT_DIR`).
- Corpus performance and external token evidence require explicit local inputs and local report locations. Until the public field is added, benchmark token accounting is explicitly `evidence_excerpts_only`; external token status is `not_evaluated` and no 95% external-token claim is made.

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
