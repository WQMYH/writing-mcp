import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  test("freezes the native mentions relationship alongside other produced edge kinds",()=>{
    // Break caught: a future vocabulary reduction can no longer leave the
    // persisted native `mentions` relationship outside the public contract.
    expect(EDGE_KINDS).toContain("mentions");
  });

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

  test("resolves [[alias]] into a document-to-entity mentions edge with bidirectional BFS evidence",async()=>{
    // Break caught: native references can be stored as unresolved, inverted,
    // or lose their source evidence when a persisted alias is used.
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-mentions-alias-")),workRef=stableId("work","mentions-alias",root);
    const doc=(name:string,title:string,kind:SourceDocument["kind"],content:string,chapterNumber?:number):SourceDocument=>({documentRef:stableId("doc",workRef,name),relativePath:name,absolutePath:name,title,kind,content,chapterNumber,sourceMtimeMs:1,sourceSize:Buffer.byteLength(content)});
    const character=doc("character.md","语笙","character","# 语笙\n角色定义。"),chapter=doc("chapter.md","第一章","chapter","# 第一章\n尚未出现引用。",1);
    const work:ParsedWork={workRef,title:"Alias mentions",rootPath:root,adapter:"generic",capabilities:[],documents:[character,chapter]};
    const store=new WritingStore(work);
    try{
      await store.index("rebuild");
      const dbPath=join(root,".writing-index",work.workRef.replace(":","-"),"index.sqlite"),db=new DatabaseSync(dbPath);
      let entityRef="";
      try{
        entityRef=String((db.prepare("SELECT entity_ref FROM entities WHERE name='语笙'").get() as {entity_ref:string}).entity_ref);
        // The generic fixture has no source alias declaration grammar. Seed a
        // persisted, canonical alias, then change the source so incremental
        // indexing exercises the real native-reference resolver.
        db.prepare("INSERT INTO aliases(entity_ref,alias,normalized_alias) VALUES(?,?,?)").run(entityRef,"林夜","林夜");
      }finally{db.close();}
      chapter.content="# 第一章\n[[林夜]]走进北塔。";
      chapter.sourceSize=Buffer.byteLength(chapter.content);
      const indexed=await store.index("incremental");
      const verified=new DatabaseSync(dbPath,{readOnly:true});
      let sourceSpanRef="";
      try{
        const edge=verified.prepare("SELECT edge_ref,source_ref,target_ref,kind,span_ref,revision FROM edges WHERE kind='mentions'").get() as {edge_ref:string;source_ref:string;target_ref:string;kind:string;span_ref:string;revision:number};
        sourceSpanRef=edge.span_ref;
        expect(edge).toMatchObject({source_ref:chapter.documentRef,target_ref:entityRef,kind:"mentions",revision:indexed.revision});
        expect(verified.prepare("SELECT COUNT(*) count FROM unresolved_mentions WHERE text='林夜'").get()).toEqual({count:0});
        const expectedStart=chapter.content.indexOf("林夜"),expectedEnd=expectedStart+"林夜".length,expectedHash=createHash("sha256").update("林夜").digest("hex");
        expect(verified.prepare("SELECT start_offset,end_offset,evidence_hash FROM mentions WHERE entity_ref=? AND span_ref=? AND source_kind='native'").get(entityRef,sourceSpanRef)).toEqual({start_offset:expectedStart,end_offset:expectedEnd,evidence_hash:expectedHash});
        expect(verified.prepare("SELECT ee.span_ref,ee.start_offset,ee.end_offset,ee.evidence_hash,ee.revision,s.document_ref FROM edge_evidence ee JOIN spans s ON s.span_ref=ee.span_ref WHERE ee.edge_ref=?").get(edge.edge_ref)).toEqual({span_ref:sourceSpanRef,start_offset:expectedStart,end_offset:expectedEnd,evidence_hash:expectedHash,revision:indexed.revision,document_ref:chapter.documentRef});
      }finally{verified.close();}

      // Break caught: accepting a document seed for neighborhood must not
      // silently broaden the entity operation into a document lookup.
      const entityLookup=await store.explore("entity",chapter.documentRef,20,0);
      expect(entityLookup.results).toEqual([]);
      expect(entityLookup.diagnostics.some(entry=>entry.code==="NO_RESULTS")).toBe(true);
      const fromDocument=await store.explore("neighborhood",chapter.documentRef,20,1);
      const fromEntity=await store.explore("neighborhood",entityRef,20,1);
      const documentPath=fromDocument.results.find(item=>item.ref===entityRef)?.pathEvidence?.find(edge=>edge.edgeKind==="mentions");
      const entityPath=fromEntity.results.find(item=>item.ref===chapter.documentRef)?.pathEvidence?.find(edge=>edge.edgeKind==="mentions");
      expect(documentPath).toMatchObject({direction:"outgoing",sourceRef:chapter.documentRef,targetRef:entityRef,evidence:{documentRef:chapter.documentRef,revision:indexed.revision}});
      expect(entityPath).toMatchObject({direction:"incoming",sourceRef:chapter.documentRef,targetRef:entityRef,evidence:{documentRef:chapter.documentRef,revision:indexed.revision}});
      expect(entityPath?.edgeRef).toBe(documentPath?.edgeRef);
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });

  test("keeps a multi-owner persisted alias unresolved instead of selecting a deterministic-looking mention",async()=>{
    // Break caught: a shared alias must not silently resolve to the first row
    // in a sorted SQLite query and become a false graph fact.
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-ambiguous-alias-")),workRef=stableId("work","ambiguous-alias",root);
    const doc=(name:string,title:string,kind:SourceDocument["kind"],content:string,chapterNumber?:number):SourceDocument=>({documentRef:stableId("doc",workRef,name),relativePath:name,absolutePath:name,title,kind,content,chapterNumber,sourceMtimeMs:1,sourceSize:Buffer.byteLength(content)});
    const first=doc("first.md","语笙","character","# 语笙\n角色定义。"),second=doc("second.md","清璃","character","# 清璃\n角色定义。"),chapter=doc("chapter.md","第一章","chapter","# 第一章\n尚未出现引用。",1);
    const work:ParsedWork={workRef,title:"Ambiguous alias",rootPath:root,adapter:"generic",capabilities:[],documents:[first,second,chapter]};
    const store=new WritingStore(work);
    try{
      await store.index("rebuild");
      const dbPath=join(root,".writing-index",work.workRef.replace(":","-"),"index.sqlite"),db=new DatabaseSync(dbPath);
      try{
        const refs=(db.prepare("SELECT entity_ref FROM entities WHERE name IN ('语笙','清璃') ORDER BY name").all() as Array<{entity_ref:string}>).map(row=>row.entity_ref);
        expect(refs).toHaveLength(2);
        for(const ref of refs)db.prepare("INSERT INTO aliases(entity_ref,alias,normalized_alias) VALUES(?,?,?)").run(ref,"林夜","林夜");
      }finally{db.close();}
      chapter.content="# 第一章\n[[林夜]]走进北塔。";
      chapter.sourceSize=Buffer.byteLength(chapter.content);
      await store.index("incremental");
      const verified=new DatabaseSync(dbPath,{readOnly:true});
      try{
        expect(verified.prepare("SELECT COUNT(*) count FROM edges WHERE kind='mentions' AND source_ref=?").get(chapter.documentRef)).toEqual({count:0});
        expect(verified.prepare("SELECT text,reason FROM unresolved_mentions WHERE text='林夜'").get()).toEqual({text:"林夜",reason:"AMBIGUOUS_ALIAS"});
      }finally{verified.close();}
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });
});
