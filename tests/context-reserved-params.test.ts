import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface DiagnosticResult { traceId: string; tool: string; outcome: "success" | "failure" }
interface SuccessEnvelope<T> { result: { ok: true; data: T; diagnostic: DiagnosticResult } }
const success = <T>(call: unknown): SuccessEnvelope<T>["result"] => ((call as { structuredContent?: unknown }).structuredContent as SuccessEnvelope<T>).result;

describe("AUD-012 target chapter anchor and reserved context parameters",()=>{
  test("explore exposes targetChapter and context accepts reserved inputs",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"writing-mcp-aud012-"));
    const source=join(dir,"novel");
    await cp(new URL("../fixtures/generic-novel",import.meta.url),source,{recursive:true});
    const client=new Client({name:"writing-mcp-test",version:"0.1.0"});
    const transport=new StdioClientTransport({command:process.execPath,args:[resolve("packages/mcp-server/dist/index.js")],env:{...process.env,WRITING_MCP_ROOTS:dir} as Record<string,string>});
    try{
      await client.connect(transport);
      const tools=await client.listTools();
      const explore=tools.tools.find(tool=>tool.name==="writing_explore")!,context=tools.tools.find(tool=>tool.name==="writing_context")!;
      const exploreProperties=explore.inputSchema.properties as Record<string,unknown>;
      expect(Object.keys(exploreProperties)).toContain("targetChapter");
      const contextProperties=context.inputSchema.properties as Record<string,unknown>;
      for(const reserved of ["targetChapter","entityRefs","documentRefs","excludeRefs"])expect(Object.keys(contextProperties)).toContain(reserved);
      // Reserved parameters must be documented as reserved, not silently dropped.
      expect(context.description).toMatch(/reserved/i);

      const resolvedCall=await client.callTool({name:"writing_resolve",arguments:{sourcePath:source}});
      const workRef=success<{workRef:string}>(resolvedCall).data.workRef;
      await client.callTool({name:"writing_index",arguments:{workRef,mode:"rebuild"}});

      const anchoredCall=await client.callTool({name:"writing_explore",arguments:{workRef,operation:"timeline",targetChapter:1}});
      const anchored=success<{results:Array<{title:string;kind:string}>}>(anchoredCall);
      expect(anchored.data.results.length).toBeGreaterThan(0);
      // The chapter-two entity itself is not valid at chapter one; relation
      // headings may still name the target chapter.
      expect(anchored.data.results.every(item=>!(item.kind==="Chapter"&&item.title.includes("第二章")))).toBe(true);

      const packetCall=await client.callTool({name:"writing_context",arguments:{workRef,taskType:"answer",query:"铜钥匙",budgetTokens:200,targetChapter:1,entityRefs:[],documentRefs:[],excludeRefs:[]}});
      const packet=success<{status:string}>(packetCall);
      expect(packet.data.status).not.toBe("budget_unsatisfiable");
    }finally{
      await client.close();
      await rm(dir,{recursive:true,force:true});
    }
  },30_000);
});
