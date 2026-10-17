import { describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { splitDocument, WritingStore, type SourceDocument } from "@writing-mcp/core";

// AUD-030: splitDocument must enforce a hard span cap (oversized single
// lines are hard-split, never left as one giant span), keep locators exact
// after trimming, and keep boundary evidence contiguous without overlap.

const doc = (content: string, sourceStartLine = 1): SourceDocument => ({
  documentRef: "doc:aud030",
  relativePath: "one.md",
  absolutePath: "one.md",
  title: "测试",
  kind: "document",
  content,
  sourceStartLine,
  sourceMtimeMs: 1,
  sourceSize: new TextEncoder().encode(content).length,
});

describe("span hard cap and boundary rules (AUD-030)", () => {
  test.each([
    { name: "one below cap", cap: 8, content: "甲乙\n丙丁戊己", chunks: ["甲乙\n丙丁戊己"] },
    { name: "exact cap", cap: 8, content: "甲乙丙\n丁戊己庚", chunks: ["甲乙丙\n丁戊己庚"] },
    { name: "one above cap", cap: 8, content: "甲乙丙丁\n戊己庚辛", chunks: ["甲乙丙丁", "戊己庚辛"] },
    { name: "small cap", cap: 2, content: "甲\n乙", chunks: ["甲", "乙"] },
    { name: "multiple overflow lines", cap: 8, content: "甲乙丙丁\n戊己庚辛\n壬癸子丑", chunks: ["甲乙丙丁", "戊己庚辛", "壬癸子丑"] },
    { name: "default-sized cap", cap: 2400, content: "甲".repeat(1200) + "\n" + "乙".repeat(1200), chunks: ["甲".repeat(1200), "乙".repeat(1200)] },
  ])("checks multiline size before append: $name (W-MCP-001)", ({ cap, content, chunks }) => {
    const spans = splitDocument(doc(content, 7), String, cap);
    expect(spans.map(span => span.content)).toEqual(chunks);
    expect(spans.every(span => span.content.length <= cap)).toBe(true);
    expect(spans.map(span => span.content).join("\n")).toBe(content);
    expect(spans[0]!.startLine).toBe(7);
    expect(spans.at(-1)!.endLine).toBe(7 + content.split("\n").length - 1);
  });

  test("marks a pre-MR2 derivation stale and reindexes unchanged source (W-MCP-001)", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-span-upgrade-"));
    const content = "甲".repeat(1200) + "\n" + "乙".repeat(1200);
    const work = { workRef: "work:span-upgrade", rootPath: root, title: "Legacy", adapter: "generic" as const, capabilities: [], documents: [doc(content)] };
    const store = new WritingStore(work);
    try {
      await store.index("rebuild");
      store.close();
      const db = new DatabaseSync(join(root, ".writing-index", "work-span-upgrade", "index.sqlite"));
      try {
        // Frozen fingerprint produced by schema-v4 before versioned text derivation.
        db.prepare("UPDATE documents SET semantic_hash=?").run("b818c5c2277856c076d16a8504dc435764c918614c0f2827cd21d9d6028cfc22");
      } finally { db.close(); }
      expect((await store.index("status")).freshness).toBe("stale");
      const refreshed = await store.index("incremental");
      expect(refreshed.stats).toMatchObject({ updated: 1, skipped: 0, spans: 2 });
      expect(refreshed.freshness).toBe("fresh");
      const unchanged = await store.index("incremental");
      expect(unchanged.revision).toBe(refreshed.revision);
      expect(unchanged.stats).toMatchObject({ updated: 0, skipped: 1 });
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("hard-splits an oversized single line into bounded spans on the same source line", () => {
    const line = "甲".repeat(5000);
    const spans = splitDocument(doc(line), n => String(n), 2400);
    expect(spans.length).toBeGreaterThan(1);
    expect(spans.every(span => span.content.length <= 2400)).toBe(true);
    expect(spans.every(span => span.startLine === 1 && span.endLine === 1)).toBe(true);
    expect(spans.every(span => span.locators.every(l => l.startLine === 1 && l.endLine === 1))).toBe(true);
    expect(spans.map(span => span.content).join("")).toBe(line);
  });

  test.each(["😀", "𠀀", "中"])("keeps %s intact at a hard split (W-MCP-002)", glyph => {
    const content = "甲".repeat(7) + glyph + "乙";
    const spans = splitDocument(doc(content, 7), String, 8);
    expect(spans.every(span => span.content.isWellFormed())).toBe(true);
    expect(spans.every(span => span.content.length <= 8)).toBe(true);
    expect(spans.map(span => span.content).join("")).toBe(content);
    expect(spans.every(span => span.startLine === 7 && span.endLine === 7)).toBe(true);
    expect(spans.every(span => span.locators.every(locator => locator.startLine === 7 && locator.endLine === 7))).toBe(true);
  });

  test("rejects a cap that cannot hold a surrogate pair rather than dropping data or looping (W-MCP-002)", () => {
    expect(() => splitDocument(doc("😀"), String, 1)).toThrow(RangeError);
  });

  test("locators exclude blank lines trimmed from span edges", () => {
    const spans = splitDocument(doc("\n\n首行正文\n\n"), n => String(n));
    expect(spans).toHaveLength(1);
    expect(spans[0]!.startLine).toBe(3);
    expect(spans[0]!.endLine).toBe(3);
    expect(spans[0]!.locators[0]).toMatchObject({ startLine: 3, endLine: 3 });
  });

  test("adjacent spans tile the source contiguously without overlap or gaps", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `第${i + 1}行内容填充文本。`);
    const spans = splitDocument(doc(lines.join("\n")), n => String(n), 300);
    expect(spans.length).toBeGreaterThan(1);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.startLine).toBe(spans[i - 1]!.endLine + 1);
    }
    expect(spans[0]!.startLine).toBe(1);
    expect(spans[spans.length - 1]!.endLine).toBe(40);
    const reassembled = spans.map(span => span.content).join("\n");
    expect(reassembled).toBe(lines.join("\n"));
  });

  test("hard-split chunks keep the following span contiguous on the next line", () => {
    const content = `${"乙".repeat(5000)}\n收尾行。`;
    const spans = splitDocument(doc(content), n => String(n), 2400);
    expect(spans.length).toBeGreaterThan(2);
    const chunks = spans.slice(0, -1);
    expect(chunks.every(span => span.startLine === 1 && span.endLine === 1)).toBe(true);
    expect(chunks.map(span => span.content).join("")).toBe("乙".repeat(5000));
    const tail = spans[spans.length - 1]!;
    expect(tail.startLine).toBe(2);
    expect(tail.endLine).toBe(2);
    expect(tail.content).toBe("收尾行。");
  });

  test("heading boundaries keep splitting with exact locators", () => {
    const spans = splitDocument(doc("# 甲标题\n内容甲。\n# 乙标题\n内容乙。"), n => String(n));
    expect(spans).toHaveLength(2);
    expect(spans[0]!.heading).toBe("甲标题");
    expect(spans[1]!.heading).toBe("乙标题");
    expect(spans[0]!.startLine).toBe(1);
    expect(spans[0]!.endLine).toBe(2);
    expect(spans[1]!.startLine).toBe(3);
    expect(spans[1]!.endLine).toBe(4);
    expect(spans[1]!.locators[0]).toMatchObject({ startLine: 3, endLine: 4 });
  });
});
