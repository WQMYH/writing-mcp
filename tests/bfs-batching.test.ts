import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { stableId, WritingStore, type SourceDocument } from "@writing-mcp/core";

describe("AUD-020 bounded fan-out and batched expansion",()=>{
  test("caps per-node fan-out deterministically on a wide graph",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-fanout-")),workRef=stableId("work","fanout",root);
    const make=(path:string,content:string):SourceDocument=>({documentRef:stableId("doc",workRef,path),relativePath:path,absolutePath:path,title:path,kind:"character",content,sourceMtimeMs:1,sourceSize:content.length});
    // One hub entity referenced by 90 bracket links; each target also carries
    // its contains/precedes structure, so the hub touches well above the 64 fan-out cap.
    const documents:SourceDocument[]=[make("hub.md","# 中枢")];
    for(let index=0;index<90;index++)documents.push(make(`leaf-${String(index).padStart(2,"0")}.md`,`# 叶${String(index).padStart(2,"0")}\n记录 [[中枢]] 的关联。`));
    const store=new WritingStore({workRef,title:"FanOut",rootPath:root,adapter:"generic",capabilities:[],documents});
    try{
      await store.index("rebuild");
      const result=await store.explore("neighborhood","中枢",20,2);
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.metrics.visitedNodes).toBeLessThanOrEqual(512);
      expect(result.truncated).toBe(true);
      expect(result.metrics.omittedEstimate).toBeGreaterThan(0);
      // Expansion must stay deterministic across repeated runs.
      const again=await store.explore("neighborhood","中枢",20,2);
      expect(again.results.map(item=>item.ref)).toEqual(result.results.map(item=>item.ref));
      expect(again.metrics.omittedEstimate).toBe(result.metrics.omittedEstimate);
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });

  test("expands a wide graph within the batched performance budget",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-bfs-perf-")),workRef=stableId("work","bfs-perf",root);
    const make=(path:string,content:string):SourceDocument=>({documentRef:stableId("doc",workRef,path),relativePath:path,absolutePath:path,title:path,kind:"character",content,sourceMtimeMs:1,sourceSize:content.length});
    const documents:SourceDocument[]=[make("hub.md","# 枢纽")];
    for(let index=0;index<200;index++)documents.push(make(`node-${String(index).padStart(3,"0")}.md`,`# 节点${String(index).padStart(3,"0")}\n[[枢纽]] 与 节点${String((index+1)%200).padStart(3,"0")} 相连。`));
    const store=new WritingStore({workRef,title:"BfsPerf",rootPath:root,adapter:"generic",capabilities:[],documents});
    try{
      await store.index("rebuild");
      const started=performance.now();
      const result=await store.explore("neighborhood","枢纽",20,3);
      const elapsedMs=performance.now()-started;
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.metrics.visitedNodes).toBeGreaterThan(10);
      // Generous guardrail: a per-node edge query for every visited node would
      // push this far beyond the budget once the global cap (512) is reached.
      expect(elapsedMs,"batched BFS over a wide graph should stay inside the deterministic budget").toBeLessThan(5_000);
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });
});
