import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { describe, expect, test } from "vitest";
import { GenericAdapter } from "@writing-mcp/adapter-generic";

// AUD-028: EPUB ingestion must enforce deterministic resource limits
// (entry count, per-document size, total decoded size) with stable error
// codes instead of unbounded ZIP expansion.

const containerXml = `<?xml version="1.0"?><container><rootfiles><rootfile media-type="application/oebps-package+xml" full-path="content.opf"/></rootfiles></container>`;

async function epubWith(chapters: Array<{ id: string; body: string }>, opfVersion = "3.0"): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", containerXml);
  const manifest = chapters.map(c => `<item href="${c.id}.xhtml" id="${c.id}" media-type="application/xhtml+xml"/>`).join("");
  const spine = chapters.map(c => `<itemref idref="${c.id}"/>`).join("");
  zip.file("content.opf", `<?xml version="1.0"?><package version="${opfVersion}" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>受限测试</dc:title></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`);
  for (const c of chapters) zip.file(`${c.id}.xhtml`, `<html><body><p>${c.body}</p></body></html>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function loadWithLimits(path: string, data: Buffer, limits: { maxDocumentBytes?: number; maxTotalBytes?: number }) {
  await writeFile(path, data);
  const adapter = new GenericAdapter({ epub: limits });
  return adapter.load((await adapter.discover(path))[0]!);
}

async function decodedParts(data: Buffer): Promise<{ opf: string; spine: string[] }> {
  const zip = await JSZip.loadAsync(data);
  return {
    opf: await zip.file("content.opf")!.async("string"),
    spine: await Promise.all(["c1.xhtml", "c2.xhtml"].map(name => zip.file(name)?.async("string")).filter((value): value is Promise<string> => value !== undefined)),
  };
}

describe("EPUB resource limits (AUD-028)", () => {
  test("rejects packages with too many ZIP entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-epub-entries-")), path = join(dir, "many.epub");
    const data = await epubWith([{ id: "c1", body: "第一章 正文。" }]);
    await writeFile(path, data);
    // Re-pack with junk entries above the injected limit.
    const zip = await JSZip.loadAsync(data);
    for (let i = 0; i < 5; i++) zip.file(`junk-${i}.css`, "body{}");
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    const adapter = new GenericAdapter({ epub: { maxEntries: 4 } });
    try {
      await expect(adapter.load((await adapter.discover(path))[0]!)).rejects.toMatchObject({ code: "EPUB_TOO_MANY_ENTRIES" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("rejects a single oversized spine document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-epub-large-")), path = join(dir, "large.epub");
    await writeFile(path, await epubWith([{ id: "c1", body: "第一章 " + "甲".repeat(500) }]));
    const adapter = new GenericAdapter({ epub: { maxDocumentBytes: 200 } });
    try {
      await expect(adapter.load((await adapter.discover(path))[0]!)).rejects.toMatchObject({ code: "EPUB_DOCUMENT_TOO_LARGE" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("rejects packages whose total decoded spine exceeds the limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-epub-total-")), path = join(dir, "total.epub");
    await writeFile(path, await epubWith([
      { id: "c1", body: "第一章 " + "甲".repeat(150) },
      { id: "c2", body: "第二章 " + "乙".repeat(150) },
    ]));
    const adapter = new GenericAdapter({ epub: { maxDocumentBytes: 10_000, maxTotalBytes: 250 } });
    try {
      await expect(adapter.load((await adapter.discover(path))[0]!)).rejects.toMatchObject({ code: "EPUB_TOTAL_TOO_LARGE" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("loads an EPUB 2.0 package within default limits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-epub-v2-")), path = join(dir, "legacy.epub");
    await writeFile(path, await epubWith([
      { id: "c1", body: "第一章 甲。" },
      { id: "c2", body: "第二章 乙。" },
    ], "2.0"));
    const adapter = new GenericAdapter();
    try {
      const work = await adapter.load((await adapter.discover(path))[0]!);
      expect(work.documents.filter(d => d.kind === "chapter")).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("enforces the decoded OPF limit in UTF-8 bytes at the exact boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-epub-opf-bytes-")), path = join(dir, "opf.epub");
    const data = await epubWith([{ id: "c1", body: "第一章 正文。" }]);
    const { opf } = await decodedParts(data);
    const exactBytes = Buffer.byteLength(opf, "utf8");
    try {
      await expect(loadWithLimits(path, data, { maxDocumentBytes: exactBytes })).resolves.toMatchObject({ documents: expect.any(Array) });
      await expect(loadWithLimits(path, data, { maxDocumentBytes: exactBytes - 1 })).rejects.toMatchObject({ code: "EPUB_DOCUMENT_TOO_LARGE" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("enforces each decoded spine document limit in UTF-8 bytes at the exact boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-epub-spine-bytes-")), path = join(dir, "spine.epub");
    const data = await epubWith([{ id: "c1", body: "第一章 " + "甲".repeat(200) }]);
    const { spine } = await decodedParts(data);
    const exactBytes = Buffer.byteLength(spine[0]!, "utf8");
    try {
      await expect(loadWithLimits(path, data, { maxDocumentBytes: exactBytes })).resolves.toMatchObject({ documents: expect.any(Array) });
      await expect(loadWithLimits(path, data, { maxDocumentBytes: exactBytes - 1 })).rejects.toMatchObject({ code: "EPUB_DOCUMENT_TOO_LARGE" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("sums decoded spine UTF-8 bytes at the exact total boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-epub-total-bytes-")), path = join(dir, "total-bytes.epub");
    const data = await epubWith([{ id: "c1", body: "第一章 " + "甲".repeat(40) }, { id: "c2", body: "第二章 " + "乙".repeat(40) }]);
    const { spine } = await decodedParts(data);
    const exactBytes = spine.reduce((total, html) => total + Buffer.byteLength(html, "utf8"), 0);
    try {
      await expect(loadWithLimits(path, data, { maxDocumentBytes: 10_000, maxTotalBytes: exactBytes })).resolves.toMatchObject({ documents: expect.any(Array) });
      await expect(loadWithLimits(path, data, { maxDocumentBytes: 10_000, maxTotalBytes: exactBytes - 1 })).rejects.toMatchObject({ code: "EPUB_TOTAL_TOO_LARGE" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
