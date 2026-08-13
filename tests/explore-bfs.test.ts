import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { stableId, WritingStore, type ParsedWork, type SourceDocument } from "@writing-mcp/core";

describe("M3 bounded graph exploration",()=>{
  test("honors 0-3 hops and returns evidence for every traversed edge",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-bfs-")),workRef=stableId("work","bfs",root);
    const make=(path:string,title:string,kind:SourceDocument["kind"],content:string,chapterNumber?:number):SourceDocument=>({documentRef:stableId("doc",workRef,path),relativePath:path,absolutePath:path,title,kind,content,chapterNumber,sourceMtimeMs:1,sourceSize:content.length});
    const work:ParsedWork={workRef,title:"BFS",rootPath:root,adapter:"generic",capabilities:[],documents:[make("characters.md","Alice","character","# Alice"),make("one.md","One","chapter","# One\nAlice entered.",1),make("two.md","Two","chapter","# Two\nThe trail continued.",2)]};
    const store=new WritingStore(work);
    try{
      await store.index("rebuild");
      const zero=await store.explore("neighborhood","Alice",20,0);expect(zero.results).toHaveLength(1);expect(zero.metrics.maxActualHops).toBe(0);
      const two=await store.explore("neighborhood","Alice",20,2);expect(two.metrics.maxActualHops).toBe(2);expect(two.metrics.visitedNodes).toBeGreaterThan(1);
      const traversed=two.results.filter(item=>item.pathEvidence?.length);expect(traversed.length).toBeGreaterThan(0);expect(traversed.every(item=>item.pathEvidence!.every(edge=>edge.evidence.documentRef&&edge.evidence.relativePath))).toBe(true);
      expect(two.results.find(item=>item.title==="One")?.evidence.documentRef).toBe(work.documents[1]!.documentRef);
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  });
});
