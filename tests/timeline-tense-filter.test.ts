import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { stableId, WritingStore, type ParsedWork, type SourceDocument } from "@writing-mcp/core";

const makeWork=(rootPath:string):ParsedWork=>{
  const workRef=stableId("work","tense",rootPath);
  const doc=(name:string,title:string,content:string,chapterNumber:number):SourceDocument=>({documentRef:stableId("doc",workRef,name),relativePath:name,absolutePath:name,title,kind:"chapter",content,chapterNumber,sourceMtimeMs:1,sourceSize:content.length});
  return{workRef,title:"Tense",rootPath,adapter:"generic",capabilities:[],documents:[
    doc("one.md","第一章","# 第一章\n铜钥匙第一次出现。",1),
    doc("two.md","第二章","# 第二章\n北塔开门。",2),
    doc("three.md","第三章","# 第三章\n银铃铛响起。",3),
  ]};
};

const chapterRefs=(db:DatabaseSync)=>(db.prepare("SELECT e.entity_ref FROM entities e JOIN spans s ON s.span_ref=e.span_ref JOIN documents d ON d.document_ref=s.document_ref WHERE e.kind='Chapter' ORDER BY d.source_ordinal,s.ordinal,e.entity_ref").all() as Array<{entity_ref:string}>).map(row=>row.entity_ref);
const insertFact=(db:DatabaseSync,ref:string,name:string,spanRef:string,from:string|null,to:string|null,time:string)=>{db.prepare("INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(ref,"Fact",name,name,"deterministic",1,spanRef,`identity-${ref}`,`evidence-${ref}`,from,to,time,JSON.stringify({}),1);};

describe("AUD-012 timeline chapter-tense filtering against a target chapter anchor",()=>{
  test("projects only facts temporally valid at the anchored chapter",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-tense-")),work=makeWork(root);
    let store=new WritingStore(work);
    try{await store.index("rebuild");}finally{store.close();}
    const dbPath=join(root,".writing-index",work.workRef.replace(":","-"),"index.sqlite"),db=new DatabaseSync(dbPath);
    try{
      const [ch1,ch2,ch3]=chapterRefs(db),span=String((db.prepare("SELECT span_ref FROM spans ORDER BY span_ref LIMIT 1").get() as {span_ref:string}).span_ref);
      // Valid chapters 1..2 and chapters 3..end respectively.
      insertFact(db,"entity:fact-early","黎明之约",span,ch1!,ch2!,"黄昏");
      insertFact(db,"entity:fact-late","深夜密会",span,ch3!,null,"深夜");
    }finally{db.close();}
    store=new WritingStore(work);
    try{
      const at2=await store.explore("timeline","",20,2,2);
      expect(at2.diagnostics.map(item=>item.code)).toContain("TIMELINE_PROJECTION");
      expect(at2.results.map(item=>item.title)).toEqual(["precedes: 第一章 → 第二章","黎明之约","第二章","precedes: 第二章 → 第三章"]);
      const at3=await store.explore("timeline","",20,2,3);
      expect(at3.results.map(item=>item.title)).toEqual(["precedes: 第二章 → 第三章","第三章","深夜密会"]);
      // An anchor beyond the last chapter keeps only facts valid to the end.
      const tail=await store.explore("timeline","",20,2,99);
      expect(tail.results.map(item=>item.title)).toEqual(["深夜密会"]);
      const again=await store.explore("timeline","",20,2,2);
      expect(again.results.map(item=>item.ref)).toEqual(at2.results.map(item=>item.ref));
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });

  test("combines the anchor with deterministic name filtering",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-tense-filter-")),work=makeWork(root);
    let store=new WritingStore(work);
    try{await store.index("rebuild");}finally{store.close();}
    const dbPath=join(root,".writing-index",work.workRef.replace(":","-"),"index.sqlite"),db=new DatabaseSync(dbPath);
    try{
      const [ch1,,ch3]=chapterRefs(db),span=String((db.prepare("SELECT span_ref FROM spans ORDER BY span_ref LIMIT 1").get() as {span_ref:string}).span_ref);
      insertFact(db,"entity:fact-span","长夜之约",span,ch1!,ch3!,"子夜");
    }finally{db.close();}
    store=new WritingStore(work);
    try{
      const filtered=await store.explore("timeline","第三章",20,2,3);
      expect(filtered.results.map(item=>item.title)).toEqual(["precedes: 第二章 → 第三章","第三章"]);
      const anchoredAway=await store.explore("timeline","第一章",20,2,1);
      expect(anchoredAway.results.map(item=>item.title)).toEqual(["第一章","precedes: 第一章 → 第二章"]);
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });
});
