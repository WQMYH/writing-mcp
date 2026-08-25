import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { delimiter } from "node:path";
import { z } from "zod";
import { WritingService } from "@writing-mcp/core";
import { GenericAdapter } from "@writing-mcp/adapter-generic";
import { InkosAdapter } from "@writing-mcp/adapter-inkos";
import { DiagnosticRecorder, type SafeErrorDetail } from "./diagnostics.js";
import { assembleResult, boundDiagnostic, boundError, fitBusinessData } from "./response-limits.js";

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
// AUD-025: tool data schemas are exported so registerTool outputSchema and the
// handleDiagnosed self-validation share one source of truth (no second copy).
export const TOOL_RESOLVE_DATA_SCHEMA = z.object({ status: z.enum(["resolved", "ambiguous", "unsupported"]), workRef: z.string().optional(), candidates: z.array(candidateSchema), diagnostics: z.array(sourceDiagnosticSchema) });
export const TOOL_INDEX_DATA_SCHEMA = z.object({ workRef: z.string(), revision: z.number(), schemaVersion: z.number(), freshness: z.enum(["fresh", "stale", "missing", "incompatible"]), stats: z.object({ added: z.number(), updated: z.number(), deleted: z.number(), skipped: z.number(), documents: z.number(), spans: z.number(), entities: z.number(), edges: z.number() }), contextSources: z.object({ byLayer: z.record(z.string(), z.number()), byKind: z.record(z.string(), z.number()) }).optional(), diagnostics: z.array(sourceDiagnosticSchema), elapsedMs: z.number() });
export const TOOL_EXPLORE_DATA_SCHEMA = z.object({ workRef: z.string(), revision: z.number(), freshness: z.literal("fresh"), operation: z.enum(["search", "entity", "neighborhood", "timeline", "document", "stats"]), results: z.array(itemSchema), ambiguous: z.array(itemSchema), truncated: z.boolean(), metrics: z.object({ candidateCount: z.number(), returnedCount: z.number(), visitedNodes: z.number(), maxActualHops: z.number(), omittedEstimate: z.number(), elapsedMs: z.number() }), diagnostics: z.array(sourceDiagnosticSchema) });
export const TOOL_CONTEXT_DATA_SCHEMA = z.object({ status: z.enum(["complete", "truncated", "budget_unsatisfiable"]), workRef: z.string(), revision: z.number(), budgetTokens: z.number(), usedTokens: z.number(), estimated: z.boolean(), estimator: z.string(), accountingScope: z.literal("evidence_excerpts_only"), blocks: z.array(itemSchema.extend({ layer: z.enum(["L0", "L1", "L2", "L3"]), tokens: z.number(), required: z.boolean() })), omitted: z.array(z.object({ ref: z.string(), reason: z.string(), tokens: z.number() })), diagnostics: z.array(sourceDiagnosticSchema) });
export const TOOL_DIAGNOSE_DATA_SCHEMA = z.object({
  action: z.enum(["inspect", "start_capture", "finish_capture"]), workRef: z.string(), purpose: z.enum(["usage", "development"]), status: z.enum(["healthy", "degraded"]).optional(), eventHistoryAvailable: z.boolean().optional(), recentEvents: z.array(z.unknown()).optional(), diagnosticsDirectory: z.string().optional(), observationScope: z.literal("mcp_calls_only").optional(), diagnosticRunRef: z.string().optional(), contentPolicy: z.enum(["metadata", "query"]).optional(), limits: z.object({ calls: z.number(), bytes: z.number() }).optional(), formats: z.array(z.enum(["json", "markdown"])).optional(), artifactRef: z.string().optional(), artifactPath: z.string().optional(), schemaVersion: z.number().optional(), sha256: z.string().optional(), calls: z.number().optional(), failures: z.number().optional(), truncated: z.boolean().optional(), index: z.object({ revision: z.number(), freshness: z.string(), documents: z.number(), spans: z.number(), entities: z.number(), edges: z.number(), contextSources: z.object({ byLayer: z.record(z.string(), z.number()), byKind: z.record(z.string(), z.number()) }).optional() }).optional(),
});
const envelope = <T extends z.ZodType>(data: T) => z.object({ result: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), data, diagnostic: postCallDiagnosticSchema }), z.object({ ok: z.literal(false), error: errorSchema, diagnostic: postCallDiagnosticSchema })]) });
const resolveSchema = envelope(TOOL_RESOLVE_DATA_SCHEMA);
const indexSchema = envelope(TOOL_INDEX_DATA_SCHEMA);
const exploreSchema = envelope(TOOL_EXPLORE_DATA_SCHEMA);
const contextSchema = envelope(TOOL_CONTEXT_DATA_SCHEMA);
const diagnoseSchema = envelope(TOOL_DIAGNOSE_DATA_SCHEMA);

type ToolInput = Record<string, unknown>;

export function createService(): WritingService {
  const roots = (process.env.WRITING_MCP_ROOTS ?? "").split(delimiter).map(value => value.trim()).filter(Boolean);
  return new WritingService([new InkosAdapter(), new GenericAdapter()], roots);
}

function errorDetail(error: unknown, traceId: string): SafeErrorDetail & { traceId: string } {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "INTERNAL_ERROR";
  return { code, message: error instanceof Error ? error.message : "Unexpected error", traceId, recovery: recoveryFor(code) };
}

function recoveryFor(code: string): string {
  if (code === "WORK_REF_NOT_FOUND") return "Call writing_resolve in this server session, then retry.";
  if (code === "INDEX_BUSY") return "Wait for the other index writer or close the process holding the SQLite index, then retry.";
  if (code.startsWith("DIAGNOSTIC_")) return "Start a new development capture or remove old derived diagnostic reports, then retry.";
  if (code === "PATH_NOT_ALLOWED" || code === "AUTHORIZED_ROOTS_REQUIRED") return "Check WRITING_MCP_ROOTS and use a source inside an authorized root.";
  if (code === "OUTPUT_SCHEMA_MISMATCH") return "This is a server-side contract defect, not a caller error; report the traceId and retry after the server is updated.";
  if (code === "RESPONSE_TOO_LARGE") return "Narrow the query, lower the result limit, or request a smaller diagnostic window, then retry.";
  return "Check the tool arguments and related work reference, then retry.";
}

/**
 * DIAGNOSTIC INVARIANT: every public MCP tool must execute through this wrapper.
 * It records both success and failure after the business action and attaches the
 * report to the response. Do not register a handler that calls business logic
 * directly; doing so would make real user call chains invisible to diagnostics.
 */
async function handleDiagnosed(recorder: DiagnosticRecorder, tool: string, input: ToolInput, action: () => Promise<unknown>, dataSchema: z.ZodType, correlationRef?: string) {
  const traceId = recorder.newTraceId();
  const started = performance.now();
  try {
    const workRef = typeof input.workRef === "string" ? input.workRef : undefined;
    if (correlationRef && workRef) await recorder.assertCaptureActive(workRef, correlationRef);
    const value = await action() as Record<string, unknown>;
    // AUD-025: self-validate against the shared data schema before recording;
    // otherwise the SDK's post-handler output validation could reject a result
    // that diagnostics already recorded as success.
    if (!dataSchema.safeParse(value).success) throw Object.assign(new Error(`${tool} produced a result that does not match its declared output data schema`), { code: "OUTPUT_SCHEMA_MISMATCH" });
    const reduced = fitBusinessData(tool, value);
    if (!dataSchema.safeParse(reduced).success) throw Object.assign(new Error(`${tool} response reduction produced a result that does not match its declared output data schema`), { code: "OUTPUT_SCHEMA_MISMATCH" });
    const diagnostic = boundDiagnostic(await recorder.record({ traceId, tool, input, output: reduced, elapsedMs: performance.now() - started, ...(correlationRef ? { diagnosticRunRef: correlationRef } : {}) }));
    return assembleResult({ ok: true, data: reduced, diagnostic });
  } catch (error) {
    const detail = boundError(tool, errorDetail(error, traceId));
    const diagnostic = boundDiagnostic(await recorder.record({ traceId, tool, input, error: detail, elapsedMs: performance.now() - started, ...(correlationRef ? { diagnosticRunRef: correlationRef } : {}) }));
    return assembleResult({ ok: false, error: detail, diagnostic });
  }
}

export interface ServerOptions {
  /** Observability boundary (AUD-025): protocol/transport-layer errors that never reach a tool handler. */
  readonly onerror?: (error: Error) => void;
}

export interface StdioRuntime {
  readonly server: ReturnType<typeof createServer>;
  /** AUD-032: idempotent graceful shutdown — closes the MCP server (transport)
   * before the service. Never writes to stdout: stdout is the JSON-RPC channel. */
  readonly shutdown: () => Promise<void>;
}

export interface TerminationCoordinatorOptions {
  readonly fallbackMs?: number;
  readonly setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly forceExit?: (code: number) => void;
  readonly setExitCode?: (code: number) => void;
  readonly onError?: (error: unknown) => void;
}

export interface TerminationCoordinator {
  readonly terminate: () => Promise<void>;
  readonly completion: Promise<void>;
}

export function createTerminationCoordinator(shutdown: () => Promise<void>, options?: TerminationCoordinatorOptions): TerminationCoordinator {
  const setTimer = options?.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer = options?.clearTimer ?? (timer => clearTimeout(timer));
  const forceExit = options?.forceExit ?? (code => process.exit(code));
  const setExitCode = options?.setExitCode ?? (code => { process.exitCode = code; });
  const onError = options?.onError ?? (error => console.error(`[writing-mcp][lifecycle] shutdown failed: ${error instanceof Error ? error.message : String(error)}`));
  let resolveCompletion!: () => void;
  const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
  let terminationPromise: Promise<void> | undefined;
  const terminate = (): Promise<void> => {
    if (terminationPromise) return terminationPromise;
    const fallback = setTimer(() => forceExit(1), options?.fallbackMs ?? 5_000);
    fallback.unref?.();
    terminationPromise = Promise.resolve()
      .then(shutdown)
      .catch(error => {
        try { onError(error); } catch { /* stderr/reporting failure must not strand termination */ }
        setExitCode(1);
      })
      .finally(() => { clearTimer(fallback); resolveCompletion(); });
    return terminationPromise;
  };
  return { terminate, completion };
}

export function createStdioRuntime(service: WritingService, options?: ServerOptions): StdioRuntime {
  const server = createServer(service, undefined, options);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      const failures: unknown[] = [];
      try { await server.close(); } catch (error) { failures.push(error); }
      try { await service.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Writing MCP shutdown failed");
    })();
    return shutdownPromise;
  };
  return { server, shutdown };
}

export function createServer(service = createService(), recorder = new DiagnosticRecorder(workRef => service.diagnosticDirectory(workRef)), options?: ServerOptions) {
  const server = new McpServer({ name: "writing-mcp", version: "0.1.0" });
  // onerror lives on the underlying low-level Server (Protocol), not on the McpServer wrapper.
  if (options?.onerror) server.server.onerror = options.onerror;
  const diagnosticRunRef = (input: ToolInput): string | undefined => typeof input.diagnosticRunRef === "string" ? input.diagnosticRunRef : undefined;

  server.registerTool("writing_resolve", { description: "Resolve an InkOS or generic writing source to a stable work reference. Every call returns and persists a diagnostic report.", inputSchema: { sourcePath: z.string(), adapterHint: z.enum(["inkos", "generic"]).optional(), diagnosticRunRef: z.string().optional() }, outputSchema: resolveSchema }, input => handleDiagnosed(recorder, "writing_resolve", input, () => service.resolve(input.sourcePath, input.adapterHint), TOOL_RESOLVE_DATA_SCHEMA, diagnosticRunRef(input)));
  server.registerTool("writing_index", { description: "Inspect, incrementally update, or rebuild a work's derived index. Every call returns and persists a diagnostic report.", inputSchema: { workRef: z.string(), mode: z.enum(["status", "incremental", "rebuild"]), diagnosticRunRef: z.string().optional() }, outputSchema: indexSchema }, input => handleDiagnosed(recorder, "writing_index", input, () => service.index(input.workRef, input.mode), TOOL_INDEX_DATA_SCHEMA, diagnosticRunRef(input)));
  server.registerTool("writing_explore", { description: "Search or explore the indexed writing graph with bounded results. Use search before entity/neighborhood when no stable entityRef is known. targetChapter anchors the timeline projection to a 1-based chapter position and is ignored by other operations. Every call returns and persists a diagnostic report.", inputSchema: { workRef: z.string(), operation: z.enum(["search", "entity", "neighborhood", "timeline", "document", "stats"]), query: z.string().max(2048).optional(), maxHops: z.number().int().min(0).max(3).default(2), limit: z.number().int().min(1).max(100).default(20), targetChapter: z.number().int().min(1).max(1_000_000).optional(), diagnosticRunRef: z.string().optional() }, outputSchema: exploreSchema }, input => handleDiagnosed(recorder, "writing_explore", input, () => service.explore(input.workRef, input.operation, input.query, input.limit, input.maxHops, input.targetChapter), TOOL_EXPLORE_DATA_SCHEMA, diagnosticRunRef(input)));
  server.registerTool("writing_context", { description: "Build an evidence-backed context packet within a token budget; this tool assembles context and does not answer a factual question by itself. `accountingScope: evidence_excerpts_only` means usedTokens is an estimated excerpt-only accounting scope (mixed-cjk-v1), material for external token evaluation rather than an exact model-token claim; it excludes refs, headings, locators, omitted rows, diagnostics, JSON framing, and Markdown fallback. targetChapter anchors the fill order toward a 1-based chapter position; entityRefs/documentRefs resolve directly into blocks and rank ahead of search hits within their layer, outranking targetChapter proximity (a pinned ref already in the search pool keeps its search-hit rank, and pinned blocks are not folded by evidence dedup); excludeRefs removes matching candidates — requiredRefs win over excludeRefs when both name the same ref, and excludeRefs win over entityRefs/documentRefs pins. taskType is reserved: it is accepted, validated, and recorded but never changes assembly — it is an Agent-side workflow label (conventional values answer/revise/custom/continue_chapter/draft_chapter; unknown values are accepted and recorded). Every call returns and persists a diagnostic report.", inputSchema: { workRef: z.string(), taskType: z.string().max(64).optional(), query: z.string().max(2048), budgetTokens: z.number().int().min(1).max(1_000_000), requiredRefs: z.array(z.string().max(256)).max(128).default([]), targetChapter: z.number().int().min(1).max(1_000_000).optional(), entityRefs: z.array(z.string().max(256)).max(128).optional(), documentRefs: z.array(z.string().max(256)).max(128).optional(), excludeRefs: z.array(z.string().max(256)).max(128).optional(), diagnosticRunRef: z.string().optional() }, outputSchema: contextSchema }, input => handleDiagnosed(recorder, "writing_context", input, () => service.context(input.workRef, input.query, input.budgetTokens, input.requiredRefs, { excludeRefs: input.excludeRefs, entityRefs: input.entityRefs, documentRefs: input.documentRefs, targetChapter: input.targetChapter, taskType: input.taskType }), TOOL_CONTEXT_DATA_SCHEMA, diagnosticRunRef(input)));
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
      return { ...inspected, index: { revision: index.revision, freshness: index.freshness, documents: index.stats.documents, spans: index.stats.spans, entities: index.stats.entities, edges: index.stats.edges, contextSources: index.contextSources } };
    }, TOOL_DIAGNOSE_DATA_SCHEMA, runRef);
  });
  return server;
}

export async function runStdio(): Promise<void> {
  const service = createService();
  // stderr is the only observability exit for protocol-layer errors (AUD-025):
  // SDK input rejections and handler-level failures stay in the MCP envelope.
  // stdout stays pure JSON-RPC; shutdown closes server and service (AUD-032).
  const runtime = createStdioRuntime(service, { onerror: error => console.error(`[writing-mcp][protocol] ${error instanceof Error ? error.stack ?? error.message : String(error)}`) });
  const termination = createTerminationCoordinator(runtime.shutdown);
  const terminate = (): void => { void termination.terminate(); };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  // stdin EOF (client disconnect) closes the transport and enters the same
  // memoized promise as SIGINT/SIGTERM; repeated triggers cannot double-close.
  runtime.server.server.onclose = terminate;
  try {
    await runtime.server.connect(new StdioServerTransport());
    await termination.completion;
  } catch (error) {
    await termination.terminate();
    throw error;
  } finally {
    process.off("SIGINT", terminate);
    process.off("SIGTERM", terminate);
  }
}
