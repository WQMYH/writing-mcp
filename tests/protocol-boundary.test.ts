import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DiagnosticRecorder } from "../packages/mcp-server/src/diagnostics.js";
import { createServer, TOOL_EXPLORE_DATA_SCHEMA, TOOL_RESOLVE_DATA_SCHEMA } from "../packages/mcp-server/src/server.js";

interface DiagnosticLike { traceId: string; outcome: "success" | "failure"; persistence: string; executionSummary: { action: string } }
interface SuccessEnvelope<T> { result: { ok: true; data: T; diagnostic: DiagnosticLike } }
interface FailureEnvelope { result: { ok: false; error: { code: string; message: string; traceId: string; recovery?: string }; diagnostic: DiagnosticLike } }

const success = <T>(call: unknown): SuccessEnvelope<T>["result"] => ((call as { structuredContent?: unknown }).structuredContent as SuccessEnvelope<T>).result;
const failure = (call: unknown): FailureEnvelope["result"] => ((call as { structuredContent?: unknown }).structuredContent as FailureEnvelope)["result"];

const stubService = (resolveResult: unknown) => ({
  resolve: async () => resolveResult,
  index: async () => { throw new Error("not used"); },
  explore: async () => { throw new Error("not used"); },
  context: async () => { throw new Error("not used"); },
  diagnosticDirectory: () => undefined,
});

describe("MCP protocol boundary (AUD-025)", () => {
  test("tool data schemas are shared between registration and wrapper validation", () => {
    // Single source of truth: registration envelopes must be built from the exported data schemas.
    expect(TOOL_RESOLVE_DATA_SCHEMA.safeParse({ status: "resolved", candidates: [], diagnostics: [] }).success).toBe(true);
    expect(TOOL_RESOLVE_DATA_SCHEMA.safeParse({ status: "bogus" }).success).toBe(false);
    expect(TOOL_EXPLORE_DATA_SCHEMA.safeParse({ bogus: true }).success).toBe(false);
  });

  test("output schema mismatch is recorded as failure and returned as a consistent envelope", async () => {
    const recorder = new DiagnosticRecorder(() => undefined);
    const server = createServer(stubService({ status: "not-a-real-status", candidates: [], diagnostics: [] }) as never, recorder);
    const client = new Client({ name: "boundary-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const call = await client.callTool({ name: "writing_resolve", arguments: { sourcePath: "whatever" } });
      expect(call.isError).toBe(true);
      const failed = failure(call);
      expect(failed.error.code).toBe("OUTPUT_SCHEMA_MISMATCH");
      expect(failed.error.recovery).toBeTruthy();
      expect(failed.diagnostic.outcome).toBe("failure");
      expect(failed.diagnostic.traceId).toBe(failed.error.traceId);
      expect(failed.diagnostic.executionSummary.action).toBe("writing_resolve");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("query deadlines return a diagnosed error with timeout-specific recovery", async () => {
    const timeout = Object.assign(new Error("Explore exceeded the execution time limit"), { code: "EXPLORE_TIME_LIMIT_EXCEEDED" });
    const service = { ...stubService({}), explore: async () => { throw timeout; } };
    const recorder = new DiagnosticRecorder(() => undefined);
    const server = createServer(service as never, recorder);
    const client = new Client({ name: "boundary-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const call = await client.callTool({ name: "writing_explore", arguments: { workRef: "work:test", operation: "search" } });
      expect(call.isError).toBe(true);
      const failed = failure(call);
      expect(failed.error.code).toBe("EXPLORE_TIME_LIMIT_EXCEEDED");
      expect(failed.error.recovery).toBe("Retry with a narrower query or lower result limit after any current index update finishes.");
      expect(failed.diagnostic.outcome).toBe("failure");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("normal in-process calls stay consistent and report no protocol errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-boundary-normal-"));
    const source = join(dir, "novel");
    await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
    const previousRoots = process.env.WRITING_MCP_ROOTS;
    process.env.WRITING_MCP_ROOTS = dir;
    const protocolErrors: unknown[] = [];
    try {
      const { createService } = await import("../packages/mcp-server/src/server.js");
      const service = createService();
      const recorder = new DiagnosticRecorder(workRef => service.diagnosticDirectory(workRef));
      const server = createServer(service, recorder, { onerror: (error: unknown) => protocolErrors.push(error) });
      const client = new Client({ name: "boundary-test", version: "0.1.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const resolved = success<{ status: string; workRef: string }>(await client.callTool({ name: "writing_resolve", arguments: { sourcePath: source } }));
        expect(resolved.data.status).toBe("resolved");
        expect(resolved.diagnostic.outcome).toBe("success");
        expect(resolved.diagnostic.persistence).toBe("persisted");
        expect(protocolErrors).toEqual([]);
      } finally {
        await client.close();
        await server.close();
        service.close();
      }
    } finally {
      if (previousRoots === undefined) delete process.env.WRITING_MCP_ROOTS; else process.env.WRITING_MCP_ROOTS = previousRoots;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("SDK input rejection returns a bare error result and leaves no diagnostic record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-boundary-input-"));
    const source = join(dir, "novel");
    await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
    const client = new Client({ name: "boundary-test", version: "0.1.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("packages/mcp-server/dist/index.js")], env: { ...process.env, WRITING_MCP_ROOTS: dir } as Record<string, string> });
    try {
      await client.connect(transport);
      let stderrOutput = "";
      transport.stderr?.on("data", (chunk: Buffer) => { stderrOutput += chunk.toString(); });
      // Resolve first so the diagnostics directory and baseline files exist.
      const resolved = success<{ workRef: string }>(await client.callTool({ name: "writing_resolve", arguments: { sourcePath: source } }));
      const diagnosticRoot = join(source, ".writing-index", resolved.data.workRef.replaceAll(":", "-"), "diagnostics");
      const reportsBefore = await readdir(join(diagnosticRoot, "reports")).catch(() => [] as string[]);

      // Missing required sourcePath: rejected by the SDK before any handler runs.
      const rejected = await client.callTool({ name: "writing_resolve", arguments: {} });
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toBeUndefined();
      expect(String((rejected.content as Array<{ text?: string }>)[0]?.text)).toContain("Invalid arguments");

      const reportsAfter = await readdir(join(diagnosticRoot, "reports"));
      expect(reportsAfter).toEqual(reportsBefore);
      // The SDK handles input rejection inside the call-tool path; no protocol error reaches stderr.
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
      expect(stderrOutput).toBe("");
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("protocol-level transport errors surface through the injected onerror handler", async () => {
    const protocolErrors: Error[] = [];
    const server = createServer(stubService({}) as never, new DiagnosticRecorder(() => undefined), { onerror: error => protocolErrors.push(error as Error) });
    const client = new Client({ name: "boundary-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      // A message matching no JSON-RPC type predicate reaches the protocol layer's
      // "Unknown message type" branch, which reports via onerror. (Unknown *notifications*
      // are silently ignored by the SDK, per protocol.js _onnotification.)
      await clientTransport.send({ jsonrpc: "2.0" } as never);
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
      expect(protocolErrors.length).toBeGreaterThan(0);
      expect(String(protocolErrors[0].message)).toContain("Unknown message type");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
