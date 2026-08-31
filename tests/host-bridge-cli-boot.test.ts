import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { runCli, type CliIo } from "../packages/host-bridge/src/cli.js";

const MCP_ENTRY = resolve("packages/mcp-server/dist/index.js");
const DEV_ORIGINS = ["http://127.0.0.1:1111", "http://localhost:1111"];

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((open) => probe.listen(0, "127.0.0.1", open));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((closed) => probe.close(() => closed()));
  return port;
}

interface BootHandle {
  port: number;
  lines: string[];
  pairingCode(): string;
  request(path: string, init?: RequestInit): Promise<{ status: number; code: string | undefined; json: Record<string, unknown> }>;
  waitReady(): Promise<void>;
  waitForExit(): Promise<number>;
  shutdown(): Promise<number>;
}

const booted: BootHandle[] = [];
afterEach(async () => {
  for (const handle of booted.splice(0)) await handle.shutdown();
});

async function probe(path: string, init: RequestInit = {}): Promise<{ status: number; code: string | undefined; json: Record<string, unknown> }> {
  const response = await fetch(path, init);
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = {}; }
  const error = json.error as { code?: string } | undefined;
  return { status: response.status, code: error?.code, json };
}

async function boot(argv: string[]): Promise<BootHandle> {
  const lines: string[] = [];
  const signals = new Map<string, () => void>();
  let resolveExit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((done) => { resolveExit = done; });
  const io: CliIo = {
    stderr: { write: (line: string) => { lines.push(line); return true; } },
    stdin: { once: () => undefined, resume: () => undefined },
    exit: (code: number) => resolveExit(code),
    signalOn: (event: string, listener: () => void) => signals.set(event, listener),
  };
  void runCli(argv, io).catch(() => undefined);
  const port = Number(/--port\D*(\d+)/.exec(argv.join(" "))?.[1] ?? 0);
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;
  const handle: BootHandle = {
    port,
    lines,
    pairingCode(): string {
      const printed = lines.map(line => /pairing code: (\S+)/.exec(line)?.[1]).filter((x): x is string => x !== undefined);
      const code = printed.at(-1);
      if (code === undefined) throw new Error(`no pairing code printed yet: ${lines.join("")}`);
      return code;
    },
    request: (path: string, init?: RequestInit) => probe(url(path), init),
    waitForExit(): Promise<number> {
      return Promise.race([exited, new Promise<number>((done) => setTimeout(() => done(-1), 8_000))]);
    },
    async waitReady(): Promise<void> {
      const deadline = Date.now() + 20_000;
      for (;;) {
        try {
          const health = await handle.request("/v1/health");
          if (health.status === 200) return;
        } catch {
          // not listening yet
        }
        if (Date.now() > deadline) throw new Error(`bridge never became ready on ${port}: ${lines.join("")}`);
        await new Promise<void>((done) => setTimeout(done, 25));
      }
    },
    async shutdown(): Promise<number> {
      signals.get("SIGINT")?.();
      return handle.waitForExit();
    },
  };
  booted.push(handle);
  return handle;
}

function bootArgv(root: string, port: number, hostOrigins: string[]): string[] {
  return [
    "--root", root, "--port", String(port), "--mcp-entry", MCP_ENTRY,
    ...hostOrigins.flatMap(origin => ["--host-origin", origin]),
  ];
}

describe("host bridge boot wiring (HB-M5)", () => {
  test("serves only the loopback dev origins passed as host origins", async () => {
    const root = await mkdtemp(join(tmpdir(), "hb-boot-origins-"));
    const port = await freePort();
    try {
      const handle = await boot(bootArgv(root, port, DEV_ORIGINS));
      await handle.waitReady();
      const paired = await handle.request("/v1/pair", {
        method: "POST",
        headers: { origin: DEV_ORIGINS[0], "content-type": "application/json" },
        body: JSON.stringify({ pairingCode: handle.pairingCode() }),
      });
      expect(paired.status).toBe(200);
      expect(typeof (paired.json.data as { token: unknown }).token).toBe("string");
      const foreign = await handle.request("/v1/pair", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:9999", "content-type": "application/json" },
        body: JSON.stringify({ pairingCode: handle.pairingCode() }),
      });
      expect(foreign.status).toBe(403);
      expect(foreign.code).toBe("BRIDGE_ORIGIN_DENIED");
      expect(await handle.shutdown()).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("registers the frozen storyforge plugin at boot so project routes are not disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "hb-boot-plugin-"));
    const port = await freePort();
    try {
      const handle = await boot(bootArgv(root, port, [DEV_ORIGINS[0]]));
      await handle.waitReady();
      const paired = await handle.request("/v1/pair", {
        method: "POST",
        headers: { origin: DEV_ORIGINS[0], "content-type": "application/json" },
        body: JSON.stringify({ pairingCode: handle.pairingCode() }),
      });
      expect(paired.status).toBe(200);
      const snapshot = await handle.request("/v1/projects/hb-m5-boot/snapshot", {
        method: "POST",
        headers: { origin: DEV_ORIGINS[0], "content-type": "application/json", authorization: `Bearer ${String((paired.json.data as { token: string }).token)}` },
        body: "{}",
      });
      expect(snapshot.code).not.toBe("BRIDGE_PLUGIN_DISABLED");
      expect(snapshot.code).toBe("BRIDGE_SNAPSHOT_INVALID");
      expect(await handle.shutdown()).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a wildcard or non-loopback host origin instead of opening the bridge", async () => {
    for (const origin of ["*", "http://evil.example", "https://127.0.0.1:1111", "http://127.0.0.1:1111/storyforge"]) {
      const root = await mkdtemp(join(tmpdir(), "hb-boot-bad-origin-"));
      const port = await freePort();
      try {
        const handle = await boot(bootArgv(root, port, [origin]));
        expect(await handle.shutdown()).toBe(2);
        expect(handle.lines.join("")).toMatch(/--host-origin must be/i);
        await expect(probe(`http://127.0.0.1:${port}/v1/health`)).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 60_000);
});
