import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, TOOL_CONTEXT_DATA_SCHEMA, TOOL_DIAGNOSE_DATA_SCHEMA, TOOL_EXPLORE_DATA_SCHEMA, TOOL_RESOLVE_DATA_SCHEMA } from "../packages/mcp-server/src/server.js";
import { compactJsonBytes, createDiagnosticReserve } from "../packages/mcp-server/src/response-limits.js";

const evidenceItem = (ref: string, excerpt = "长".repeat(3_000)) => ({
  ref,
  kind: "span",
  title: `标题 ${ref}`,
  score: 1,
  sourceKind: "deterministic" as const,
  confidence: 1,
  evidence: {
    documentRef: `doc:${ref}`,
    relativePath: `${ref}.md`,
    startLine: 1,
    endLine: 2,
    excerpt,
    evidenceHash: "a".repeat(64),
    revision: 1,
  },
});

const largeDiagnostic = (traceId: string, tool: string, outcome: "success" | "failure") => ({
  schemaVersion: 1,
  traceId,
  tool,
  outcome,
  recordedAt: "2026-08-21T00:00:00.000Z",
  elapsedMs: 1,
  persistence: "skipped" as const,
  persistenceError: "诊断".repeat(8_000),
  executionSummary: { action: tool, outcome, message: "摘要".repeat(8_000), details: {} },
});

function recorderSpy() {
  const records: Array<Record<string, unknown>> = [];
  return {
    records,
    newTraceId: () => "trace-response-limit",
    assertCaptureActive: async () => undefined,
    record: async (input: Record<string, unknown>) => {
      records.push(input);
      return largeDiagnostic(String(input.traceId), String(input.tool), input.error ? "failure" : "success");
    },
  };
}

const unused = async () => { throw new Error("not used"); };
const serviceWith = (overrides: Record<string, unknown>) => ({
  resolve: unused,
  index: unused,
  explore: unused,
  context: unused,
  diagnosticDirectory: () => undefined,
  ...overrides,
});

async function invoke(service: Record<string, unknown>, recorder: ReturnType<typeof recorderSpy>, name: string, args: Record<string, unknown>) {
  const server = createServer(service as never, recorder as never);
  const client = new Client({ name: "response-limit-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

async function callExplore() {
  const data = {
    workRef: "work:test",
    revision: 1,
    freshness: "fresh" as const,
    operation: "search" as const,
    results: Array.from({ length: 28 }, (_, index) => evidenceItem(`result-${index}`)),
    ambiguous: Array.from({ length: 12 }, (_, index) => evidenceItem(`ambiguous-${index}`)),
    truncated: false,
    metrics: { candidateCount: 28, returnedCount: 28, visitedNodes: 28, maxActualHops: 0, omittedEstimate: 7, elapsedMs: 1 },
    diagnostics: [],
  };
  const service = {
    resolve: async () => { throw new Error("not used"); },
    index: async () => { throw new Error("not used"); },
    explore: async () => data,
    context: async () => { throw new Error("not used"); },
    diagnosticDirectory: () => undefined,
  };
  const recorder = recorderSpy();
  const server = createServer(service as never, recorder as never);
  const client = new Client({ name: "response-limit-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return { call: await client.callTool({ name: "writing_explore", arguments: { workRef: "work:test", operation: "search" } }), recorder, original: data };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP response byte limits", () => {
  test("measures compact JSON in UTF-8 bytes and reserves the full diagnostic budget", () => {
    const value = { text: "长".repeat(100) };
    expect(JSON.stringify(value).length).toBeLessThan(compactJsonBytes(value));
    expect(compactJsonBytes(createDiagnosticReserve("writing_explore", "success"))).toBe(8_192);
  });

  test("trims multibyte explore data before recording and bounds the final envelope", async () => {
    const { call, recorder, original } = await callExplore();
    const result = (call.structuredContent as { result: { ok: true; data: typeof original; diagnostic: unknown } }).result;
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(200_000);
    expect(result.data.ambiguous).toEqual([]);
    expect(result.data.results.length).toBeLessThan(original.results.length);
    expect(result.data.metrics.returnedCount).toBe(result.data.results.length);
    expect(result.data.metrics.omittedEstimate).toBe(7 + original.ambiguous.length + original.results.length - result.data.results.length);
    expect(result.data.diagnostics.filter(item => item.code === "RESPONSE_TRUNCATED")).toHaveLength(1);
    expect((recorder.records[0]?.output as typeof original)).toEqual(result.data);
    expect(Buffer.byteLength(JSON.stringify(result.diagnostic), "utf8")).toBeLessThanOrEqual(8_192);
    const markdown = String((call.content as Array<{ text?: string }>)[0]?.text);
    expect(Buffer.byteLength(markdown, "utf8")).toBeLessThanOrEqual(16_384);
    expect(markdown).not.toContain("```json");
    expect(markdown).not.toContain(original.results[0]!.evidence.excerpt);
    expect(markdown).toContain(`- Kept: ${result.data.results.length}`);
    expect(markdown).toContain(`- Omitted: ${result.data.metrics.omittedEstimate}`);
    expect(TOOL_EXPLORE_DATA_SCHEMA.safeParse(result.data).success).toBe(true);
  });

  test("trims optional context blocks from L3 toward L0 and records response-limit omissions", async () => {
    const block = (ref: string, layer: "L0" | "L1" | "L2" | "L3", required: boolean, excerpt = "长".repeat(22_000)) => ({
      ...evidenceItem(ref, excerpt), layer, required, tokens: 100,
    });
    const data = {
      status: "complete" as const,
      workRef: "work:test",
      revision: 1,
      budgetTokens: 1_000,
      usedTokens: 500,
      estimated: true,
      estimator: "mixed-cjk-v1",
      accountingScope: "evidence_excerpts_only" as const,
      blocks: [block("required", "L0", true, "必要".repeat(200)), block("optional-l0", "L0", false), block("optional-l1", "L1", false), block("optional-l2", "L2", false), block("optional-l3", "L3", false)],
      omitted: [{ ref: "already-missing", reason: "not_found", tokens: 0 }],
      diagnostics: [],
    };
    const recorder = recorderSpy();
    const call = await invoke(serviceWith({ context: async () => data }), recorder, "writing_context", { workRef: "work:test", query: "q", budgetTokens: 1_000 });
    const result = (call.structuredContent as { result: { ok: true; data: typeof data } }).result;
    expect(result.ok).toBe(true);
    expect(compactJsonBytes(result)).toBeLessThanOrEqual(200_000);
    expect(result.data.blocks.map(item => item.ref)).toContain("required");
    expect(result.data.blocks.map(item => item.ref)).toContain("optional-l0");
    expect(result.data.blocks.map(item => item.ref)).not.toContain("optional-l3");
    const responseOmissions = result.data.omitted.filter(item => item.reason === "response_limit");
    expect(responseOmissions.map(item => item.ref)).toEqual(["optional-l3", "optional-l2"]);
    expect(new Set(responseOmissions.map(item => item.ref)).size).toBe(responseOmissions.length);
    expect(result.data.usedTokens).toBe(result.data.blocks.reduce((sum, item) => sum + item.tokens, 0));
    expect(result.data.status).toBe("truncated");
    expect((recorder.records[0]?.output as typeof data)).toEqual(result.data);
    expect(TOOL_CONTEXT_DATA_SCHEMA.safeParse(result.data).success).toBe(true);
  });

  test("returns RESPONSE_TOO_LARGE without recording success when required context cannot fit", async () => {
    const required = { ...evidenceItem("required", "必".repeat(75_000)), layer: "L0" as const, required: true, tokens: 100 };
    const data = {
      status: "complete" as const, workRef: "work:test", revision: 1, budgetTokens: 1_000, usedTokens: 100,
      estimated: true, estimator: "mixed-cjk-v1", accountingScope: "evidence_excerpts_only" as const,
      blocks: [required], omitted: [], diagnostics: [],
    };
    const recorder = recorderSpy();
    const call = await invoke(serviceWith({ context: async () => data }), recorder, "writing_context", { workRef: "work:test", query: "q", budgetTokens: 1_000 });
    const result = (call.structuredContent as { result: { ok: false; error: { code: string; recovery?: string } } }).result;
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("RESPONSE_TOO_LARGE");
    expect(result.error.recovery).toContain("Narrow the query");
    expect(recorder.records).toHaveLength(1);
    expect(recorder.records[0]).toHaveProperty("error.code", "RESPONSE_TOO_LARGE");
    expect(recorder.records[0]).not.toHaveProperty("output");
  });

  test("keeps the selected resolved candidate while trimming stable candidate tails", async () => {
    const candidate = (workRef: string, fill: number) => ({ workRef, title: workRef, rootPath: "路".repeat(fill), adapter: "generic" as const, capabilities: ["documents"] });
    const data = { status: "resolved" as const, workRef: "work:selected", candidates: [candidate("work:selected", 40_000), candidate("work:tail", 40_000)], diagnostics: [] };
    const recorder = recorderSpy();
    const call = await invoke(serviceWith({ resolve: async () => data }), recorder, "writing_resolve", { sourcePath: "source" });
    const result = (call.structuredContent as { result: { ok: true; data: typeof data } }).result;
    expect(result.data.status).toBe("resolved");
    expect(result.data.workRef).toBe("work:selected");
    expect(result.data.candidates.map(item => item.workRef)).toEqual(["work:selected"]);
    expect(result.data.diagnostics.filter(item => item.code === "RESPONSE_TRUNCATED")).toHaveLength(1);
    expect(TOOL_RESOLVE_DATA_SCHEMA.safeParse(result.data).success).toBe(true);
  });

  test("keeps ambiguous status and no workRef after candidate truncation", async () => {
    const candidates = Array.from({ length: 3 }, (_, index) => ({ workRef: `work:${index}`, title: `work:${index}`, rootPath: "路".repeat(35_000), adapter: "generic" as const, capabilities: ["documents"] }));
    const data = { status: "ambiguous" as const, candidates, diagnostics: [] };
    const call = await invoke(serviceWith({ resolve: async () => data }), recorderSpy(), "writing_resolve", { sourcePath: "source" });
    const result = (call.structuredContent as { result: { ok: true; data: typeof data } }).result;
    expect(result.data.status).toBe("ambiguous");
    expect(result.data).not.toHaveProperty("workRef");
    expect(result.data.candidates.length).toBeLessThan(candidates.length);
  });

  test("trims diagnose recentEvents but rejects non-trimmable index data", async () => {
    const diagnose = {
      action: "inspect" as const, workRef: "work:test", purpose: "development" as const, status: "healthy" as const,
      eventHistoryAvailable: true, recentEvents: Array.from({ length: 5 }, (_, index) => ({ index, message: "事".repeat(25_000) })),
      diagnosticsDirectory: "diagnostics/", observationScope: "mcp_calls_only" as const,
    };
    const diagnoseRecorder = recorderSpy();
    const diagnoseService = serviceWith({
      index: async () => ({ revision: 1, freshness: "fresh", stats: { documents: 1, spans: 1, entities: 0, edges: 0 } }),
    });
    const diagnoseRecorderWithInspect = Object.assign(diagnoseRecorder, { inspect: async () => diagnose });
    const diagnoseServerService = diagnoseService;
    // writing_diagnose calls recorder.inspect; keep the real wrapper and only replace the recorder's data source.
    const diagnoseCall = await invoke(diagnoseServerService, diagnoseRecorderWithInspect, "writing_diagnose", { action: "inspect", workRef: "work:test", purpose: "development" });
    const diagnoseResult = (diagnoseCall.structuredContent as { result: { ok: true; data: typeof diagnose & { index: unknown; truncated?: boolean } } }).result;
    expect(diagnoseResult.data.recentEvents!.length).toBeLessThan(diagnose.recentEvents.length);
    expect(diagnoseResult.data.truncated).toBe(true);
    expect(compactJsonBytes(diagnoseResult)).toBeLessThanOrEqual(200_000);
    expect(TOOL_DIAGNOSE_DATA_SCHEMA.safeParse(diagnoseResult.data).success).toBe(true);

    const indexData = {
      workRef: "work:test", revision: 1, schemaVersion: 4, freshness: "fresh" as const,
      stats: { added: 0, updated: 0, deleted: 0, skipped: 0, documents: 1, spans: 1, entities: 0, edges: 0 },
      diagnostics: [{ code: "HUGE", message: "错".repeat(75_000) }], elapsedMs: 1,
    };
    const indexRecorder = recorderSpy();
    const indexCall = await invoke(serviceWith({ index: async () => indexData }), indexRecorder, "writing_index", { workRef: "work:test", mode: "status" });
    const indexResult = (indexCall.structuredContent as { result: { ok: false; error: { code: string } } }).result;
    expect(indexResult.error.code).toBe("RESPONSE_TOO_LARGE");
    expect(indexRecorder.records[0]).toHaveProperty("error.code", "RESPONSE_TOO_LARGE");
  });

  test("bounds failure detail before the recorder and returns the same bounded error", async () => {
    const recorder = recorderSpy();
    const call = await invoke(serviceWith({ index: async () => { throw Object.assign(new Error("错".repeat(100_000)), { code: "HUGE_FAILURE" }); } }), recorder, "writing_index", { workRef: "work:test", mode: "status" });
    const result = (call.structuredContent as { result: { ok: false; error: Record<string, unknown>; diagnostic: unknown } }).result;
    expect(compactJsonBytes(result)).toBeLessThanOrEqual(200_000);
    expect(recorder.records[0]?.error).toEqual(result.error);
    expect(Buffer.byteLength(String((call.content as Array<{ text?: string }>)[0]?.text), "utf8")).toBeLessThanOrEqual(16_384);
  });
});
