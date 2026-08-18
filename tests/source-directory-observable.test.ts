import { describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableId, WritingStore, type ParsedWork, type SourceDocument } from "@writing-mcp/core";

const document = (workRef: string, relativePath: string, content: string, kind: string, ordinal: number): SourceDocument => ({
  documentRef: stableId("doc", workRef, String(ordinal)),
  relativePath,
  absolutePath: relativePath,
  title: `Document ${ordinal}`,
  kind: kind as any,
  content,
  sourceMtimeMs: 1,
  sourceSize: content.length,
});

const workAt = (rootPath: string, documents: SourceDocument[]): ParsedWork => ({
  workRef: stableId("work", "test", rootPath),
  title: "Test",
  rootPath,
  adapter: "generic",
  capabilities: [],
  documents,
});

describe("AUD-012 source directory observable", () => {
  test("stats operation exposes contextSources by layer and kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-source-dir-"));
    const ref = stableId("work", "test", root);
    const work = workAt(root, [
      document(ref, "character-a.md", "# 角色：林秋\n林秋是码头工人。", "character", 0),
      document(ref, "character-b.md", "# 角色：秦晴\n秦晴是酒馆老板。", "character", 1),
      document(ref, "chapter-1.md", "# 第一章\n林秋在码头。", "chapter", 2),
      document(ref, "chapter-2.md", "# 第二章\n秦晴在酒馆。", "chapter", 3),
      document(ref, "location.md", "# 地点：北塔\n北塔在港口。", "location", 4),
      document(ref, "state.md", "# 状态：紧张\n局势紧张。", "state", 5),
    ]);
    
    const store = new WritingStore(work);
    try {
      await store.index("rebuild");
      const stats = await store.explore("stats");
      
      expect(stats.results.length).toBe(1);
      const statsContent = JSON.parse(stats.results[0]!.evidence.excerpt);
      
      expect(statsContent.documents).toBe(6);
      expect(statsContent.contextSources).toBeDefined();
      expect(statsContent.contextSources.byLayer).toBeDefined();
      expect(statsContent.contextSources.byKind).toBeDefined();
      
      // Verify layer breakdown
      expect(statsContent.contextSources.byLayer.L1).toBe(3); // 2 characters + 1 state (Fact)
      expect(statsContent.contextSources.byLayer.L2).toBe(2); // 2 chapters
      expect(statsContent.contextSources.byLayer.L3).toBe(1); // 1 location
      
      // Verify kind breakdown
      expect(statsContent.contextSources.byKind.character).toBe(2);
      expect(statsContent.contextSources.byKind.chapter).toBe(2);
      expect(statsContent.contextSources.byKind.location).toBe(1);
      expect(statsContent.contextSources.byKind.state).toBe(1);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
