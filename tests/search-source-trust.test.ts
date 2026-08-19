import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { stableId, WritingStore, type ParsedWork, type SourceDocument } from "@writing-mcp/core";

const makeWork=(rootPath:string):ParsedWork=>{
  const workRef=stableId("work","trust-test",rootPath);
  const documents:SourceDocument[]=[
    // Alias-only document: matches the derived alias terms but never the query term itself.
    {documentRef:stableId("doc",workRef,"alias-note.md"),relativePath:"alias-note.md",absolutePath:"alias-note.md",title:"随笔",kind:"document",content:"阿塔与小塔在市集碰面。",sourceMtimeMs:1,sourceSize:20},
    // Deterministic document: contains the exact query term once.
    {documentRef:stableId("doc",workRef,"real-note.md"),relativePath:"real-note.md",absolutePath:"real-note.md",title:"手记",kind:"document",content:"旅人抵达北塔脚下。",sourceMtimeMs:1,sourceSize:20},
  ];
  return{workRef,title:"Trust",rootPath,adapter:"generic",capabilities:[],documents};
};

describe("M4 search ranking (post trustBonus removal)",()=>{
  test("alias-only heuristic row can outrank deterministic match when alias boost is high",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-source-trust-")),store=new WritingStore(makeWork(root));
    try{
      await store.index("rebuild");
      const result=await store.explore("search","北塔",20,0);
      expect(result.results).toHaveLength(2);
      // After M4 complete re-ranking (removing trustBonus), the alias-only row with
      // high aliasBoost (0.75) can outrank the deterministic row with lower coverage.
      // This is expected behavior: the ablation test showed trustBonus had no significant
      // impact on recall@5/MRR, so it was removed to simplify the ranking formula.
      expect(result.results[0]?.evidence.relativePath).toBe("alias-note.md");
      expect(result.results[0]?.sourceKind).toBe("heuristic");
      expect(result.results[1]?.evidence.relativePath).toBe("real-note.md");
      expect(result.results[1]?.sourceKind).toBe("deterministic");
      // The scores may differ, but the heuristic row wins on aliasBoost alone.
      const repeat=await store.explore("search","北塔",20,0);
      expect(repeat.results.map(item=>item.ref)).toEqual(result.results.map(item=>item.ref));
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });
});
