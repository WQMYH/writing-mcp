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

## MCP result rules

- Every call returns Markdown `content` and a JSON `structuredContent` envelope.
- Success uses `{ result: { ok: true, data } }`; failure uses `{ result: { ok: false, error } }`.
- Every tool advertises an `outputSchema`.
- Expected failures return `isError: true`; their error contains `code`, `message`, and optional `recovery`.
- Stack traces and paths outside the requested source are not returned.
- `budget_unsatisfiable` remains a successful business result, not an MCP execution error.

## Benchmark gate

- Dataset: `benchmarks/m0.json`, exactly 30 machine-readable tasks.
- M0 gate: 100% pass on the deterministic fixture.
- The fixture gate validates test infrastructure, not the final product claim.
- The v1 product gates (90% fact recall, 100% evidence coverage, 60% token reduction) require representative real-work corpora in later milestones.
