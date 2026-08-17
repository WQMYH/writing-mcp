import { describe, expect, test } from "vitest";
import { splitDocument, type SourceDocument } from "@writing-mcp/core";

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
  test("hard-splits an oversized single line into bounded spans on the same source line", () => {
    const line = "甲".repeat(5000);
    const spans = splitDocument(doc(line), n => String(n), 2400);
    expect(spans.length).toBeGreaterThan(1);
    expect(spans.every(span => span.content.length <= 2400)).toBe(true);
    expect(spans.every(span => span.startLine === 1 && span.endLine === 1)).toBe(true);
    expect(spans.every(span => span.locators.every(l => l.startLine === 1 && l.endLine === 1))).toBe(true);
    expect(spans.map(span => span.content).join("")).toBe(line);
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
