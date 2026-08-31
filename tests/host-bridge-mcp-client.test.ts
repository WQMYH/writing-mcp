import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createMcpClient } from "../packages/host-bridge/src/mcp-client.js";

const MCP_ENTRY = resolve("packages/mcp-server/dist/index.js");
const children: Array<{ kill: (signal?: NodeJS.Signals) => boolean }> = [];
afterAll(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });

describe("host bridge MCP stdio client (HB-M1)", () => {
  test("performs the initialize handshake and a real tool call against the built server", async () => {
    const root = await mkdtemp(join(tmpdir(), "hb-mcp-"));
    try {
      await cp(new URL("../fixtures/generic-novel", import.meta.url), join(root, "novel"), { recursive: true });
      const client = createMcpClient({ command: process.execPath, args: [MCP_ENTRY], env: { ...process.env, WRITING_MCP_ROOTS: root } as NodeJS.ProcessEnv });
      try {
        await client.start();
        expect(client.isRunning()).toBe(true);
        const result = await client.callTool("writing_resolve", { sourcePath: join(root, "novel") }) as { structuredContent?: { result?: { ok?: boolean; data?: { status?: string } } } };
        expect(result.structuredContent?.result?.ok).toBe(true);
        expect(result.structuredContent?.result?.data?.status).toBe("resolved");
      } finally {
        await client.stop();
      }
      expect(client.isRunning()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stderr capture stays bounded even when the child floods it", async () => {
    const script = "process.stderr.write('x'.repeat(3 * 1024 * 1024)); setTimeout(() => process.exit(0), 100);";
    const client = createMcpClient({ command: process.execPath, args: ["-e", script], stderrLimitBytes: 64 * 1024 });
    const exited = new Promise<void>((resolvePromise) => client.onExit(resolvePromise));
    void client.start().catch(() => undefined);
    await exited;
    expect(client.stderrText().length).toBeGreaterThan(0);
    expect(client.stderrText().length).toBeLessThanOrEqual(64 * 1024 + 1024);
    await client.stop();
  });

  test("stderr capture retains the newest complete tail after overflowing the limit", async () => {
    const limit = 4 * 1024;
    const marker = "LATEST-DIAGNOSTIC-MARKER";
    const script = `process.stderr.write('x'.repeat(${limit + 2048}) + '${marker}'); setTimeout(() => process.exit(0), 50);`;
    const client = createMcpClient({ command: process.execPath, args: ["-e", script], stderrLimitBytes: limit });
    const exited = new Promise<void>((resolvePromise) => client.onExit(resolvePromise));
    void client.start().catch(() => undefined);
    await exited;
    expect(Buffer.byteLength(client.stderrText(), "utf8")).toBe(limit);
    expect(client.stderrText().endsWith(marker)).toBe(true);
    await client.stop();
  });

  test("non-JSON stdout noise does not break the protocol channel", async () => {
    const script = [
      "process.stdout.write('this is definitely not json\\n');",
      "let buffer = '';",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += String(chunk);",
      "  const lines = buffer.split('\\n');",
      "  buffer = lines.pop();",
      "  for (const line of lines) {",
      "    if (!line.trim()) continue;",
      "    const message = JSON.parse(line);",
      "    if (message.id === 1) {",
      "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stub', version: '0.0.1' } } }) + '\\n');",
      "    } else if (message.id) {",
      "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }) + '\\n');",
      "    }",
      "  }",
      "});",
    ].join("\n");
    const client = createMcpClient({ command: process.execPath, args: ["-e", script] });
    try {
      await client.start();
      const result = await client.callTool("writing_resolve", {}) as { content?: unknown[] };
      expect(result).toHaveProperty("content");
    } finally {
      await client.stop();
    }
  });

  test("a child dying mid-request rejects the pending call with BRIDGE_MCP_UNAVAILABLE", async () => {
    const script = [
      "let buffer = '';",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += String(chunk);",
      "  const lines = buffer.split('\\n');",
      "  buffer = lines.pop();",
      "  for (const line of lines) {",
      "    if (!line.trim()) continue;",
      "    const message = JSON.parse(line);",
      "    if (message.id === 1) {",
      "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stub', version: '0.0.1' } } }) + '\\n');",
      "    } else if (message.id) {",
      "      process.exit(70);",
      "    }",
      "  }",
      "});",
    ].join("\n");
    const client = createMcpClient({ command: process.execPath, args: ["-e", script] });
    const exited = new Promise<number | null>((resolvePromise) => { client.onExit(() => resolvePromise(70)); });
    await client.start();
    await expect(client.callTool("writing_resolve", {})).rejects.toMatchObject({ code: "BRIDGE_MCP_UNAVAILABLE" });
    expect(await exited).toBe(70);
    expect(client.isRunning()).toBe(false);
    await client.stop();
  });

  test("stop is idempotent and terminates the child", async () => {
    const root = await mkdtemp(join(tmpdir(), "hb-mcp-stop-"));
    try {
      const client = createMcpClient({ command: process.execPath, args: [MCP_ENTRY], env: { ...process.env, WRITING_MCP_ROOTS: root } as NodeJS.ProcessEnv });
      await client.start();
      const pid = client.pid;
      expect(pid).toBeGreaterThan(0);
      await client.stop();
      await client.stop();
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
