import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { GenericAdapter } from "@writing-mcp/adapter-generic";
import { splitDocument } from "@writing-mcp/core";

describe("generic TXT ingestion",()=>{
  test.each([
    { blanks: 0, start: 1 }, { blanks: 1, start: 2 }, { blanks: 3, start: 4 },
  ].flatMap(item => ["\n", "\r\n"].flatMap(eol => [false, true].map(bom => ({ ...item, eol, bom })))))(
    "locates trimmed preface with $blanks leading blank lines, BOM=$bom, EOL=$eol (W-MCP-010)",
    async ({ blanks, start, eol, bom }) => {
      const root = await mkdtemp(join(tmpdir(), "writing-mcp-preface-lines-")), path = join(root, "novel.txt");
      const input = (bom ? "\ufeff" : "") + eol.repeat(blanks) + ["  前言首行。", "前言末行。 ", "", "第一章 正文", "章内容。"].join(eol);
      await writeFile(path, input, "utf8");
      const adapter = new GenericAdapter();
      try {
        const work = await adapter.load((await adapter.discover(path))[0]!);
        expect(work.documents).toHaveLength(2);
        const preface = work.documents[0]!;
        expect(preface.content).toBe("前言首行。\n前言末行。");
        expect(preface.sourceStartLine).toBe(start);
        const [span] = splitDocument(preface, String);
        expect(span).toMatchObject({ startLine: start, endLine: start + 1 });
        expect(span!.locators).toEqual([{ relativePath: "novel.txt#preface", startLine: start, endLine: start + 1 }]);
        expect(work.documents[1]!.sourceStartLine).toBe(start + 3);
        const sourceLines = input.replace(/^\ufeff/, "").replace(/\r\n/g, "\n").split("\n");
        expect(sourceLines[span!.startLine - 1]!.trim()).toBe("前言首行。");
        expect(sourceLines[span!.endLine - 1]!.trim()).toBe("前言末行。");
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );

  test("decodes GBK and preserves original line locations when splitting chapters",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-gbk-")),path=join(root,"novel.txt");
    await writeFile(path,Buffer.from("b5dad2bbd5c20d0ad4c0b7e3b3f6cfd6a1a30d0ab5dab6fed5c20d0abcccd0f8a1a3","hex"));
    const adapter=new GenericAdapter();
    try{const candidate=(await adapter.discover(path))[0]!;const work=await adapter.load(candidate);expect(work.documents.map(document=>({title:document.title,chapterNumber:document.chapterNumber,start:document.sourceStartLine,path:document.relativePath}))).toEqual([{title:"第一章",chapterNumber:1,start:1,path:"novel.txt#v1-c1"},{title:"第二章",chapterNumber:2,start:3,path:"novel.txt#v1-c2"}]);expect(work.documents[0]!.content).toContain("岳枫出现");expect(splitDocument(work.documents[1]!,ordinal=>String(ordinal))[0]!.startLine).toBe(3);}finally{await rm(root,{recursive:true,force:true});}
  });

  test("starts a new inferred volume when chapter numbering resets",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-volumes-")),path=join(root,"novel.txt");await writeFile(path,"第一章\n甲。\n第二章\n乙。\n第一章\n丙。","utf8");const adapter=new GenericAdapter();
    try{const work=await adapter.load((await adapter.discover(path))[0]!);expect(work.documents.map(document=>document.relativePath)).toEqual(["novel.txt#v1-c1","novel.txt#v1-c2","novel.txt#v2-c1"]);expect(work.documents.map(document=>document.chapterNumber)).toEqual([1,2,3]);}finally{await rm(root,{recursive:true,force:true});}
  });
});
