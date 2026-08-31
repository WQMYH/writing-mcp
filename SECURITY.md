# Security Policy

Boundary document for the maintainers. Every claim below is a reading of the
checked-in source, with the file named so you can confirm it instead of trusting
this page.

## Supported versions

| Version | Supported |
|---|---|
| Current `main` | ✅ Yes — the only supported build, gated by `pnpm verify` on ubuntu and windows |
| `v0.x` tags | Not yet published — this repository has no tags or releases, so there is no older version to patch |

Because there is no release stream yet, fixes land on `main` and are described in
[docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md), which records a
traceable commit per status claim.

## What is and is not in the trust boundary

Writing MCP is a **local, stdio-only server** that reads manuscript sources and
answers questions about them. The threat model follows from that.

**Not in the threat model:**

- **Remote attackers over the network.** The core packages create no listener and
  make no outbound request. There is no `node:http`, `node:net`, `node:dns`,
  `fetch`, WebSocket or third-party client anywhere in `packages/core`,
  `packages/adapter-*` or `packages/mcp-server` — greppable in seconds. Transport
  is the stdio pipe your MCP client already authenticated.
- **Anyone who can already read your authorized roots.** A process with your file
  permissions does not need this server.
- **Anyone who can already read the index directory.** The derived index contains
  excerpts of the sources it indexed; it is protected by your filesystem
  permissions, not by the server. The `index.sqlite` under
  `.writing-index/<workId>/` is a copy of your text and should be treated with the
  same care as the manuscript itself.

**In the threat model** — and this is what the design actually defends:

1. **Source access is confined to explicitly authorized roots.**
   `WRITING_MCP_ROOTS` is required; with no roots configured the server refuses
   with `AUTHORIZED_ROOTS_REQUIRED` (`packages/core/src/ids.ts:19`). Every target
   path is passed through `realpath` before comparison
   (`packages/core/src/ids.ts:10`), so a symlink or a Windows junction that points
   outside the root resolves to its real destination first and is then rejected by
   `assertWithin` with `PATH_NOT_ALLOWED` (`packages/core/src/ids.ts:12-23`).
   Adapters do not swallow that error — a boundary violation propagates instead of
   silently returning an empty candidate list
   (`packages/adapter-generic/src/index.ts:42`, `packages/adapter-inkos/src/index.ts:130`).
   **Report this one aggressively.** Anything that reads outside a root is a bug.
2. **The server never writes back to your sources.** Writes go only to the derived
   `.writing-index/<workId>/` directory, and index replacement is atomic with a
   cooperative writer lock (`INDEX_BUSY`, `packages/core/src/store.ts:163-166`,
   `packages/core/src/store.ts:218`). A parser or index bug that modified, deleted
   or moved a source file is a security-relevant defect here, not just a data bug.
3. **Untrusted files are parsed under hard size caps.** EPUB is the highest-risk
   path — a ZIP is attacker-authorable and decompression bombs are the classic
   failure. Enforced limits: 4096 ZIP entries, 16 MiB per decoded spine document,
   64 MiB total decoded spine (`packages/adapter-generic/src/epub.ts:17`), plus an
   explicit check that a manifest `href` cannot normalize out of the package root
   (`EPUB_HREF_INVALID`, `packages/adapter-generic/src/epub.ts:82`). Plain text
   documents are capped at 16 MiB per file and 64 MiB per work
   (`packages/adapter-generic/src/txt.ts:10`, enforced as `SOURCE_FILE_TOO_LARGE` /
   `SOURCE_TOTAL_TOO_LARGE` in `packages/adapter-generic/src/index.ts:51-52`).
   A "zip bomb that fits the caps" is still a reportable DoS if it degrades below
   those numbers.
4. **Query input is bounded, and output is size-fitted.** `writing_explore`
   rejects queries over 2048 characters (`QUERY_TOO_LARGE`), clamps `limit` to
   1–100 and `maxHops` to 0–3 (`packages/core/src/store.ts:482`);
   `writing_context` rejects ref lists over 128 items or 256 characters per ref
   (`CONTEXT_REFS_TOO_LARGE`) and a `budgetTokens` outside 1–1,000,000
   (`BUDGET_OUT_OF_RANGE`) (`packages/core/src/store.ts:654`). Structured results
   are capped at 200,000 bytes and reduced deterministically rather than truncated
   mid-record (`packages/mcp-server/src/response-limits.ts:3`). Values reach SQLite
   only as bound parameters; the interpolated fragments inside prepared statements
   are generated `?` placeholder lists and fixed column or `WHERE` constants
   (`packages/core/src/store.ts:338-340`, `packages/core/src/store.ts:464`,
   `packages/core/src/store.ts:526`) — never query text, refs or paths. FTS5 search
   is the one place query text becomes SQL syntax, and each term is wrapped in
   double quotes with embedded quotes stripped before it enters the `MATCH`
   expression (`packages/core/src/store.ts:577-578`), so a query cannot inject FTS5
   operators.
5. **Diagnostics must not leak prose.** This is the project's real privacy
   engineering, because the corpus is other people's unpublished manuscripts.
   Invocation records persist a *summary* of parameters: only `workRef`,
   `adapterHint`, `mode`, `operation`, `taskType`, `purpose`, `action`,
   `diagnosticRunRef` and `contentPolicy` are stored as text; every other string
   becomes `{ type, length, sha256 }`, and arrays/objects become a hash of their
   serialization (`packages/mcp-server/src/diagnostics.ts:405-410`). Result views
   carry refs, trust labels, scores and a hash of the locators — titles, excerpts
   and locator contents never enter the report
   (`packages/mcp-server/src/diagnostics.ts:427-438`). Each report names its own
   redactions: `source_text`, `returned_excerpts`, `absolute_paths`,
   `stack_traces`, `sql`, `credentials`, `agent_reasoning`, `non_mcp_tools`
   (`packages/mcp-server/src/diagnostics.ts:222`), and stdout is reserved for the
   MCP protocol so report material cannot ride it
   (`packages/mcp-server/src/diagnostics.ts:159-160`).
   Query text is opt-in per capture (`contentPolicy: "query"`) and never default.
   Retention is bounded: the diagnostics directory is capped at 100 MiB and is
   rescanned every 1 MiB of appended bytes, evicting oldest non-protected reports
   and then whole closed capture groups until it converges
   (`packages/mcp-server/src/diagnostic-retention.ts:5-7`,
   `packages/mcp-server/src/diagnostic-retention.ts:75-108`).
   If you find a path where prose or an absolute path reaches disk, that is the
   single most valuable report you can send.
6. **Publication history is gated, not promised.** `pnpm privacy:gate`
   (`scripts/privacy-gate.mjs`) scans every object reachable from local refs —
   blob contents plus commit and tag messages — for banned markers and fails the
   build on any hit. It runs *first* in `pnpm verify`, so a leak cannot sit one
   commit away from `main`, and CI checks out with `fetch-depth: 0` specifically so
   the scan sees real history. The gate's own output is leak-safe: it prints the
   marker name, path and object id, never the matched text, and markers are stored
   hex-encoded so the scanner does not contain the plaintext it searches for.

## The host bridge is a separate boundary

`packages/host-bridge*` is **not** part of the five core tools and is not published
in this repository's current `main`. When it is, it adds the only inbound network
surface in the project, and it has its own enforcement order rather than inheriting
the stdio assumption: bind loopback, then check the peer address, then the `Host`
header, then an explicit `Origin` allowlist, then the bearer token
(`packages/host-bridge/src/server.ts:10`,
`packages/host-bridge/src/server.ts:107-116`). Pairing codes are single-use,
16 bytes of entropy, 10-minute TTL, and bearer tokens expire in 1 hour; only
SHA-256 hashes of secrets are retained in memory
(`packages/host-bridge/src/auth.ts:25-37`). A DNS-rebinding or cross-origin request
that reaches the port is expected to fail at the `Host`/`Origin` layer even with a
stolen token. Treat a way around that ordering as a vulnerability report.
Design detail lives in [docs/host-bridge/DESIGN.md](docs/host-bridge/DESIGN.md).

## Reporting a vulnerability

Open a **private security contact** first: reach the maintainer through the
address on their GitHub profile, or via GitHub's private-vulnerability-report
form on this repository if it is enabled. Include:

- the commit or tag you built from, and the OS (Windows and POSIX path handling
  differ, and both are gated);
- the tool call and argument shape that triggers it — **do not paste manuscript
  text**; a redacted or synthetic stand-in is enough, and please say which it is;
- which boundary you believe is violated, using the numbered list above.

Expected handling: an acknowledgement within 7 days; if confirmed, a fix on `main`
behind the full `pnpm verify` chain with a regression test planted *before* the
implementation, and an entry in `docs/IMPLEMENTATION_STATUS.md` pointing at the
commit. No coordinated-disclosure embargo is promised, because this is a
single-maintainer project with no release process — ask if you need one and the
question goes to the maintainer directly.

**Please do not** open a public issue for a boundary escape, and do not attach real
manuscript excerpts to any report, public or private: they are third parties'
unpublished work.

## Non-goals that are not vulnerabilities

- The token estimate is a published heuristic (`mixed-cjk-v1`) over evidence
  excerpts only, explicitly labelled `estimated: true` /
  `accountingScope: evidence_excerpts_only`. It is not an exact model-token count
  and does not claim to be.
- Determinism is a property of a fixed index revision and query; edits to your
  sources legitimately change answers.
- Retrieval quality on your corpus is a product gap, tracked in the status
  document, not a security issue.
- The server holds no authentication of its own: whatever can drive its stdio pipe
  can query whatever its authorized roots permit. Access control is your client
  configuration and your filesystem.
