import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GenericAdapter } from "@writing-mcp/adapter-generic";
import { WritingStore } from "@writing-mcp/core";
import { expect, test } from "vitest";

const shapes = [
  { name: "BMP", text: (count: number) => "中".repeat(count) },
  { name: "supplementary", text: (count: number) => "😀".repeat(count) },
  { name: "mixed", text: (count: number) => "中".repeat(Math.floor(count / 2)) + "😀".repeat(count - Math.floor(count / 2)) },
];
const envelope = (call: unknown) => (call as { structuredContent?: { result?: { ok: boolean; data: Record<string, unknown> } } }).structuredContent?.result;

test.each(shapes)("published limits and real SDK stdio agree on $name code points (W-MCP-025)", async ({ text }) => {
  const root = await mkdtemp(join(tmpdir(), "writing-mcp-input-unicode-")), source = join(root, "novel");
  await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
  const client = new Client({ name: "unicode-boundary", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("packages/mcp-server/dist/index.js")], env: { ...process.env, WRITING_MCP_ROOTS: root } as Record<string, string> });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const properties = (name: string) => listed.tools.find(tool => tool.name === name)!.inputSchema.properties as Record<string, { maxLength?: number; items?: { maxLength?: number } }>;
    expect(properties("writing_explore").query!.maxLength).toBe(2048);
    expect(properties("writing_context").query!.maxLength).toBe(2048);
    expect(properties("writing_context").taskType!.maxLength).toBe(64);
    expect(properties("writing_diagnose").label!.maxLength).toBe(80);
    const resolved = envelope(await client.callTool({ name: "writing_resolve", arguments: { sourcePath: source } }))!;
    const workRef = String(resolved.data.workRef);
    const invoke = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: { workRef, ...args } });
    for (const delta of [-1, 0, 1]) {
      const valid = delta <= 0;
      for (const name of ["writing_explore", "writing_context"]) {
        const call = await invoke(name, { query: text(2048 + delta), ...(name === "writing_explore" ? { operation: "search" } : { budgetTokens: 1000 }) });
        expect(call.isError === true, `${name} query at 2048${delta >= 0 ? "+" : ""}${delta}`).toBe(!valid);
        if (valid) expect(envelope(call)?.ok).toBe(true);
      }
      const hinted = await invoke("writing_context", { query: "铜钥匙", budgetTokens: 1000, taskType: text(64 + delta) });
      expect(hinted.isError === true, `taskType at 64+${delta}`).toBe(!valid);
      const label = text(80 + delta), captured = await invoke("writing_diagnose", { action: "start_capture", purpose: "development", label });
      expect(captured.isError === true, `label at 80+${delta}`).toBe(!valid);
      if (valid) {
        const diagnosticRunRef = String(envelope(captured)!.data.diagnosticRunRef);
        const meta = JSON.parse(await readFile(join(source, ".writing-index", workRef.replace(":", "-"), "diagnostics", "runs", `${diagnosticRunRef}.meta.json`), "utf8"));
        expect(meta.label).toBe(label);
        expect(envelope(await invoke("writing_diagnose", { action: "finish_capture", purpose: "development", diagnosticRunRef }))?.ok).toBe(true);
      }
      for (const field of ["requiredRefs", "entityRefs", "documentRefs", "excludeRefs"]) {
        expect(properties("writing_context")[field]!.items!.maxLength).toBe(256);
        const call = await invoke("writing_context", { query: "铜钥匙", budgetTokens: 1000, [field]: [text(256 + delta)] });
        expect(call.isError === true, `${field} at 256+${delta}`).toBe(!valid);
        if (valid) expect(envelope(call)?.ok).toBe(true);
      }
    }
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("direct store query/evaluator/ref guards use the same code-point boundaries (W-MCP-025)", async () => {
  const root = await mkdtemp(join(tmpdir(), "writing-mcp-core-unicode-")), source = join(root, "novel"), adapter = new GenericAdapter();
  await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
  const store = new WritingStore(await adapter.load((await adapter.discover(source))[0]!));
  try {
    await store.index("rebuild");
    for (const query of ["中".repeat(2048), "😀".repeat(2048), "中😀".repeat(1024)]) {
      await expect(store.explore("search", query)).resolves.toHaveProperty("operation", "search");
      await expect(store.evaluateSearch(query, 20, {})).resolves.toHaveProperty("operation", "search");
      await expect(store.context(query, 1000)).resolves.toHaveProperty("accountingScope", "evidence_excerpts_only");
      await expect(store.explore("search", query + "x")).rejects.toMatchObject({ code: "QUERY_TOO_LARGE" });
      await expect(store.evaluateSearch(query + "x", 20, {})).rejects.toMatchObject({ code: "QUERY_TOO_LARGE" });
      await expect(store.context(query + "x", 1000)).rejects.toMatchObject({ code: "QUERY_TOO_LARGE" });
    }
    const ref = "😀".repeat(256);
    await expect(store.context("", 1000, [ref], { entityRefs: [ref], documentRefs: [ref], excludeRefs: [ref] })).resolves.toHaveProperty("status", "truncated");
    for (const field of ["requiredRefs", "entityRefs", "documentRefs", "excludeRefs"]) {
      await expect(store.context("", 1000, field === "requiredRefs" ? [ref + "x"] : [], field === "requiredRefs" ? {} : { [field]: [ref + "x"] })).rejects.toMatchObject({ code: "CONTEXT_REFS_TOO_LARGE" });
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
