import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { estimateTokens, WritingService } from "@writing-mcp/core";
import { GenericAdapter } from "@writing-mcp/adapter-generic";

interface Fact { id:string; query:string; expect:string }
interface ContextTask extends Fact { budgetTokens:number }
interface Baseline { expectedFacts:Fact[]; contextTasks:ContextTask[]; gates:{minimumFactRecall:number;minimumEvidenceCoverage:number;minimumTokenReduction:number} }

describe("M0 token and fact baseline",()=>{
  test("meets fixture recall, evidence and context-reduction gates",async()=>{
    const spec=JSON.parse(await readFile(new URL("../benchmarks/baseline.json",import.meta.url),"utf8")) as Baseline;
    const fixture=new URL("../fixtures/generic-novel/",import.meta.url);const names=(await readdir(fixture)).sort();const fullText=(await Promise.all(names.map(name=>readFile(new URL(name,fixture),"utf8")))).join("\n");const fullBookTokens=estimateTokens(fullText);
    const dir=await mkdtemp(join(tmpdir(),"writing-mcp-baseline-"));const source=join(dir,"novel");await cp(fixture,source,{recursive:true});const service=new WritingService([new GenericAdapter()]);let recalled=0,evidenced=0,totalContextTokens=0;
    try{const resolved=await service.resolve(source);const workRef=resolved.workRef!;await service.index(workRef,"rebuild");for(const fact of spec.expectedFacts){const result=await service.explore(workRef,"search",fact.query,20,2);const text=result.results.map(r=>r.evidence.excerpt).join("\n");if(text.includes(fact.expect))recalled++;if(result.results.length>0&&result.results.every(r=>r.evidence.relativePath&&r.evidence.startLine>0))evidenced++;}for(const task of spec.contextTasks){const packet=await service.context(workRef,task.query,task.budgetTokens);expect(packet.blocks.map(b=>b.evidence.excerpt).join("\n"),task.id).toContain(task.expect);expect(packet.usedTokens,task.id).toBeLessThanOrEqual(task.budgetTokens);totalContextTokens+=packet.usedTokens;}}
    finally{service.close();await rm(dir,{recursive:true,force:true});}
    const recall=recalled/spec.expectedFacts.length;const evidenceCoverage=evidenced/spec.expectedFacts.length;const averageContextTokens=totalContextTokens/spec.contextTasks.length;const tokenReduction=1-averageContextTokens/fullBookTokens;
    expect(fullBookTokens).toBe(166);expect(recall).toBeGreaterThanOrEqual(spec.gates.minimumFactRecall);expect(evidenceCoverage).toBeGreaterThanOrEqual(spec.gates.minimumEvidenceCoverage);expect(tokenReduction).toBeGreaterThanOrEqual(spec.gates.minimumTokenReduction);
  },30000);
});
