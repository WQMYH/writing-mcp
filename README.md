# Writing MCP

[![verify](https://github.com/WQMYH/writing-mcp/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/WQMYH/writing-mcp/actions/workflows/verify.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--v3.0--only-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-24.x-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](#quality-gates)
[![pnpm](https://img.shields.io/badge/pnpm-11%2B-orange.svg)](https://pnpm.io/)

**English** | [简体中文](README.zh-CN.md)

A local, deterministic knowledge-access and context-supply layer for writing agents, served over the [Model Context Protocol](https://modelcontextprotocol.io) (stdio). Writing MCP turns authorized fiction projects — InkOS, Markdown, UTF-8/GB18030 TXT, and conversion-type EPUB — into a rebuildable SQLite/FTS5 index, then answers retrieval, bounded graph exploration, and token-budgeted context queries with verifiable evidence excerpts. No LLM inside; your agent stays the writer.

## Why this exists

A novel outgrows the context window long before it is finished. Once an agent is working from memory of what it read earlier, established facts drift and plausible inventions appear — a character's eye colour, who was present at a scene, whether a clue has been paid off yet. Most text-oriented MCP servers answer this by wrapping a vector database (nearest neighbours, no locators) or by wrapping an LLM (fluent, unauditable). Writing MCP wraps neither: it reads the manuscript deterministically and returns the exact span, its file, its line range and a hash of its text, so a claim can be checked against the source instead of trusted. If the server cannot support an answer, it says so and names the reason.

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

The workspace packages are still `private: true` — there is no `npm install writing-mcp`. Run it from a clone:

```bash
git clone https://github.com/WQMYH/writing-mcp.git
cd writing-mcp
pnpm install
pnpm build
pnpm verify   # privacy gate + typecheck + lint + tests + benchmark + coverage
```

Start the server over stdio, authorizing one or more writing directories:

```bash
export WRITING_MCP_ROOTS="/path/to/your/writing-projects"
pnpm start
```

```powershell
$env:WRITING_MCP_ROOTS = "C:\path\to\writing-projects"
pnpm start
```

`WRITING_MCP_ROOTS` is required and accepts multiple roots separated by the platform path delimiter (`;` on Windows, `:` on Unix). Resolved source files and traversed symlinks/junctions must remain inside an authorized root — anything outside is refused with `PATH_NOT_ALLOWED` before it is read.

The derived index is written next to the source under `.writing-index/<workId>/`; the manuscripts themselves are never modified. Delete that directory and the index rebuilds from scratch.

Point your MCP client at the built server:

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

## A real response

Both blocks below are measured output from `fixtures/generic-novel/` — the three-file synthetic project committed in this repository — captured against a built-from-source `dist`, so you can reproduce them with any MCP client. Long fields are elided with `…`.

```jsonc
// writing_explore  { "workRef": "work:…", "operation": "search", "query": "铜钥匙", "limit": 3 }
{
  "revision": 1,
  "freshness": "fresh",
  "operation": "search",
  "results": [
    {
      "ref": "span:fe51910281f7c57c279bebec",
      "kind": "character",
      "title": "林秋",
      "sourceKind": "deterministic",
      "confidence": 1,
      "evidence": {
        "relativePath": "characters.md",
        "startLine": 3,
        "endLine": 5,
        "excerpt": "## 林秋\n\n林秋是调查员，随身携带一枚铜钥匙。",
        "evidenceHash": "afb424773a948012f12d855575b97f1096bdacf06411b48c0491eaf89acdb53d"
      }
    }
    // …2 further chapter spans, same shape
  ],
  "ambiguous": [],
  "truncated": false,
  "metrics": { "candidateCount": 3, "returnedCount": 3, "visitedNodes": 3, "maxActualHops": 0, "omittedEstimate": 0 },
  "diagnostics": [
    { "code": "QUERY_ANALYZED", "message": "Deterministic query analysis produced 1 term(s)" },
    { "code": "PRF_EXPANDED", "message": "Deterministic two-pass search added 8 bounded expansion term(s): 钥匙, 铜钥, 下档案, 地下档, 档案室, 下档, 下档案室, 北塔" }
  ]
}
```

A query in Chinese matched text it never tokenized: no dictionary, no segmentation model, no embedding. `relativePath` + `startLine`/`endLine` locate the claim, and `evidenceHash` is a SHA-256 over exactly the returned `excerpt`, so a reader can confirm the server did not paraphrase. The `diagnostics` array names the expansion terms the ranking actually used — the mechanism is inspectable rather than implied.

```jsonc
// writing_context  { "workRef": "work:…", "query": "铜钥匙 和 北塔 有什么关系？", "budgetTokens": 160 }
{
  "status": "complete",
  "revision": 1,
  "budgetTokens": 160,
  "usedTokens": 140,
  "estimated": true,
  "estimator": "mixed-cjk-v1",
  "accountingScope": "evidence_excerpts_only",
  "blocks": [
    { "layer": "L1", "kind": "character", "title": "林秋",  "tokens": 24, "required": false, "evidence": { "relativePath": "characters.md", "startLine": 3, "endLine": 5, "evidenceHash": "afb4247…" } },
    { "layer": "L1", "kind": "character", "title": "周岚",  "tokens": 23, "required": false, "evidence": { "…" : "…" } },
    { "layer": "L2", "kind": "chapter",   "title": "第一章 雨夜",  "tokens": 41, "required": false, "evidence": { "relativePath": "chapter-01.md", "…" : "…" } },
    { "layer": "L2", "kind": "chapter",   "title": "第二章 地下室", "tokens": 52, "required": false, "evidence": { "relativePath": "chapter-02.md", "…" : "…" } }
  ],
  "omitted": []
}
```

Note what `usedTokens` does and does not claim: `estimated: true` with `accountingScope: evidence_excerpts_only` means the figure counts the returned excerpts only — not refs, headings, locators, omissions, diagnostics or JSON framing — using the published `mixed-cjk-v1` heuristic. It is material for an external tokenizer to check, not an exact model-token count. Blocks are tagged with the layer they came from, and `omitted` lists what did not fit and why (empty here: everything fit).

These are 174 characters of synthetic fixture text. They demonstrate response *shape* and honesty of accounting; they say nothing about speed or quality at novel length. Those gates live in [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

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

`pnpm verify` is the whole chain, and CI runs it on every push to `main` and every pull request, on ubuntu and windows:

| Gate | Command | Threshold is fixed at |
|---|---|---|
| Publication privacy gate | `pnpm privacy:gate` | Fails if any object reachable from local branches/tags contains a banned privacy marker; runs *first*, so a leak cannot be one commit away from `main` |
| Strict typecheck | `pnpm check` | `tsc -b` with `strict: true`; the package sources carry zero `any` annotations and zero `@ts-ignore`, both greppable claims |
| Zero-warning lint | `pnpm lint` | `oxlint --deny-warnings` over `packages`, `tests`, `scripts` — with `packages/core/src/store.ts` still ignored, because its dense formatting trips oxlint's minified-file heuristic (tracked as AUD-035, whose fix is to split the file) |
| Tests | `pnpm test` | Suite plus the documentation contract tests; file → topic map in [tests/README.md](tests/README.md) |
| Frozen public benchmark | `pnpm benchmark` | 30 tasks; minimum fact recall 0.90, minimum evidence coverage 1.00, minimum token reduction 0.60 |
| Coverage ratchet | `pnpm coverage` | lines 90%, statements 87%, functions 85%, branches 73% |

`pnpm benchmark` on the repository fixture is deterministic and currently reports **30/30 tasks passed, 30/30 evidence-covered, fact recall 10/10, token reduction 0.669** against the 0.60 gate — the average context packet costs 55 estimated tokens where the whole fixture costs 166. Reproduce it with `pnpm build && pnpm benchmark`.

What the benchmark does **not** measure: prose quality, whether an assembled packet makes a better chapter, retrieval quality on your corpus, or exact model-token savings. It gates retrieval correctness, evidence traceability and excerpt-only token accounting on a committed fixture. Larger-corpus gates exist but depend on material that is not published here, so they are recorded in [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) rather than claimed in this file.

## Repository layout

```text
packages/
├─ core/                  # store, retrieval, PRF, context assembly
├─ adapter-generic/       # Markdown / TXT / EPUB adapters
├─ adapter-inkos/         # InkOS project structure adapter
├─ mcp-server/            # stdio server, five tools, diagnostics
├─ host-bridge/           # optional loopback bridge runtime for browser hosts
├─ host-bridge-protocol/  # frozen host-plugin protocol v1 (Zod + fixtures)
└─ host-plugin-storyforge/# first governed static host-plugin manifest
tests/  docs/  scripts/  fixtures/
```

## Host integration plugins

Writing MCP is designed to stay a focused core: host-specific integrations live in governed, static plugins outside the five public tools. The first one — a local loopback host bridge for browser-based writing hosts — has its wire protocol frozen as v1 in [`packages/host-bridge-protocol`](packages/host-bridge-protocol), canonical cross-repo fixtures in [`fixtures/host-bridge-protocol`](fixtures/host-bridge-protocol), and an implemented runtime in [`packages/host-bridge`](packages/host-bridge). Storyforge startup wiring and the real browser-to-Bridge-to-Writing-MCP acceptance chain are implemented, including fail-closed behavior and explicit one-shot bypass. Nothing host-specific enters the core MVP.

## Project status

Phased M0–M5, and the labels below are the ones [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) actually carry — that file is the single source of truth, and this section summarizes it rather than competing with it:

| | |
|---|---|
| M0 protocol and contract | Mostly complete (versioned contract, five tool schemas, uniform envelopes, 30-task benchmark, token and fact baselines) |
| M0.1 diagnostics | Complete (all-tool diagnostic wrapper, explicit capture, redaction, bounded retention) |
| M1 adapters and boundaries | Reinforcing (authorized roots, InkOS/Markdown/TXT/EPUB, locator and lifecycle hardening) |
| M2 index and truthfulness | Base gate complete (SQLite/FTS5 schema v4, revisions, transactions, atomic replacement, recovery) |
| M3 retrieval | Mostly complete (search/entity/neighborhood/document/stats, unsegmented Chinese question analysis, bounded BFS, timeline, deterministic two-pass PRF) |
| M4 context assembly | In progress — extraction and budget gates landed; external tokenizer review of the token estimate is open |
| M5 client acceptance | In progress — the documentation slice is landed; real-client connectivity and more EPUB/InkOS variants are not |

Nothing in this repository is v1-complete: M3–M5 remain, and the project does not claim otherwise. There are no versioned release tags or GitHub releases yet, and the packages stay `private: true` until the M4 external-tokenizer review lands; the first `v0.x` release follows that gate rather than a date. Current next steps are listed in [docs/IMPLEMENTATION_STATUS.md § 下一步](docs/IMPLEMENTATION_STATUS.md).

## Documentation

| Document | Contents |
|---|---|
| [docs/CLIENT_SETUP.md](docs/CLIENT_SETUP.md) | Node/pnpm prerequisites, Qoder/Codex stdio configuration, first calls, troubleshooting |
| [docs/M0_CONTRACT.md](docs/M0_CONTRACT.md) | Frozen protocol and data contract: tool schemas, envelopes, diagnostics |
| [docs/REFERENCE.md](docs/REFERENCE.md) | Tool semantics and parameters in depth |
| [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) | Milestone state, machine-gate evidence, traceable commits |
| [docs/RELIABILITY_REPAIR_PLAN.md](docs/RELIABILITY_REPAIR_PLAN.md) | Frozen execution plan for the 2026-08-20 reliability repair round: branch discipline, red-first rule, per-task gates (Chinese) |
| [docs/adr/](docs/adr) | Five accepted architecture decision records (deterministic local core, EPUB parsing, and the schema v2→v4 evidence model evolution) |
| [tests/README.md](tests/README.md) | Test file → topic coverage map |
| [SECURITY.md](SECURITY.md) | Threat model boundary, what the privacy guarantees cover, how to report a vulnerability |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Gate chain, red-first convention, documentation discipline |

Language note: this README, [README.zh-CN.md](README.zh-CN.md), `docs/M0_CONTRACT.md`, the ADRs, [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md) are the English set — `SECURITY.md` and `CONTRIBUTING.md` stay English-only because GitHub surfaces them to reporters and contributors who may not read Chinese; `docs/CLIENT_SETUP.md`, `docs/REFERENCE.md`, `docs/IMPLEMENTATION_STATUS.md` and `docs/RELIABILITY_REPAIR_PLAN.md` are written in Chinese. `docs/M0_CONTRACT.md` is normative for wire behaviour — where a translated summary and the contract disagree, the contract wins.

## Contributing

Nothing merges on trust. A change is mergeable when `pnpm verify` passes on it — including the documentation contract tests, which check that setup examples stay parseable and free of personal paths. Evaluation chains that consume non-public material (`pnpm verify:private`) are reported separately in the status document and never substituted for the public gates. New behaviour arrives as a failing test first; the ordering of test and implementation is not stylistic, it is what makes a gate meaningful.

Design and planning documents stay out of Git by convention: the executable contract is the published schema plus the committed fixtures, and `docs/IMPLEMENTATION_STATUS.md` is the only place status claims are recorded. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full rules.

## License

Writing MCP is licensed under the GNU Affero General Public License v3.0 only ([LICENSE](LICENSE)); third-party dependencies retain their own licenses.
