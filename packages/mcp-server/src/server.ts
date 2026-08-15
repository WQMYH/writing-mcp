import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { delimiter } from "node:path";
import { z } from "zod";
import { WritingService } from "@writing-mcp/core";
import { GenericAdapter } from "@writing-mcp/adapter-generic";
import { InkosAdapter } from "@writing-mcp/adapter-inkos";
import { DiagnosticRecorder, type PostCallDiagnostic, type SafeErrorDetail } from "./diagnostics.js";

const sourceDiagnosticSchema = z.object({ code: z.string(), message: z.string(), path: z.string().optional() });
const evidenceLocatorSchema = z.object({ relativePath: z.string(), startLine: z.number(), endLine: z.number() });
const evidenceSchema = z.object({ documentRef: z.string(), relativePath: z.string(), startLine: z.number(), endLine: z.number(), excerpt: z.string(), evidenceHash: z.string(), revision: z.number(), locators: z.array(evidenceLocatorSchema).optional() });
const pathEvidenceSchema = z.object({ edgeRef: z.string(), edgeKind: z.string(), direction: z.enum(["outgoing", "incoming"]), sourceRef: z.string(), targetRef: z.string(), sourceKind: z.enum(["native", "deterministic", "heuristic"]), confidence: z.number(), evidence: evidenceSchema });
const itemSchema = z.object({ ref: z.string(), kind: z.string(), title: z.string(), score: z.number(), sourceKind: z.enum(["native", "deterministic", "heuristic"]), confidence: z.number(), evidence: evidenceSchema, path: z.array(z.string()).optional(), pathEvidence: z.array(pathEvidenceSchema).optional() });
const candidateSchema = z.object({ workRef: z.string(), title: z.string(), rootPath: z.string(), sourcePath: z.string().optional(), adapter: z.enum(["inkos", "generic"]), capabilities: z.array(z.string()) });
const executionSummarySchema = z.object({ action: z.string(), outcome: z.enum(["success", "failure"]), message: z.string(), details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) });
const postCallDiagnosticSchema = z.object({
  schemaVersion: z.number(), traceId: z.string(), tool: z.string(), outcome: z.enum(["success", "failure"]), recordedAt: z.string(), elapsedMs: z.number(),
  workRef: z.string().optional(), revision: z.number().optional(), persistence: z.enum(["persisted", "skipped", "failed"]), artifactRef: z.string().optional(), artifactPath: z.string().optional(), artifactSha256: z.string().optional(), persistenceError: z.string().optional(), executionSummary: executionSummarySchema,
});
const errorSchema = z.object({ code: z.string(), message: z.string(), traceId: z.string(), recovery: z.string().optional() });
const envelope = <T extends z.ZodType>(data: T) => z.object({ result: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), data, diagnostic: postCallDiagnosticSchema }), z.object({ ok: z.literal(false), error: errorSchema, diagnostic: postCallDiagnosticSchema })]) });
const resolveSchema = envelope(z.object({ status: z.enum(["resolved", "ambiguous", "unsupported"]), workRef: z.string().optional(), candidates: z.array(candidateSchema), diagnostics: z.array(sourceDiagnosticSchema) }));
const indexSchema = envelope(z.object({ workRef: z.string(), revision: z.number(), schemaVersion: z.number(), freshness: z.enum(["fresh", "stale", "missing", "incompatible"]), stats: z.object({ added: z.number(), updated: z.number(), deleted: z.number(), skipped: z.number(), documents: z.number(), spans: z.number(), entities: z.number(), edges: z.number() }), diagnostics: z.array(sourceDiagnosticSchema), elapsedMs: z.number() }));
const exploreSchema = envelope(z.object({ workRef: z.string(), revision: z.number(), freshness: z.literal("fresh"), operation: z.enum(["search", "entity", "neighborhood", "timeline", "document", "stats"]), results: z.array(itemSchema), ambiguous: z.array(itemSchema), truncated: z.boolean(), metrics: z.object({ candidateCount: z.number(), returnedCount: z.number(), visitedNodes: z.number(), maxActualHops: z.number(), omittedEstimate: z.number(), elapsedMs: z.number() }), diagnostics: z.array(sourceDiagnosticSchema) }));
const contextSchema = envelope(z.object({ status: z.enum(["complete", "truncated", "budget_unsatisfiable"]), workRef: z.string(), revision: z.number(), budgetTokens: z.number(), usedTokens: z.number(), estimated: z.boolean(), estimator: z.string(), blocks: z.array(itemSchema.extend({ layer: z.enum(["L0", "L1", "L2", "L3"]), tokens: z.number(), required: z.boolean() })), omitted: z.array(z.object({ ref: z.string(), reason: z.string(), tokens: z.number() })), diagnostics: z.array(sourceDiagnosticSchema) }));
const diagnoseSchema = envelope(z.object({
  action: z.enum(["inspect", "start_capture", "finish_capture"]), workRef: z.string(), purpose: z.enum(["usage", "development"]), status: z.enum(["healthy", "degraded"]).optional(), eventHistoryAvailable: z.boolean().optional(), recentEvents: z.array(z.unknown()).optional(), diagnosticsDirectory: z.string().optional(), observationScope: z.literal("mcp_calls_only").optional(), diagnosticRunRef: z.string().optional(), contentPolicy: z.enum(["metadata", "query"]).optional(), limits: z.object({ calls: z.number(), bytes: z.number() }).optional(), formats: z.array(z.enum(["json", "markdown"])).optional(), artifactRef: z.string().optional(), artifactPath: z.string().optional(), schemaVersion: z.number().optional(), sha256: z.string().optional(), calls: z.number().optional(), failures: z.number().optional(), truncated: z.boolean().optional(), index: z.object({ revision: z.number(), freshness: z.string(), documents: z.number(), spans: z.number(), entities: z.number(), edges: z.number() }).optional(),
}));

type ToolInput = Record<string, unknown>;

export function createService(): WritingService {
  const roots = (process.env.WRITING_MCP_ROOTS ?? "").split(delimiter).map(value => value.trim()).filter(Boolean);
  return new WritingService([new InkosAdapter(), new GenericAdapter()], roots);
}

function success(value: Record<string, unknown>, diagnostic: PostCallDiagnostic) {
  const result = { ok: true as const, data: value, diagnostic };
  return { content: [{ type: "text" as const, text: "```json\n" + JSON.stringify({ data: value, diagnostic }, null, 2) + "\n```" }], structuredContent: { result } };
}

function errorDetail(error: unknown, traceId: string): SafeErrorDetail & { traceId: string } {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "INTERNAL_ERROR";
  return { code, message: error instanceof Error ? error.message : "Unexpected error", traceId, recovery: recoveryFor(code) };
}

function failure(detail: SafeErrorDetail & { traceId: string }, diagnostic: PostCallDiagnostic) {
  return { content: [{ type: "text" as const, text: `Error ${detail.code} (${detail.traceId}): ${detail.message}` }], structuredContent: { result: { ok: false as const, error: detail, diagnostic } }, isError: true };
}

function recoveryFor(code: string): string {
  if (code === "WORK_REF_NOT_FOUND") return "Call writing_resolve in this server session, then retry.";
  if (code === "INDEX_BUSY") return "Wait for the other index writer or close the process holding the SQLite index, then retry.";
  if (code.startsWith("DIAGNOSTIC_")) return "Start a new development capture or remove old derived diagnostic reports, then retry.";
  if (code === "PATH_NOT_ALLOWED" || code === "AUTHORIZED_ROOTS_REQUIRED") return "Check WRITING_MCP_ROOTS and use a source inside an authorized root.";
  return "Check the tool arguments and related work reference, then retry.";
}

/**
 * DIAGNOSTIC INVARIANT: every public MCP tool must execute through this wrapper.
 * It records both success and failure after the business action and attaches the
 * report to the response. Do not register a handler that calls business logic
 * directly; doing so would make real user call chains invisible to diagnostics.
 */
async function handleDiagnosed(recorder: DiagnosticRecorder, tool: string, input: ToolInput, action: () => Promise<unknown>, correlationRef?: string) {
  const traceId = recorder.newTraceId();
  const started = performance.now();
  try {
    const workRef = typeof input.workRef === "string" ? input.workRef : undefined;
    if (correlationRef && workRef) await recorder.assertCaptureActive(workRef, correlationRef);
    const value = await action() as Record<string, unknown>;
    const diagnostic = await recorder.record({ traceId, tool, input, output: value, elapsedMs: performance.now() - started, ...(correlationRef ? { diagnosticRunRef: correlationRef } : {}) });
    return success(value, diagnostic);
  } catch (error) {
    const detail = errorDetail(error, traceId);
    const diagnostic = await recorder.record({ traceId, tool, input, error: detail, elapsedMs: performance.now() - started, ...(correlationRef ? { diagnosticRunRef: correlationRef } : {}) });
    return failure(detail, diagnostic);
  }
}

export function createServer(service = createService(), recorder = new DiagnosticRecorder(workRef => service.diagnosticDirectory(workRef))) {
  const server = new McpServer({ name: "writing-mcp", version: "0.1.0" });
  const diagnosticRunRef = (input: ToolInput): string | undefined => typeof input.diagnosticRunRef === "string" ? input.diagnosticRunRef : undefined;

  server.registerTool("writing_resolve", { description: "Resolve an InkOS or generic writing source to a stable work reference. Every call returns and persists a diagnostic report.", inputSchema: { sourcePath: z.string(), adapterHint: z.enum(["inkos", "generic"]).optional(), diagnosticRunRef: z.string().optional() }, outputSchema: resolveSchema }, input => handleDiagnosed(recorder, "writing_resolve", input, () => service.resolve(input.sourcePath, input.adapterHint), diagnosticRunRef(input)));
  server.registerTool("writing_index", { description: "Inspect, incrementally update, or rebuild a work's derived index. Every call returns and persists a diagnostic report.", inputSchema: { workRef: z.string(), mode: z.enum(["status", "incremental", "rebuild"]), diagnosticRunRef: z.string().optional() }, outputSchema: indexSchema }, input => handleDiagnosed(recorder, "writing_index", input, () => service.index(input.workRef, input.mode), diagnosticRunRef(input)));
  server.registerTool("writing_explore", { description: "Search or explore the indexed writing graph with bounded results. Use search before entity/neighborhood when no stable entityRef is known. Every call returns and persists a diagnostic report.", inputSchema: { workRef: z.string(), operation: z.enum(["search", "entity", "neighborhood", "timeline", "document", "stats"]), query: z.string().max(2048).optional(), maxHops: z.number().int().min(0).max(3).default(2), limit: z.number().int().min(1).max(100).default(20), diagnosticRunRef: z.string().optional() }, outputSchema: exploreSchema }, input => handleDiagnosed(recorder, "writing_explore", input, () => service.explore(input.workRef, input.operation, input.query, input.limit, input.maxHops), diagnosticRunRef(input)));
  server.registerTool("writing_context", { description: "Build an evidence-backed context packet within a token budget; this tool assembles context and does not answer a factual question by itself. Every call returns and persists a diagnostic report.", inputSchema: { workRef: z.string(), taskType: z.enum(["continue_chapter", "draft_chapter", "revise", "answer", "custom"]), query: z.string().max(2048), budgetTokens: z.number().int().min(1).max(1_000_000), requiredRefs: z.array(z.string().max(256)).max(128).default([]), diagnosticRunRef: z.string().optional() }, outputSchema: contextSchema }, input => handleDiagnosed(recorder, "writing_context", input, () => service.context(input.workRef, input.query, input.budgetTokens, input.requiredRefs), diagnosticRunRef(input)));
  server.registerTool("writing_diagnose", { description: "Inspect MCP effects or explicitly capture a development call chain. It never repairs an index or evaluates prose quality.", inputSchema: { action: z.enum(["inspect", "start_capture", "finish_capture"]).default("inspect"), workRef: z.string(), purpose: z.enum(["usage", "development"]).default("usage"), diagnosticRunRef: z.string().optional(), label: z.string().max(80).optional(), contentPolicy: z.enum(["metadata", "query"]).default("metadata"), formats: z.array(z.enum(["json", "markdown"])).default(["json"]), limit: z.number().int().min(1).max(100).default(20) }, outputSchema: diagnoseSchema }, input => {
    const action = input.action;
    const runRef = action === "inspect" ? input.diagnosticRunRef : undefined;
    return handleDiagnosed(recorder, "writing_diagnose", input, async () => {
      if (action !== "inspect" && input.purpose !== "development") throw Object.assign(new Error(`${action} requires purpose=development`), { code: "INVALID_DIAGNOSTIC_REQUEST" });
      if (action === "start_capture") {
        await service.index(input.workRef, "status");
        return recorder.startCapture(input.workRef, input.label, input.contentPolicy);
      }
      if (action === "finish_capture") {
        if (!input.diagnosticRunRef) throw Object.assign(new Error("finish_capture requires diagnosticRunRef"), { code: "INVALID_DIAGNOSTIC_REQUEST" });
        return recorder.finishCapture(input.workRef, input.diagnosticRunRef, input.formats);
      }
      const index = await service.index(input.workRef, "status");
      const inspected = await recorder.inspect(input.workRef, input.purpose, input.limit);
      return { ...inspected, index: { revision: index.revision, freshness: index.freshness, documents: index.stats.documents, spans: index.stats.spans, entities: index.stats.entities, edges: index.stats.edges } };
    }, runRef);
  });
  return server;
}

export async function runStdio(): Promise<void> {
  const service = createService();
  const server = createServer(service);
  const close = () => service.close();
  process.once("SIGINT", close); process.once("SIGTERM", close); process.once("exit", close);
  await server.connect(new StdioServerTransport());
}
