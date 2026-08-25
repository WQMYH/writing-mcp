import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";

test("only gold:update mutates an explicit controlled baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "writing-mcp-gold-scripts-"));
  try {
    const source = join(root, "novel.md"), annotation = join(root, "annotations.json"), baseline = join(root, "baseline.json");
    await writeFile(source, ["# 第一章\nalpha evidence", "# 第二章\nbeta", "# 第三章\ngamma", "# 第四章\ndelta evidence", "# 第五章\nepsilon", "# 第六章\nzeta"].join("\n\n"));
    await writeFile(annotation, JSON.stringify({ schemaVersion: 2, work: { private: true, sourcePath: source }, facts: [
      { id: "holdout", query: "alpha", evidenceQuotes: ["alpha evidence"], expectedChapters: { volume: 1, chapter: 1 }, required: true },
      { id: "train", query: "delta", evidenceQuotes: ["delta evidence"], expectedChapters: { volume: 1, chapter: 4 }, required: true }
    ] }));
    const env = { ...process.env, WRITING_MCP_PRIVATE_ACCEPTANCE: annotation, WRITING_MCP_GOLD_BASELINE_PATH: baseline };
    const run = (script: string) => spawnSync(process.execPath, [script], { cwd: process.cwd(), encoding: "utf8", env });
    const update = run("scripts/gold-update.mjs");
    expect(update.status, update.stderr).toBe(0);
    const written = await readFile(baseline, "utf8");
    expect(run("scripts/gold-gate.mjs").status).toBe(0);
    expect(run("scripts/gold-check.mjs").status).toBe(0);
    expect(run("scripts/gate-gold-evidence.mjs").status).toBe(0);
    expect(await readFile(baseline, "utf8")).toBe(written);
  } finally { await rm(root, { recursive: true, force: true }); }
});
