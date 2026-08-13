# ADR 0001: Deterministic local TypeScript core

- Status: Accepted
- Date: 2026-08-13

## Decision

Writing MCP v1 uses a TypeScript monorepo on Node.js 24. Its core performs local, deterministic parsing, SQLite/FTS5 indexing, bounded graph traversal and extractive context assembly. It does not call an LLM, network service or vector database.

The source files remain the sole source of truth. `.writing-index` is disposable derived state.

## Consequences

- Core behavior can be tested without credentials, network access or model variance.
- MCP and direct core tests share the same implementation.
- Semantic extraction and generative compression are deliberately deferred to an Agent or a later, explicitly versioned access-layer extension.
- Node 24 is required for the built-in `node:sqlite`; changing the runtime requires a new compatibility decision.
