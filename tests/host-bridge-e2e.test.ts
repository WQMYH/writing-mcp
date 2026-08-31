import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { createBridgeState } from "../packages/host-bridge/src/state.js";
import { createPluginRegistry } from "../packages/host-bridge/src/plugins.js";
import { createSnapshotPipeline } from "../packages/host-bridge/src/snapshot.js";
import { createRestartableMcpClient, type RestartableMcpClient } from "../packages/host-bridge/src/mcp-client.js";
import { createBridgeServer, type BridgeServer } from "../packages/host-bridge/src/server.js";
import { createPairingManager } from "../packages/host-bridge/src/auth.js";
import { createProjectToolProxy } from "../packages/host-bridge/src/tool-proxy.js";
import { storyforgePluginManifest } from "@writing-mcp/host-plugin-storyforge";
import { computeContentHash, computeSnapshotHash } from "../packages/host-bridge-protocol/src/index.js";

const MCP_ENTRY = resolve("packages/mcp-server/dist/index.js");
const ORIGIN = "http://127.0.0.1:1111";
const PROJECT = "hb-m6-project";

const doc = (relativePath: string, category: string, content: string) => ({
  relativePath, category, mediaType: "text/markdown", content, sha256: computeContentHash(content),
});

const CHAPTERS = [
  { chapterKey: "n:1", ordinal: 1 },
  { chapterKey: "n:2", ordinal: 2 },
];

function documents(marker: string) {
  return [
    doc("project/story-core.md", "project", "# 故事核心\n\n主角要找回失落的剑印，marker=" + marker),
    doc("world/qingyun.md", "world", "# 青云宗\n\n青云宗坐落在苍梧山脉，掌管剑印大典。"),
    doc("character/linche.md", "character", "# 林澈\n\n林澈是青云宗外门弟子，佩一把缺口的青锋剑。"),
    doc("outline/volume-one.md", "outline", "# 第一卷 离乡\n\n林澈在剑印大典前夜下山。"),
    doc("chapters/第一章-离乡.md", "chapter", "# 第一章 离乡\n\n林澈背起行囊，青锋剑在鞘中低鸣。他答应过师父，剑印现世之前不回青云宗。"),
    doc("chapters/第二章-入门.md", "chapter", "# 第二章 入门\n\n苍梧山的雪线下埋着旧剑痕。林澈第一次听见剑印的震动。"),
    doc("foreshadow/sword-seal.md", "foreshadow", "# 剑印\n\n剑印每六十年震动一次，听到震动的人活不过那年冬天。"),
  ];
}

function draft(hostProjectId: string, docs: ReturnType<typeof documents>) {
  return {
    protocolVersion: 1,
    pluginId: "storyforge",
    hostProjectId,
    documents: docs,
    chapters: CHAPTERS,
    claimedSnapshotHash: computeSnapshotHash(1, docs as never),
  };
}

interface Envelope {
  status: number;
  ok: boolean;
  data?: Record<string, unknown>;
  inner?: Record<string, unknown>;
  code?: string;
  text: string;
}

interface Stack {
  server: BridgeServer;
  mcp: RestartableMcpClient;
  url(path: string): string;
  call(method: string, path: string, options?: { body?: unknown; token?: string | null; origin?: string | null }): Promise<Envelope>;
  tool(operation: string, args: Record<string, unknown>, token?: string): Promise<Envelope>;
  token: string;
  close(): Promise<void>;
}

async function openStack(bridgeRoot: string, options: { restore?: boolean } = {}): Promise<Stack> {
  const state = createBridgeState();
  const registry = createPluginRegistry({ bridgeRoot, state });
  await registry.register(storyforgePluginManifest);
  const auth = createPairingManager({ onCode: () => undefined });
  const mcp = createRestartableMcpClient({
    command: process.execPath,
    args: [MCP_ENTRY],
    env: { ...process.env, WRITING_MCP_ROOTS: join(bridgeRoot, "projects") } as NodeJS.ProcessEnv,
  });
  const pipeline = createSnapshotPipeline({ bridgeRoot, registry, state, mcp, mcpMaintenance: mcp });
  if (options.restore) await pipeline.restoreFromManifests();
  const toolProxy = createProjectToolProxy({ bridgeRoot, mcp, pipeline, isPluginAvailable: () => registry.isAvailable() });
  const server = createBridgeServer({ auth, state, pipeline, toolProxy, config: { port: 0, allowedOrigins: [ORIGIN] } });
  await mcp.start();
  await server.listen();
  state.setProcessState("ready");
  const paired = auth.pair(auth.currentCode().code);
  if (!paired.ok) throw new Error("pairing should succeed at boot");
  const active = paired.token;

  const stack: Stack = {
    server,
    mcp,
    token: active,
    url: (path) => `http://127.0.0.1:${server.port()}${path}`,
    async call(method, path, options = {}) {
      const headers: Record<string, string> = {};
      if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
      if (options.body !== undefined) headers["content-type"] = "application/json";
      const bearer = options.token === null ? undefined : options.token ?? active;
      if (bearer) headers.authorization = `Bearer ${bearer}`;
      const request: RequestInit = { method, headers };
      if (options.body !== undefined && method !== "GET" && method !== "HEAD") request.body = JSON.stringify(options.body);
      const response = await fetch(stack.url(path), request);
      const text = await response.text();
      let parsed: { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string } } = {};
      try { parsed = JSON.parse(text) as typeof parsed; } catch { parsed = {}; }
      const bridgeData = parsed.data;
      const isToolEnvelope = Boolean(bridgeData && typeof bridgeData === "object" && "ok" in bridgeData && bridgeData.data && typeof bridgeData.data === "object");
      return {
        status: response.status,
        ok: parsed.ok === true,
        data: bridgeData,
        inner: isToolEnvelope ? (bridgeData as { data: Record<string, unknown> }).data : undefined,
        code: parsed.error?.code,
        text,
      };
    },
    tool: (operation, args, bearer) => stack.call("POST", `/v1/projects/${PROJECT}/${operation}`, { body: { protocolVersion: 1, arguments: args }, token: bearer }),
    async close() {
      await server.close();
      await mcp.stop();
    },
  };
  return stack;
}

describe("host bridge M5 acceptance chain (HB-M6)", () => {
  test("pairs, snapshots, runs the five tools, survives restart, rolls back, deletes derived data and rebuilds", async () => {
    const bridgeRoot = await mkdtemp(join(tmpdir(), "hb-e2e-"));
    let stack = await openStack(bridgeRoot, { restore: true });
    const first = documents("snapshot-one");
    let activatedHash = "";
    try {
      // 1-2 startup and pairing over the frozen loopback surface
      const health = await stack.call("GET", "/v1/health", { origin: null });
      expect(health.data).toMatchObject({ processState: "ready", requiresPairing: false });
      expect((await stack.call("GET", "/v1/health")).code).toBeUndefined();
      expect((await stack.call("POST", "/v1/pair", { body: { pairingCode: "replayed" } })).code).toBe("BRIDGE_PAIRING_CODE_INVALID");

      // 3 consistent snapshot: activate then no-op
      const activated = await stack.call("POST", `/v1/projects/${PROJECT}/snapshot`, { body: draft(PROJECT, first) });
      expect(activated.ok).toBe(true);
      expect(activated.data).toMatchObject({ outcome: "activated", bindingState: "fresh" });
      activatedHash = String(activated.data?.snapshotHash);
      expect(activatedHash).toBe(computeSnapshotHash(1, first as never));
      expect((await stack.call("POST", `/v1/projects/${PROJECT}/snapshot`, { body: draft(PROJECT, first) })).data).toMatchObject({ outcome: "noop" });

      // 4 resolve and index against the bridge-owned derived directory
      const resolved = await stack.tool("resolve", { sourcePath: "C:/Windows" });
      expect(resolved).toMatchObject({ status: 200, ok: true, inner: { status: "resolved" } });
      const workRef = String(resolved.inner?.workRef);
      expect(workRef).toMatch(/^work:/);
      const indexed = await stack.tool("index", { mode: "status" });
      expect(indexed.inner).toMatchObject({ freshness: "fresh", schemaVersion: 4 });
      expect(indexed.inner?.workRef).toBe(workRef);
      for (const envelope of [resolved, indexed]) {
        expect(envelope.text).not.toContain(bridgeRoot);
        expect(envelope.text).not.toMatch(/[A-Za-z]:[\\/]/);
      }

      // 5 explore / context / diagnose through the shared stdio child
      const explored = await stack.tool("explore", { operation: "search", query: "剑印大典", limit: 5 });
      expect(explored.ok).toBe(true);
      expect(JSON.stringify(explored.inner)).toContain("青云宗");
      const packet = await stack.tool("context", { query: "青锋剑 剑印大典", budgetTokens: 4000 });
      expect(packet.ok).toBe(true);
      const packetJson = JSON.stringify(packet.inner);
      expect(packetJson).toContain("青锋剑");
      expect(packetJson).toMatch(/evidence_excerpts_only/);
      const diagnosed = await stack.tool("diagnose", {});
      expect(diagnosed.ok).toBe(true);
      expect(diagnosed.inner).toBeDefined();
      for (const envelope of [explored, packet, diagnosed]) {
        expect(envelope.text).not.toContain(bridgeRoot);
        expect(envelope.text).not.toMatch(/[A-Za-z]:[\\/]/);
      }

      // 6 章节注入载荷：document 取回正文，context 包内同一摘录不重复出现
      const chapter = await stack.tool("explore", { operation: "document", query: "chapters/第一章-离乡.md" });
      expect(chapter.ok).toBe(true);
      expect(JSON.stringify(chapter.inner)).toContain("青锋剑在鞘中低鸣");
      const anchored = await stack.tool("context", { query: "第一章 离乡 青锋剑", budgetTokens: 4000 });
      expect(anchored.ok).toBe(true);
      expect((JSON.stringify(anchored.inner).split("青锋剑在鞘中低鸣").length - 1)).toBeLessThanOrEqual(1);

      // 7-8 MCP restart: the same bridgeRoot reloads as a stale candidate and re-activates
      await stack.close();
      stack = await openStack(bridgeRoot, { restore: true });
      expect((await stack.call("GET", `/v1/projects/${PROJECT}/status`)).data).toMatchObject({ bindingState: "stale", snapshotHash: activatedHash });
      expect((await stack.call("POST", `/v1/projects/${PROJECT}/snapshot`, { body: draft(PROJECT, first) })).data).toMatchObject({ outcome: "activated", bindingState: "fresh" });
      expect(JSON.stringify((await stack.tool("explore", { operation: "search", query: "苍梧山", limit: 5 })).data)).toContain("第二章");

      // 9 a failed activation rolls back to the previous snapshot
      await stack.mcp.stop();
      const broken = await stack.call("POST", `/v1/projects/${PROJECT}/snapshot`, { body: draft(PROJECT, documents("snapshot-two")) });
      expect(broken.status).toBe(500);
      expect(broken.code).toBe("BRIDGE_SNAPSHOT_ACTIVATION_FAILED");
      await stack.server.close();
      stack = await openStack(bridgeRoot, { restore: true });
      const afterRollback = await stack.call("GET", `/v1/projects/${PROJECT}/status`);
      expect(afterRollback.data).toMatchObject({ bindingState: "stale", snapshotHash: activatedHash });
      expect(afterRollback.data?.snapshotHash).not.toBe(computeSnapshotHash(1, documents("snapshot-two") as never));
      expect((await stack.call("POST", `/v1/projects/${PROJECT}/snapshot`, { body: draft(PROJECT, first) })).data).toMatchObject({ outcome: "activated" });

      // 10 deleting derived data blocks tool calls until a fresh snapshot
      const deleted = await stack.call("DELETE", `/v1/projects/${PROJECT}/derived-data`);
      expect(deleted).toMatchObject({ status: 200, ok: true, data: { bindingState: "empty" } });
      const blocked = await stack.tool("context", { query: "林澈", budgetTokens: 4000 });
      expect(blocked.code).toBe("BRIDGE_BINDING_DEGRADED");
      expect((await stack.call("GET", `/v1/projects/${PROJECT}/status`)).data).toMatchObject({ bindingState: "empty" });

      // 11-12 re-snapshot and rebuild restores retrieval
      expect((await stack.call("POST", `/v1/projects/${PROJECT}/snapshot`, { body: draft(PROJECT, first) })).data).toMatchObject({ outcome: "activated", bindingState: "fresh" });
      expect(JSON.stringify((await stack.tool("explore", { operation: "search", query: "青锋剑", limit: 5 })).inner)).toContain("第一章");

      // 12b 治理：派生写入只允许出现在授权根与暂存目录内
      const allowed = new Set([".bridge", ".staging", "projects"]);
      const entries = (await readdir(bridgeRoot)).sort();
      expect(entries.every(entry => allowed.has(entry))).toBe(true);
      expect(entries).toContain("projects");
      for (const key of await readdir(join(bridgeRoot, ".staging"))) {
        expect((await readdir(join(bridgeRoot, ".staging", key))).length).toBe(0);
      }
      const projectKey = (await readdir(join(bridgeRoot, "projects")))[0];
      expect((await readdir(join(bridgeRoot, "projects", projectKey))).sort()).toEqual([".bridge", ".writing-index", "source"]);
    } finally {
      await stack.close();
      await rm(bridgeRoot, { recursive: true, force: true });
    }
  }, 180_000);

  test("refuses every unauthenticated path before touching plugin, snapshot or MCP state", async () => {
    const bridgeRoot = await mkdtemp(join(tmpdir(), "hb-e2e-auth-"));
    const stack = await openStack(bridgeRoot, { restore: true });
    try {
      const paths: Array<[string, string, unknown]> = [
        ["GET", `/v1/projects/${PROJECT}/status`, undefined],
        ["POST", `/v1/projects/${PROJECT}/snapshot`, draft(PROJECT, documents("no-auth"))],
        ["POST", `/v1/projects/${PROJECT}/explore`, { protocolVersion: 1, arguments: { operation: "stats" } }],
        ["DELETE", `/v1/projects/${PROJECT}/derived-data`, undefined],
      ];
      for (const [method, path, body] of paths) {
        expect(await stack.call(method, path, { token: null, body })).toMatchObject({ status: 401, code: "BRIDGE_TOKEN_EXPIRED" });
        expect(await stack.call(method, path, { origin: "http://evil.example", body })).toMatchObject({ status: 403, code: "BRIDGE_ORIGIN_DENIED" });
      }
      expect((await stack.call("GET", `/v1/projects/../status`, { token: null })).status).toBeLessThan(500);
      expect((await stack.call("POST", `/v1/projects/${encodeURIComponent("a".repeat(300))}/status`)).code).toBe("BRIDGE_PROJECT_ID_INVALID");
    } finally {
      await stack.close();
      await rm(bridgeRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
