import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createBridgeState } from "../packages/host-bridge/src/state.js";
import { createPluginRegistry } from "../packages/host-bridge/src/plugins.js";
import { createSnapshotPipeline } from "../packages/host-bridge/src/snapshot.js";
import { hostPluginManifestSchema } from "@writing-mcp/host-plugin-storyforge";
import { computeContentHash, computeSnapshotHash } from "../packages/host-bridge-protocol/src/index.js";

const manifest = hostPluginManifestSchema.parse({
  id: "storyforge",
  apiVersion: 1,
  hostCompatibility: { bridgeProtocol: "^1" },
  minimumPermissions: ["export:snapshot", "invoke:tools", "delete:derived"],
  exportCategories: ["project", "world", "character", "outline", "chapter", "foreshadow"],
  license: "AGPL-3.0-only",
  testMatrix: { node: ["24"], platforms: ["win32"] },
});

const doc = (relativePath: string, content: string, category = "project") => ({ relativePath, category, mediaType: "text/markdown", content, sha256: computeContentHash(content) });
const draft = (documents: unknown[], chapters: Array<{ chapterKey: string; ordinal: number }> = []) => ({
  protocolVersion: 1,
  pluginId: "storyforge",
  hostProjectId: "123",
  documents,
  chapters,
  claimedSnapshotHash: computeContentHash("ignored"),
});

interface StubMcp {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  freshnessQueue: Array<"fresh" | "stale" | "missing" | "incompatible">;
  failResolve?: boolean;
  callTool(name: string, args: unknown): Promise<unknown>;
}

function stubMcp(overrides: Partial<StubMcp> = {}): StubMcp {
  const stub: StubMcp = { calls: [], freshnessQueue: ["missing", "fresh"], ...overrides };
  stub.callTool = async (name: string, args: unknown) => {
    const record = args as Record<string, unknown>;
    stub.calls.push({ name, args: record });
    if (name === "writing_resolve") {
      if (stub.failResolve) throw new Error("mcp down");
      return { structuredContent: { result: { ok: true, data: { status: "resolved", workRef: "work-1", candidates: [], diagnostics: [] }, diagnostic: {} } } };
    }
    if (name === "writing_index") {
      const freshness = stub.freshnessQueue.shift() ?? "fresh";
      return { structuredContent: { result: { ok: true, data: { workRef: record.workRef, revision: stub.calls.length, schemaVersion: 4, freshness, stats: {} }, diagnostic: {} } } };
    }
    return { structuredContent: { result: { ok: true, data: {}, diagnostic: {} } } };
  };
  return stub;
}

async function makeStack(overrides: Record<string, unknown> = {}) {
  const bridgeRoot = await mkdtemp(join(tmpdir(), "hb-snap-"));
  const state = createBridgeState();
  const registry = createPluginRegistry({ bridgeRoot, state });
  await registry.register(manifest);
  const mcp = stubMcp();
  const pipeline = createSnapshotPipeline({ bridgeRoot, registry, state, mcp, ...overrides });
  return { bridgeRoot, state, registry, mcp, pipeline, async cleanup() { await rm(bridgeRoot, { recursive: true, force: true }); } };
}

describe("host bridge snapshot transaction (HB-M2)", () => {
  test("activates a snapshot: writes source, resolves and indexes, records a fresh binding", async () => {
    const stack = await makeStack();
    try {
      const result = await stack.pipeline.activate("123", "http://localhost:1111", draft([doc("project/story-core.md", "# 核心")]));
      expect(result).toMatchObject({ outcome: "activated", bindingState: "fresh" });
      expect(result.snapshotHash).toBe(computeSnapshotHash(1, [doc("project/story-core.md", "# 核心") as never]));
      expect(stack.mcp.calls.map((call) => call.name)).toEqual(["writing_resolve", "writing_index", "writing_index"]);
      expect(stack.mcp.calls[0]).toMatchObject({ name: "writing_resolve", args: { adapterHint: "generic" } });
      const projectKey = stack.pipeline.projectKey("123", "http://localhost:1111");
      const written = await readFile(join(stack.bridgeRoot, "projects", projectKey, "source", "project", "story-core.md"), "utf8");
      expect(written).toBe("# 核心");
      const binding = JSON.parse(await readFile(join(stack.bridgeRoot, "projects", projectKey, ".bridge", "manifest.json"), "utf8"));
      expect(binding).toMatchObject({ pluginId: "storyforge", hostProjectId: "123", projectKey, snapshotHash: result.snapshotHash, workRef: "work-1", manifestSchemaVersion: 1, bindingState: "fresh" });
      expect(typeof binding.indexRevision).toBe("number");
    } finally {
      await stack.cleanup();
    }
  });

  test("index modes follow freshness: status, then incremental for missing/stale and rebuild for incompatible", async () => {
    const stack = await makeStack();
    try {
      stack.mcp.freshnessQueue = ["missing", "fresh"];
      await stack.pipeline.activate("123", "http://localhost:1111", draft([doc("a.md", "a")]));
      expect(stack.mcp.calls[1].args).toMatchObject({ mode: "status" });
      expect(stack.mcp.calls[2].args).toMatchObject({ mode: "incremental" });

      stack.mcp.freshnessQueue = ["incompatible", "fresh"];
      await stack.pipeline.activate("123", "http://localhost:1111", draft([doc("b.md", "b")]));
      expect(stack.mcp.calls.at(-2)?.args).toMatchObject({ mode: "status" });
      expect(stack.mcp.calls.at(-1)?.args).toMatchObject({ mode: "rebuild" });
    } finally {
      await stack.cleanup();
    }
  });

  test("the identical snapshot is a no-op while the binding is fresh: no MCP calls, unchanged revision", async () => {
    const stack = await makeStack();
    try {
      const documents = [doc("a.md", "a")];
      await stack.pipeline.activate("123", "http://localhost:1111", draft(documents));
      const callsAfterFirst = stack.mcp.calls.length;
      const second = await stack.pipeline.activate("123", "http://localhost:1111", draft(documents));
      expect(second.outcome).toBe("noop");
      expect(stack.mcp.calls.length).toBe(callsAfterFirst);
    } finally {
      await stack.cleanup();
    }
  });

  test("forged document hashes are rejected; a wrong claimedSnapshotHash is simply ignored", async () => {
    const stack = await makeStack();
    try {
      const forged = draft([{ ...doc("a.md", "a"), sha256: computeContentHash("tampered") }]);
      await expect(stack.pipeline.activate("123", "http://localhost:1111", forged)).rejects.toMatchObject({ code: "BRIDGE_SNAPSHOT_INVALID" });
      const result = await stack.pipeline.activate("123", "http://localhost:1111", draft([doc("a.md", "a")], [{ chapterKey: "n:1", ordinal: 1 }]));
      expect(result.snapshotHash).not.toBe("ignored");
    } finally {
      await stack.cleanup();
    }
  });

  test("size limits: per-document 16 MiB, total 64 MiB, and more than 4096 documents are invalid", async () => {
    const stack = await makeStack();
    try {
      const big = "a".repeat(16 * 1024 * 1024 + 1);
      await expect(stack.pipeline.activate("123", "http://localhost:1111", draft([doc("big.md", big)]))).rejects.toMatchObject({ code: "BRIDGE_SNAPSHOT_INVALID" });
      const half = "a".repeat(33 * 1024 * 1024);
      await expect(stack.pipeline.activate("123", "http://localhost:1111", draft([doc("h1.md", half), doc("h2.md", half)]))).rejects.toMatchObject({ code: "BRIDGE_SNAPSHOT_INVALID" });
      const many = Array.from({ length: 4097 }, (_, index) => doc(`d${index}.md`, "x"));
      await expect(stack.pipeline.activate("123", "http://localhost:1111", draft(many))).rejects.toMatchObject({ code: "BRIDGE_SNAPSHOT_INVALID" });
    } finally {
      await stack.cleanup();
    }
  });

  test("escaped relative paths never reach the filesystem", async () => {
    const stack = await makeStack();
    try {
      await expect(stack.pipeline.activate("123", "http://localhost:1111", draft([doc("../evil.md", "x")]))).rejects.toMatchObject({ code: "BRIDGE_SNAPSHOT_INVALID" });
      await expect(stack.pipeline.activate("123", "http://localhost:1111", draft([{ ...doc("ok.md", "x"), mediaType: "text/plain" }]))).rejects.toMatchObject({ code: "BRIDGE_SNAPSHOT_INVALID" });
    } finally {
      await stack.cleanup();
    }
  });

  test("EBUSY during the two-phase replace is retried with a bound before succeeding", async () => {
    const realRename = (await import("node:fs/promises")).rename;
    let attempts = 0;
    const flaky = async (from: string, to: string) => {
      attempts += 1;
      if (attempts <= 2) { const error: NodeJS.ErrnoException = new Error("EBUSY"); error.code = "EBUSY"; throw error; }
      return realRename(from, to);
    };
    const stack = await makeStack({ renameFn: flaky });
    try {
      const result = await stack.pipeline.activate("123", "http://localhost:1111", draft([doc("a.md", "a")]));
      expect(result.outcome).toBe("activated");
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      await stack.cleanup();
    }
  });

  test("when indexing never turns fresh the previous source and binding survive", async () => {
    const stack = await makeStack();
    try {
      await stack.pipeline.activate("123", "http://localhost:1111", draft([doc("a.md", "old")]));
      stack.mcp.freshnessQueue = ["stale", "stale", "stale", "stale"];
      await expect(stack.pipeline.activate("123", "http://localhost:1111", draft([doc("a.md", "new")]))).rejects.toMatchObject({ code: "BRIDGE_SNAPSHOT_ACTIVATION_FAILED" });
      const restored = await readFile(join(stack.bridgeRoot, "projects", stack.pipeline.projectKey("123", "http://localhost:1111"), "source", "a.md"), "utf8");
      expect(restored).toBe("old");
      const status = stack.pipeline.status("123", "http://localhost:1111");
      expect(status.bindingState).toBe("fresh");
    } finally {
      await stack.cleanup();
    }
  });

  test("a failed restore degrades the binding instead of lying about freshness", async () => {
    const stack = await makeStack();
    try {
      await stack.pipeline.activate("123", "http://localhost:1111", draft([doc("a.md", "old")]));
      const realRename = (await import("node:fs/promises")).rename;
      stack.mcp.freshnessQueue = ["stale", "stale"];
      const brokenRestore = async (from: string, to: string) => {
        if (from.includes("previous-source")) { const error: NodeJS.ErrnoException = new Error("EPERM"); error.code = "EPERM"; throw error; }
        return realRename(from, to);
      };
      stack.pipeline.setRenameFnForTest(brokenRestore);
      await expect(stack.pipeline.activate("123", "http://localhost:1111", draft([doc("a.md", "new")]))).rejects.toMatchObject({ code: "BRIDGE_BINDING_DEGRADED" });
      expect(stack.pipeline.status("123", "http://localhost:1111").bindingState).toBe("degraded");
    } finally {
      await stack.cleanup();
    }
  });

  test("a restart reloads bindings as stale candidates and only re-activation projects fresh", async () => {
    const stack = await makeStack();
    try {
      await stack.pipeline.activate("123", "http://localhost:1111", draft([doc("a.md", "a")]));
      const revived = createSnapshotPipeline({ bridgeRoot: stack.bridgeRoot, registry: stack.registry, state: stack.state, mcp: stack.mcp });
      await revived.restoreFromManifests();
      expect(revived.status("123", "http://localhost:1111").bindingState).toBe("stale");
      stack.mcp.freshnessQueue = ["fresh"];
      const result = await revived.activate("123", "http://localhost:1111", draft([doc("a.md", "a")]));
      expect(result.bindingState).toBe("fresh");
    } finally {
      await stack.cleanup();
    }
  });

  test("disabled or revoked plugins refuse new snapshots without touching derived data", async () => {
    const stack = await makeStack();
    try {
      await stack.pipeline.activate("123", "http://localhost:1111", draft([doc("a.md", "a")]));
      stack.state.setPluginState("disabled");
      await expect(stack.pipeline.activate("123", "http://localhost:1111", draft([doc("a.md", "b")]))).rejects.toMatchObject({ code: "BRIDGE_PLUGIN_DISABLED" });
      const source = await readFile(join(stack.bridgeRoot, "projects", stack.pipeline.projectKey("123", "http://localhost:1111"), "source", "a.md"), "utf8");
      expect(source).toBe("a");
      stack.state.setPluginState("revoked");
      await expect(stack.pipeline.activate("123", "http://localhost:1111", draft([doc("a.md", "c")]))).rejects.toMatchObject({ code: "BRIDGE_PLUGIN_DISABLED" });
    } finally {
      await stack.cleanup();
    }
  });

  test("mismatched hostProjectId between route and draft is invalid", async () => {
    const stack = await makeStack();
    try {
      await expect(stack.pipeline.activate("456", "http://localhost:1111", draft([doc("a.md", "a")]))).rejects.toMatchObject({ code: "BRIDGE_PROJECT_ID_INVALID" });
    } finally {
      await stack.cleanup();
    }
  });
});
