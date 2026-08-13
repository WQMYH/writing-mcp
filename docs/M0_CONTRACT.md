# M0 Contract v1

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

## SQLite schema v2 amendment

Schema v2 is the active implementation contract. It is an incompatible upgrade from schema v1; existing derived indexes are rebuilt from source files rather than semantically migrated.

- `works` records the work, adapter, canonical source-path hash, schema/software versions, and current valid revision.
- `index_revisions` records source snapshot hash, build statistics, validity status, and software version.
- entities and edges add evidence content hash, optional chapter-reference validity range, optional narrative time, deterministic `properties_json`, and revision.
- mentions and unresolved mentions add revision.
- v2 adds indexes for source spans, endpoints/kinds, validity ranges, and revisions.

See `docs/adr/0003-schema-v2-temporal-evidence.md` for compatibility and scope decisions.

## MCP result rules

- Every call returns Markdown `content` and a JSON `structuredContent` envelope.
- Success uses `{ result: { ok: true, data } }`; failure uses `{ result: { ok: false, error } }`.
- Every tool advertises an `outputSchema`.
- Expected failures return `isError: true`; their error contains `code`, `message`, and optional `recovery`.
- Stack traces and paths outside the requested source are not returned.
- `budget_unsatisfiable` remains a successful business result, not an MCP execution error.

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
