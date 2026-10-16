import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { computeContentHash, computeProjectKey, computeSnapshotHash } from "../packages/host-bridge-protocol/src/index.js";

const MCP_ENTRY = resolve("packages/mcp-server/dist/index.js");
const CLI_ENTRY = resolve("packages/host-bridge/dist/cli.js");
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
  const child = spawn(process.execPath, [CLI_ENTRY, ...argv], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stderr.on("data", chunk => lines.push(String(chunk)));
  const exited = new Promise<number>((done, reject) => { child.once("exit", code => done(code ?? -1)); child.once("error", reject); });
  const port = Number(/--port\D*(\d+)/.exec(argv.join(" "))?.[1] ?? 0);
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;
  const handle: BootHandle = {
    port,
    lines,
    pairingCode(): string {
      const code = [...lines.join("").matchAll(/pairing code: (\S+)/g)].at(-1)?.[1];
      if (code === undefined) throw new Error(`no pairing code printed yet: ${lines.join("")}`);
      return code;
    },
    request: (path: string, init?: RequestInit) => probe(url(path), init),
    async waitForExit(): Promise<number> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([exited, new Promise<number>(done => { timer = setTimeout(() => done(-1), 8_000); })]); }
      finally { if (timer) clearTimeout(timer); }
    },
    async waitReady(): Promise<void> {
      const deadline = Date.now() + 20_000;
      for (;;) {
        if (child.exitCode !== null) throw new Error(`CLI exited before ready (${child.exitCode}): ${lines.join("")}`);
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
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
      return handle.waitForExit();
    },
  };
  booted.push(handle);
  return handle;
}

function bootArgv(root: string, port: number, hostOrigins: string[], mcpEntry = MCP_ENTRY): string[] {
  return [
    "--root", root, "--port", String(port), "--mcp-entry", mcpEntry,
    ...hostOrigins.flatMap(origin => ["--host-origin", origin]),
  ];
}

describe("host bridge boot wiring (HB-M5)", () => {
  test.each(["bridge", "mcp"] as const)("first correlated call after %s restart recovers the work registry, not missing or closed captures (W-MCP-019)", async restart => {
    const root = await mkdtemp(join(tmpdir(), "hb-capture-restart-")), origin = DEV_ORIGINS[0]!;
    const entry = join(root, "mcp-pid.mjs"), pidPath = join(root, "mcp.pid");
    await writeFile(entry, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidPath)},String(process.pid));await import(${JSON.stringify(pathToFileURL(MCP_ENTRY).href)});`);
    let handle = await boot(bootArgv(root, await freePort(), [origin], entry));
    const pair = async () => {
      await handle.waitReady();
      const paired = await handle.request("/v1/pair", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ pairingCode: handle.pairingCode() }) });
      expect(paired.status).toBe(200);
      return { origin, "content-type": "application/json", authorization: `Bearer ${String((paired.json.data as { token: string }).token)}` };
    };
    let headers = await pair();
    const tool = async (operation: string, args: Record<string, unknown>, project = "captured") => {
      const response = await handle.request(`/v1/projects/${project}/${operation}`, { method: "POST", headers, body: JSON.stringify({ protocolVersion: 1, arguments: args }) });
      expect(response.status).toBe(200);
      return response.json.data as { ok: boolean; data?: Record<string, unknown>; error?: { code: string }; diagnostic?: { persistence: string } };
    };
    try {
      const content = "# First chapter\nScout returns.", documents = [{ relativePath: "chapters/one.md", category: "chapter", mediaType: "text/markdown", content, sha256: computeContentHash(content) }];
      for (const project of ["captured", "other"]) {
        expect((await handle.request(`/v1/projects/${project}/snapshot`, { method: "POST", headers, body: JSON.stringify({ protocolVersion: 1, pluginId: "storyforge", hostProjectId: project, documents, chapters: [{ chapterKey: "n:1", ordinal: 1 }], claimedSnapshotHash: computeSnapshotHash(1, documents as never) }) })).status).toBe(200);
      }
      const started = await tool("diagnose", { action: "start_capture", purpose: "development" });
      expect(started.ok).toBe(true);
      const diagnosticRunRef = started.data!.diagnosticRunRef;
      const oldPid = Number(await readFile(pidPath, "utf8"));
      expect(Number.isInteger(oldPid) && oldPid > 0).toBe(true);
      expect(await tool("explore", { operation: "search", query: "Scout", diagnosticRunRef }, "other")).toMatchObject({ ok: false, error: { code: "DIAGNOSTIC_RUN_NOT_FOUND" } });
      expect(Number(await readFile(pidPath, "utf8"))).toBe(oldPid);
      const restartChild = async () => {
        if (restart === "bridge") {
          expect(await handle.shutdown()).toBe(0);
          handle = await boot(bootArgv(root, await freePort(), [origin], entry));
          headers = await pair();
        } else {
          expect((await handle.request("/v1/projects/other/derived-data", { method: "DELETE", headers })).status).toBe(200);
        }
      };
      await restartChild();
      expect(() => process.kill(oldPid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
      const explored = await tool("explore", { operation: "search", query: "Scout", diagnosticRunRef });
      expect(explored).toMatchObject({ ok: true, diagnostic: { persistence: "persisted" } });
      expect(JSON.stringify(explored.data)).toContain("Scout returns");
      // A second restart makes finish_capture itself the first correlated call.
      if (restart === "mcp") {
        // The deleted unrelated project is reactivated before the next maintenance restart.
        expect((await handle.request("/v1/projects/other/snapshot", { method: "POST", headers, body: JSON.stringify({ protocolVersion: 1, pluginId: "storyforge", hostProjectId: "other", documents, chapters: [{ chapterKey: "n:1", ordinal: 1 }], claimedSnapshotHash: computeSnapshotHash(1, documents as never) }) })).status).toBe(200);
      }
      await restartChild();
      const finished = await tool("diagnose", { action: "finish_capture", purpose: "development", diagnosticRunRef });
      expect(finished).toMatchObject({ ok: true, data: { diagnosticRunRef, calls: 1 } });
      const currentPid = Number(await readFile(pidPath, "utf8"));
      expect(Number.isInteger(currentPid) && currentPid > 0).toBe(true);
      expect(await tool("explore", { operation: "search", query: "Scout", diagnosticRunRef })).toMatchObject({ ok: false, error: { code: "DIAGNOSTIC_RUN_CLOSED" } });
      expect(await tool("explore", { operation: "search", query: "Scout", diagnosticRunRef: "diag-" + "0".repeat(24) })).toMatchObject({ ok: false, error: { code: "DIAGNOSTIC_RUN_NOT_FOUND" } });
      expect(Number(await readFile(pidPath, "utf8"))).toBe(currentPid);
      expect(await handle.shutdown()).toBe(0);
      expect(() => process.kill(currentPid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
      expect(existsSync(join(root, ".bridge", "instance.lock"))).toBe(false);
    } finally { await handle.shutdown(); await rm(root, { recursive: true, force: true }); }
  }, 35_000);

  test("real CLI refuses to delete a captured project, permits an unrelated project, then permits the closed capture (W-MCP-017)", async () => {
    const root = await mkdtemp(join(tmpdir(), "hb-cli-capture-")), origin = DEV_ORIGINS[0]!;
    const entry = join(root, "mcp-pid.mjs"), pidPath = join(root, "mcp.pid");
    await writeFile(entry, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidPath)},String(process.pid));await import(${JSON.stringify(pathToFileURL(MCP_ENTRY).href)});`);
    const handle = await boot(bootArgv(root, await freePort(), [origin], entry));
    try {
      await handle.waitReady();
      const paired = await handle.request("/v1/pair", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ pairingCode: handle.pairingCode() }) });
      expect(paired.status).toBe(200);
      const headers = { origin, "content-type": "application/json", authorization: `Bearer ${String((paired.json.data as { token: string }).token)}` };
      const content = "# First chapter\nScout enters.", documents = [{ relativePath: "chapters/one.md", category: "chapter", mediaType: "text/markdown", content, sha256: computeContentHash(content) }];
      for (const project of ["captured", "other"]) {
        const snapshot = await handle.request(`/v1/projects/${project}/snapshot`, { method: "POST", headers, body: JSON.stringify({ protocolVersion: 1, pluginId: "storyforge", hostProjectId: project, documents, chapters: [{ chapterKey: "n:1", ordinal: 1 }], claimedSnapshotHash: computeSnapshotHash(1, documents as never) }) });
        expect(snapshot.status).toBe(200);
      }
      const tool = async (args: Record<string, unknown>) => {
        const response = await handle.request("/v1/projects/captured/diagnose", { method: "POST", headers, body: JSON.stringify({ protocolVersion: 1, arguments: args }) });
        expect(response.status).toBe(200);
        return response.json.data as { ok: boolean; data: Record<string, unknown> };
      };
      const first = await tool({ action: "start_capture", purpose: "development" }), second = await tool({ action: "start_capture", purpose: "development" });
      expect(first.ok && second.ok).toBe(true);
      const projectDir = join(root, "projects", computeProjectKey("storyforge", origin, "captured"));
      const denied = await handle.request("/v1/projects/captured/derived-data", { method: "DELETE", headers });
      expect(denied).toMatchObject({ status: 409, code: "DERIVED_DATA_BUSY" });
      expect(await readFile(join(projectDir, "source", "chapters", "one.md"), "utf8")).toBe(content);
      expect(existsSync(join(projectDir, ".writing-index"))).toBe(true);
      expect((await tool({ purpose: "development", limit: 1 })).data.activeCaptureCount).toBe(2);
      const oldPid = Number(await readFile(pidPath, "utf8"));
      expect(Number.isInteger(oldPid) && oldPid > 0).toBe(true);
      expect((await handle.request("/v1/projects/other/derived-data", { method: "DELETE", headers })).status).toBe(200);
      expect(() => process.kill(oldPid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
      expect((await tool({ purpose: "development", limit: 1 })).data.activeCaptureCount).toBe(2);
      expect((await tool({ action: "finish_capture", purpose: "development", diagnosticRunRef: first.data.diagnosticRunRef })).ok).toBe(true);
      expect((await handle.request("/v1/projects/captured/derived-data", { method: "DELETE", headers })).code).toBe("DERIVED_DATA_BUSY");
      expect((await tool({ action: "finish_capture", purpose: "development", diagnosticRunRef: second.data.diagnosticRunRef })).ok).toBe(true);
      expect((await handle.request("/v1/projects/captured/derived-data", { method: "DELETE", headers })).status).toBe(200);
      expect(existsSync(projectDir)).toBe(false);
      const lastPid = Number(await readFile(pidPath, "utf8"));
      expect(Number.isInteger(lastPid) && lastPid > 0).toBe(true);
      expect(await handle.shutdown()).toBe(0);
      expect(() => process.kill(lastPid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
      expect(existsSync(join(root, ".bridge", "instance.lock"))).toBe(false);
    } finally { await handle.shutdown(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);

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
