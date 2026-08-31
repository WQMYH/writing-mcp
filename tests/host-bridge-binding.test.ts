import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { createBridgeState } from "../packages/host-bridge/src/state.js";
import { createPluginRegistry } from "../packages/host-bridge/src/plugins.js";
import { createSnapshotPipeline } from "../packages/host-bridge/src/snapshot.js";
import { createMcpClient } from "../packages/host-bridge/src/mcp-client.js";
import { createBridgeServer } from "../packages/host-bridge/src/server.js";
import { createPairingManager } from "../packages/host-bridge/src/auth.js";
import { hostPluginManifestSchema } from "@writing-mcp/host-plugin-storyforge";
import { computeContentHash } from "../packages/host-bridge-protocol/src/index.js";

const MCP_ENTRY = resolve("packages/mcp-server/dist/index.js");
const manifest = hostPluginManifestSchema.parse({
  id: "storyforge",
  apiVersion: 1,
  hostCompatibility: { bridgeProtocol: "^1" },
  minimumPermissions: ["export:snapshot", "invoke:tools", "delete:derived"],
  exportCategories: ["project", "world", "character", "outline", "chapter", "foreshadow"],
  license: "AGPL-3.0-only",
  testMatrix: { node: ["24"] },
});

const doc = (relativePath: string, content: string, category = "chapter") => ({ relativePath, category, mediaType: "text/markdown", content, sha256: computeContentHash(content) });

const canonicalDraft = () => ({
  protocolVersion: 1,
  pluginId: "storyforge",
  hostProjectId: "123",
  hostRevision: "rev-1",
  documents: [
    doc("chapters/第一章.md", "# 第一章 离乡\n\n林澈背起行囊。"),
    doc("chapters/第二章.md", "# 第二章 入门\n\n山路十八弯。"),
  ],
  chapters: [
    { chapterKey: "n:1", ordinal: 1 },
    { chapterKey: "n:2", ordinal: 2 },
  ],
  claimedSnapshotHash: "0".repeat(64),
});

describe("host bridge binding lifecycle (HB-M2)", () => {
  test("the canonical draft activates over HTTP through a real MCP stdio server and lands fresh", async () => {
    const bridgeRoot = await mkdtemp(join(tmpdir(), "hb-binding-"));
    try {
      const state = createBridgeState();
      const registry = createPluginRegistry({ bridgeRoot, state });
      await registry.register(manifest);
      const mcp = createMcpClient({ command: process.execPath, args: [MCP_ENTRY], env: { ...process.env, WRITING_MCP_ROOTS: join(bridgeRoot, "projects") } as NodeJS.ProcessEnv });
      const auth = createPairingManager({ onCode: () => undefined });
      const pipeline = createSnapshotPipeline({ bridgeRoot, registry, state, mcp });
      const server = createBridgeServer({ auth, state, pipeline, config: { port: 0, allowedOrigins: ["http://localhost:1111"] } });
      await mcp.start();
      await server.listen();
      try {
        state.setProcessState("ready");
        const paired = auth.pair(auth.currentCode().code);
        if (!paired.ok) throw new Error("pair should succeed");
        const response = await fetch(`http://127.0.0.1:${server.port()}/v1/projects/123/snapshot`, {
          method: "POST",
          headers: { origin: "http://localhost:1111", "content-type": "application/json", authorization: `Bearer ${paired.token}` },
          body: JSON.stringify(canonicalDraft()),
        });
        expect(response.status).toBe(200);
        const body = await response.json() as { ok: boolean; data: { outcome: string; bindingState: string; snapshotHash: string } };
        expect(body.ok).toBe(true);
        expect(body.data.outcome).toBe("activated");
        expect(body.data.bindingState).toBe("fresh");
        const statusResponse = await fetch(`http://127.0.0.1:${server.port()}/v1/projects/123/status`, { headers: { origin: "http://localhost:1111", authorization: `Bearer ${paired.token}` } });
        expect(statusResponse.status).toBe(200);
      } finally {
        await server.close();
        await mcp.stop();
      }
    } finally {
      await rm(bridgeRoot, { recursive: true, force: true });
    }
  });

  test("unauthenticated snapshot and status requests are refused", async () => {
    const bridgeRoot = await mkdtemp(join(tmpdir(), "hb-binding-"));
    try {
      const state = createBridgeState();
      const registry = createPluginRegistry({ bridgeRoot, state });
      await registry.register(manifest);
      const auth = createPairingManager({ onCode: () => undefined });
      const pipeline = createSnapshotPipeline({ bridgeRoot, registry, state, mcp: { callTool: async () => ({}) } });
      const server = createBridgeServer({ auth, state, pipeline, config: { port: 0, allowedOrigins: ["http://localhost:1111"] } });
      await server.listen();
      try {
        const snapshot = await fetch(`http://127.0.0.1:${server.port()}/v1/projects/123/snapshot`, {
          method: "POST",
          headers: { origin: "http://localhost:1111", "content-type": "application/json" },
          body: JSON.stringify(canonicalDraft()),
        });
        expect(snapshot.status).toBe(401);
        const status = await fetch(`http://127.0.0.1:${server.port()}/v1/projects/123/status`, { headers: { origin: "http://localhost:1111" } });
        expect(status.status).toBe(401);
        const badId = await fetch(`http://127.0.0.1:${server.port()}/v1/projects/%2E%2E%2Fevil/status`, { headers: { origin: "http://localhost:1111" } });
        expect(badId.status).toBe(401);
      } finally {
        await server.close();
      }
    } finally {
      await rm(bridgeRoot, { recursive: true, force: true });
    }
  });

  test("the binding manifest is written last: a failed activation never overwrites an existing one", async () => {
    const bridgeRoot = await mkdtemp(join(tmpdir(), "hb-binding-"));
    try {
      const state = createBridgeState();
      const registry = createPluginRegistry({ bridgeRoot, state });
      await registry.register(manifest);
      let resolveCalls = 0;
      const mcp = {
        callTool: async (name: string) => {
          if (name === "writing_resolve") {
            resolveCalls += 1;
            if (resolveCalls > 1) throw new Error("mcp died");
            return { structuredContent: { result: { ok: true, data: { status: "resolved", workRef: "work-1", candidates: [], diagnostics: [] }, diagnostic: {} } } };
          }
          return { structuredContent: { result: { ok: true, data: { workRef: "work-1", revision: 1, schemaVersion: 4, freshness: "fresh", stats: {} }, diagnostic: {} } } };
        },
      };
      const pipeline = createSnapshotPipeline({ bridgeRoot, registry, state, mcp });
      await pipeline.activate("123", "http://localhost:1111", canonicalDraft());
      const projectKey = pipeline.projectKey("123", "http://localhost:1111");
      const manifestPath = join(bridgeRoot, "projects", projectKey, ".bridge", "manifest.json");
      const before = await readFile(manifestPath, "utf8");
      expect((await pipeline.activate("123", "http://localhost:1111", canonicalDraft())).outcome).toBe("noop");
      const differentDraft = { ...canonicalDraft(), documents: [doc("chapters/第三章.md", "# 第三章", "chapter")], chapters: [{ chapterKey: "n:3", ordinal: 1 }] };
      await expect(pipeline.activate("123", "http://localhost:1111", differentDraft)).rejects.toMatchObject({ code: "BRIDGE_SNAPSHOT_ACTIVATION_FAILED" });
      expect(await readFile(manifestPath, "utf8")).toBe(before);
    } finally {
      await rm(bridgeRoot, { recursive: true, force: true });
    }
  });
});
