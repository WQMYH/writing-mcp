import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

const run = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8", env });

describe("corpus performance gate scripts", () => {
  test("writes deterministic token evaluation material only under an explicit local report directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-corpus-gate-"));
    const corpus = join(root, "corpus"), reports = join(root, "reports"), reportsAgain = join(root, "reports-again"), tasks = join(root, "tasks.json");
    try {
      await cp(new URL("../fixtures/generic-novel", import.meta.url), corpus, { recursive: true });
      await writeFile(tasks, JSON.stringify({ explore: [{ operation: "search", query: "铜钥匙", limit: 10 }], context: [{ query: "铜钥匙", budgetTokens: 200 }] }));
      const result = run(["scripts/run-corpus-benchmark.mjs", corpus, tasks, reports], { ...process.env, WRITING_MCP_CORPUS_MAX_INDEX_PER_MILLION_MS: "1000000000" });
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(await readFile(join(reports, "corpus-benchmark-report.json"), "utf8"));
      expect(report.measurement).toEqual({ warmupRunsPerTask: 1, measuredRunsPerTask: 1, percentile: 0.95 });
      const materialPath = join(reports, "token-evaluation-materials.json");
      const first = JSON.parse(await readFile(materialPath, "utf8"));
      expect(first.schemaVersion).toBe("token-evaluation-materials-v1");
      expect(first.accountingScope).toBe("evidence_excerpts_only");
      expect(first.externalTokenResult).toBe("not_evaluated");
      expect(first.fullInput.text).toContain("铜钥匙");
      expect(first.contexts[0].packet.usedTokens).toBeGreaterThan(0);
      expect(first.contexts[0].accountedInputs.every((input: { ref: string; text: string; estimatedTokens: number }) => input.ref && input.text && Number.isFinite(input.estimatedTokens))).toBe(true);
      expect(first.contexts[0].accountedInputs.reduce((sum: number, input: { estimatedTokens: number }) => sum + input.estimatedTokens, 0)).toBe(first.contexts[0].packet.usedTokens);
      expect(first.contexts[0].packet.refs.length).toBeGreaterThan(0);
      const secondRun = run(["scripts/run-corpus-benchmark.mjs", corpus, tasks, reportsAgain], { ...process.env, WRITING_MCP_CORPUS_MAX_INDEX_PER_MILLION_MS: "1000000000" });
      expect(secondRun.status, secondRun.stderr).toBe(0);
      const second = JSON.parse(await readFile(join(reportsAgain, "token-evaluation-materials.json"), "utf8"));
      expect(second).toEqual(first);
      expect(result.stdout).not.toContain(root);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("defaults a single-file corpus report below its parent and rejects empty task sets", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-corpus-file-"));
    const corpus = join(root, "novel.txt"), tasks = join(root, "tasks.json");
    try {
      await writeFile(corpus, "# 第一章\n铜钥匙在北塔。\n");
      await writeFile(tasks, JSON.stringify({ explore: [], context: [] }));
      const empty = run(["scripts/run-corpus-benchmark.mjs", corpus, tasks]);
      expect(empty.status).toBe(1);
      expect(empty.stderr).toContain("non-empty explore and context arrays");
      await writeFile(tasks, JSON.stringify({ explore: [{ operation: "search", query: "铜钥匙" }], context: [{ query: "铜钥匙", budgetTokens: 50 }] }));
      const isolatedEnv = { ...process.env, WRITING_MCP_CORPUS_MAX_INDEX_PER_MILLION_MS: "1000000000" };
      delete isolatedEnv.WRITING_MCP_PRIVATE_REPORT_DIR;
      const result = run(["scripts/run-corpus-benchmark.mjs", corpus, tasks], isolatedEnv);
      expect(result.status, result.stderr).toBe(0);
      await expect(readFile(join(root, ".writing-index", "benchmarks", "token-evaluation-materials.json"), "utf8")).resolves.toContain("token-evaluation-materials-v1");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("fails a controlled fixture when a machine threshold is exceeded", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-corpus-threshold-"));
    const corpus = join(root, "corpus"), reports = join(root, "reports"), tasks = join(root, "tasks.json");
    try {
      await cp(new URL("../fixtures/generic-novel", import.meta.url), corpus, { recursive: true });
      await writeFile(tasks, JSON.stringify({ explore: [{ operation: "search", query: "铜钥匙", limit: 10 }], context: [{ query: "铜钥匙", budgetTokens: 200 }] }));
      const result = run(["scripts/run-corpus-benchmark.mjs", corpus, tasks, reports], { ...process.env, WRITING_MCP_CORPUS_MAX_EXPLORE_P95_MS: "0.000001" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Explore P95 exceeded");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
