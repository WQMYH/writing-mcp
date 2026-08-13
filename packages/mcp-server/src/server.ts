import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WritingService } from "@writing-mcp/core";
import { GenericAdapter } from "@writing-mcp/adapter-generic";
import { InkosAdapter } from "@writing-mcp/adapter-inkos";

export function createService(){return new WritingService([new InkosAdapter(),new GenericAdapter()]);}
const response=(value:unknown)=>({content:[{type:"text" as const,text:"```json\n"+JSON.stringify(value,null,2)+"\n```"}],structuredContent:value as Record<string,unknown>});

export function createServer(service=createService()){
  const server=new McpServer({name:"writing-mcp",version:"0.1.0"});
  server.registerTool("writing_resolve",{description:"Resolve an InkOS or generic writing source to a stable work reference.",inputSchema:{sourcePath:z.string(),adapterHint:z.enum(["inkos","generic"]).optional()}},async input=>response(await service.resolve(input.sourcePath,input.adapterHint)));
  server.registerTool("writing_index",{description:"Inspect, incrementally update, or rebuild a work's derived index.",inputSchema:{workRef:z.string(),mode:z.enum(["status","incremental","rebuild"])}},async input=>response(await service.index(input.workRef,input.mode)));
  server.registerTool("writing_explore",{description:"Search or explore the indexed writing graph with bounded results.",inputSchema:{workRef:z.string(),operation:z.enum(["search","entity","neighborhood","timeline","document","stats"]),query:z.string().optional(),maxHops:z.number().int().min(0).max(3).default(2),limit:z.number().int().min(1).max(100).default(20)}},async input=>response(await service.explore(input.workRef,input.operation,input.query,input.limit,input.maxHops)));
  server.registerTool("writing_context",{description:"Build an evidence-backed context packet within a token budget.",inputSchema:{workRef:z.string(),taskType:z.enum(["continue_chapter","draft_chapter","revise","answer","custom"]),query:z.string(),budgetTokens:z.number().int().min(1),requiredRefs:z.array(z.string()).default([])}},async input=>response(await service.context(input.workRef,input.query,input.budgetTokens,input.requiredRefs)));
  return server;
}
export async function runStdio(){const service=createService();const server=createServer(service);const close=()=>service.close();process.once("SIGINT",close);process.once("SIGTERM",close);process.once("exit",close);await server.connect(new StdioServerTransport());}
