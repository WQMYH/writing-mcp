import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { WritingStore, stableId, type ParsedWork, type SourceDocument } from "@writing-mcp/core";

const makeWork = (rootPath: string): ParsedWork => {
  const workRef = stableId("work", "constraint-wiring", rootPath);
  const doc = (name: string, title: string, content: string, kind: SourceDocument["kind"], chapterNumber?: number): SourceDocument => ({ documentRef: stableId("doc", workRef, name), relativePath: name, absolutePath: name, title, kind, content, chapterNumber, sourceMtimeMs: 1, sourceSize: content.length });
  return {
    workRef, title: "ConstraintWiring", rootPath, adapter: "generic", capabilities: [], documents: [
      doc("linqiu.md", "林秋", "# 林秋\n林秋是守着北塔的記錄者。", "character"),
      doc("ch1.md", "第一篇", "# 第一篇\n林秋在北塔下等待。", "chapter", 1),
      doc("ch2.md", "第二篇", "# 第二篇\n林秋沿着旧城墙行走。", "chapter", 2),
      doc("ch3.md", "第三篇", "# 第三篇\n林秋在码头眺望海面。", "chapter", 3),
    ],
  };
};

const refsFromDb = async (root: string, indexPath: string) => {
  const db = new DatabaseSync(indexPath);
  try {
    return {
      entityRef: String((db.prepare("SELECT entity_ref FROM entities WHERE name='林秋' AND kind='Character'").get() as { entity_ref: string }).entity_ref),
      charDocRef: String((db.prepare("SELECT document_ref FROM documents WHERE kind='character'").get() as { document_ref: string }).document_ref),
      ch1DocRef: String((db.prepare("SELECT document_ref FROM documents WHERE kind='chapter' AND chapter_number=1").get() as { document_ref: string }).document_ref),
      ch2DocRef: String((db.prepare("SELECT document_ref FROM documents WHERE kind='chapter' AND chapter_number=2").get() as { document_ref: string }).document_ref),
      ch3DocRef: String((db.prepare("SELECT document_ref FROM documents WHERE kind='chapter' AND chapter_number=3").get() as { document_ref: string }).document_ref),
    };
  } finally { db.close(); }
};

describe("AUD-012 constraint interface wiring (store level)", () => {
  test("excludeRefs removes matching candidates and reports them as excluded", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-wire-excl-")), store = new WritingStore(makeWork(root), join(root, "idx.sqlite"));
    try {
      await store.index("rebuild");
      const baseline = await store.context("林秋", 1_000_000);
      const victim = baseline.blocks.find(block => block.kind === "chapter")!;
      const packet = await store.context("林秋", 1_000_000, [], { excludeRefs: [victim.ref] });
      expect(packet.blocks.some(block => block.ref === victim.ref)).toBe(false);
      expect(packet.omitted.some(entry => entry.ref === victim.ref && entry.reason === "excluded")).toBe(true);
      // requiredRefs win over excludeRefs
      const requiredWins = await store.context("林秋", 1_000_000, [victim.ref], { excludeRefs: [victim.ref] });
      expect(requiredWins.blocks.some(block => block.ref === victim.ref)).toBe(true);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("entityRefs and documentRefs resolve directly into blocks and rank ahead of search hits within their layer", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-wire-pin-")), store = new WritingStore(makeWork(root), join(root, "idx.sqlite"));
    try {
      await store.index("rebuild");
      const { entityRef, charDocRef } = await refsFromDb(root, join(root, "idx.sqlite"));
      const byEntity = await store.context("林秋", 1_000_000, [], { entityRefs: [entityRef] });
      const entityBlock = byEntity.blocks.find(block => block.ref === entityRef);
      expect(entityBlock, "entityRef must resolve directly").toBeDefined();
      expect(entityBlock!.layer).toBe("L1");
      expect(entityBlock!.required).toBe(false);
      const byDoc = await store.context("林秋", 1_000_000, [], { documentRefs: [charDocRef] });
      const docBlock = byDoc.blocks.find(block => block.evidence.documentRef === charDocRef);
      expect(docBlock, "documentRef must resolve directly").toBeDefined();
      expect(docBlock!.layer).toBe("L1");
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("targetChapter anchors layer ordering toward the target chapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-wire-anchor-")), store = new WritingStore(makeWork(root), join(root, "idx.sqlite"));
    try {
      await store.index("rebuild");
      const { ch1DocRef, ch2DocRef, ch3DocRef } = await refsFromDb(root, join(root, "idx.sqlite"));
      const packet = await store.context("林秋", 1_000_000, [], { targetChapter: 2 });
      const l2Order = packet.blocks.filter(block => block.layer === "L2").map(block => block.evidence.documentRef);
      const pos = (ref: string) => l2Order.indexOf(ref);
      expect(pos(ch2DocRef), "chapter 2 must be present in L2").not.toBe(-1);
      expect(pos(ch1DocRef)).not.toBe(-1);
      expect(pos(ch3DocRef)).not.toBe(-1);
      expect(pos(ch2DocRef)).toBeLessThan(pos(ch1DocRef));
      expect(pos(ch1DocRef)).toBeLessThan(pos(ch3DocRef));
      // without targetChapter the anchor does not apply (pure score order)
      const unanchored = await store.context("林秋", 1_000_000);
      const unanchoredOrder = unanchored.blocks.filter(block => block.layer === "L2").map(block => block.evidence.documentRef);
      expect(unanchoredOrder).not.toEqual(l2Order);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("taskType is value-open and never drives assembly; unknown values are accepted", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-wire-tasktype-")), store = new WritingStore(makeWork(root), join(root, "idx.sqlite"));
    try {
      await store.index("rebuild");
      const baseline = await store.context("林秋", 1_000_000);
      const withConvention = await store.context("林秋", 1_000_000, [], { taskType: "answer" });
      const withUnknown = await store.context("林秋", 1_000_000, [], { taskType: "brand_new_type_from_usage" });
      const key = (packet: { blocks: Array<{ ref: string }> }) => JSON.stringify(packet.blocks.map(block => block.ref));
      expect(key(withUnknown)).toBe(key(baseline));
      expect(key(withConvention)).toBe(key(baseline));
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("shared database handle survives context calls (no premature close)", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-wire-db-")), store = new WritingStore(makeWork(root), join(root, "idx.sqlite"));
    try {
      await store.index("rebuild");
      await store.context("林秋", 1_000_000, [], { excludeRefs: [], entityRefs: [], targetChapter: 2 });
      await store.context("林秋", 1_000_000);
      const after = await store.explore("search", "林秋");
      expect(after.results.length).toBeGreaterThan(0);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("ref-list size validation covers every ref list (CONTEXT_REFS_TOO_LARGE)", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-wire-validate-")), store = new WritingStore(makeWork(root), join(root, "idx.sqlite"));
    try {
      await store.index("rebuild");
      const oversized = Array.from({ length: 129 }, (_, i) => `ref-${i}`);
      for (const key of ["excludeRefs", "entityRefs", "documentRefs"] as const) {
        await expect(store.context("林秋", 1_000_000, [], { [key]: oversized })).rejects.toMatchObject({ code: "CONTEXT_REFS_TOO_LARGE" });
      }
      await expect(store.context("林秋", 1_000_000, oversized)).rejects.toMatchObject({ code: "CONTEXT_REFS_TOO_LARGE" });
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
});
