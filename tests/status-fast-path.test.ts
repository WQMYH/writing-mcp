import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { WritingService } from "@writing-mcp/core";
import { GenericAdapter } from "@writing-mcp/adapter-generic";
import type { ParsedWork, WorkCandidate } from "@writing-mcp/core";

/** Counting adapter: records how many times load() ran (AUD-021 regression). */
class CountingGenericAdapter extends GenericAdapter {
  loadCount = 0;
  override async load(candidate: WorkCandidate): Promise<ParsedWork> {
    this.loadCount++;
    return super.load(candidate);
  }
}

describe("status mtime/size fast path (no semantic snapshot sacrifice)", () => {
  test("unchanged source returns fresh without re-reading files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-status-fast-"));
    const adapter = new CountingGenericAdapter();
    const service = new WritingService([adapter]);
    try {
      const source = join(dir, "novel");
      await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
      const resolved = await service.resolve(source, "generic");
      const workRef = resolved.workRef!;
      const rebuilt = await service.index(workRef, "rebuild");
      const loadsAfterRebuild = adapter.loadCount;
      // Fingerprint (name+mtime+size) unchanged: the existing store is reused
      // and adapter.load must not run again for repeated status calls.
      const second = await service.index(workRef, "status");
      const third = await service.index(workRef, "status");
      expect(adapter.loadCount).toBe(loadsAfterRebuild);
      // Fast-path result stays semantically identical to the full path.
      expect(second).toMatchObject({ freshness: "fresh", revision: rebuilt.revision });
      expect(second.stats).toEqual(third.stats);
      expect(second.diagnostics).toEqual([]);
      expect(second.contextSources).toEqual(third.contextSources);
    } finally {
      service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("source edit defeats the fast path and status reports stale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-status-fast-edit-"));
    const adapter = new CountingGenericAdapter();
    const service = new WritingService([adapter]);
    try {
      const source = join(dir, "novel");
      await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
      const resolved = await service.resolve(source, "generic");
      const workRef = resolved.workRef!;
      await service.index(workRef, "rebuild");
      const loadsAfterRebuild = adapter.loadCount;
      const chapter = join(source, "chapter-01.md");
      await writeFile(chapter, (await readFile(chapter, "utf8")) + "\n新增段落标记\n");
      const after = await service.index(workRef, "status");
      // mtime/size changed: the fast path must fall through to the full
      // semantic snapshot path and report the drift.
      expect(adapter.loadCount).toBeGreaterThan(loadsAfterRebuild);
      expect(after.freshness).toBe("stale");
      expect(after.diagnostics.some(d => d.code === "INDEX_SOURCE_CHANGED")).toBe(true);
    } finally {
      service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("status exposes the context source directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-status-sources-"));
    const service = new WritingService([new GenericAdapter()]);
    try {
      const source = join(dir, "novel");
      await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
      const resolved = await service.resolve(source, "generic");
      const workRef = resolved.workRef!;
      await service.index(workRef, "rebuild");
      const status = await service.index(workRef, "status");
      expect(status.contextSources).toBeDefined();
      // Fixture: one character document (L1) and two chapters (L2).
      expect(status.contextSources!.byLayer).toMatchObject({ L1: 1, L2: 2, L3: 0 });
      const byKindTotal = Object.values(status.contextSources!.byKind).reduce((sum: number, n: number) => sum + n, 0);
      expect(byKindTotal).toBe(status.stats.documents);
      const layerTotal = Object.values(status.contextSources!.byLayer).reduce((sum: number, n: number) => sum + n, 0);
      expect(layerTotal).toBe(status.stats.documents);
    } finally {
      service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
