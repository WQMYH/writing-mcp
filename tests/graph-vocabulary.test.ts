import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { EDGE_KINDS, ENTITY_KINDS, WORK_CAPABILITIES, stableId, WritingStore, type ParsedWork, type SourceDocument } from "@writing-mcp/core";
import { GenericAdapter } from "@writing-mcp/adapter-generic";
import { InkosAdapter } from "@writing-mcp/adapter-inkos";

const makeWork=(rootPath:string):ParsedWork=>{
  const workRef=stableId("work","vocab",rootPath);
  const doc=(name:string,title:string,kind:SourceDocument["kind"],content:string,chapterNumber?:number):SourceDocument=>({documentRef:stableId("doc",workRef,name),relativePath:name,absolutePath:name,title,kind,content,chapterNumber,sourceMtimeMs:1,sourceSize:content.length});
  return{workRef,title:"Vocab",rootPath,adapter:"generic",capabilities:[],documents:[
    doc("one.md","第一章","chapter","# 第一章\n语笙走进北塔。",1),
    doc("two.md","第二章","chapter","# 第二章\n北塔的门开了。",2),
    doc("outline.md","主线大纲","outline","# 主线大纲\n铜钥匙线索贯穿全书。"),
    doc("state.md","当前状态","state","# 当前状态\n语笙被困塔中。"),
    doc("hooks.md","待回收伏笔","foreshadow","# 待回收伏笔\n银铃铛尚未解释。"),
    doc("role.md","语笙","character","# 语笙\n化名林夜。"),
    doc("facts.md","设定","document","# 设定\n地点：北塔\n物品：铜钥匙\n事件：雨夜入塔"),
  ]};
};

describe("AUD-022 frozen deterministic graph vocabulary",()=>{
  test("indexed entity kinds include OutlineNode and stay inside the frozen set",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-vocab-")),work=makeWork(root),store=new WritingStore(work);
    try{
      await store.index("rebuild");
      const dbPath=join(root,".writing-index",work.workRef.replace(":","-"),"index.sqlite"),db=new DatabaseSync(dbPath);
      try{
        const entityKinds=(db.prepare("SELECT DISTINCT kind FROM entities ORDER BY kind").all() as Array<{kind:string}>).map(row=>row.kind);
        expect(entityKinds).toContain("OutlineNode");
        expect(entityKinds.every(kind=>ENTITY_KINDS.includes(kind as (typeof ENTITY_KINDS)[number]))).toBe(true);
        const edgeKinds=(db.prepare("SELECT DISTINCT kind FROM edges ORDER BY kind").all() as Array<{kind:string}>).map(row=>row.kind);
        expect(edgeKinds.length).toBeGreaterThan(0);
        expect(edgeKinds.every(kind=>EDGE_KINDS.includes(kind as (typeof EDGE_KINDS)[number]))).toBe(true);
      }finally{db.close();}
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });

  test("adapter capability declarations stay inside the frozen vocabulary",async()=>{
    const inkosSource=fileURLToPath(new URL("../fixtures/inkos-minimal",import.meta.url));
    const inkosCandidates=await new InkosAdapter().discover(inkosSource);
    expect(inkosCandidates).toHaveLength(1);
    expect(inkosCandidates[0]!.capabilities.every(cap=>WORK_CAPABILITIES.includes(cap))).toBe(true);
    const genericRoot=await mkdtemp(join(tmpdir(),"writing-mcp-vocab-generic-"));
    try{
      const { writeFile }=await import("node:fs/promises");
      await writeFile(join(genericRoot,"notes.md"),"# Notes\n内容。");
      const genericCandidates=await new GenericAdapter().discover(genericRoot);
      expect(genericCandidates).toHaveLength(1);
      expect(genericCandidates[0]!.capabilities.every(cap=>WORK_CAPABILITIES.includes(cap))).toBe(true);
    }finally{await rm(genericRoot,{recursive:true,force:true});}
  });
});
