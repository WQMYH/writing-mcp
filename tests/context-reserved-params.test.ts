import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface DiagnosticResult { traceId: string; tool: string; outcome: "success" | "failure" }
interface SuccessEnvelope<T> { result: { ok: true; data: T; diagnostic: DiagnosticResult } }
const success = <T>(call: unknown): SuccessEnvelope<T>["result"] => ((call as { structuredContent?: unknown }).structuredContent as SuccessEnvelope<T>).result;
interface Packet { status: string; blocks: Array<{ ref: string; layer: string; evidence: { documentRef: string } }>; omitted: Array<{ ref: string; reason: string; tokens: number }> }

describe("AUD-012 constraint interface through MCP", () => {
  test("exposes wired constraints, excludes/pins via MCP, and keeps taskType value-open and non-driving", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-aud012-"));
    const source = join(dir, "novel");
    await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
    const client = new Client({ name: "writing-mcp-test", version: "0.1.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("packages/mcp-server/dist/index.js")], env: { ...process.env, WRITING_MCP_ROOTS: dir } as Record<string, string> });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const explore = tools.tools.find(tool => tool.name === "writing_explore")!, context = tools.tools.find(tool => tool.name === "writing_context")!;
      const exploreProperties = explore.inputSchema.properties as Record<string, unknown>;
      expect(Object.keys(exploreProperties)).toContain("targetChapter");
      const contextProperties = context.inputSchema.properties as Record<string, unknown>;
      for (const wired of ["targetChapter", "entityRefs", "documentRefs", "excludeRefs"]) expect(Object.keys(contextProperties)).toContain(wired);
      // taskType is value-open: an open string schema (no enum), and still documented as reserved.
      expect((contextProperties.taskType as { enum?: unknown }).enum).toBeUndefined();
      expect(context.description).toMatch(/reserved/i);
      expect(context.description).toMatch(/taskType/i);

      const resolvedCall = await client.callTool({ name: "writing_resolve", arguments: { sourcePath: source } });
      const workRef = success<{ workRef: string }>(resolvedCall).data.workRef;
      await client.callTool({ name: "writing_index", arguments: { workRef, mode: "rebuild" } });

      const anchoredCall = await client.callTool({ name: "writing_explore", arguments: { workRef, operation: "timeline", targetChapter: 1 } });
      const anchored = success<{ results: Array<{ title: string; kind: string }> }>(anchoredCall);
      expect(anchored.data.results.length).toBeGreaterThan(0);
      // The chapter-two entity itself is not valid at chapter one; relation
      // headings may still name the target chapter.
      expect(anchored.data.results.every(item => !(item.kind === "Chapter" && item.title.includes("第二章")))).toBe(true);

      // Baseline packet; then exercise the wired constraints through MCP.
      const baselineCall = await client.callTool({ name: "writing_context", arguments: { workRef, taskType: "answer", query: "铜钥匙", budgetTokens: 100_000 } });
      const baseline = success<Packet>(baselineCall);
      expect(baseline.data.status).not.toBe("budget_unsatisfiable");
      expect(baseline.data.blocks.length).toBeGreaterThan(0);

      // excludeRefs removes a candidate and reports it.
      const victim = baseline.data.blocks[0]!.ref;
      const excludeCall = await client.callTool({ name: "writing_context", arguments: { workRef, taskType: "answer", query: "铜钥匙", budgetTokens: 100_000, excludeRefs: [victim] } });
      const excluded = success<Packet>(excludeCall);
      expect(excluded.data.blocks.some(block => block.ref === victim)).toBe(false);
      expect(excluded.data.omitted.some(entry => entry.ref === victim && entry.reason === "excluded")).toBe(true);

      // documentRefs resolves the block's own document directly.
      const docRef = baseline.data.blocks[0]!.evidence.documentRef;
      const pinnedCall = await client.callTool({ name: "writing_context", arguments: { workRef, taskType: "answer", query: "铜钥匙", budgetTokens: 100_000, documentRefs: [docRef] } });
      const pinned = success<Packet>(pinnedCall);
      expect(pinned.data.blocks.some(block => block.evidence.documentRef === docRef)).toBe(true);

      // Unknown taskType is accepted (value-open) and changes nothing.
      const unknownTypeCall = await client.callTool({ name: "writing_context", arguments: { workRef, taskType: "brand_new_type_from_usage", query: "铜钥匙", budgetTokens: 100_000 } });
      const unknownType = success<Packet>(unknownTypeCall);
      expect(unknownType.data.status).not.toBe("budget_unsatisfiable");
      expect(unknownType.data.blocks.map(block => block.ref)).toEqual(baseline.data.blocks.map(block => block.ref));
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 45_000);
});
