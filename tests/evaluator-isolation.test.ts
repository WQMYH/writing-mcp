import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { GenericAdapter } from "@writing-mcp/adapter-generic";
import { WritingService, type ParsedWork, type WorkCandidate } from "@writing-mcp/core";

class CountingGenericAdapter extends GenericAdapter {
  loadCount = 0;

  override async load(candidate: WorkCandidate): Promise<ParsedWork> {
    this.loadCount++;
    return super.load(candidate);
  }
}

async function makeSearchService() {
  const root = await mkdtemp(join(tmpdir(), "writing-mcp-evaluator-"));
  await writeFile(join(root, "direct.md"), "# Direct\n安娜在北塔值守。\n");
  await writeFile(join(root, "alias.md"), "# Alias\n小娜在港口值守。\n");
  const adapter = new CountingGenericAdapter();
  const service = new WritingService([adapter]);
  const resolved = await service.resolve(root, "generic");
  if (!resolved.workRef) throw new Error("controlled fixture did not resolve");
  await service.index(resolved.workRef, "rebuild");
  return { root, adapter, service, workRef: resolved.workRef };
}

async function makePrfSearchService() {
  const root = await mkdtemp(join(tmpdir(), "writing-mcp-prf-"));
  await writeFile(join(root, "one.md"), "# One\nlost crown beacon is observed from the north.\n");
  await writeFile(join(root, "two.md"), "# Two\nlost crown beacon is observed from the south.\n");
  await writeFile(join(root, "target.md"), "# Target\nthe beacon opens the sealed archive.\n");
  const adapter = new CountingGenericAdapter();
  const service = new WritingService([adapter]);
  const resolved = await service.resolve(root, "generic");
  if (!resolved.workRef) throw new Error("PRF fixture did not resolve");
  await service.index(resolved.workRef, "rebuild");
  return { root, adapter, service, workRef: resolved.workRef };
}

describe("evaluator-only search experiments", () => {
  test("does not let WRITING_MCP_ABLATE alter ordinary service results", async () => {
    const fixture = await makeSearchService();
    const prior = process.env.WRITING_MCP_ABLATE;
    try {
      const baseline = await fixture.service.explore(fixture.workRef, "search", "安娜", 10, 0);
      process.env.WRITING_MCP_ABLATE = "no_coverage,no_alias";
      const withEnvironment = await fixture.service.explore(fixture.workRef, "search", "安娜", 10, 0);
      expect(withEnvironment.results.map((item) => item.ref)).toEqual(baseline.results.map((item) => item.ref));
      expect(withEnvironment.results.map((item) => item.score)).toEqual(baseline.results.map((item) => item.score));
    } finally {
      if (prior === undefined) delete process.env.WRITING_MCP_ABLATE;
      else process.env.WRITING_MCP_ABLATE = prior;
      fixture.service.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("applies an explicitly injected evaluator variant without changing production search", async () => {
    const fixture = await makeSearchService();
    try {
      const ordinary = await fixture.service.explore(fixture.workRef, "search", "安娜", 10, 0);
      const evaluated = await fixture.service.evaluateSearch(fixture.workRef, "安娜", 10, { disabledFactors: ["coverage"] });
      expect(ordinary.results[0]?.evidence.excerpt).toContain("安娜");
      expect(evaluated.results[0]?.evidence.excerpt).toContain("小娜");
      expect((await fixture.service.explore(fixture.workRef, "search", "安娜", 10, 0)).results[0]?.evidence.excerpt).toContain("安娜");
    } finally {
      fixture.service.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("runs evaluator variants against one indexed work without reloading it", async () => {
    const fixture = await makeSearchService();
    try {
      const loadsAfterIndex = fixture.adapter.loadCount;
      await fixture.service.evaluateSearch(fixture.workRef, "安娜", 10, { disabledFactors: ["coverage"] });
      await fixture.service.evaluateSearch(fixture.workRef, "安娜", 10, { disabledFactors: ["alias"] });
      expect(fixture.adapter.loadCount).toBe(loadsAfterIndex);
    } finally {
      fixture.service.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("keeps the evaluator baseline separate and matches the accepted production PRF configuration", async () => {
    const fixture = await makePrfSearchService();
    try {
      const baseline = await fixture.service.evaluateSearch(fixture.workRef, "lost crown", 10, {});
      const expanded = await fixture.service.evaluateSearch(fixture.workRef, "lost crown", 10, {
        prf: { topK: 5, termCount: 4, weight: 0.35 },
      });
      expect(baseline.results.some((item) => item.title === "Target")).toBe(false);
      expect(expanded.results.some((item) => item.title === "Target")).toBe(true);
      expect(expanded.diagnostics.some((item) => item.code === "PRF_EXPANDED")).toBe(true);
      const narrow = await fixture.service.evaluateSearch(fixture.workRef, "lost crown", 1, {
        prf: { topK: 5, termCount: 4, weight: 0.35 },
      });
      expect(narrow.results).toHaveLength(1);
      expect(narrow.diagnostics.some((item) => item.code === "PRF_EXPANDED")).toBe(true);
      const production = await fixture.service.explore(fixture.workRef, "search", "lost crown", 10, 0);
      const accepted = await fixture.service.evaluateSearch(fixture.workRef, "lost crown", 10, {
        prf: { topK: 5, termCount: 6, weight: 0.35 },
      });
      const acceptedAgain = await fixture.service.evaluateSearch(fixture.workRef, "lost crown", 10, {
        prf: { topK: 5, termCount: 6, weight: 0.35 },
      });
      expect(production.results).toEqual(accepted.results);
      expect(production.results).not.toEqual(baseline.results);
      expect(acceptedAgain.results).toEqual(accepted.results);
    } finally {
      fixture.service.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects evaluator PRF settings outside the frozen calibration grid", async () => {
    const fixture = await makePrfSearchService();
    try {
      await expect(fixture.service.evaluateSearch(fixture.workRef, "lost crown", 10, {
        prf: { topK: 6, termCount: 4, weight: 0.35 },
      })).rejects.toMatchObject({ code: "INVALID_SEARCH_EXPERIMENT" });
    } finally {
      fixture.service.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
