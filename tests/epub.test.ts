import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { describe, expect, test } from "vitest";
import { GenericAdapter } from "@writing-mcp/adapter-generic";

async function fixtureZip(options:{container?:boolean;opf?:boolean;chapters?:boolean}={container:true,opf:true,chapters:true}){
  const zip=new JSZip();const base=new URL("../fixtures/epub-minimal/",import.meta.url);
  if(options.container)zip.file("META-INF/container.xml",await readFile(new URL("META-INF/container.xml",base),"utf8"));
  if(options.opf)zip.file("OEBPS/content.opf",await readFile(new URL("OEBPS/content.opf",base),"utf8"));
  if(options.chapters){zip.file("OEBPS/chapter-1.xhtml",await readFile(new URL("OEBPS/chapter-1.xhtml",base),"utf8"));zip.file("OEBPS/chapter-2.xhtml",await readFile(new URL("OEBPS/chapter-2.xhtml",base),"utf8"));}
  return zip.generateAsync({type:"nodebuffer"});
}

describe("generic EPUB technical validation",()=>{
  test("loads ordered spine chapters with stable evidence locations",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"writing-mcp-epub-"));const path=join(dir,"tower.epub");await writeFile(path,await fixtureZip());const adapter=new GenericAdapter();
    try{const [candidate]=await adapter.discover(path);expect(candidate).toBeDefined();const work=await adapter.load(candidate!);expect(work.documents.map(d=>d.title)).toEqual(["第一章 北塔","第二章 档案室"]);expect(work.documents[0]?.relativePath).toContain("tower.epub#OEBPS/chapter-1.xhtml");}
    finally{await rm(dir,{recursive:true,force:true});}
  });

  test("rejects malformed packages without returning partial documents",async()=>{
    const cases:Array<[string,Buffer,RegExp]>=[
      ["invalid ZIP",Buffer.from("not-a-zip"),/zip|central directory|corrupted/i],
      ["missing container",await fixtureZip({container:false,opf:true,chapters:true}),/container does not declare/i],
      ["missing OPF",await fixtureZip({container:true,opf:false,chapters:true}),/OPF package is missing/i],
      ["missing spine documents",await fixtureZip({container:true,opf:true,chapters:false}),/no readable spine chapters/i]
    ];
    for(const [name,data,pattern] of cases){const dir=await mkdtemp(join(tmpdir(),"writing-mcp-epub-invalid-"));const path=join(dir,"invalid.epub");await writeFile(path,data);const adapter=new GenericAdapter();try{const [candidate]=await adapter.discover(path);await expect(adapter.load(candidate!),name).rejects.toThrow(pattern);}finally{await rm(dir,{recursive:true,force:true});}}
  });
});
