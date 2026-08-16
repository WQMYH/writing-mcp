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

describe("M3 search source-trust ranking factor",()=>{
  test("deterministic term match outranks an alias-only heuristic row with a higher raw score",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-source-trust-")),store=new WritingStore(makeWork(root));
    try{
      await store.index("rebuild");
      const result=await store.explore("search","北塔",20,0);
      expect(result.results).toHaveLength(2);
      // The alias-only row carries alias boost plus proximity and would win on raw
      // scoring alone; the source-trust factor must lift the deterministic row above it.
      expect(result.results[0]?.evidence.relativePath).toBe("real-note.md");
      expect(result.results[0]?.sourceKind).toBe("deterministic");
      expect(result.results[1]?.evidence.relativePath).toBe("alias-note.md");
      expect(result.results[1]?.sourceKind).toBe("heuristic");
      expect(result.results[0]!.score).toBeGreaterThan(result.results[1]!.score);
      const repeat=await store.explore("search","北塔",20,0);
      expect(repeat.results.map(item=>item.ref)).toEqual(result.results.map(item=>item.ref));
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });
});
