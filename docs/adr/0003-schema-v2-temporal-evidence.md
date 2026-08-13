# ADR 0003: Schema v2 temporal evidence

- Status: Accepted
- Date: 2026-08-14

## Context

Schema v1 proved the vertical retrieval slice but did not record work ownership, source snapshots, evidence hashes, temporal validity, deterministic properties, or the revision that produced every graph record. The v2 implementation plan requires those fields before formal multi-hop retrieval.

## Decision

Schema v2 is an incompatible derived-index upgrade. A schema v1 database is rebuilt solely from authorized source files; semantic rows are never copied from the old cache.

Temporal validity uses stable Chapter entity references in `valid_from_chapter` and `valid_to_chapter`, not bare chapter numbers. A moved or structurally renamed chapter can therefore invalidate its old temporal anchor instead of silently attaching evidence to a different chapter number. `narrative_time` remains optional text from explicit source data.

`properties_json` is limited to parser-versioned, deterministic properties. The initial properties are structural values such as span ordinal, document kind, explicit marker, and chapter order.

Schema v2 supports structural `contains`, `mentions`, `appears_in`, and `precedes` relationships. The domain relations `located_at`, `causes`, `plants`, `echoes`, `resolves`, `implements_outline`, and `contradicts` remain part of the v1 relation vocabulary, but are not emitted until a source adapter exposes explicit structure or a versioned fixed marker. Ordinary prose is never used to guess them.

## Consequences

- Existing v1 caches are disposable and rebuild automatically during an explicit index update.
- Every graph fact can be tied to a source span, content hash, revision, confidence, and optional temporal range.
- Deferred relationship kinds remain schema-compatible and can be added without changing the public four-tool surface.
- Atomic temporary-database replacement is a separate M2.1 gate; this ADR does not claim it is already implemented.
