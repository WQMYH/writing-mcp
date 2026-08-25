import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";

test("private report-only mode still rejects malformed annotation input", async () => {
  const root = await mkdtemp(join(tmpdir(), "writing-mcp-private-schema-"));
  try {
    const invalid = join(root, "invalid.json");
    await writeFile(invalid, JSON.stringify({ schemaVersion: 1, work: { private: true }, facts: [] }));
    const result = spawnSync(process.execPath, ["scripts/run-private-acceptance.mjs", "--report-only"], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, WRITING_MCP_PRIVATE_ACCEPTANCE: invalid } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Private acceptance data must use schemaVersion 2");
  } finally { await rm(root, { recursive: true, force: true }); }
});
