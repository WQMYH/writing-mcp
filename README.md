# Writing MCP

TypeScript MVP for evidence-backed writing retrieval and token-budgeted context assembly.

## Requirements

- Node.js 24.x (uses built-in `node:sqlite` with FTS5)
- pnpm 11+

## Verify

```powershell
pnpm install
pnpm build
pnpm test
```

## Run over stdio

```powershell
$env:WRITING_MCP_ROOTS="E:\WritingProjects"
pnpm start
```

`WRITING_MCP_ROOTS` is required by the MCP server and accepts one or more explicitly authorized directories separated by the platform path delimiter (`;` on Windows, `:` on Unix). Resolved source files and traversed symlinks/junctions must remain inside an authorized root.

The server exposes `writing_resolve`, `writing_index`, `writing_explore`, `writing_context`, and `writing_diagnose`. Call `writing_resolve` first; a `workRef` is scoped to the running server process.

Every tool response includes a concise diagnostic report on both success and failure. The server also writes a redacted per-call JSON report and bounded JSONL events under the work's derived `.writing-index/<workId>/diagnostics/` directory. This is enforced by a shared server-side handler and does not depend on agent prompts.

To capture a small real-user MCP call chain, call `writing_diagnose` with `action: "start_capture"` and `purpose: "development"`, pass the returned `diagnosticRunRef` to subsequent tools, then call `writing_diagnose` with `action: "finish_capture"`. The final JSON report observes MCP calls only; it excludes agent reasoning, other tools, source excerpts, absolute paths, stacks, SQL, and credentials. `contentPolicy: "query"` must be explicitly selected if query text is needed for a local diagnostic run.

Example client configuration:

```json
{
  "mcpServers": {
    "writing-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["<repo-root>/packages/mcp-server/dist/index.js"],
      "cwd": "<repo-root>",
      "env": {
        "WRITING_MCP_ROOTS": "<authorized-writing-root>"
      }
    }
  }
}
```

For the supported v1 stdio setup, use placeholder roots rather than personal paths, follow `writing_resolve` → `writing_index(status)` → `writing_diagnose(inspect)`, and consult the seven failure diagnostics and privacy boundary in [docs/CLIENT_SETUP.md](docs/CLIENT_SETUP.md). The document includes both Qoder JSON and Codex TOML examples.
