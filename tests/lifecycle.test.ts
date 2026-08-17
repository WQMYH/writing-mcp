import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, test } from "vitest";
import { WritingService } from "../packages/core/src/service.js";
import { GenericAdapter } from "../packages/adapter-generic/src/index.js";
import { InkosAdapter } from "../packages/adapter-inkos/src/index.js";
import { createStdioRuntime } from "../packages/mcp-server/src/server.js";

// AUD-032: process lifecycle — deterministic graceful shutdown, no stdout pollution.
// stdout is the JSON-RPC channel; every emitted line must parse as a protocol message.

const ENTRY = resolve("packages/mcp-server/dist/index.js");
const spawned: ChildProcessWithoutNullStreams[] = [];
afterAll(() => { for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });

interface ExitResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function spawnServer(roots: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [ENTRY], { env: { ...process.env, WRITING_MCP_ROOTS: roots } as NodeJS.ProcessEnv });
  spawned.push(child);
  return child;
}

function collect(child: ChildProcessWithoutNullStreams): Promise<ExitResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => rejectPromise(new Error(`server did not exit within 10s (stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)})`)), 10_000);
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolvePromise({ code, signal, stdout, stderr }); });
    child.once("error", rejectPromise);
  });
}

const assertCleanStdout = (stdout: string) => {
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const parsed: unknown = JSON.parse(line);
    expect(parsed).toBeTypeOf("object");
    const message = parsed as Record<string, unknown>;
    expect(message.jsonrpc).toBe("2.0");
  }
};

describe("process lifecycle (AUD-032)", () => {
  test("SIGTERM terminates the server process within the deadline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-lifecycle-"));
    const child = spawnServer(dir);
    const exited = collect(child);
    await new Promise(r => setTimeout(r, 600));
    child.kill("SIGTERM");
    const result = await exited;
    // POSIX runs the graceful handler (exit 0); Windows terminates unconditionally (signal).
    if (process.platform === "win32") expect(result.signal).toBe("SIGTERM");
    else { expect(result.code).toBe(0); expect(result.signal).toBeNull(); }
    assertCleanStdout(result.stdout);
    await rm(dir, { recursive: true, force: true });
  }, 20_000);

  test("SIGINT terminates the server process within the deadline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-lifecycle-"));
    const child = spawnServer(dir);
    const exited = collect(child);
    await new Promise(r => setTimeout(r, 600));
    child.kill("SIGINT");
    const result = await exited;
    if (process.platform === "win32") expect(result.signal).toBe("SIGINT");
    else { expect(result.code).toBe(0); expect(result.signal).toBeNull(); }
    assertCleanStdout(result.stdout);
    await rm(dir, { recursive: true, force: true });
  }, 20_000);

  test("stdin EOF (client disconnect) shuts the server down with exit code 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-lifecycle-"));
    const child = spawnServer(dir);
    const exited = collect(child);
    await new Promise(r => setTimeout(r, 600));
    child.stdin.end();
    const result = await exited;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    assertCleanStdout(result.stdout);
    await rm(dir, { recursive: true, force: true });
  }, 20_000);

  test("a full session emits only JSON-RPC on stdout and still exits cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-lifecycle-"));
    const source = join(dir, "novel");
    await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
    const child = spawnServer(dir);
    const exited = collect(child);
    const send = (message: Record<string, unknown>) => { child.stdin.write(JSON.stringify(message) + "\n"); };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lifecycle-test", version: "0.1.0" } } });
    await new Promise(r => setTimeout(r, 1_000));
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "writing_resolve", arguments: { sourcePath: source } } });
    await new Promise(r => setTimeout(r, 2_000));
    child.stdin.end();
    const result = await exited;
    expect(result.code).toBe(0);
    assertCleanStdout(result.stdout);
    const responses = result.stdout.split("\n").filter(line => line.trim() !== "").map(line => JSON.parse(line) as { id?: number });
    expect(responses.some(message => message.id === 1)).toBe(true);
    expect(responses.some(message => message.id === 2)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  test("the shutdown chain closes server and service, is idempotent, and never writes to stdout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-lifecycle-"));
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    const service = new WritingService([new InkosAdapter(), new GenericAdapter()], [dir]);
    const runtime = createStdioRuntime(service, { onerror: () => undefined });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "lifecycle-inprocess", version: "0.1.0" });
    await Promise.all([runtime.server.connect(serverSide), client.connect(clientSide)]);
    try {
      (process.stdout.write as unknown) = (chunk: unknown) => { writes.push(String(chunk)); return true; };
      await runtime.shutdown();
      await runtime.shutdown();
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(writes).toEqual([]);
    await expect(client.listTools()).rejects.toThrow();
    expect(service.close()).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  }, 20_000);
});
