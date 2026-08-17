import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { GenericAdapter } from "@writing-mcp/adapter-generic";

// AUD-027: chapter-number syntax must be explicitly supported and deterministic.
// Roman numerals after "chapter" used to be matched by the regex but dropped by
// Number("iv"); Chinese numerals above 一百 were unsupported; Markdown titles
// with Chinese-numeral chapters were not recognized as chapters.

describe("TXT/Markdown chapter numbering (AUD-027)", () => {
  test("parses roman numeral chapters instead of skipping them", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-roman-")), path = join(root, "novel.txt");
    await writeFile(path, "chapter i\n甲。\nchapter ii\n乙。\nchapter iv\n丁。", "utf8");
    const adapter = new GenericAdapter();
    try {
      const work = await adapter.load((await adapter.discover(path))[0]!);
      expect(work.documents.map(d => d.relativePath)).toEqual(["novel.txt#v1-c1", "novel.txt#v1-c2", "novel.txt#v1-c4"]);
      expect(work.documents.map(d => d.localChapterNumber)).toEqual([1, 2, 4]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("parses Chinese numerals above 一百", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-hundred-")), path = join(root, "novel.txt");
    await writeFile(path, "第一百零三章\n甲。\n第一百一十章\n乙。\n第二百章\n丙。", "utf8");
    const adapter = new GenericAdapter();
    try {
      const work = await adapter.load((await adapter.discover(path))[0]!);
      expect(work.documents.map(d => d.localChapterNumber)).toEqual([103, 110, 200]);
      expect(work.documents.map(d => d.relativePath)).toEqual(["novel.txt#v1-c103", "novel.txt#v1-c110", "novel.txt#v1-c200"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("roman numbering resets start a new inferred volume", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-roman-reset-")), path = join(root, "novel.txt");
    await writeFile(path, "chapter ii\n甲。\nchapter i\n乙。", "utf8");
    const adapter = new GenericAdapter();
    try {
      const work = await adapter.load((await adapter.discover(path))[0]!);
      expect(work.documents.map(d => d.relativePath)).toEqual(["novel.txt#v1-c2", "novel.txt#v2-c1"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("invalid roman numerals are skipped deterministically instead of producing chapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-roman-invalid-")), path = join(root, "novel.txt");
    await writeFile(path, "chapter i\n甲。\nchapter im\n这行不是合法罗马数字。\nchapter ii\n乙。", "utf8");
    const adapter = new GenericAdapter();
    try {
      const work = await adapter.load((await adapter.discover(path))[0]!);
      expect(work.documents.map(d => d.relativePath)).toEqual(["novel.txt#v1-c1", "novel.txt#v1-c2"]);
      expect(work.documents[0]!.content).toContain("这行不是合法罗马数字");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("Markdown titles with Chinese-numeral chapters are recognized as chapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-md-chinese-")), path = join(root, "notes.md");
    await writeFile(path, "# 第一百零三章 决战\n正文。", "utf8");
    const adapter = new GenericAdapter();
    try {
      const work = await adapter.load((await adapter.discover(path))[0]!);
      expect(work.documents[0]?.kind).toBe("chapter");
      expect(work.documents[0]?.chapterNumber).toBe(103);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
