# Writing MCP

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--v3.0--only-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-24.x-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](#quality-gates)
[![pnpm](https://img.shields.io/badge/pnpm-11%2B-orange.svg)](https://pnpm.io/)

**English** | [简体中文](README.zh-CN.md)

A local, deterministic knowledge-access and context-supply layer for writing agents, served over the [Model Context Protocol](https://modelcontextprotocol.io) (stdio). Writing MCP turns authorized fiction projects — InkOS, Markdown, UTF-8/GB18030 TXT, and conversion-type EPUB — into a rebuildable SQLite/FTS5 index, then answers retrieval, bounded graph exploration, and token-budgeted context queries with verifiable evidence excerpts. No LLM inside; your agent stays the writer.

## Design principles

- **Deterministic by construction** — the same index revision and query always produce the same answer; ranking and assembly are fully reproducible and machine-gated.
- **Evidence-backed** — every fact carries source references, byte/character counts, SHA-256 excerpt hashes, and explicit omission reasons when something did not fit the budget.
- **Read-only and sandboxed** — sources are accessed through explicitly authorized roots with symlink/junction escape protection; the server never writes back to your manuscripts.
- **Honest accounting** — token numbers are explicitly labeled heuristic estimates over evidence excerpts (`accountingScope: evidence_excerpts_only`), with enough material published for an external tokenizer to verify independently.
- **Private by default** — diagnostics record parameter summaries, outcomes, timings, and reference hashes; prose content and absolute paths are not persisted.

## The five tools

| Tool | Purpose |
|---|---|
| `writing_resolve` | Identify works under the authorized roots and return a `workRef` |
| `writing_index` | Build or incrementally refresh the per-work index; `status` reports freshness |
| `writing_explore` | Search, entities, neighborhoods, relations, 0–3 hop BFS, timeline, document and stats queries |
| `writing_context` | Assemble a `ContextPacket`: layered (L0–L3) evidence selection with required refs, chapter/entity/document constraints, exclusions, dedup, and budget trimming |
| `writing_diagnose` | Health inspection and sanitized diagnostic captures |

Typical call order: `writing_resolve` → `writing_index(status)` → `writing_explore` / `writing_context`. A `workRef` is valid for the lifetime of the server process.

## Quick start

Requirements: **Node.js 24.x** (built-in `node:sqlite` with FTS5) and **pnpm 11+**.

```powershell
pnpm install
pnpm verify   # privacy gate + typecheck + lint + tests + benchmark + coverage
```

Start over stdio:

```powershell
$env:WRITING_MCP_ROOTS = "E:\WritingProjects"   # bash: export WRITING_MCP_ROOTS=...
pnpm start
```

`WRITING_MCP_ROOTS` must point at directories you explicitly authorize (Windows separates multiple roots with `;`, Unix with `:`). Point your MCP client at the built server:

```json
{
  "mcpServers": {
    "writing-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["<repo-root>/packages/mcp-server/dist/index.js"],
      "cwd": "<repo-root>",
      "env": { "WRITING_MCP_ROOTS": "<authorized-writing-root>" }
    }
  }
}
```

Full client setup — Qoder and Codex configuration, first-call walkthrough, and a seven-category troubleshooting guide — lives in [docs/CLIENT_SETUP.md](docs/CLIENT_SETUP.md).

## How it fits together

```text
InkOS / Markdown / TXT / EPUB          (authorized roots, read-only)
        │  adapters (format detection, chapter splitting, EPUB spine parsing)
        ▼
.writing-index/<workId>/index.sqlite   (SQLite + FTS5, schema-versioned,
        │                               incremental, transactional, rebuildable)
        │  deterministic retrieval (exact + FTS5/BM25, aliases, PRF,
        │                           bounded BFS, relation evidence)
        ▼
MCP stdio tools                        (resolve → index → explore → context → diagnose)
        │  evidence excerpts + hashes + budget accounting
        ▼
Your AI agent                          (does the writing; MCP never does)
```

## What it deliberately does not do

- Generate, rewrite, or write back manuscript content, or make creative decisions;
- Call external LLMs, vector databases, or network services;
- Store agent reasoning, session memory, or model state;
- Claim exact token savings — see the honest-accounting note above.

## Quality gates

Every `pnpm verify` runs the privacy history gate, a strict TypeScript build, zero-warning lint, the full test suite, a frozen 30-task public benchmark (fact recall, evidence coverage, response budgets), and coverage ratchet thresholds. Test inventory: [tests/README.md](tests/README.md).

## Repository layout

```text
packages/
├─ core/                  # store, retrieval, PRF, context assembly
├─ adapter-generic/       # Markdown / TXT / EPUB adapters
├─ adapter-inkos/         # InkOS project structure adapter
├─ mcp-server/            # stdio server, five tools, diagnostics
├─ host-bridge-protocol/  # frozen host-plugin protocol v1 (Zod + fixtures)
└─ host-plugin-storyforge/# first governed static host-plugin manifest
tests/  docs/  scripts/  fixtures/
```

## Host integration plugins

Writing MCP is designed to stay a focused core: host-specific integrations live in governed, static plugins outside the five public tools. The first one — a local loopback host bridge for browser-based writing hosts — has its wire protocol frozen as v1 in [`packages/host-bridge-protocol`](packages/host-bridge-protocol) with canonical cross-repo fixtures in [`fixtures/host-bridge-protocol`](fixtures/host-bridge-protocol); the bridge runtime is currently in development. Nothing host-specific enters the core MVP.

## Project status

M0–M3 (protocol, indexing, retrieval) are complete with machine gates; M4 (context assembly) is in its final verification slice pending external tokenizer review; M5 (client acceptance) has its documentation slice landed. The single source of truth for all status claims is [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

## Documentation

| Document | Contents |
|---|---|
| [docs/CLIENT_SETUP.md](docs/CLIENT_SETUP.md) | Node/pnpm prerequisites, Qoder/Codex stdio configuration, first calls, troubleshooting |
| [docs/M0_CONTRACT.md](docs/M0_CONTRACT.md) | Frozen protocol and data contract: tool schemas, envelopes, diagnostics |
| [docs/REFERENCE.md](docs/REFERENCE.md) | Tool semantics and parameters in depth |
| [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) | Milestone state, machine-gate evidence, traceable commits |
| [tests/README.md](tests/README.md) | Test file → topic coverage map |

## License

Writing MCP is licensed under the GNU Affero General Public License v3.0 only ([LICENSE](LICENSE)); third-party dependencies retain their own licenses.
