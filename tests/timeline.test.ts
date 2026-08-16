import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { stableId, WritingStore, type ParsedWork, type SourceDocument } from "@writing-mcp/core";

const makeWork=(rootPath:string):ParsedWork=>{
  const workRef=stableId("work","timeline",rootPath);
  const doc=(name:string,title:string,content:string,chapterNumber:number):SourceDocument=>({documentRef:stableId("doc",workRef,name),relativePath:name,absolutePath:name,title,kind:"chapter",content,chapterNumber,sourceMtimeMs:1,sourceSize:content.length});
  return{workRef,title:"Timeline",rootPath,adapter:"generic",capabilities:[],documents:[
    doc("one.md","第一章","# 第一章\n铜钥匙出现。",1),
    doc("two.md","第二章","# 第二章\n北塔开门。",2),
    doc("three.md","第三章","# 第三章\n银铃铛响起。",3),
  ]};
};

describe("AUD-015 timeline is an independent deterministic projection",()=>{
  test("projects chapters and precedes relations in chapter order instead of full-text search",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-timeline-")),store=new WritingStore(makeWork(root));
    try{
      await store.index("rebuild");
      const result=await store.explore("timeline","",20,0);
      expect(result.diagnostics.map(item=>item.code)).toContain("TIMELINE_PROJECTION");
      // 3 Chapter entities + 2 precedes relations, all carrying temporal attributes.
      expect(result.results).toHaveLength(5);
      const titles=result.results.map(item=>item.title);
      expect(titles).toEqual(["第一章","precedes: 第一章 → 第二章","第二章","precedes: 第二章 → 第三章","第三章"]);
      expect(result.results.every(item=>item.evidence.relativePath&&item.evidence.startLine>0)).toBe(true);
      const relation=result.results[1]!;
      expect(relation.kind).toBe("precedes-relation");
      const again=await store.explore("timeline","",20,0);
      expect(again.results.map(item=>item.ref)).toEqual(result.results.map(item=>item.ref));
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });

  test("filters the projection deterministically by name",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-timeline-filter-")),store=new WritingStore(makeWork(root));
    try{
      await store.index("rebuild");
      const filtered=await store.explore("timeline","第二章",20,0);
      expect(filtered.results).toHaveLength(3);
      expect(filtered.results.every(item=>item.title.includes("第二章"))).toBe(true);
      const missing=await store.explore("timeline","不存在的事件",20,0);
      expect(missing.results).toEqual([]);
      expect(missing.diagnostics.map(item=>item.code)).toContain("NO_RESULTS");
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });

  test("orders unknown-chapter temporal items after positioned chapters and reports no temporal data cleanly",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-timeline-order-")),work=makeWork(root);
    let store=new WritingStore(work);
    try{await store.index("rebuild");}finally{store.close();}
    // Inject a temporal fact whose chapter anchors are not chapter entity refs;
    // it must sort deterministically after all positioned chapters.
    const dbPath=join(root,".writing-index",work.workRef.replace(":","-"),"index.sqlite"),db=new DatabaseSync(dbPath);
    try{
      const span=String((db.prepare("SELECT span_ref FROM spans ORDER BY span_ref LIMIT 1").get() as {span_ref:string}).span_ref);
      db.prepare("INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("entity:manual-fact","Fact","手写事实","手写事实","deterministic",1,span,"identity-manual","evidence-manual","chapter-x","chapter-y","夜晚",json({}),1);
    }finally{db.close();}
    store=new WritingStore(work);
    try{
      const result=await store.explore("timeline","",20,0);
      expect(result.results[result.results.length-1]!.title).toBe("手写事实");
    }finally{store.close();await rm(root,{recursive:true,force:true});}
    // A work with no chapters at all has no temporal data: stable NO_RESULTS.
    const bareRoot=await mkdtemp(join(tmpdir(),"writing-mcp-timeline-empty-")),bareWork:ParsedWork={workRef:stableId("work","timeline-empty",bareRoot),title:"Empty",rootPath:bareRoot,adapter:"generic",capabilities:[],documents:[{documentRef:stableId("doc","timeline-empty-bare","notes.md"),relativePath:"notes.md",absolutePath:"notes.md",title:"Notes",kind:"document",content:"无章节内容。",sourceMtimeMs:1,sourceSize:10}]};
    const bareStore=new WritingStore(bareWork);
    try{
      await bareStore.index("rebuild");
      const empty=await bareStore.explore("timeline","",20,0);
      expect(empty.results).toEqual([]);
      expect(empty.diagnostics.map(item=>item.code)).toContain("NO_RESULTS");
    }finally{bareStore.close();await rm(bareRoot,{recursive:true,force:true});}
  });
});

const json=(value:unknown)=>JSON.stringify(value);
