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

The server exposes `writing_resolve`, `writing_index`, `writing_explore`, and `writing_context`. Call `writing_resolve` first; a `workRef` is scoped to the running server process.

Example client configuration:

```json
{
  "mcpServers": {
    "writing": {
      "command": "node",
      "args": ["E:/Programming/AI/Agents/Writing/writing-mcp/packages/mcp-server/dist/index.js"],
      "env": {
        "WRITING_MCP_ROOTS": "E:/WritingProjects"
      }
    }
  }
}
```
