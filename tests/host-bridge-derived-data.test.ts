import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createBridgeState } from "../packages/host-bridge/src/state.js";
import { createPluginRegistry } from "../packages/host-bridge/src/plugins.js";
import { createSnapshotPipeline } from "../packages/host-bridge/src/snapshot.js";
import { hostPluginManifestSchema } from "@writing-mcp/host-plugin-storyforge";
import { computeContentHash } from "../packages/host-bridge-protocol/src/index.js";

const manifest = hostPluginManifestSchema.parse({
  id: "storyforge",
  apiVersion: 1,
  hostCompatibility: { bridgeProtocol: "^1" },
  minimumPermissions: ["export:snapshot", "invoke:tools", "delete:derived"],
  exportCategories: ["project", "world", "character", "outline", "chapter", "foreshadow"],
  license: "AGPL-3.0-only",
  testMatrix: { node: ["24"] },
});

const doc = (relativePath: string, content: string) => ({ relativePath, category: "project", mediaType: "text/markdown", content, sha256: computeContentHash(content) });
const draft = (documents: unknown[]) => ({ protocolVersion: 1, pluginId: "storyforge", hostProjectId: "123", documents, chapters: [], claimedSnapshotHash: "0".repeat(64) });

const freshMcp = { callTool: async () => ({ structuredContent: { result: { ok: true, data: { status: "resolved", workRef: "work-1", revision: 1, schemaVersion: 4, freshness: "fresh", candidates: [], diagnostics: [], stats: {} }, diagnostic: {} } } }) };

async function makeStack() {
  const bridgeRoot = await mkdtemp(join(tmpdir(), "hb-derived-"));
  const state = createBridgeState();
  const registry = createPluginRegistry({ bridgeRoot, state });
  await registry.register(manifest);
  const pipeline = createSnapshotPipeline({ bridgeRoot, registry, state, mcp: freshMcp });
  return { bridgeRoot, state, registry, pipeline, async cleanup() { await rm(bridgeRoot, { recursive: true, force: true }); } };
}

describe("host bridge derived data deletion (HB-M2)", () => {
  test("deletes source, project bridge dir, and index, keeps global plugin state, reports empty", async () => {
    const stack = await makeStack();
    try {
      await stack.pipeline.activate("123", "http://localhost:1111", draft([doc("a.md", "a")]));
      const projectDir = join(stack.bridgeRoot, "projects", stack.pipeline.projectKey("123", "http://localhost:1111"));
      await mkdir(join(projectDir, ".writing-index"), { recursive: true });
      await writeFile(join(projectDir, ".writing-index", "index.sqlite"), "db-bytes");
      await mkdir(join(stack.bridgeRoot, ".bridge"), { recursive: true });
      await writeFile(join(stack.bridgeRoot, ".bridge", "plugin-state.json"), JSON.stringify({ pluginId: "storyforge", state: "enabled" }));

      const result = await stack.pipeline.deleteDerivedData("123", "http://localhost:1111");
      expect(result).toEqual({ bindingState: "empty" });
      expect(existsSync(projectDir)).toBe(false);
      expect(await readFile(join(stack.bridgeRoot, ".bridge", "plugin-state.json"), "utf8")).toContain("storyforge");
      expect(stack.pipeline.status("123", "http://localhost:1111").bindingState).toBe("empty");
    } finally {
      await stack.cleanup();
    }
  });

  test("an active capture makes deletion busy and changes nothing", async () => {
    const stack = await makeStack();
    try {
      await stack.pipeline.activate("123", "http://localhost:1111", draft([doc("a.md", "a")]));
      const busy = createSnapshotPipeline({ bridgeRoot: stack.bridgeRoot, registry: stack.registry, state: stack.state, mcp: freshMcp, hasActiveCapture: () => true });
      await expect(busy.deleteDerivedData("123", "http://localhost:1111")).rejects.toMatchObject({ code: "DERIVED_DATA_BUSY" });
      const projectDir = join(stack.bridgeRoot, "projects", stack.pipeline.projectKey("123", "http://localhost:1111"));
      expect(existsSync(join(projectDir, "source"))).toBe(true);
      expect(stack.pipeline.status("123", "http://localhost:1111").bindingState).toBe("fresh");
    } finally {
      await stack.cleanup();
    }
  });

  test("deleting an unknown project is a no-op success", async () => {
    const stack = await makeStack();
    try {
      await expect(stack.pipeline.deleteDerivedData("999", "http://localhost:1111")).resolves.toEqual({ bindingState: "empty" });
    } finally {
      await stack.cleanup();
    }
  });
});
