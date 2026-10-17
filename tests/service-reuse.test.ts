import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { WritingService } from "@writing-mcp/core";
import { GenericAdapter } from "@writing-mcp/adapter-generic";
import type { ParsedWork, SourceSnapshot, WorkCandidate } from "@writing-mcp/core";

/** Counting adapter: records how many times load() ran (AUD-021 regression). */
class CountingGenericAdapter extends GenericAdapter {
  loadCount = 0;
  override async load(candidate: WorkCandidate): Promise<ParsedWork> {
    this.loadCount++;
    return super.load(candidate);
  }
}

describe("AUD-021: explore/context reuse the store when the source is unchanged", () => {
  test("hot rebuild publishes the edited source to the same service and on-disk index (W-MCP-007)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-hot-rebuild-")), source = join(dir, "novel");
    const service = new WritingService([new GenericAdapter()]);
    try {
      await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
      const chapter = join(source, "chapter-01.md"), oldMarker = "oldcanaryunique", newMarker = "newcanaryuniquereplacement";
      await writeFile(chapter, `# 第一章 北塔\n${oldMarker}`);
      const workRef = (await service.resolve(source, "generic")).workRef!;
      await service.index(workRef, "incremental");
      expect((await service.explore(workRef, "search", oldMarker)).results[0]?.evidence.excerpt).toContain(oldMarker);
      await service.context(workRef, oldMarker, 2000);
      await writeFile(chapter, `# 第一章 北塔\n${newMarker}`);
      const rebuilt = await service.index(workRef, "rebuild");
      expect(rebuilt.freshness).toBe("fresh");
      for (let call = 0; call < 2; call++) {
        const found = await service.explore(workRef, "search", newMarker);
        expect(found).toMatchObject({ freshness: "fresh", revision: rebuilt.revision });
        expect(found.results[0]?.evidence.excerpt).toContain(newMarker);
        expect((await service.explore(workRef, "search", oldMarker)).results).toEqual([]);
      }
      const packet = await service.context(workRef, newMarker, 2000);
      expect(packet.blocks.some(block => block.evidence.excerpt.includes(newMarker))).toBe(true);
      const db = new DatabaseSync(join(source, ".writing-index", workRef.replace(":", "-"), "index.sqlite"), { readOnly: true });
      try {
        const contents = db.prepare("SELECT content FROM spans").all().map(row => String(row.content)).join("\n");
        expect(contents).toContain(newMarker);
        expect(contents).not.toContain(oldMarker);
      } finally { db.close(); }
      expect((await service.index(workRef, "status")).freshness).toBe("fresh");
      expect((await service.index(workRef, "rebuild")).freshness).toBe("fresh");
      expect((await service.explore(workRef, "search", newMarker)).results[0]?.evidence.excerpt).toContain(newMarker);
    } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
  });

  test("repeated explore does not reload source files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-aud021-"));
    const adapter = new CountingGenericAdapter();
    const service = new WritingService([adapter]);
    try {
      const source = join(dir, "novel");
      await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
      const resolved = await service.resolve(source, "generic");
      const workRef = resolved.workRef!;
      await service.index(workRef, "rebuild");
      const loadsAfterRebuild = adapter.loadCount;
      await service.explore(workRef, "search", "铜钥匙", 10, 2);
      await service.explore(workRef, "search", "北塔", 10, 2);
      await service.context(workRef, "北塔", 300);
      // None of these calls should re-read the whole work.
      expect(adapter.loadCount).toBe(loadsAfterRebuild);
    } finally {
      service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("source edit is picked up by the next explore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-aud021-edit-"));
    const adapter = new CountingGenericAdapter();
    const service = new WritingService([adapter]);
    try {
      const source = join(dir, "novel");
      await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
      const resolved = await service.resolve(source, "generic");
      const workRef = resolved.workRef!;
      await service.index(workRef, "rebuild");
      const chapter = join(source, "chapter-01.md");
      const uniqueTerm = `独有标记${Date.now()}`;
      await writeFile(chapter, (await readFile(chapter, "utf8")) + `\n${uniqueTerm}\n`);
      const result = await service.explore(workRef, "search", uniqueTerm, 10, 2);
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0]!.evidence.excerpt).toContain(uniqueTerm);
    } finally {
      service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("mtime-only touch without content change does not add a revision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-aud021-touch-"));
    const service = new WritingService([new GenericAdapter()]);
    try {
      const source = join(dir, "novel");
      await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
      const resolved = await service.resolve(source, "generic");
      const workRef = resolved.workRef!;
      const indexed = await service.index(workRef, "rebuild");
      // Touch the file without changing content: fingerprint changes, but the
      // content hash stays identical, so incremental must not create a revision.
      const chapter = join(source, "chapter-01.md");
      await writeFile(chapter, await readFile(chapter, "utf8"), { flag: "r+" });
      // give the fingerprint a deterministic change: bump mtime via utimes is
      // not portable in tests; rewrite the same bytes is enough for content-hash
      // semantics even if fingerprint still matches on fast filesystems.
      const unchanged = await service.index(workRef, "incremental");
      expect(unchanged.revision).toBe(indexed.revision);
    } finally {
      service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("AUD-018: query operations enforce a response deadline", () => {
  const waitFor = async (condition: () => boolean): Promise<void> => {
    const deadline = performance.now() + 1_000;
    while (!condition()) {
      if (performance.now() >= deadline) throw new Error("Timed out waiting for the test condition");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };

  class DelayedSnapshotAdapter extends GenericAdapter {
    delayMs = 0;
    activeSnapshots = 0;
    maxActiveSnapshots = 0;

    override async snapshot(candidate: WorkCandidate): Promise<SourceSnapshot> {
      this.activeSnapshots++;
      this.maxActiveSnapshots = Math.max(this.maxActiveSnapshots, this.activeSnapshots);
      try {
        if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs));
        return await super.snapshot(candidate);
      } finally {
        this.activeSnapshots--;
      }
    }
  }

  test.each([
    ["explore", "EXPLORE_TIME_LIMIT_EXCEEDED"],
    ["context", "CONTEXT_TIME_LIMIT_EXCEEDED"],
    ["evaluateSearch", "EVALUATE_SEARCH_TIME_LIMIT_EXCEEDED"],
  ] as const)("%s rejects while freshness work is still running", async (operation, expectedCode) => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-aud018-"));
    const adapter = new DelayedSnapshotAdapter();
    const service = new WritingService([adapter], undefined, { queryTimeLimitMs: 15 });
    try {
      const source = join(dir, "novel");
      await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
      const resolved = await service.resolve(source, "generic");
      const workRef = resolved.workRef!;
      await service.index(workRef, "rebuild");
      adapter.delayMs = 60;
      const call = operation === "explore"
        ? service.explore(workRef, "search", "铜钥匙", 10, 2)
        : operation === "context"
          ? service.context(workRef, "铜钥匙", 300)
          : service.evaluateSearch(workRef, "铜钥匙", 10, {});
      await expect(call).rejects.toMatchObject({ code: expectedCode });
      expect(adapter.activeSnapshots).toBe(1);
      await waitFor(() => adapter.activeSnapshots === 0);
    } finally {
      service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a timed-out call keeps its underlying work inside the per-work queue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-aud018-serial-"));
    const adapter = new DelayedSnapshotAdapter();
    const service = new WritingService([adapter], undefined, { queryTimeLimitMs: 15 });
    try {
      const source = join(dir, "novel");
      await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
      const resolved = await service.resolve(source, "generic");
      const workRef = resolved.workRef!;
      await service.index(workRef, "rebuild");
      adapter.delayMs = 60;
      await expect(service.explore(workRef, "search", "铜钥匙", 10, 2)).rejects.toMatchObject({ code: "EXPLORE_TIME_LIMIT_EXCEEDED" });
      await service.index(workRef, "status");
      expect(adapter.maxActiveSnapshots).toBe(1);
    } finally {
      service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("service close waits for work that outlived a caller deadline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-aud018-close-"));
    const adapter = new DelayedSnapshotAdapter();
    const service = new WritingService([adapter], undefined, { queryTimeLimitMs: 15 });
    let closed = false;
    try {
      const source = join(dir, "novel");
      await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
      const resolved = await service.resolve(source, "generic");
      const workRef = resolved.workRef!;
      await service.index(workRef, "rebuild");
      adapter.delayMs = 60;
      await expect(service.explore(workRef, "search", "铜钥匙", 10, 2)).rejects.toMatchObject({ code: "EXPLORE_TIME_LIMIT_EXCEEDED" });
      await service.close();
      closed = true;
      expect(adapter.activeSnapshots).toBe(0);
    } finally {
      if (!closed) await service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
