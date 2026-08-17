import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import {
  CONTEXT_SOURCE_REGISTRY,
  DEFAULT_CONTEXT_SOURCE_PROFILE,
  contextSourceProfile,
  dedupByEvidence,
  ENTITY_KINDS,
  stableId,
  WritingStore,
  type ContextLayer,
  type Evidence,
  type ParsedWork,
  type SourceDocument,
} from "@writing-mcp/core";

const makeWork = (rootPath: string): ParsedWork => {
  const workRef = stableId("work", "source-registry", rootPath);
  const doc = (name: string, title: string, content: string, kind: SourceDocument["kind"], chapterNumber?: number): SourceDocument => ({ documentRef: stableId("doc", workRef, name), relativePath: name, absolutePath: name, title, kind, content, chapterNumber, sourceMtimeMs: 1, sourceSize: content.length });
  const identicalChapter = (name: string, title: string, chapterNumber: number) => doc(name, title, "# 铜钥匙记\n铜钥匙埋在北塔的基石里。", "chapter", chapterNumber);
  return {
    workRef, title: "SourceRegistry", rootPath, adapter: "generic", capabilities: [], documents: [
      doc("linqiu.md", "林秋", "# 林秋\n林秋是守着北塔的記錄者。", "character"),
      doc("ch1.md", "第一篇", "# 第一篇\n林秋在北塔下等待。", "chapter", 1),
      identicalChapter("ch2.md", "第二篇", 2),
      identicalChapter("ch3.md", "第三篇", 3),
    ],
  };
};

const evidenceOf = (hash: string): Evidence => ({ documentRef: "d", relativePath: "a.md", startLine: 1, endLine: 2, excerpt: "正文", evidenceHash: hash, revision: 1 });

describe("AUD-013 source provider registry", () => {
  test("registry covers every frozen entity kind with a semantic layer", () => {
    const expected: Record<string, ContextLayer> = {
      Character: "L1", Fact: "L1", Foreshadow: "L1",
      Chapter: "L2", Event: "L2", OutlineNode: "L2",
      Location: "L3", Item: "L3",
    };
    for (const kind of ENTITY_KINDS) {
      const profile = CONTEXT_SOURCE_REGISTRY[kind];
      expect(profile, `registry must cover ${kind}`).toBeDefined();
      expect(profile!.layer).toBe(expected[kind]);
    }
    expect(DEFAULT_CONTEXT_SOURCE_PROFILE.layer).toBe("L3");
  });

  test("profileFor promotes required refs to L0 and falls back to L3 for unknown kinds", () => {
    expect(contextSourceProfile("Character", true).layer).toBe("L0");
    expect(contextSourceProfile("chapter", false).layer).toBe("L3");
    expect(contextSourceProfile("Character", false).layer).toBe("L1");
  });

  test("dedupByEvidence keeps the first occurrence; callers protect required blocks by ordering them first", () => {
    const items = [
      { ref: "span:c", required: true, tokens: 12, evidence: evidenceOf("h1") },
      { ref: "span:a", required: false, tokens: 10, evidence: evidenceOf("h1") },
      { ref: "span:b", required: false, tokens: 12, evidence: evidenceOf("h1") },
      { ref: "span:d", required: false, tokens: 8, evidence: evidenceOf("h2") },
    ];
    const { kept, duplicates } = dedupByEvidence(items);
    expect(kept.map(item => item.ref)).toEqual(["span:c", "span:d"]);
    expect(duplicates.map(item => item.ref)).toEqual(["span:a", "span:b"]);
  });
});

describe("AUD-013 context assembly uses semantic layers instead of positions", () => {
  test("assigns layers by source kind and promotes required refs to L0", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-layer-")), work = makeWork(root), store = new WritingStore(work);
    try {
      await store.index("rebuild");
      const dbPath = join(root, ".writing-index", work.workRef.replace(":", "-"), "index.sqlite"), db = new DatabaseSync(dbPath);
      let characterRef = "";
      try { characterRef = String((db.prepare("SELECT entity_ref FROM entities WHERE name='林秋' AND kind='Character'").get() as { entity_ref: string }).entity_ref); } finally { db.close(); }
      const packet = await store.context("林秋", 10_000, [characterRef]);
      const character = packet.blocks.find(item => item.ref === characterRef);
      expect(character, "the required Character entity must be resolved").toBeDefined();
      expect(character!.layer).toBe("L0");
      expect(character!.required).toBe(true);
      const chapterBlocks = packet.blocks.filter(item => item.kind === "chapter" && !item.required);
      expect(chapterBlocks.length, "chapter span hits must appear").toBeGreaterThan(0);
      for (const block of chapterBlocks) expect(block.layer).toBe("L3");
      const characterPoolHits = packet.blocks.filter(item => item.kind === "Character" && !item.required);
      for (const block of characterPoolHits) expect(block.layer).toBe("L1");
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("folds candidates sharing an evidenceHash and reports duplicate_evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-dedup-")), store = new WritingStore(makeWork(root));
    try {
      await store.index("rebuild");
      const packet = await store.context("铜钥匙", 10_000);
      const hits = packet.blocks.filter(item => item.evidence.excerpt.includes("铜钥匙"));
      expect(hits.length, "identical excerpts across chapters must collapse to one block").toBe(1);
      const folded = packet.omitted.filter(item => item.reason === "duplicate_evidence");
      expect(folded.length).toBeGreaterThanOrEqual(1);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("under budget pressure trims from L3 toward lower layers", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-trim-")), store = new WritingStore(makeWork(root));
    try {
      await store.index("rebuild");
      const full = await store.context("北塔", 1_000_000);
      const single = full.blocks.filter(item => item.tokens > 0).sort((a, b) => a.tokens - b.tokens)[0]!;
      const tight = await store.context("北塔", single.tokens);
      expect(tight.blocks.length, "exactly one block fits the tight budget").toBe(1);
      const survivor = tight.blocks[0]!;
      const survivorRank = survivor.layer === "L0" ? 0 : survivor.layer === "L1" ? 1 : survivor.layer === "L2" ? 2 : 3;
      const fittingRanks = full.blocks.filter(item => item.tokens <= single.tokens).map(item => item.layer === "L0" ? 0 : item.layer === "L1" ? 1 : item.layer === "L2" ? 2 : 3);
      expect(survivorRank, "the surviving block must be the shallowest-layer fitting candidate").toBe(Math.min(...fittingRanks));
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
});
