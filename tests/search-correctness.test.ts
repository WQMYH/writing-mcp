import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";
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

  test("caps the serialized response byte size deterministically",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-response-limit-")),workRef=stableId("work","search-test",root);
    const documents:SourceDocument[]=Array.from({length:8},(_,index)=>({documentRef:stableId("doc",workRef,`big-${index}.md`),relativePath:`big-${index}.md`,absolutePath:`big-${index}.md`,title:`文档 ${index}`,kind:"chapter",content:`# 文档 ${index}\n${"长".repeat(2400)}`,chapterNumber:index+1,sourceMtimeMs:1,sourceSize:2400}));
    // Inject a tiny cap so the truncation path is exercised deterministically.
    const store=new WritingStore({workRef,title:"ResponseLimit",rootPath:root,adapter:"generic",capabilities:[],documents},undefined,false,2_000);
    try{
      await store.index("rebuild");
      const result=await store.explore("search","文档",100,0);
      expect(result.truncated).toBe(true);
      expect(result.diagnostics.map(item=>item.code)).toContain("RESPONSE_TRUNCATED");
      expect(Buffer.byteLength(JSON.stringify({results:result.results,ambiguous:result.ambiguous}),"utf8")).toBeLessThanOrEqual(2_000);
      expect(result.results.length).toBeLessThan(100);
      // A single multibyte evidence item can itself exceed an injected tiny
      // cap, so the protective pre-trim may truthfully return zero items.
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });

  test("core pre-trim removes ambiguous tails before results and accounts for every new omission",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-core-ambiguous-limit-")),workRef=stableId("work","ambiguous-limit",root);
    const documents:SourceDocument[]=Array.from({length:5},(_,index)=>({documentRef:stableId("doc",workRef,`role-${index}.md`),relativePath:`role-${index}.md`,absolutePath:`role-${index}.md`,title:"同名角色",kind:"character",content:`# 同名角色\n定义 ${index} ${"长".repeat(900)}`,sourceMtimeMs:1,sourceSize:910}));
    const work:ParsedWork={workRef,title:"AmbiguousLimit",rootPath:root,adapter:"generic",capabilities:[],documents};
    const baselineStore=new WritingStore(work);let baseline:Awaited<ReturnType<WritingStore["explore"]>>;
    try{await baselineStore.index("rebuild");baseline=await baselineStore.explore("entity","同名角色",100,0);}finally{baselineStore.close();}
    const limitedStore=new WritingStore(work,undefined,false,8_500);
    try{
      const limited=await limitedStore.explore("entity","同名角色",100,0);
      expect(baseline.ambiguous.length).toBeGreaterThan(1);
      expect(limited.results.map(item=>item.ref)).toEqual(baseline.results.map(item=>item.ref));
      expect(limited.ambiguous.length).toBeGreaterThan(0);
      expect(limited.ambiguous.length).toBeLessThan(baseline.ambiguous.length);
      const newlyOmitted=baseline.results.length+baseline.ambiguous.length-limited.results.length-limited.ambiguous.length;
      expect(limited.metrics.omittedEstimate).toBe(baseline.metrics.omittedEstimate+newlyOmitted);
    }finally{limitedStore.close();await rm(root,{recursive:true,force:true});}
  });

  test("evaluator pre-trim reports every result removed by its byte cap",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-evaluator-limit-")),workRef=stableId("work","evaluator-limit",root);
    const documents:SourceDocument[]=Array.from({length:20},(_,index)=>({documentRef:stableId("doc",workRef,`doc-${index}.md`),relativePath:`doc-${index}.md`,absolutePath:`doc-${index}.md`,title:`文档 ${index}`,kind:"chapter",content:`# 文档 ${index}\n共同线索 ${"长".repeat(1_000)}`,sourceMtimeMs:1,sourceSize:1_020}));
    const store=new WritingStore({workRef,title:"EvaluatorLimit",rootPath:root,adapter:"generic",capabilities:[],documents},undefined,false,10_000);
    try{
      await store.index("rebuild");
      const result=await store.evaluateSearch("共同线索",100,{});
      expect(result.results.length).toBeLessThan(result.metrics.candidateCount);
      expect(result.metrics.omittedEstimate).toBe(result.metrics.candidateCount-result.results.length);
      expect(result.metrics.returnedCount+result.metrics.omittedEstimate).toBe(result.metrics.candidateCount);
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });

  test("retains short original-term evidence when long-term FTS fills the candidate pool",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-short-original-candidate-")),workRef=stableId("work","short-original-candidate",root);
    const target:SourceDocument={documentRef:stableId("doc",workRef,"target.md"),relativePath:"target.md",absolutePath:"target.md",title:"酒吧证据",kind:"chapter",content:"# 酒吧证据\n溪海在酒吧介绍了自己的男朋友。",chapterNumber:1,sourceMtimeMs:1,sourceSize:24};
    const distractors:SourceDocument[]=Array.from({length:240},(_,index)=>({documentRef:stableId("doc",workRef,`distractor-${index}.md`),relativePath:`distractor-${index}.md`,absolutePath:`distractor-${index}.md`,title:`普通片段 ${index}`,kind:"chapter",content:`# 普通片段 ${index}\n林溪海经过这里。`,chapterNumber:index+2,sourceMtimeMs:1,sourceSize:24}));
    const store=new WritingStore({workRef,title:"ShortOriginalCandidate",rootPath:root,adapter:"generic",capabilities:[],documents:[target,...distractors]});
    try{
      await store.index("rebuild");
      const result=await store.explore("search","林溪海 酒吧",20,0);
      expect(result.results.map(item=>item.title)).toContain("酒吧证据");
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });

  test("reuses production search rows for an identical warm query at the same revision",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-warm-search-cache-")),store=new WritingStore(makeWork(root));
    const prepare=vi.spyOn(DatabaseSync.prototype,"prepare");
    try{
      await store.index("rebuild");
      prepare.mockClear();
      await store.explore("search","语笙化名林夜 北塔",20,0);
      const afterFirst=prepare.mock.calls.filter(([sql])=>String(sql).includes("spans_fts MATCH")).length;
      expect(afterFirst).toBeGreaterThan(0);
      await store.explore("search","语笙化名林夜 北塔",20,0);
      const afterSecond=prepare.mock.calls.filter(([sql])=>String(sql).includes("spans_fts MATCH")).length;
      expect(afterSecond).toBe(afterFirst);
      await store.index("rebuild");
      prepare.mockClear();
      await store.explore("search","语笙化名林夜 北塔",20,0);
      expect(prepare.mock.calls.filter(([sql])=>String(sql).includes("spans_fts MATCH")).length).toBeGreaterThan(0);
    }finally{prepare.mockRestore();store.close();await rm(root,{recursive:true,force:true});}
  });
});
