# ADR 0004: Schema v3 source freshness and writer recovery

## Status

Accepted on 2026-08-16.

## Context

Schema v2 compared only document content hashes. `writing_index(status)` reported any existing revision as fresh without comparing the current source, and metadata-only changes such as title, kind, chapter number, source order, or source line offset could be skipped. Atomic replacement also had no cooperative writer lock or startup recovery for an index left only as `.previous`.

## Decision

Schema v3 is an incompatible, rebuild-only upgrade of derived data.

- `documents` keeps the source `content_hash` and adds `semantic_hash`, `source_ordinal`, and `source_start_line`.
- `semantic_hash` covers documentRef, relative path, title, kind, chapter number, source ordinal, source start line, and content hash.
- `index_revisions.source_snapshot_hash` is derived from document semantic hashes, so source ordering and evidence-location changes participate in freshness.
- `writing_index(status)` compares the freshly loaded adapter snapshot with the current valid index. It returns `stale` plus `INDEX_SOURCE_CHANGED` when added, updated, or deleted source documents are pending.
- Operations for one work are serialized inside a `WritingService`.
- Mutating index operations use an exclusive `write.lock`. A live owner produces `INDEX_BUSY`; a dead PID lock can be reclaimed.
- Before a locked write, an absent active database is restored from `index.sqlite.previous`, and orphaned schema-owned temporary SQLite files are removed.
- If an atomic rename fails because the database is externally occupied, the public failure is normalized to `INDEX_BUSY`.
- The cache `.gitignore` is created only when absent and never overwrites an existing file.

The lock is cooperative between Writing MCP processes. It does not force unrelated programs to release SQLite handles; those conflicts remain explicit `INDEX_BUSY` failures.

## Consequences

- Existing schema v1/v2 indexes rebuild from authorized source files.
- Status currently reloads adapter content to guarantee correctness. A later mtime/size fast path may optimize this only if it preserves the same semantic snapshot result.
- Source order is now persisted and can be used by the subsequent chapter identity/order repair, but schema v3 does not itself change Chapter entity IDs or `precedes` generation.
- Cross-process crash recovery is deterministic for the replacement points represented by `.previous` and schema-owned temporary files. It is not a general distributed-lock protocol.
