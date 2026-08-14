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

  test("reranks short Chinese terms and marks nickname-only expansion as heuristic",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-ranking-")),workRef=stableId("work","ranking",root),documents:SourceDocument[]=[];
    for(let index=0;index<25;index++){const content=`普通段落 ${index} 喜欢`;documents.push({documentRef:stableId("doc",workRef,String(index)),relativePath:`noise-${index}.txt`,absolutePath:`noise-${index}.txt`,title:`Noise ${index}`,kind:"document",content,sourceMtimeMs:1,sourceSize:content.length});}
    const add=(path:string,content:string)=>documents.push({documentRef:stableId("doc",workRef,path),relativePath:path,absolutePath:path,title:path,kind:"document",content,sourceMtimeMs:1,sourceSize:content.length});add("nickname.txt","阿枫很喜欢，却也有些冲动。");add("given-name.txt","溪海后来去了酒吧。");
    const store=new WritingStore({workRef,title:"Ranking",rootPath:root,adapter:"generic",capabilities:[],documents});
    try{await store.index("rebuild");const relation=await store.explore("search","吕霁 岳枫 感情 喜欢",20,2);expect(relation.results.some(item=>item.evidence.relativePath==="nickname.txt")).toBe(true);const nickname=await store.explore("search","岳枫",20,2);expect(nickname.results.find(item=>item.evidence.relativePath==="nickname.txt")?.sourceKind).toBe("heuristic");const givenName=await store.explore("search","岳枫 林溪海 在一起 酒吧",20,2);expect(givenName.results.some(item=>item.evidence.relativePath==="given-name.txt")).toBe(true);}finally{store.close();await rm(root,{recursive:true,force:true});}
  });
});
