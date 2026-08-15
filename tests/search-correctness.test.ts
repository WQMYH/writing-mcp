import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { stableId, WritingStore, type ParsedWork, type SourceDocument } from "@writing-mcp/core";

const makeWork=(rootPath:string):ParsedWork=>{
  const workRef=stableId("work","search-test",rootPath);
  const documents:SourceDocument[]=[
    {documentRef:stableId("doc",workRef,"roles.md"),relativePath:"roles.md",absolutePath:"roles.md",title:"语笙",kind:"character",content:"# 语笙\n化名林夜，来自北塔。",sourceMtimeMs:1,sourceSize:20},
    {documentRef:stableId("doc",workRef,"chapter.md"),relativePath:"chapter.md",absolutePath:"chapter.md",title:"第一章",kind:"chapter",content:"# 第一章\n语笙在雨夜抵达北塔。",chapterNumber:1,sourceMtimeMs:1,sourceSize:20},
  ];
  return{workRef,title:"Search",rootPath,adapter:"generic",capabilities:[],documents};
};

describe("M3 deterministic query analysis",()=>{
  test("finds relevant evidence from an unsegmented Chinese question",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-cjk-query-")),store=new WritingStore(makeWork(root));
    try{
      await store.index("rebuild");
      const result=await store.explore("search","请告诉我语笙在雨夜去了哪里以及她使用了什么化名",20,0);
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.map(item=>item.evidence.excerpt).join("\n")).toContain("语笙");
      expect(result.diagnostics.some(item=>item.code==="QUERY_ANALYZED")).toBe(true);
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });

  test("distinguishes empty analysis, true no-results, and stable repeated ordering",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-query-diagnostics-")),store=new WritingStore(makeWork(root));
    try{
      await store.index("rebuild");
      const empty=await store.explore("search","　，！？",20,0);
      expect(empty.results).toEqual([]);
      expect(empty.diagnostics.map(item=>item.code)).toContain("NO_MATCHING_TERMS");
      const missing=await store.explore("search","完全不存在的量子飞船",20,0);
      expect(missing.results).toEqual([]);
      expect(missing.diagnostics.map(item=>item.code)).toContain("NO_RESULTS");
      const first=await store.explore("search","语笙 北塔",20,0),second=await store.explore("search","语笙 北塔",20,0);
      expect(second.results.map(item=>item.ref)).toEqual(first.results.map(item=>item.ref));
      await expect(store.explore("search","语".repeat(2049),20,0)).rejects.toMatchObject({code:"QUERY_TOO_LARGE"});
      await expect(store.context("语笙",100,Array.from({length:129},(_,index)=>`ref:${index}`))).rejects.toMatchObject({code:"CONTEXT_REFS_TOO_LARGE"});
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });

  test("returns aliases, duplicate identities, alternative definitions, and unresolved references without guessing",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-ambiguity-")),base=makeWork(root),work:ParsedWork={...base,documents:[
      ...base.documents,
      {...base.documents[0]!,documentRef:stableId("doc",base.workRef,"roles-2.md"),relativePath:"roles-2.md",absolutePath:"roles-2.md",content:"# 语笙\n另一份定义。"},
      {...base.documents[1]!,documentRef:stableId("doc",base.workRef,"volume-2.md"),relativePath:"volume-2.md",absolutePath:"volume-2.md",content:"# 第一章\n另一卷。"},
      {documentRef:stableId("doc",base.workRef,"notes.md"),relativePath:"notes.md",absolutePath:"notes.md",title:"Notes",kind:"document",content:"等待 [[未定角色]] 出场。",sourceMtimeMs:1,sourceSize:20},
    ]};
    let store=new WritingStore(work);
    try{await store.index("rebuild");}finally{store.close();}
    const dbPath=join(root,".writing-index",work.workRef.replace(":","-"),"index.sqlite"),db=new DatabaseSync(dbPath);
    try{const entity=db.prepare("SELECT entity_ref FROM entities WHERE name='语笙'").get() as {entity_ref:string};db.prepare("INSERT INTO aliases VALUES(?,?,?)").run(entity.entity_ref,"林夜","林夜");}finally{db.close();}
    store=new WritingStore(work);
    try{
      const alias=await store.explore("entity","林夜",20,0);expect(alias.results[0]?.title).toBe("语笙");
      const duplicate=await store.explore("entity","第一章",20,0);expect(duplicate.results).toHaveLength(2);expect(duplicate.ambiguous).toHaveLength(2);expect(duplicate.diagnostics.map(item=>item.code)).toContain("AMBIGUOUS_ENTITY");
      const definitions=await store.explore("entity","语笙",20,0);expect(definitions.results).toHaveLength(1);expect(definitions.ambiguous.some(item=>item.kind==="CharacterDefinition")).toBe(true);
      const unresolved=await store.explore("entity","未定角色",20,0);expect(unresolved.results).toEqual([]);expect(unresolved.ambiguous[0]?.kind).toBe("unresolved");expect(unresolved.diagnostics.map(item=>item.code)).toContain("UNRESOLVED_REFERENCE");
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });
});
