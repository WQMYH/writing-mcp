import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { delimiter } from "node:path";
import { WritingService } from "@writing-mcp/core";
import { GenericAdapter } from "@writing-mcp/adapter-generic";
import { InkosAdapter } from "@writing-mcp/adapter-inkos";

const diagnosticSchema=z.object({code:z.string(),message:z.string(),path:z.string().optional()});
const evidenceSchema=z.object({documentRef:z.string(),relativePath:z.string(),startLine:z.number(),endLine:z.number(),excerpt:z.string()});
const itemSchema=z.object({ref:z.string(),kind:z.string(),title:z.string(),score:z.number(),sourceKind:z.enum(["native","deterministic","heuristic"]),confidence:z.number(),evidence:evidenceSchema,path:z.array(z.string()).optional()});
const candidateSchema=z.object({workRef:z.string(),title:z.string(),rootPath:z.string(),sourcePath:z.string().optional(),adapter:z.enum(["inkos","generic"]),capabilities:z.array(z.string())});
const errorSchema=z.object({code:z.string(),message:z.string(),recovery:z.string().optional()});
const envelope=<T extends z.ZodType>(data:T)=>z.object({result:z.discriminatedUnion("ok",[z.object({ok:z.literal(true),data}),z.object({ok:z.literal(false),error:errorSchema})])});
const resolveSchema=envelope(z.object({status:z.enum(["resolved","ambiguous","unsupported"]),workRef:z.string().optional(),candidates:z.array(candidateSchema),diagnostics:z.array(diagnosticSchema)}));
const indexSchema=envelope(z.object({workRef:z.string(),revision:z.number(),schemaVersion:z.number(),freshness:z.enum(["fresh","stale","missing","incompatible"]),stats:z.object({added:z.number(),updated:z.number(),deleted:z.number(),skipped:z.number(),documents:z.number(),spans:z.number(),entities:z.number(),edges:z.number()}),diagnostics:z.array(diagnosticSchema),elapsedMs:z.number()}));
const exploreSchema=envelope(z.object({workRef:z.string(),revision:z.number(),freshness:z.literal("fresh"),operation:z.enum(["search","entity","neighborhood","timeline","document","stats"]),results:z.array(itemSchema),ambiguous:z.array(itemSchema),truncated:z.boolean(),diagnostics:z.array(diagnosticSchema)}));
const contextSchema=envelope(z.object({status:z.enum(["complete","truncated","budget_unsatisfiable"]),workRef:z.string(),revision:z.number(),budgetTokens:z.number(),usedTokens:z.number(),estimated:z.boolean(),estimator:z.string(),blocks:z.array(itemSchema.extend({layer:z.enum(["L0","L1","L2","L3"]),tokens:z.number(),required:z.boolean()})),omitted:z.array(z.object({ref:z.string(),reason:z.string(),tokens:z.number()})),diagnostics:z.array(diagnosticSchema)}));

export function createService(){const roots=(process.env.WRITING_MCP_ROOTS??"").split(delimiter).map(value=>value.trim()).filter(Boolean);return new WritingService([new InkosAdapter(),new GenericAdapter()],roots);}
const success=(value:Record<string,unknown>)=>{const result={ok:true as const,data:value};return{content:[{type:"text" as const,text:"```json\n"+JSON.stringify(value,null,2)+"\n```"}],structuredContent:{result}};};
const failure=(error:unknown)=>{const detail={code:typeof error==="object"&&error&&"code" in error?String(error.code):"INTERNAL_ERROR",message:error instanceof Error?error.message:"Unexpected error",recovery:"Check the work reference and source path, then retry."};return{content:[{type:"text" as const,text:`Error ${detail.code}: ${detail.message}`}],structuredContent:{result:{ok:false as const,error:detail}},isError:true};};
const handle=async(action:()=>Promise<unknown>)=>{try{return success(await action() as Record<string,unknown>);}catch(error){return failure(error);}};

export function createServer(service=createService()){
  const server=new McpServer({name:"writing-mcp",version:"0.1.0"});
  server.registerTool("writing_resolve",{description:"Resolve an InkOS or generic writing source to a stable work reference.",inputSchema:{sourcePath:z.string(),adapterHint:z.enum(["inkos","generic"]).optional()},outputSchema:resolveSchema},input=>handle(()=>service.resolve(input.sourcePath,input.adapterHint)));
  server.registerTool("writing_index",{description:"Inspect, incrementally update, or rebuild a work's derived index.",inputSchema:{workRef:z.string(),mode:z.enum(["status","incremental","rebuild"])},outputSchema:indexSchema},input=>handle(()=>service.index(input.workRef,input.mode)));
  server.registerTool("writing_explore",{description:"Search or explore the indexed writing graph with bounded results.",inputSchema:{workRef:z.string(),operation:z.enum(["search","entity","neighborhood","timeline","document","stats"]),query:z.string().optional(),maxHops:z.number().int().min(0).max(3).default(2),limit:z.number().int().min(1).max(100).default(20)},outputSchema:exploreSchema},input=>handle(()=>service.explore(input.workRef,input.operation,input.query,input.limit,input.maxHops)));
  server.registerTool("writing_context",{description:"Build an evidence-backed context packet within a token budget.",inputSchema:{workRef:z.string(),taskType:z.enum(["continue_chapter","draft_chapter","revise","answer","custom"]),query:z.string(),budgetTokens:z.number().int().min(1),requiredRefs:z.array(z.string()).default([])},outputSchema:contextSchema},input=>handle(()=>service.context(input.workRef,input.query,input.budgetTokens,input.requiredRefs)));
  return server;
}

export async function runStdio(){const service=createService();const server=createServer(service);const close=()=>service.close();process.once("SIGINT",close);process.once("SIGTERM",close);process.once("exit",close);await server.connect(new StdioServerTransport());}
