# ADR 0005: Schema v4 graph identity and segmented evidence

- Status: accepted
- Date: 2026-08-16

## Context

Schema v3 made source freshness truthful but still keyed Chapter entities by normalized title, sorted chapters by numeric label, stored one canonical source per named entity, and stored one evidence span per relationship. This merged repeated chapter titles, lost later mention evidence, made canonical-source deletion unstable, and could not trace a chapter assembled across EPUB spine entries.

## Decision

Schema v4 remains disposable derived state and is rebuilt from source when an older schema is encountered.

- Entity identity is scoped to the work. Chapters use stable document identity; canonical named entities use kind plus normalized name.
- Every detected definition is stored in `entity_definitions`. Canonical selection is deterministic by source ordinal, span ordinal, and definition ref, with automatic promotion after deletion.
- `precedes` follows source ordinal rather than chapter labels. Volume and local chapter numbers are retained as metadata, not treated as global order.
- Entities and edges carry separate identity and full-source evidence hashes.
- Mentions store every occurrence. Stable relationship rows use `edge_evidence` for multiple span/offset evidence records.
- EPUB parsing carries per-line source segments into `span_locators`; public evidence can return all contributing entry paths and line ranges.
- Public excerpt hashes cover the excerpt actually returned, while revisions identify the derived row/index state that produced it.

## Consequences

Repeated Chapter display names remain independently addressable, and the real converted EPUB now yields 56 Chapter entities for 56 chapter documents with 55 ordered `precedes` edges. Same-name source definitions are preserved without multiplying canonical named entities. Existing schema v1-v3 indexes are incompatible and are rebuilt; source files are never migrated or changed.

The current segmented locator identifies every source segment contributing to a span. Exact character-offset projection inside a compressed multi-window excerpt remains a later refinement; the server does not claim that a single synthetic line range represents multiple XHTML files.
