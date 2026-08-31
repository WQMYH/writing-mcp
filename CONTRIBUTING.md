# Contributing

How a change becomes part of Writing MCP. The rules below are not decoration —
each one exists because a specific failure mode is otherwise easy to hit when the
corpus is other people's unpublished manuscripts and the selling point is
determinism.

## First, the two hard rules

1. **Nothing merges on trust.** A change is mergeable when `pnpm verify` passes on
   it. "It works locally" is not a gate; the gate chain below is.
2. **No real manuscripts, ever.** Fixtures are synthetic (`fixtures/generic-novel/`
   is 174 characters of invented text about a brass key). Do not add excerpts from
   a book you do not own, and do not paste real prose into issues, PRs, commit
   messages, test names, or diagnostic captures. The privacy gate is not a substitute
   for this rule; it is the net under it.

Everything else in this file follows from those two.

## Environment

| Requirement | Pinned at | Enforced by |
|---|---|---|
| Node.js | `>=24 <25` | `engines` in `package.json` — v24 is required for built-in `node:sqlite` with FTS5, which has no fallback |
| pnpm | `11.21.0` | `packageManager` field (enable corepack) |
| Install | `pnpm install --frozen-lockfile` | CI refuses a lockfile drift |

Bootstrap: `pnpm install && pnpm build && pnpm test`. The build is `tsc -b` across
the workspace; tests import TypeScript sources directly through the vitest aliases
in `vitest.config.ts`, so coverage measures `packages/*/src`, not `dist`.

## The gate chain

`pnpm verify` runs, in this order:

| # | Command | Gate |
|---|---|---|
| 1 | `pnpm privacy:gate` | Every object reachable from local refs — blob contents plus commit/tag messages — is scanned for banned privacy markers. Runs first on purpose: a leak should never be one commit away from `main`. Output names only the marker, path and object id, never the matched text. |
| 2 | `pnpm check` | `tsc -b` with `strict: true`. |
| 3 | `pnpm lint` | `oxlint -c oxlintrc.json --deny-warnings` over `packages`, `tests`, `scripts`. |
| 4 | `pnpm test` | vitest suite, including the documentation contract tests. |
| 5 | `pnpm benchmark` | Frozen 30-task public benchmark against minimum fact recall 0.90, evidence coverage 1.00, token reduction 0.60. |
| 6 | `pnpm coverage` | v8 thresholds: lines 90, statements 87, functions 85, branches 73. |

Known and disclosed limits of the chain:

- `packages/core/src/store.ts` is listed in `ignorePatterns` in `oxlintrc.json`.
  The file is written densely enough that oxlint's minified-file heuristic treats it
  as generated. That exclusion is tracked as **AUD-035** and its resolution is to
  split the file, not to keep the ignore. Do not add paths to `ignorePatterns`.
- `pnpm verify:private` (and the `gold:*`, `corpus:gate`, `private:measure` scripts)
  consume material that is not in this repository, selected through
  `WRITING_MCP_PRIVATE_ACCEPTANCE`, `WRITING_MCP_PRIVATE_CORPUS` and
  `WRITING_MCP_CORPUS_TASKS`. **The public chain reads none of those variables** —
  the names appear only in the private and experiment scripts, never in
  `scripts/run-benchmark.mjs`, `scripts/privacy-gate.mjs` or any package source.
  Those private entry points are themselves sandbox-tested: malformed annotation
  input still fails in report-only mode (`tests/private-script-mode.test.ts`), and
  only `gold:update` may mutate a controlled baseline
  (`tests/gold-script-isolation.test.ts`).
  Private results are reported separately in `docs/IMPLEMENTATION_STATUS.md` and
  are never substituted for a public gate — locally or in a PR description.
- Coverage thresholds are a ratchet. If you make a file smaller or better covered,
  raise the threshold in the same commit and say why; lowering one needs a real
  justification, not "the numbers moved".

## Red first, then green

New behaviour arrives as a failing test, and the ordering is not stylistic: a test
written after the implementation can pass for the wrong reason. In a PR, show the
red run — the assertion that failed before the fix is the evidence that the gate
means something.

- Tests live in `tests/*.test.ts`; add your file to the topic map in
  [`tests/README.md`](tests/README.md) so the suite stays navigable.
- Boundary behaviour is tested at the boundary: path escape → `PATH_NOT_ALLOWED`,
  missing roots → `AUTHORIZED_ROOTS_REQUIRED`, size caps → the specific
  `*_TOO_LARGE` code, lock contention → `INDEX_BUSY`, FTS failure → `FTS_DEGRADED`
  with the LIKE fallback still returned. See [SECURITY.md](SECURITY.md) for what
  each boundary is defending.
- Determinism is gated, not asserted. `tests/benchmark.test.ts` runs all 30 tasks in
  `benchmarks/m0.json` against expected output on every test run, and every ranking
  path ends in an explicit `ORDER BY` tiebreak resolving to a unique ref (grep the
  `ORDER BY` clauses in `packages/core/src/store.ts`). If your change makes output
  depend on wall-clock time, locale, object-key order, or map iteration, it needs a
  different design.

## Contracts

[`docs/M0_CONTRACT.md`](docs/M0_CONTRACT.md) is normative for wire behaviour. Where
a translated summary, a doc comment, and the contract disagree, the contract wins.

- The five tools — `writing_resolve`, `writing_index`, `writing_explore`,
  `writing_context`, `writing_diagnose` — and their envelopes are a frozen surface.
  Renaming or removing a published field is a breaking change: bump the version,
  update the committed fixtures, and write an ADR.
- Index schema changes go through a numbered migration and a new
  [ADR](docs/adr/) — see ADR-0003 through 0005 for the v2→v4 evidence-model
  precedent, each recording why the old shape stopped working.
- Adding a *sixth* core tool is not a small change. Host-specific or product-specific
  capability belongs in a governed plugin outside the five-tool surface; the
  host-bridge packages are the worked example of that boundary.
- Benchmark task sets are frozen. Editing a task to make a number pass is
  indistinguishable from cheating and will be rejected.

## Documentation discipline

- `docs/IMPLEMENTATION_STATUS.md` is the **only** place status claims are recorded,
  and each claim carries a traceable commit id. Other documents summarize it; they
  do not compete with it. If you change a status, change that file — in the same
  branch — and never a README alone.
- Design and planning documents stay out of Git. The executable contract is the
  published schema plus the committed fixtures. Frozen *execution plans* are the
  exception and are committed only once their round is closed, as a record of what
  was decided (see `docs/RELIABILITY_REPAIR_PLAN.md`).
- `README.md` and `README.zh-CN.md` are a pair. Update both in the same commit;
  a diverged translation is a documentation defect.
- Documentation is machine-checked: `tests/client-setup-docs.test.ts` parses the Qoder
  JSON and Codex TOML setup examples and asserts they contain
  `<authorized-writing-root>` and contain no personal absolute paths. Broken or
  machine-specific examples fail the suite, so keep placeholders placeholder.
- Numbers quoted in a README need a command that reproduces them. A figure with no
  reproducible source is deleted rather than footnoted.

## Commits and pull requests

Conventional Commits with a scope, and a body in the house format:

```text
fix(bridge): close HB-M3 reliability prerequisites

Motivation:
- what was broken, and why it matters now

Key changes:
- what moved, per file or subsystem

Verification: pnpm verify  (<what actually ran, and the outcome>)
```

`Verification:` is the line reviewers read first. If you ran only part of the
chain, say which part. The history rewrite that this project has already been
through is a good reminder that commit *content* is public forever: never put
tokens, credentials, personal email addresses, or absolute paths of private
machines in a message.

Work on a branch off `main`, one focused change per branch, and keep
`pnpm verify` green at each commit rather than only at the tip.

## What will not be merged

- Generated or LLM-written prose, comments, or documentation presented as verified.
  Nothing here outsources judgment to a model, including in its own repository.
- Claims of exact token savings. Estimates must stay labelled `estimated: true` with
  an explicit `accountingScope`, and the material needed to check them externally
  must stay in the response.
- Anything that writes back to a source file, or that reaches outside
  `WRITING_MCP_ROOTS`.
- Silent degradation — a caught-and-dropped error, an empty result where an error
  code belongs, a truncation without an `omitted` reason.
- Host-specific logic inside the core MVP, or a sixth tool smuggled in as a flag.
- A "temporary" disable of any gate in the chain.

## Getting help

Open an issue for anything that is not a security boundary — [SECURITY.md](SECURITY.md)
covers the boundary cases and how to report them privately. This is a
single-maintainer project without a release process, so responsiveness is uneven;
a small, self-contained PR with a red-first test is the fastest path to a merge.
