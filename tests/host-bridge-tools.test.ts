import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { createPairingManager } from "../packages/host-bridge/src/auth.js";
import { createBridgeServer } from "../packages/host-bridge/src/server.js";
import { createBridgeState } from "../packages/host-bridge/src/state.js";
import * as bridgeExports from "../packages/host-bridge/src/index.js";
import { TIMEOUTS } from "@writing-mcp/host-bridge-protocol";

describe("host bridge tool routes (HB-M3)", () => {
  test("all five project tool endpoints validate the proxy envelope and dispatch the requested operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "hb-tools-routes-"));
    const auth = createPairingManager({ onCode: () => undefined });
    const state = createBridgeState({ countActiveSessions: () => auth.activeTokenCount() });
    const calls: Array<{ operation: string; hostProjectId: string; origin: string; args: Record<string, unknown> }> = [];
    const toolProxy = {
      invoke: async (operation: string, hostProjectId: string, origin: string, args: Record<string, unknown>) => {
        calls.push({ operation, hostProjectId, origin, args });
        return { operation, echoed: args };
      },
    };
    const pipeline = {
      status: () => ({ hostProjectId: "123", bindingState: "fresh" as const, workRef: "work-1" }),
      activate: async () => ({ outcome: "noop" as const, snapshotHash: "0".repeat(64), bindingState: "fresh" as const }),
      deleteDerivedData: async () => ({ bindingState: "empty" as const }),
    };
    const server = createBridgeServer({
      auth,
      state,
      pipeline: pipeline as never,
      toolProxy,
      config: { port: 0, allowedOrigins: ["http://localhost:1111"] },
    });
    await server.listen();
    try {
      const paired = auth.pair(auth.currentCode().code);
      if (!paired.ok) throw new Error("pair should succeed");
      const invalid = await fetch(`http://127.0.0.1:${server.port()}/v1/projects/123/explore`, {
        method: "POST",
        headers: { origin: "http://localhost:1111", authorization: `Bearer ${paired.token}`, "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: 1, arguments: {}, unexpected: true }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ ok: false, error: { code: "BRIDGE_TOOL_REQUEST_INVALID" } });
      for (const operation of ["resolve", "index", "explore", "context", "diagnose"] as const) {
        const response = await fetch(`http://127.0.0.1:${server.port()}/v1/projects/123/${operation}`, {
          method: "POST",
          headers: {
            origin: "http://localhost:1111",
            authorization: `Bearer ${paired.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ protocolVersion: 1, arguments: { query: operation } }),
        });
        expect(response.status, operation).toBe(200);
        const body = await response.json() as { ok: boolean; data: { operation: string } };
        expect(body).toMatchObject({ ok: true, data: { operation } });
      }
      expect(calls.map((call) => call.operation)).toEqual(["resolve", "index", "explore", "context", "diagnose"]);
      expect(calls.every((call) => call.hostProjectId === "123" && call.origin === "http://localhost:1111")).toBe(true);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("project proxy owns workRef, retries WORK_REF_NOT_FOUND once, forces metadata diagnostics, and applies frozen timeouts", async () => {
    const createProjectToolProxy = (bridgeExports as unknown as {
      createProjectToolProxy?: (options: Record<string, unknown>) => {
        invoke(operation: "resolve" | "index" | "explore" | "context" | "diagnose", hostProjectId: string, origin: string, args: Record<string, unknown>): Promise<unknown>;
      };
    }).createProjectToolProxy;
    expect(typeof createProjectToolProxy).toBe("function");
    if (!createProjectToolProxy) return;

    const calls: Array<{ name: string; args: Record<string, unknown>; timeoutMs?: number }> = [];
    let firstExplore = true;
    const mcp = {
      callTool: async (name: string, args: unknown, timeoutMs?: number) => {
        const record = args as Record<string, unknown>;
        calls.push({ name, args: record, timeoutMs });
        if (name === "writing_resolve") {
          return { structuredContent: { result: { ok: true, data: { status: "resolved", workRef: "work-new" }, diagnostic: {} } } };
        }
        if (name === "writing_explore" && firstExplore) {
          firstExplore = false;
          return { structuredContent: { result: { ok: false, error: { code: "WORK_REF_NOT_FOUND", message: "stale" }, diagnostic: {} } } };
        }
        return { structuredContent: { result: { ok: true, data: {
          workRef: record.workRef,
          operation: name,
          ...(name === "writing_diagnose" ? {
            artifactPath: "C:/private/report.json",
            diagnosticsDirectory: "C:/private/diagnostics",
            recentEvents: [{ artifactPath: "C:/private/nested.json", summary: "safe" }],
          } : {}),
        }, diagnostic: {} } } };
      },
    };
    const pipeline = {
      projectKey: () => "project-key",
      status: () => ({ hostProjectId: "123", bindingState: "fresh" as const, workRef: "work-old" }),
    };
    const proxy = createProjectToolProxy({ bridgeRoot: "C:/bridge", mcp, pipeline, isPluginAvailable: () => true });

    const explored = await proxy.invoke("explore", "123", "http://localhost:1111", { workRef: "browser-controlled", query: "北塔" });
    expect(explored).toMatchObject({ ok: true, data: { workRef: "work-new" } });
    expect(calls.map((call) => call.name)).toEqual(["writing_explore", "writing_resolve", "writing_explore"]);
    expect(calls[0]).toMatchObject({ args: { workRef: "work-old", query: "北塔" }, timeoutMs: TIMEOUTS.toolMs });
    expect(calls[1].args).toMatchObject({ sourcePath: expect.stringMatching(/projects[\\/]project-key$/), adapterHint: "generic" });
    expect(calls[2]).toMatchObject({ args: { workRef: "work-new" }, timeoutMs: TIMEOUTS.toolMs });

    await proxy.invoke("index", "123", "http://localhost:1111", { workRef: "wrong", mode: "rebuild" });
    expect(calls.at(-1)).toMatchObject({ name: "writing_index", args: { workRef: "work-new", mode: "rebuild" }, timeoutMs: TIMEOUTS.snapshotMs });
    const diagnosed = await proxy.invoke("diagnose", "123", "http://localhost:1111", { action: "inspect", contentPolicy: "full" });
    expect(calls.at(-1)).toMatchObject({ name: "writing_diagnose", args: { workRef: "work-new", action: "inspect", contentPolicy: "metadata" }, timeoutMs: TIMEOUTS.toolMs });
    expect(JSON.stringify(diagnosed)).not.toContain("C:/private")
    expect(diagnosed).not.toHaveProperty("data.artifactPath")
    expect(diagnosed).not.toHaveProperty("data.diagnosticsDirectory")
    expect(diagnosed).toMatchObject({ data: { recentEvents: [{ summary: "safe" }] } })
    expect(JSON.stringify(diagnosed)).not.toContain("C:/private")
  });

  test("the complete five-tool proxy fixture runs against one real MCP stdio child", async () => {
    const root = await mkdtemp(join(tmpdir(), "hb-tools-real-"));
    const projectKey = "real-project-key";
    const projectDir = join(root, "projects", projectKey);
    await mkdir(projectDir, { recursive: true });
    await cp(new URL("../fixtures/generic-novel", import.meta.url), join(projectDir, "source"), { recursive: true });
    const mcp = bridgeExports.createMcpClient({
      command: process.execPath,
      args: [resolve("packages/mcp-server/dist/index.js")],
      env: { ...process.env, WRITING_MCP_ROOTS: join(root, "projects") } as NodeJS.ProcessEnv,
    });
    await mcp.start();
    try {
      const proxy = bridgeExports.createProjectToolProxy({
        bridgeRoot: root,
        mcp,
        pipeline: {
          projectKey: () => projectKey,
          status: () => ({ hostProjectId: "real", bindingState: "stale" as const }),
        },
      });
      const resolved = await proxy.invoke("resolve", "real", "http://localhost:1111", {});
      expect(resolved).toMatchObject({ ok: true, data: { status: "resolved" } });
      const indexed = await proxy.invoke("index", "real", "http://localhost:1111", { mode: "rebuild" });
      expect(indexed).toMatchObject({ ok: true, data: { freshness: "fresh" } });
      const explored = await proxy.invoke("explore", "real", "http://localhost:1111", { operation: "search", query: "林秋", limit: 5 });
      expect(explored).toMatchObject({ ok: true });
      const contextualized = await proxy.invoke("context", "real", "http://localhost:1111", { taskType: "answer", query: "林秋", budgetTokens: 500 });
      expect(contextualized).toMatchObject({ ok: true, data: { accountingScope: "evidence_excerpts_only" } });
      const diagnosed = await proxy.invoke("diagnose", "real", "http://localhost:1111", { action: "inspect", purpose: "usage", contentPolicy: "query" });
      expect(diagnosed).toMatchObject({ ok: true, data: { action: "inspect" } });
      expect(JSON.stringify(diagnosed)).not.toMatch(/[A-Z]:[\\/]/i);
    } finally {
      await mcp.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
