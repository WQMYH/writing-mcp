import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { WritingService, type ExploreOperation } from "@writing-mcp/core";
import { GenericAdapter } from "@writing-mcp/adapter-generic";

interface BenchmarkTask { id:string; operation:ExploreOperation|"context"; query:string; expect:string; budgetTokens?:number }

describe("M0 deterministic benchmark",()=>{
  test("passes all 30 machine-readable tasks with evidence",async()=>{
    const tasks=JSON.parse(await readFile(new URL("../benchmarks/m0.json",import.meta.url),"utf8")) as BenchmarkTask[];
    expect(tasks).toHaveLength(30);
    const dir=await mkdtemp(join(tmpdir(),"writing-mcp-benchmark-"));const source=join(dir,"novel");await cp(new URL("../fixtures/generic-novel",import.meta.url),source,{recursive:true});
    const service=new WritingService([new GenericAdapter()]);let passed=0,evidenced=0;
    try{const resolved=await service.resolve(source);const workRef=resolved.workRef!;await service.index(workRef,"rebuild");for(const task of tasks){if(task.operation==="context"){const packet=await service.context(workRef,task.query,task.budgetTokens??200);const text=packet.blocks.map(b=>b.evidence.excerpt).join("\n");expect(text,task.id).toContain(task.expect);expect(packet.usedTokens,task.id).toBeLessThanOrEqual(task.budgetTokens??200);if(packet.blocks.every(b=>b.evidence.relativePath&&b.evidence.startLine>0))evidenced++;}else{const result=await service.explore(workRef,task.operation,task.query,20,2);const text=result.results.map(r=>`${r.title}\n${r.evidence.excerpt}`).join("\n");expect(text,task.id).toContain(task.expect);if(result.results.every(r=>r.evidence.relativePath&&r.evidence.startLine>0))evidenced++;}passed++;}}
    finally{service.close();await rm(dir,{recursive:true,force:true});}
    expect(passed/tasks.length).toBe(1);expect(evidenced/tasks.length).toBe(1);
  },30000);
});
