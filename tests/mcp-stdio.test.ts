import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface DiagnosticResult {
  traceId: string;
  tool: string;
  outcome: "success" | "failure";
  persistence: "persisted" | "skipped" | "failed";
  artifactPath?: string;
  executionSummary: { action: string; outcome: string; message: string };
}

interface SuccessEnvelope<T> { result: { ok: true; data: T; diagnostic: DiagnosticResult } }
interface FailureEnvelope { result: { ok: false; error: { code: string; traceId: string }; diagnostic: DiagnosticResult } }

const success = <T>(call: { structuredContent?: unknown }): SuccessEnvelope<T>["result"] => (call.structuredContent as SuccessEnvelope<T>).result;
const failure = (call: { structuredContent?: unknown }): FailureEnvelope["result"] => (call.structuredContent as FailureEnvelope).result;

describe("MCP stdio transport", () => {
  test("all five tools pass through diagnostics and explicit captures produce artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-stdio-"));
    const source = join(dir, "novel");
    await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
    const client = new Client({ name: "writing-mcp-test", version: "0.1.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("packages/mcp-server/dist/index.js")], env: { ...process.env, WRITING_MCP_ROOTS: dir } as Record<string, string> });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual(["writing_context", "writing_diagnose", "writing_explore", "writing_index", "writing_resolve"]);
      expect(listed.tools.every(tool => tool.outputSchema)).toBe(true);

      const resolvedCall = await client.callTool({ name: "writing_resolve", arguments: { sourcePath: source } });
      const resolved = success<{ workRef: string; status: string }>(resolvedCall);
      expect(resolved.data.status).toBe("resolved");
      expect(resolved.diagnostic).toMatchObject({ tool: "writing_resolve", outcome: "success", persistence: "persisted" });
      const workRef = resolved.data.workRef;
      const diagnosticRoot = join(source, ".writing-index", workRef.replaceAll(":", "-"), "diagnostics");

      const indexedCall = await client.callTool({ name: "writing_index", arguments: { workRef, mode: "rebuild" } });
      const indexed = success<{ stats: { documents: number } }>(indexedCall);
      expect(indexed.data.stats.documents).toBe(3);
      expect(indexed.diagnostic).toMatchObject({ tool: "writing_index", outcome: "success", persistence: "persisted" });

      const startedCall = await client.callTool({ name: "writing_diagnose", arguments: { action: "start_capture", purpose: "development", workRef, label: "stdio regression" } });
      const started = success<{ diagnosticRunRef: string; contentPolicy: string }>(startedCall);
      expect(started.data.contentPolicy).toBe("metadata");
      expect(started.diagnostic).toMatchObject({ tool: "writing_diagnose", outcome: "success", persistence: "persisted" });
      const diagnosticRunRef = started.data.diagnosticRunRef;

      const privateQuery = "chapter-02";
      const exploredCall = await client.callTool({ name: "writing_explore", arguments: { workRef, operation: "document", query: privateQuery, diagnosticRunRef } });
      const explored = success<{ results: unknown[] }>(exploredCall);
      expect(explored.data.results.length).toBeGreaterThan(0);
      expect(explored.diagnostic).toMatchObject({ tool: "writing_explore", outcome: "success", persistence: "persisted" });
      const exploredArtifact = await readFile(join(diagnosticRoot, explored.diagnostic.artifactPath!), "utf8");
      expect(exploredArtifact).not.toContain(privateQuery);
      expect(exploredArtifact).toContain("sha256");

      const contextCall = await client.callTool({ name: "writing_context", arguments: { workRef, taskType: "answer", query: privateQuery, budgetTokens: 200, diagnosticRunRef } });
      const context = success<{ usedTokens: number }>(contextCall);
      expect(context.data.usedTokens).toBeLessThanOrEqual(200);
      expect(context.diagnostic).toMatchObject({ tool: "writing_context", outcome: "success", persistence: "persisted" });

      const finishedCall = await client.callTool({ name: "writing_diagnose", arguments: { action: "finish_capture", purpose: "development", workRef, diagnosticRunRef, formats: ["json", "markdown"] } });
      const finished = success<{ artifactPath: string; calls: number; failures: number; sha256: string }>(finishedCall);
      expect(finished.data).toMatchObject({ calls: 2, failures: 0 });
      expect(finished.data.sha256).toMatch(/^[a-f0-9]{64}$/);
      const capture = JSON.parse(await readFile(join(diagnosticRoot, finished.data.artifactPath), "utf8")) as { observationScope: string; calls: Array<{ sequence: number; tool: string }> };
      expect(capture.observationScope).toBe("mcp_calls_only");
      expect(capture.calls.map(call => [call.sequence, call.tool])).toEqual([[1, "writing_explore"], [2, "writing_context"]]);
      await stat(join(diagnosticRoot, "runs", `${diagnosticRunRef}.md`));

      const queryCaptureStart = success<{ diagnosticRunRef: string }>(await client.callTool({ name: "writing_diagnose", arguments: { action: "start_capture", purpose: "development", workRef, contentPolicy: "query" } }));
      await client.callTool({ name: "writing_explore", arguments: { workRef, operation: "document", query: privateQuery, diagnosticRunRef: queryCaptureStart.data.diagnosticRunRef } });
      const queryCaptureFinish = success<{ artifactPath: string }>(await client.callTool({ name: "writing_diagnose", arguments: { action: "finish_capture", purpose: "development", workRef, diagnosticRunRef: queryCaptureStart.data.diagnosticRunRef } }));
      expect(await readFile(join(diagnosticRoot, queryCaptureFinish.data.artifactPath), "utf8")).toContain(privateQuery);

      const closedRunCall = await client.callTool({ name: "writing_index", arguments: { workRef, mode: "status", diagnosticRunRef } });
      const closedRun = failure(closedRunCall);
      expect(closedRun.error.code).toBe("DIAGNOSTIC_RUN_CLOSED");
      expect(closedRun.diagnostic).toMatchObject({ tool: "writing_index", outcome: "failure", persistence: "persisted", persistenceError: "DIAGNOSTIC_RUN_CLOSED" });

      const inspectedCall = await client.callTool({ name: "writing_diagnose", arguments: { action: "inspect", purpose: "usage", workRef } });
      const inspected = success<{ status: string; observationScope: string; index: { revision: number; freshness: string; documents: number; contextSources?: { byLayer: Record<string, number>; byKind: Record<string, number> } } }>(inspectedCall);
      expect(inspected.data.observationScope).toBe("mcp_calls_only");
      // Source catalog summary: the inspect index digest carries the same
      // contextSources breakdown as writing_explore stats (M4 source directory).
      expect(inspected.data.index.contextSources).toBeDefined();
      expect(inspected.data.index.contextSources!.byLayer).toMatchObject({ L1: 1, L2: 2, L3: 0 });
      expect(Object.values(inspected.data.index.contextSources!.byKind).reduce((sum: number, n: number) => sum + n, 0)).toBe(inspected.data.index.documents);
      expect(inspected.diagnostic).toMatchObject({ tool: "writing_diagnose", outcome: "success", persistence: "persisted" });

      const failedCall = await client.callTool({ name: "writing_index", arguments: { workRef: "work:missing", mode: "status" } });
      expect(failedCall.isError).toBe(true);
      const failed = failure(failedCall);
      expect(failed.error.code).toBe("WORK_REF_NOT_FOUND");
      expect(failed.error.traceId).toBe(failed.diagnostic.traceId);
      expect(failed.diagnostic).toMatchObject({ tool: "writing_index", outcome: "failure", persistence: "persisted" });

      for (const diagnostic of [resolved.diagnostic, indexed.diagnostic, started.diagnostic, explored.diagnostic, context.diagnostic, finished.diagnostic, queryCaptureStart.diagnostic, queryCaptureFinish.diagnostic, closedRun.diagnostic, inspected.diagnostic, failed.diagnostic]) {
        expect(diagnostic.executionSummary.action).toBe(diagnostic.tool);
        expect(diagnostic.artifactPath).toMatch(/^reports\/trace-[a-f0-9]{24}\.json$/);
      }
      await stat(join(diagnosticRoot, "diagnostics.jsonl"));
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
