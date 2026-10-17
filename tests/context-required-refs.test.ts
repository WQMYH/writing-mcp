import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { stableId, WritingStore, type ParsedWork, type SourceDocument } from "@writing-mcp/core";

const makeWork=(rootPath:string):ParsedWork=>{
  const workRef=stableId("work","required-refs",rootPath);
  const doc=(name:string,title:string,content:string,chapterNumber:number):SourceDocument=>({documentRef:stableId("doc",workRef,name),relativePath:name,absolutePath:name,title,kind:"chapter",content,chapterNumber,sourceMtimeMs:1,sourceSize:content.length});
  return{workRef,title:"RequiredRefs",rootPath,adapter:"generic",capabilities:[],documents:[
    doc("alpha.md","甲篇","# 甲篇\n铜钥匙藏在抽屉里，等着被发现。",1),
    doc("beta.md","乙篇","# 乙篇\n银铃铛挂在屋檐下，风吹会响。",2),
  ]};
};

describe("AUD-005 requiredRefs resolve outside the search candidate pool",()=>{
  test("preserves each true omission cause when required minimum exceeds budget (W-MCP-003)", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-omission-reasons-")), work = makeWork(root);
    const first = work.documents[0]!;
    work.documents.push(
      { ...first, documentRef: stableId("doc", work.workRef, "copy.md"), relativePath: "copy.md", absolutePath: "copy.md" },
      { ...first, documentRef: stableId("doc", work.workRef, "optional.md"), relativePath: "optional.md", absolutePath: "optional.md", title: "Optional", content: "# Optional\n铜钥匙也有线索。" },
    );
    const store = new WritingStore(work);
    try {
      await store.index("rebuild");
      const ref = async (path: string) => (await store.explore("document", path, 20, 0)).results[0]!.ref;
      const [required, excluded, duplicate, optional] = [await ref("alpha.md"), await ref("beta.md"), await ref("copy.md"), await ref("optional.md")];
      const options = { excludeRefs: [excluded!], documentRefs: ["doc:missing"] };
      const roomy = await store.context("铜钥匙 银铃铛", 10_000, [required!, "entity:missing"], options);
      const minimum = roomy.blocks.find(block => block.ref === required)!.tokens;
      const packet = await store.context("铜钥匙 银铃铛", minimum - 1, [required!, "entity:missing"], options);
      expect(packet.status).toBe("budget_unsatisfiable");
      expect(packet.blocks).toEqual([]);
      const reasons = new Map(packet.omitted.map(item => [item.ref, item.reason]));
      expect(reasons.get(required!)).toBe("required_minimum_exceeds_budget");
      expect(reasons.get(optional!)).toBe("budget_limit");
      expect(reasons.get(excluded!)).toBe("excluded");
      expect(reasons.get(duplicate!)).toBe("duplicate_evidence");
      expect(reasons.get("entity:missing")).toBe("not_found");
      expect(reasons.get("doc:missing")).toBe("not_found");
      const exact = await store.context("铜钥匙 银铃铛", minimum, [required!], options);
      expect(exact.status).not.toBe("budget_unsatisfiable");
      expect(exact.blocks.map(block => block.ref)).toEqual([required]);
      expect(exact.usedTokens).toBe(minimum);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test.each(["required", "pin"])("restores an explicitly requested duplicate %s without contradictory omissions (W-MCP-004)", async mode => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-restored-duplicate-")), work = makeWork(root);
    work.documents[1] = { ...work.documents[1]!, title: work.documents[0]!.title, content: work.documents[0]!.content };
    const store = new WritingStore(work);
    try {
      await store.index("rebuild");
      const baseline = await store.context("铜钥匙", 10_000);
      const kept = baseline.blocks[0]!.ref, folded = baseline.omitted.find(item => item.reason === "duplicate_evidence")!.ref;
      const required = mode === "required" ? [kept, folded] : [], options = mode === "pin" ? { entityRefs: [folded] } : {};
      const packet = await store.context("铜钥匙", 10_000, required, options);
      expect(packet.blocks.map(block => block.ref).sort()).toEqual([kept, folded].sort());
      expect(packet.omitted).toEqual([]);
      const tight = await store.context("铜钥匙", 1, required, options);
      expect(tight.blocks).toEqual([]);
      expect(tight.omitted).toHaveLength(2);
      expect(new Set(tight.omitted.map(item => item.ref)).size).toBe(2);
      expect(tight.omitted.every(item => item.reason === (mode === "required" ? "required_minimum_exceeds_budget" : "budget_limit"))).toBe(true);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("resolves a required span ref that the search pool does not contain",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-required-span-")),work=makeWork(root),store=new WritingStore(work);
    try{
      await store.index("rebuild");
      const betaDocRef=stableId("doc",work.workRef,"beta.md");
      const dbPath=join(root,".writing-index",work.workRef.replace(":","-"),"index.sqlite"),db=new DatabaseSync(dbPath);
      let betaSpanRef="";
      try{betaSpanRef=String((db.prepare("SELECT span_ref FROM spans WHERE document_ref=? ORDER BY ordinal LIMIT 1").get(betaDocRef) as {span_ref:string}).span_ref);}finally{db.close();}
      const packet=await store.context("铜钥匙",10_000,[betaSpanRef]);
      const block=packet.blocks.find(item=>item.ref===betaSpanRef);
      expect(block,"the required span must be resolved even though it is not in the search top-50 pool").toBeDefined();
      expect(block!.required).toBe(true);
      expect(block!.evidence.excerpt).toContain("银铃铛");
      expect(packet.usedTokens).toBeGreaterThanOrEqual(block!.tokens);
      // Break caught: callers could mistake the built-in excerpt estimate for
      // whole-packet or exact model-token accounting.
      expect(packet.accountingScope).toBe("evidence_excerpts_only");
      expect(packet.usedTokens).toBe(packet.blocks.reduce((total,entry)=>total+entry.tokens,0));
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });

  test("resolves a required entity ref that the search pool does not contain",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-required-entity-")),work=makeWork(root),store=new WritingStore(work);
    try{
      await store.index("rebuild");
      const dbPath=join(root,".writing-index",work.workRef.replace(":","-"),"index.sqlite"),db=new DatabaseSync(dbPath);
      let entityRef="";
      try{entityRef=String((db.prepare("SELECT entity_ref FROM entities WHERE name='乙篇'").get() as {entity_ref:string}).entity_ref);}finally{db.close();}
      const packet=await store.context("铜钥匙",10_000,[entityRef]);
      const block=packet.blocks.find(item=>item.ref===entityRef);
      expect(block,"the required entity must be resolved even though it is not in the search top-50 pool").toBeDefined();
      expect(block!.required).toBe(true);
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });

  test("reports unresolvable required refs in omitted instead of dropping them silently",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-required-missing-")),store=new WritingStore(makeWork(root));
    try{
      await store.index("rebuild");
      const packet=await store.context("铜钥匙",10_000,["entity:does-not-exist"]);
      expect(packet.blocks.some(item=>item.ref==="entity:does-not-exist")).toBe(false);
      expect(packet.omitted).toContainEqual({ref:"entity:does-not-exist",reason:"not_found",tokens:0});
      expect(packet.status).toBe("truncated");
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });

  test("reports budget_unsatisfiable when a direct-resolved required ref exceeds the budget",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-required-budget-")),work=makeWork(root),store=new WritingStore(work);
    try{
      await store.index("rebuild");
      const betaDocRef=stableId("doc",work.workRef,"beta.md");
      const dbPath=join(root,".writing-index",work.workRef.replace(":","-"),"index.sqlite"),db=new DatabaseSync(dbPath);
      let betaSpanRef="";
      try{betaSpanRef=String((db.prepare("SELECT span_ref FROM spans WHERE document_ref=? ORDER BY ordinal LIMIT 1").get(betaDocRef) as {span_ref:string}).span_ref);}finally{db.close();}
      const packet=await store.context("铜钥匙",1,[betaSpanRef]);
      expect(packet.status).toBe("budget_unsatisfiable");
      expect(packet.omitted.some(item=>item.ref===betaSpanRef&&item.reason==="required_minimum_exceeds_budget")).toBe(true);
      // The required packet-shape field must not disappear from an early
      // business-result return path.
      expect(packet.accountingScope).toBe("evidence_excerpts_only");
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });

  test("keeps pool-hit required refs deduplicated and prioritized",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-required-pool-")),work=makeWork(root),store=new WritingStore(work);
    try{
      await store.index("rebuild");
      const alphaDocRef=stableId("doc",work.workRef,"alpha.md");
      const dbPath=join(root,".writing-index",work.workRef.replace(":","-"),"index.sqlite"),db=new DatabaseSync(dbPath);
      let alphaSpanRef="";
      try{alphaSpanRef=String((db.prepare("SELECT span_ref FROM spans WHERE document_ref=? ORDER BY ordinal LIMIT 1").get(alphaDocRef) as {span_ref:string}).span_ref);}finally{db.close();}
      const packet=await store.context("铜钥匙",10_000,[alphaSpanRef,alphaSpanRef]);
      const hits=packet.blocks.filter(item=>item.ref===alphaSpanRef);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.required).toBe(true);
      expect(packet.blocks[0]!.ref).toBe(alphaSpanRef);
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });
});
