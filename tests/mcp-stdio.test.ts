import { mkdtemp, cp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("MCP stdio transport",()=>{
  test("lists and calls the four tools",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"writing-mcp-stdio-"));
    const source=join(dir,"novel");await cp(new URL("../fixtures/generic-novel",import.meta.url),source,{recursive:true});
    const client=new Client({name:"writing-mcp-test",version:"0.1.0"});
    const transport=new StdioClientTransport({command:process.execPath,args:[resolve("packages/mcp-server/dist/index.js")]});
    try{
      await client.connect(transport);
      const listed=await client.listTools();expect(listed.tools.map(t=>t.name).sort()).toEqual(["writing_context","writing_explore","writing_index","writing_resolve"]);expect(listed.tools.every(t=>t.outputSchema)).toBe(true);
      const resolved=await client.callTool({name:"writing_resolve",arguments:{sourcePath:source}});const resolvedData=(resolved.structuredContent as {result:{data:{workRef:string;status:string}}}).result.data;expect(resolvedData.status).toBe("resolved");
      const indexed=await client.callTool({name:"writing_index",arguments:{workRef:resolvedData.workRef,mode:"rebuild"}});expect((indexed.structuredContent as {result:{data:{stats:{documents:number}}}}).result.data.stats.documents).toBe(3);
      const explored=await client.callTool({name:"writing_explore",arguments:{workRef:resolvedData.workRef,operation:"search",query:"铜钥匙"}});expect((explored.structuredContent as {result:{data:{results:unknown[]}}}).result.data.results.length).toBeGreaterThan(0);
      const context=await client.callTool({name:"writing_context",arguments:{workRef:resolvedData.workRef,taskType:"answer",query:"铜钥匙",budgetTokens:200}});expect((context.structuredContent as {result:{data:{usedTokens:number}}}).result.data.usedTokens).toBeLessThanOrEqual(200);
      const failed=await client.callTool({name:"writing_index",arguments:{workRef:"work:missing",mode:"status"}});expect(failed.isError).toBe(true);expect((failed.structuredContent as {result:{error:{code:string}}}).result.error.code).toBe("WORK_REF_NOT_FOUND");
    }finally{await client.close();await rm(dir,{recursive:true,force:true});}
  },30000);
});
