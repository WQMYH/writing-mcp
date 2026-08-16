import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { describe, expect, test } from "vitest";
import { WritingService } from "@writing-mcp/core";
import { GenericAdapter } from "@writing-mcp/adapter-generic";

// AUD-026: a generic directory must not silently merge independent books.
// Each EPUB is a self-contained book container and becomes its own candidate;
// remaining text files merge into one directory work; capabilities reflect the
// actual input instead of always claiming "epub".

async function epubFixture(title: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container><rootfiles><rootfile media-type="application/oebps-package+xml" full-path="content.opf"/></rootfiles></container>`);
  zip.file("content.opf", `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>${title}</dc:title></metadata><manifest><item href="chapter-1.xhtml" id="c1" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  zip.file("chapter-1.xhtml", `<html><body><p>第一章 内容来自 ${title}。</p></body></html>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("generic work boundary (AUD-026)", () => {
  test("a directory with two EPUBs yields two candidates and resolves ambiguous", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-boundary-two-epub-"));
    await writeFile(join(dir, "north.epub"), await epubFixture("北塔"));
    await writeFile(join(dir, "south.epub"), await epubFixture("南塔"));
    const service = new WritingService([new GenericAdapter()]);
    try {
      const adapter = new GenericAdapter();
      const candidates = await adapter.discover(dir);
      expect(candidates.map(c => c.title).sort()).toEqual(["北塔", "南塔"]);
      const result = await service.resolve(dir, "generic");
      expect(result.status).toBe("ambiguous");
      expect(result.workRef).toBeUndefined();
      expect(result.candidates).toHaveLength(2);
    } finally {
      service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an EPUB candidate from a directory equals direct resolution of that file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-boundary-epub-direct-"));
    const epubPath = join(dir, "book.epub");
    await writeFile(epubPath, await epubFixture("孤本"));
    await writeFile(join(dir, "notes.md"), "# 笔记\n与书无关的杂记。");
    const adapter = new GenericAdapter();
    try {
      const fromDirectory = await adapter.discover(dir);
      const epubCandidate = fromDirectory.find(c => c.title === "孤本");
      expect(epubCandidate).toBeDefined();
      const [direct] = await adapter.discover(epubPath);
      expect(epubCandidate!.workRef).toBe(direct!.workRef);
      expect(epubCandidate!.rootPath).toBe(direct!.rootPath);
      // The notes file forms its own directory work; together they are ambiguous.
      expect(fromDirectory).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("capabilities reflect the actual input instead of always claiming epub", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-boundary-caps-"));
    await writeFile(join(dir, "book.epub"), await epubFixture("有书"));
    await writeFile(join(dir, "notes.md"), "# 笔记\n纯文本。");
    const adapter = new GenericAdapter();
    try {
      const candidates = await adapter.discover(dir);
      const epubCandidate = candidates.find(c => c.capabilities.includes("epub"));
      const textCandidate = candidates.find(c => !c.capabilities.includes("epub"));
      expect(epubCandidate?.title).toBe("有书");
      expect(textCandidate?.title).toBe(basename(dir));
      expect(textCandidate?.capabilities).toEqual(["documents", "full_text"]);
      // Loading the text work must not pull in EPUB content.
      const textWork = await adapter.load(textCandidate!);
      expect(textWork.documents.map(d => d.relativePath)).toEqual(["notes.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a pure text directory stays one work without the epub capability", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-boundary-text-"));
    await writeFile(join(dir, "chapter-01.md"), "# 第一章\n正文甲。");
    await writeFile(join(dir, "chapter-02.md"), "# 第二章\n正文乙。");
    const adapter = new GenericAdapter();
    try {
      const [candidate] = await adapter.discover(dir);
      expect(candidate?.capabilities).toEqual(["documents", "full_text"]);
      const work = await adapter.load(candidate!);
      expect(work.documents.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
