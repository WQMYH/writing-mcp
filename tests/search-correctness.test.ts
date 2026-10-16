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
  test.each([
    { marker: "RAVEN", prefix: "x".repeat(1200), name: "uppercase" },
    { marker: "Raven", prefix: "x".repeat(1200), name: "mixed case" },
    { marker: "RAVEN", prefix: "İ".repeat(600) + "x".repeat(600), name: "length-changing lowercase prefix" },
  ])("exposes the original unique proper noun with $name (W-MCP-006)", async ({ marker, prefix }) => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-case-window-")), work = makeWork(root);
    const content = prefix + ` ${marker} ` + "z".repeat(600);
    work.documents = [{ ...work.documents[0]!, title: "Evidence", kind: "document", content, sourceSize: Buffer.byteLength(content) }];
    const store = new WritingStore(work);
    try {
      await store.index("rebuild");
      const result = await store.explore("search", "raven", 20, 0), item = result.results[0]!;
      expect(item.evidence.excerpt).toContain(marker);
      expect(item.sourceKind).toBe("deterministic");
      expect(item.evidence.excerpt.split("\n…\n").every(part => content.includes(part))).toBe(true);
      expect(item.evidence.excerpt.length).toBeLessThanOrEqual(900);
      expect((await store.explore("search", "RAVEN", 20, 0)).results).toEqual(result.results);
      const packet = await store.context("raven", 10_000);
      expect(packet.blocks[0]!.evidence.excerpt).toContain(marker);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test.each([1, 2, 100])("does not hide same-name owner ambiguity at limit %i (W-MCP-008)", async limit => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-owner-limit-")), work = makeWork(root);
    work.documents.push({ ...work.documents[1]!, documentRef: stableId("doc", work.workRef, "other-volume.md"), relativePath: "other-volume.md", content: "# 第一章\nAnother volume." });
    const store = new WritingStore(work);
    try {
      await store.index("rebuild");
      const result = await store.explore("neighborhood", "第一章", limit, 2);
      expect(result.diagnostics.map(item => item.code)).toContain("AMBIGUOUS_ENTITY");
      expect(result.results.length).toBeLessThanOrEqual(limit);
      expect(result.metrics.maxActualHops).toBe(0);
      expect(result.results.every(item => !item.pathEvidence?.length)).toBe(true);
      const explicit = await store.explore("neighborhood", result.results[0]!.ref, 20, 1);
      expect(explicit.diagnostics.map(item => item.code)).not.toContain("AMBIGUOUS_ENTITY");
      expect(explicit.metrics.maxActualHops).toBe(1);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("counts distinct alias owners before limiting, without inventing owners from multiple aliases (W-MCP-008/021)", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-alias-owner-")), work = makeWork(root), store = new WritingStore(work);
    try {
      await store.index("rebuild");
      const db = new DatabaseSync(join(root, ".writing-index", work.workRef.replace(":", "-"), "index.sqlite"));
      const owner = String(db.prepare("SELECT entity_ref FROM entities WHERE name='语笙'").get()!.entity_ref);
      try {
        for (const alias of ["语笙-旧名", "语笙-昵称"]) db.prepare("INSERT INTO aliases VALUES(?,?,?)").run(owner, alias, alias);
        const one = await store.explore("neighborhood", "语笙", 20, 1);
        expect(one.diagnostics.map(item => item.code)).not.toContain("AMBIGUOUS_ENTITY");
        expect(one.results.filter(item => item.ref === owner)).toHaveLength(1);
        expect(one.metrics.maxActualHops).toBe(1);
        const chapter = String(db.prepare("SELECT entity_ref FROM entities WHERE kind='Chapter'").get()!.entity_ref);
        for (const ref of [owner, chapter]) db.prepare("INSERT INTO aliases VALUES(?,?,?)").run(ref, "共同名字", "共同名字");
        const many = await store.explore("neighborhood", "共同名字", 1, 1);
        expect(many.diagnostics.map(item => item.code)).toContain("AMBIGUOUS_ENTITY");
        expect(many.metrics.maxActualHops).toBe(0);
      } finally { db.close(); }
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("assigns exact/partial entity scores so a graph neighbor cannot displace its named seed (W-MCP-015)", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-seed-score-")), work = makeWork(root), store = new WritingStore(work);
    try {
      await store.index("rebuild");
      const exact = await store.explore("entity", "语笙", 20, 0), seed = exact.results[0]!;
      expect(seed.score).toBe(2);
      expect((await store.explore("entity", "语", 20, 0)).results[0]!.score).toBe(1);
      for (const query of ["语笙", seed.ref, work.documents[1]!.documentRef]) for (const limit of [1, 2]) {
        const result = await store.explore("neighborhood", query, limit, 1);
        expect(result.results[0]!.ref).toBe(query === work.documents[1]!.documentRef ? query : seed.ref);
        expect(result.results[0]!.score).toBe(2);
        if (limit === 2) expect(result.results[1]!.score).toBe(0.5);
      }
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test.each([
    { query: "Sun\\Moon", want: ["Sun\\Moon"] }, { query: "SunMoon", want: ["SunMoon"] },
    { query: "%", want: ["Sun%_\\Moon"] }, { query: "_", want: ["Sun%_\\Moon"] },
    { query: "Sun%_\\Moon", want: ["Sun%_\\Moon"] },
  ])("matches literal entity-name punctuation: $query (W-MCP-024)", async ({ query, want }) => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-entity-like-")), work = makeWork(root);
    work.documents = ["Sun\\Moon", "SunMoon", "Sun%_\\Moon"].map((title, index) => ({
      documentRef: stableId("doc", work.workRef, String(index)), relativePath: `${index}.md`, absolutePath: `${index}.md`, title, kind: "character", content: `# ${title}`, sourceMtimeMs: 1, sourceSize: title.length + 2,
    }));
    const store = new WritingStore(work);
    try { await store.index("rebuild"); expect((await store.explore("entity", query, 20, 0)).results.map(item => item.title)).toEqual(want); }
    finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test.each(["😀", "𠀀"])("preserves %s through SQLite, excerpt windows and graph evidence (W-MCP-002)", async glyph => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-unicode-evidence-")), workRef = stableId("work", "unicode-evidence", root);
    const document = (path: string, title: string, kind: SourceDocument["kind"], content: string): SourceDocument => ({
      documentRef: stableId("doc", workRef, path), relativePath: path, absolutePath: path, title, kind, content, sourceMtimeMs: 1, sourceSize: Buffer.byteLength(content),
    });
    const splitContent = "p".repeat(2399) + glyph + " trailer";
    const documents = [
      document("role.md", "Iona", "character", "# Iona\n" + "x".repeat(892) + glyph + "z".repeat(300)),
      document("split.md", "Split", "document", splitContent),
      document("window.md", "Window", "document", "x".repeat(850) + glyph + "x".repeat(148) + "needle" + "x".repeat(142) + glyph + "x".repeat(800)),
      document("fallback.md", "fallbackhit", "document", "y".repeat(899) + glyph + "z".repeat(1100)),
    ];
    const store = new WritingStore({ workRef, title: "Unicode evidence", rootPath: root, adapter: "generic", capabilities: [], documents });
    try {
      await store.index("rebuild");
      const db = new DatabaseSync(join(root, ".writing-index", workRef.replace(":", "-"), "index.sqlite"), { readOnly: true });
      try {
        const contents = db.prepare("SELECT content FROM spans WHERE document_ref=? ORDER BY ordinal").all(documents[1]!.documentRef).map(row => String(row.content));
        expect(contents.join("")).toBe(splitContent);
        expect(contents.every(content => content.isWellFormed() && content.length <= 2400)).toBe(true);
      } finally { db.close(); }
      const direct = await store.explore("entity", "Iona", 20, 0);
      expect(direct.results).toHaveLength(1);
      expect(direct.results[0]!.evidence.excerpt.isWellFormed()).toBe(true);
      const window = await store.explore("search", "needle", 20, 0);
      expect(window.results[0]!.evidence.excerpt).toContain("needle");
      expect(window.results[0]!.evidence.excerpt.isWellFormed()).toBe(true);
      const fallback = await store.explore("search", "fallbackhit", 20, 0);
      expect(fallback.results).not.toHaveLength(0);
      expect(fallback.results[0]!.evidence.excerpt.isWellFormed()).toBe(true);
      const neighborhood = await store.explore("neighborhood", "Iona", 20, 1);
      const edges = neighborhood.results.flatMap(item => item.pathEvidence ?? []);
      expect(edges).not.toHaveLength(0);
      expect(edges.every(edge => edge.evidence.excerpt.isWellFormed())).toBe(true);
      const packet = await store.context("needle", 10_000);
      expect(packet.blocks).not.toHaveLength(0);
      expect(packet.blocks.every(block => block.evidence.excerpt.isWellFormed())).toBe(true);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

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
