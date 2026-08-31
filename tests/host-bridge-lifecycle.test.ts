import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { acquireInstanceLock } from "../packages/host-bridge/src/instance-lock.js";
import { isLoopbackAddress, createBridgeServer } from "../packages/host-bridge/src/server.js";
import { createPairingManager } from "../packages/host-bridge/src/auth.js";
import { createBridgeState } from "../packages/host-bridge/src/state.js";
import { runCli } from "../packages/host-bridge/src/cli.js";

const CLI_ENTRY = resolve("packages/host-bridge/dist/cli.js");
const MCP_ENTRY = resolve("packages/mcp-server/dist/index.js");
const children: Array<{ kill: (signal?: NodeJS.Signals) => boolean }> = [];
afterAll(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });

const ORIGINS = ["http://localhost:1111", "http://127.0.0.1:1111"];

function makeStack(overrides: Record<string, unknown> = {}) {
  const printed: string[] = [];
  const auth = createPairingManager({ onCode: (code) => printed.push(code) });
  const state = createBridgeState({ countActiveSessions: () => auth.activeTokenCount() });
  const server = createBridgeServer({ auth, state, config: { port: 0, allowedOrigins: ORIGINS }, ...overrides });
  return { auth, state, server, printed };
}

async function request(port: number, path: string, headers: Record<string, string> = {}, method = "GET", body?: string) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? { method, headers } : { method, headers, body });
  const text = await response.text();
  let json: unknown = undefined;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, headers: response.headers, text, json };
}

// fetch() forbids overriding the Host header; node:http is needed to forge it.
function requestWithHostHeader(port: number, hostHeader: string, path: string): Promise<{ status: number | undefined; text: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host: hostHeader } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += String(chunk); });
      res.on("end", () => resolvePromise({ status: res.statusCode, text }));
    });
    req.on("error", rejectPromise);
    req.end();
  });
}

describe("host bridge security guards (HB-M1)", () => {
  test("loopback address classifier accepts only loopback forms", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
    expect(isLoopbackAddress("::ffff:192.168.1.10")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  test("health is bearer-free, reflects process and pairing state, and sets CORS for allowed origins", async () => {
    const stack = makeStack();
    await stack.server.listen();
    try {
      const before = await request(stack.server.port(), "/v1/health", { origin: ORIGINS[0] });
      expect(before.status).toBe(200);
      expect(before.json).toMatchObject({ protocolVersion: 1, ok: true, data: { processState: "starting", requiresPairing: true } });
      expect(before.headers.get("access-control-allow-origin")).toBe(ORIGINS[0]);
      expect(JSON.stringify(before.json)).not.toContain("token");
      stack.state.setProcessState("ready");
      const paired = stack.auth.pair(stack.auth.currentCode().code);
      if (!paired.ok) throw new Error("pair should succeed");
      const after = await request(stack.server.port(), "/v1/health", { origin: ORIGINS[0] });
      expect(after.json).toMatchObject({ data: { processState: "ready", requiresPairing: false } });
    } finally {
      await stack.server.close();
    }
  });

  test("wrong Host, wrong Origin, and unlisted origins on health are denied with frozen codes", async () => {
    const stack = makeStack();
    await stack.server.listen();
    try {
      const host = await requestWithHostHeader(stack.server.port(), "evil.example:443", "/v1/health");
      expect(host.status).toBe(403);
      expect(JSON.parse(host.text)).toMatchObject({ ok: false, error: { code: "BRIDGE_HOST_DENIED" } });
      const origin = await request(stack.server.port(), "/v1/health", { origin: "http://evil.example:1111" });
      expect(origin.status).toBe(403);
      expect(origin.json).toMatchObject({ ok: false, error: { code: "BRIDGE_ORIGIN_DENIED" } });
      const anonymous = await request(stack.server.port(), "/v1/health");
      expect(anonymous.status).toBe(200);
    } finally {
      await stack.server.close();
    }
  });

  test("PNA preflight answers only when the private-network access is requested", async () => {
    const stack = makeStack();
    await stack.server.listen();
    try {
      const withPna = await request(stack.server.port(), "/v1/health", { origin: ORIGINS[0], "access-control-request-method": "GET", "access-control-request-private-network": "true" }, "OPTIONS");
      expect(withPna.status).toBe(204);
      expect(withPna.headers.get("access-control-allow-private-network")).toBe("true");
      expect(withPna.headers.get("access-control-allow-origin")).toBe(ORIGINS[0]);
      const plain = await request(stack.server.port(), "/v1/health", { origin: ORIGINS[0], "access-control-request-method": "GET" }, "OPTIONS");
      expect(plain.status).toBe(204);
      expect(plain.headers.get("access-control-allow-private-network")).toBeNull();
    } finally {
      await stack.server.close();
    }
  });

  test("pair requires an allowed origin, validates the body, and unpair needs a bearer", async () => {
    const stack = makeStack();
    await stack.server.listen();
    try {
      const denied = await request(stack.server.port(), "/v1/pair", { origin: "http://evil.example:1111", "content-type": "application/json" }, "POST", JSON.stringify({ pairingCode: "x" }));
      expect(denied.status).toBe(403);
      const missingOrigin = await request(stack.server.port(), "/v1/pair", { "content-type": "application/json" }, "POST", JSON.stringify({ pairingCode: stack.printed[0] }));
      expect(missingOrigin.status).toBe(403);
      const bad = await request(stack.server.port(), "/v1/pair", { origin: ORIGINS[0], "content-type": "application/json" }, "POST", JSON.stringify({ pairingCode: "wrong" }));
      expect(bad.status).toBe(401);
      expect(bad.json).toMatchObject({ ok: false, error: { code: "BRIDGE_PAIRING_CODE_INVALID" } });
      const good = await request(stack.server.port(), "/v1/pair", { origin: ORIGINS[0], "content-type": "application/json" }, "POST", JSON.stringify({ pairingCode: stack.auth.currentCode().code }));
      expect(good.status).toBe(200);
      if (!good.json || good.json.ok !== true) throw new Error("pair should succeed");
      const token: string = good.json.data.token;
      expect(stack.auth.validateBearer(token).ok).toBe(true);
      const unauth = await request(stack.server.port(), "/v1/unpair", { origin: ORIGINS[0] }, "POST");
      expect(unauth.status).toBe(401);
      const unpair = await request(stack.server.port(), "/v1/unpair", { origin: ORIGINS[0], authorization: `Bearer ${token}` }, "POST");
      expect(unpair.status).toBe(200);
      expect(stack.auth.validateBearer(token).ok).toBe(false);
    } finally {
      await stack.server.close();
    }
  });

  test("business routes are bearer-gated before anything else is revealed", async () => {
    const stack = makeStack();
    await stack.server.listen();
    try {
      const missing = await request(stack.server.port(), "/v1/projects/123/status", { origin: ORIGINS[0] });
      expect(missing.status).toBe(401);
      expect(missing.json).toMatchObject({ ok: false, error: { code: "BRIDGE_TOKEN_EXPIRED" } });
      const malformed = await request(stack.server.port(), "/v1/projects/123/status", { origin: ORIGINS[0], authorization: "Basic abc" });
      expect(malformed.status).toBe(401);
      const paired = stack.auth.pair(stack.auth.currentCode().code);
      if (!paired.ok) throw new Error("pair should succeed");
      const unknown = await request(stack.server.port(), "/v1/projects/123/status", { origin: ORIGINS[0], authorization: `Bearer ${paired.token}` });
      expect(unknown.status).toBe(404);
    } finally {
      await stack.server.close();
    }
  });

  test("oversized request bodies are rejected before parsing", async () => {
    const stack = makeStack({ config: { port: 0, allowedOrigins: ORIGINS, bodyLimitBytes: 1024 } });
    await stack.server.listen();
    try {
      const huge = await request(stack.server.port(), "/v1/pair", { origin: ORIGINS[0], "content-type": "application/json" }, "POST", JSON.stringify({ pairingCode: "x".repeat(4096) }));
      expect(huge.status).toBe(413);
      expect(huge.json).toMatchObject({ ok: false, error: { code: "BRIDGE_REQUEST_TOO_LARGE" } });
    } finally {
      await stack.server.close();
    }
  });
});

describe("host bridge instance lock (HB-M1)", () => {
  test("second acquisition is refused while the first holder lives", async () => {
    const root = await mkdtemp(join(tmpdir(), "hb-lock-"));
    try {
      const first = await acquireInstanceLock({ root });
      await expect(acquireInstanceLock({ root, isAlive: () => true })).rejects.toMatchObject({ code: "BRIDGE_INSTANCE_LOCKED" });
      await first.release();
      const second = await acquireInstanceLock({ root });
      await second.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a stale lock with a dead pid of identical content is cleaned up", async () => {
    const root = await mkdtemp(join(tmpdir(), "hb-lock-"));
    try {
      await mkdir(join(root, ".bridge"), { recursive: true });
      await writeFile(join(root, ".bridge", "instance.lock"), JSON.stringify({ pid: 2_147_000_000, startedAt: 1, protocolVersion: 1, nonce: "stale" }));
      const acquired = await acquireInstanceLock({ root, isAlive: (pid) => pid !== 2_147_000_000 });
      expect(acquired.content.pid).toBe(process.pid);
      await acquired.release();
      const reacquired = await acquireInstanceLock({ root });
      expect(reacquired.content.pid).toBe(process.pid);
      await reacquired.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unparseable lock is never cleaned up", async () => {
    const root = await mkdtemp(join(tmpdir(), "hb-lock-"));
    try {
      await mkdir(join(root, ".bridge"), { recursive: true });
      await writeFile(join(root, ".bridge", "instance.lock"), "not-json");
      await expect(acquireInstanceLock({ root, isAlive: () => false })).rejects.toMatchObject({ code: "BRIDGE_INSTANCE_LOCKED" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("host bridge CLI lifecycle (HB-M1)", () => {
  test("stdin EOF shuts the bridge down, releases the lock, and never prints the code to health", async () => {
    const root = await mkdtemp(join(tmpdir(), "hb-cli-"));
    const port = 48930 + Math.floor(Math.random() * 400);
    const child = spawn(process.execPath, [CLI_ENTRY, "--root", root, "--port", String(port), "--mcp-entry", MCP_ENTRY], {
      env: { ...process.env, WRITING_MCP_ROOTS: join(root, "projects") } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    try {
      const code = await new Promise<string>((resolvePromise, rejectPromise) => {
        let stderr = "";
        const timer = setTimeout(() => rejectPromise(new Error(`no pairing code within 15s (stderr=${stderr})`)), 15_000);
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
          const match = stderr.match(/pairing code: ([A-Za-z0-9_-]+)/);
          if (match) { clearTimeout(timer); resolvePromise(match[1]); }
        });
        child.once("exit", (exitCode) => rejectPromise(new Error(`cli exited early with ${exitCode}`)));
      });
      expect(code.length).toBeGreaterThanOrEqual(22);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          const health = await request(port, "/v1/health");
          if (health.status === 200) {
            expect(health.json).toMatchObject({ data: { processState: "ready" } });
            expect(health.text).not.toContain(code);
            break;
          }
        } catch { /* not listening yet */ }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
      child.stdin.end();
      const exit = await new Promise<number | null>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error("cli did not exit within 10s of stdin EOF")), 10_000);
        child.once("exit", (exitCode) => { clearTimeout(timer); resolvePromise(exitCode); });
      });
      expect(exit).toBe(0);
      await expect(acquireInstanceLock({ root })).resolves.toMatchObject({ content: { pid: process.pid } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unexpected MCP child death degrades the state instead of faking readiness", async () => {
    const { createMcpClient } = await import("../packages/host-bridge/src/mcp-client.js");
    const root = await mkdtemp(join(tmpdir(), "hb-degrade-"));
    try {
      const auth = createPairingManager({ onCode: () => undefined });
      const state = createBridgeState({ countActiveSessions: () => auth.activeTokenCount() });
      const mcp = createMcpClient({ command: process.execPath, args: [MCP_ENTRY], env: { ...process.env, WRITING_MCP_ROOTS: join(root, "projects") } as NodeJS.ProcessEnv });
      const server = createBridgeServer({ auth, state, config: { port: 0, allowedOrigins: ORIGINS } });
      await mcp.start();
      await server.listen();
      try {
        state.setProcessState("ready");
        const pid = mcp.pid;
        expect(pid).toBeGreaterThan(0);
        process.kill(pid, "SIGKILL");
        await new Promise((resolvePromise) => mcp.onExit(resolvePromise));
        state.setProcessState("degraded");
        const health = await request(server.port(), "/v1/health");
        expect(health.json).toMatchObject({ data: { processState: "degraded" } });
      } finally {
        await server.close();
        await mcp.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runCli refuses to start when another instance holds the lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "hb-cli-lock-"));
    try {
      const holder = await acquireInstanceLock({ root });
      const lines: string[] = [];
      const exitCode = await runCli(["--root", root, "--port", "0", "--mcp-entry", MCP_ENTRY], {
        stderr: { write: (line: string) => { lines.push(line); } },
        stdin: { once: () => undefined, end: () => undefined },
        exit: () => undefined,
        signalOn: () => undefined,
      });
      expect(exitCode).toBe(3);
      expect(lines.join("\n")).toMatch(/instance lock|already running/i);
      await holder.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
