import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { describe, expect, test } from "vitest";
import { GenericAdapter } from "@writing-mcp/adapter-generic";
import { WritingStore } from "@writing-mcp/core";

async function fixtureZip(options:{container?:boolean;opf?:boolean;chapters?:boolean}={container:true,opf:true,chapters:true}){
  const zip=new JSZip();const base=new URL("../fixtures/epub-minimal/",import.meta.url);
  if(options.container)zip.file("META-INF/container.xml",await readFile(new URL("META-INF/container.xml",base),"utf8"));
  if(options.opf)zip.file("OEBPS/content.opf",await readFile(new URL("OEBPS/content.opf",base),"utf8"));
  if(options.chapters){zip.file("OEBPS/chapter-1.xhtml",await readFile(new URL("OEBPS/chapter-1.xhtml",base),"utf8"));zip.file("OEBPS/chapter-2.xhtml",await readFile(new URL("OEBPS/chapter-2.xhtml",base),"utf8"));}
  return zip.generateAsync({type:"nodebuffer"});
}

async function convertedBookFixture(){
  const zip=new JSZip(),title="\u67ab\u9701";
  zip.file("META-INF/container.xml",`<?xml version="1.0"?><container><rootfiles><rootfile media-type="application/oebps-package+xml" full-path="content.opf"/></rootfiles></container>`);
  zip.file("content.opf",`<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>${title}</dc:title></metadata><manifest><item href="titlepage.xhtml" id="cover" media-type="application/xhtml+xml"/><item href="part-1.html" id="part-1" media-type="application/xhtml+xml"/><item href="part-2.html" id="part-2" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="cover"/><itemref idref="part-1"/><itemref idref="part-2"/></spine></package>`);
  zip.file("titlepage.xhtml",`<html><head><title>Cover</title></head><body>Cover</body></html>`);
  zip.file("part-1.html",`<html><head><title>\ufffd\ufffd\ufffd\ufffd</title></head><body><p>《${title}》</p><p>（上）</p><p>第一章</p><p>秦晴在雨中出现。</p><p>第二章</p><p>阿枫开始奔跑。</p></body></html>`);
  zip.file("part-2.html",`<html><head><title>broken</title></head><body><p>第二章的后半部分。</p><p>第三章</p><p>方宏留下钥匙。</p></body></html>`);
  return zip.generateAsync({type:"nodebuffer"});
}

describe("generic EPUB technical validation",()=>{
  test("loads ordered spine chapters with stable evidence locations",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"writing-mcp-epub-"));const path=join(dir,"tower.epub");await writeFile(path,await fixtureZip());const adapter=new GenericAdapter();
    try{const [candidate]=await adapter.discover(path);expect(candidate).toBeDefined();const work=await adapter.load(candidate!);expect(work.documents.map(d=>d.title)).toEqual(["第一章 北塔","第二章 档案室"]);expect(work.documents[0]?.relativePath).toContain("tower.epub#OEBPS/chapter-1.xhtml");}
    finally{await rm(dir,{recursive:true,force:true});}
  });

  test("uses OPF metadata and splits converted multi-chapter spine documents",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"writing-mcp-epub-converted-")),path=join(dir,"unknown.epub");await writeFile(path,await convertedBookFixture());const adapter=new GenericAdapter();
    try{
      const [candidate]=await adapter.discover(path);expect(candidate?.title).toBe("\u67ab\u9701");
      const work=await adapter.load(candidate!);
      expect(work.documents.map(document=>[document.kind,document.title])).toEqual([
        ["document","\u67ab\u9701 preface"],
        ["chapter","\u7b2c\u4e00\u7ae0"],
        ["chapter","\u7b2c\u4e8c\u7ae0"],
        ["chapter","\u7b2c\u4e09\u7ae0"],
      ]);
      expect(work.documents.some(document=>document.content.includes("Cover")||document.content.includes("\ufffd"))).toBe(false);
      expect(work.documents[2]?.content).toContain("\u7b2c\u4e8c\u7ae0\u7684\u540e\u534a\u90e8\u5206");
      expect(work.documents[1]?.relativePath).toContain("unknown.epub#part-1.html::v1-c1");
      expect(work.documents[2]?.sourceSegments?.map(segment=>segment.relativePath)).toEqual([
        "unknown.epub#part-1.html",
        "unknown.epub#part-2.html",
      ]);
      const store=new WritingStore(work);
      try{
        await store.index("rebuild");
        const explored=await store.explore("search","第二章的后半部分",10,0);
        expect(explored.results[0]?.evidence.locators?.map(locator=>locator.relativePath)).toEqual([
          "unknown.epub#part-1.html",
          "unknown.epub#part-2.html",
        ]);
      }finally{store.close();}
    }finally{await rm(dir,{recursive:true,force:true});}
  });

  test("keeps document references unique when each EPUB is its own work (AUD-026)",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"writing-mcp-epub-multiple-")),data=await convertedBookFixture();await writeFile(join(dir,"one.epub"),data);await writeFile(join(dir,"two.epub"),data);const adapter=new GenericAdapter();
    try{const candidates=await adapter.discover(dir);expect(candidates).toHaveLength(2);for(const candidate of candidates){const work=await adapter.load(candidate);expect(new Set(work.documents.map(document=>document.documentRef)).size).toBe(work.documents.length);}}
    finally{await rm(dir,{recursive:true,force:true});}
  });

  test("rejects malformed packages without returning partial documents",async()=>{
    const cases:Array<[string,Buffer,string]>=[
      ["invalid ZIP",Buffer.from("not-a-zip"),"EPUB_INVALID_ZIP"],
      ["missing container",await fixtureZip({container:false,opf:true,chapters:true}),"EPUB_CONTAINER_MISSING"],
      ["missing OPF",await fixtureZip({container:true,opf:false,chapters:true}),"EPUB_OPF_MISSING"],
      ["missing spine documents",await fixtureZip({container:true,opf:true,chapters:false}),"EPUB_NO_READABLE_SPINE"]
    ];
    for(const [name,data,code] of cases){const dir=await mkdtemp(join(tmpdir(),"writing-mcp-epub-invalid-"));const path=join(dir,"invalid.epub");await writeFile(path,data);const adapter=new GenericAdapter();try{const [candidate]=await adapter.discover(path);await expect(adapter.load(candidate!),name).rejects.toMatchObject({code});}finally{await rm(dir,{recursive:true,force:true});}}
  });
});
