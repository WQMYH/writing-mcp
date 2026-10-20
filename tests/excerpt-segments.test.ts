import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { stableId, WritingStore, type Evidence, type SourceDocument } from "@writing-mcp/core";
import { createServer, TOOL_CONTEXT_DATA_SCHEMA, TOOL_EXPLORE_DATA_SCHEMA } from "../packages/mcp-server/src/server.js";
import { DiagnosticRecorder } from "../packages/mcp-server/src/diagnostics.js";
import { compactJsonBytes, createDiagnosticReserve, fitBusinessData } from "../packages/mcp-server/src/response-limits.js";

const segments = (evidence: Evidence) => evidence.excerptSegments;
const locator = (startLine: number, endLine: number, relativePath = "chapter.txt") => ({ relativePath, startLine, endLine });
const numberedLines = () => Array.from({ length: 60 }, (_, i) => `${String(i + 1).padStart(2, "0")}|${"文".repeat(26)}`);
const dualLines = () => {
  const lines = numberedLines();
  lines[19] = `20|anchorone${"文".repeat(17)}`;
  lines[57] = `58|anchortwo${"文".repeat(17)}`;
  return lines;
};

async function withStore(content: string, check: (store: WritingStore, doc: SourceDocument) => Promise<void>, overrides: Partial<SourceDocument> = {}) {
  const root = await mkdtemp(join(tmpdir(), "writing-mcp-excerpt-segments-"));
  const workRef = stableId("work", root);
  const doc: SourceDocument = {
    documentRef: stableId("doc", workRef, "chapter.txt"), relativePath: "chapter.txt", absolutePath: join(root, "chapter.txt"),
    title: "Excerpt fixture", kind: "chapter", chapterNumber: 1, content, sourceMtimeMs: 1, sourceSize: Buffer.byteLength(content), ...overrides,
  };
  const store = new WritingStore({ workRef, title: "Synthetic", rootPath: root, adapter: "generic", capabilities: [], documents: [doc] });
  try { await store.index("rebuild"); await check(store, doc); }
  finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

describe("EXT-OBS-001 returned excerpt source segments", () => {
  test.each(["\n", "\r\n"])("keeps dual windows while locating each window (%j and terminal newline)", async newline => {
    const normalized = dualLines().join("\n");
    await withStore(dualLines().join(newline) + newline, async store => {
      const result = await store.explore("search", "anchorone anchortwo", 20, 0);
      const evidence = result.results[0]!.evidence;
      const excerpt = normalized.slice(424, 722) + "\n…\n" + normalized.slice(1501, 1799);
      expect(evidence.excerpt).toBe(excerpt);
      expect(evidence.locators).toEqual([locator(1, 60)]);
      expect(segments(evidence)).toEqual([
        { excerptStart: 0, excerptEnd: 298, locators: [locator(15, 25)] },
        { excerptStart: 301, excerptEnd: 599, locators: [locator(51, 60)] },
      ]);
      const packet = await store.context("anchorone anchortwo", 5_000);
      expect(packet.blocks[0]!.evidence).toEqual(evidence);
      expect(TOOL_EXPLORE_DATA_SCHEMA.parse(result).results[0]!.evidence).toEqual(evidence);
      expect(TOOL_CONTEXT_DATA_SCHEMA.parse(packet).blocks[0]!.evidence).toEqual(evidence);
    });
  });

  test("distinguishes identical windows by their selected offsets, not text lookup", async () => {
    const lines = Array.from({ length: 60 }, () => `aa|${"x".repeat(26)}`);
    lines[14] = lines[44] = `aa|needle${"x".repeat(20)}`;
    const content = lines.join("\n");
    await withStore(content, async store => {
      const evidence = (await store.explore("search", "needle", 20, 0)).results[0]!.evidence;
      const excerpt = [content.slice(274, 572), content.slice(1174, 1472), content.slice(1501, 1799)].join("\n…\n");
      expect(evidence.excerpt).toBe(excerpt);
      expect(excerpt.slice(0, 298)).toBe(excerpt.slice(301, 599));
      expect(segments(evidence)).toEqual([
        { excerptStart: 0, excerptEnd: 298, locators: [locator(10, 20)] },
        { excerptStart: 301, excerptEnd: 599, locators: [locator(40, 50)] },
        { excerptStart: 602, excerptEnd: 900, locators: [locator(51, 60)] },
      ]);
    });
  });

  test("does not treat original ellipsis text as an inserted window separator", async () => {
    const content = "a".repeat(600) + "\n…\n" + "b".repeat(600);
    await withStore(content, async store => {
      const evidence = (await store.explore("search", "ellipsis", 20, 0)).results[0]!.evidence;
      expect(evidence.excerpt).toBe(content.slice(0, 900));
      expect(segments(evidence)).toEqual([{ excerptStart: 0, excerptEnd: 900, locators: [locator(1, 3)] }]);
    }, { title: "ellipsis" });
  });

  test("accounts for surrogate pairs removed at both window boundaries", async () => {
    const content = "中".repeat(850) + "😀" + "x".repeat(148) + "needle" + "x".repeat(142) + "𠀀" + "x".repeat(800);
    await withStore(content, async store => {
      const evidence = (await store.explore("search", "needle", 20, 0)).results[0]!.evidence;
      expect(evidence.excerpt).toBe(content.slice(852, 1148));
      expect(evidence.excerpt.isWellFormed()).toBe(true);
      expect(segments(evidence)).toEqual([{ excerptStart: 0, excerptEnd: 296, locators: [locator(1, 1)] }]);
    });
  });

  test("maps a window across XHTML entries through the document source map", async () => {
    const content = "A".repeat(600) + "\n" + "B".repeat(500) + "needle" + "B".repeat(94) + "\n" + "C".repeat(600);
    await withStore(content, async store => {
      const evidence = (await store.explore("search", "needle", 20, 0)).results[0]!.evidence;
      expect(evidence.excerpt).toBe([content.slice(752, 1050), content.slice(952, 1250), content.slice(1504, 1802)].join("\n…\n"));
      expect(evidence.locators).toEqual([locator(10, 11, "a.xhtml"), locator(20, 20, "b.xhtml")]);
      expect(segments(evidence)).toEqual([
        { excerptStart: 0, excerptEnd: 298, locators: [locator(11, 11, "a.xhtml")] },
        { excerptStart: 301, excerptEnd: 599, locators: [locator(11, 11, "a.xhtml"), locator(20, 20, "b.xhtml")] },
        { excerptStart: 602, excerptEnd: 900, locators: [locator(20, 20, "b.xhtml")] },
      ]);
    }, { sourceStartLine: 10, sourceSegments: [
      { ...locator(10, 11, "a.xhtml"), documentStartLine: 1, documentEndLine: 2 },
      { ...locator(20, 20, "b.xhtml"), documentStartLine: 3, documentEndLine: 3 },
    ] });
  });

  test("locates prefix excerpts on required/entity/document refs and retains TXT chapter offsets", async () => {
    const content = dualLines().join("\n");
    await withStore(content, async (store, doc) => {
      const entityRef = (await store.explore("entity", "Excerpt fixture", 20, 0)).results[0]!.ref;
      const required = await store.context("unmatchablezz", 5_000, [entityRef]);
      const pinned = await store.context("unmatchablezz", 5_000, [], { entityRefs: [entityRef], documentRefs: [doc.documentRef] });
      expect(required.blocks).toHaveLength(1);
      expect(pinned.blocks).toHaveLength(2);
      for (const block of [...required.blocks, ...pinned.blocks]) {
        expect(block.evidence.excerpt).toBe(content.slice(0, 900));
        expect(block.evidence.locators).toEqual([locator(101, 160)]);
        expect(segments(block.evidence)).toEqual([{ excerptStart: 0, excerptEnd: 900, locators: [locator(101, 130)] }]);
      }
      expect((await store.context("unmatchablezz", 1, [entityRef])).status).toBe("budget_unsatisfiable");
      expect((await store.context("anchorone anchortwo", 1)).blocks).toEqual([]);
    }, { sourceStartLine: 101 });
  });

  test("advertises and returns the same metadata over MCP search/context", async () => {
    await withStore(dualLines().join("\n"), async store => {
      const { workRef } = await store.explore("search", "anchorone anchortwo", 20, 0);
      const service = {
        explore: async () => store.explore("search", "anchorone anchortwo", 20, 0),
        context: async () => store.context("anchorone anchortwo", 5_000),
        diagnosticDirectory: () => undefined,
      };
      const server = createServer(service as never, new DiagnosticRecorder(() => undefined));
      const client = new Client({ name: "excerpt-segments-test", version: "0.1.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const tools = await client.listTools();
        for (const name of ["writing_explore", "writing_context"]) {
          expect(JSON.stringify(tools.tools.find(tool => tool.name === name)!.outputSchema)).toContain("excerptSegments");
          const args = name === "writing_explore" ? { workRef, operation: "search", query: "anchorone anchortwo" } : { workRef, query: "anchorone anchortwo", budgetTokens: 5_000 };
          const response = await client.callTool({ name, arguments: args });
          expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
          const result = response.structuredContent as { result: { ok: boolean; data: { results?: { evidence: Evidence }[]; blocks?: { evidence: Evidence }[] } } };
          expect(result.result.ok).toBe(true);
          const evidence = (result.result.data.results ?? result.result.data.blocks)![0]!.evidence;
          expect(segments(evidence)).toEqual([
            { excerptStart: 0, excerptEnd: 298, locators: [locator(15, 25)] },
            { excerptStart: 301, excerptEnd: 599, locators: [locator(51, 60)] },
          ]);
        }
      } finally { await client.close(); await server.close(); }
    });
  });

  test("counts segment bytes and drops whole optional items, never orphaned offsets", async () => {
    await withStore(dualLines().join("\n"), async store => {
      const data = await store.explore("search", "anchorone anchortwo", 20, 0);
      const item = data.results[0]!;
      expect(segments(item.evidence)).toHaveLength(2);
      const repeated = { ...data, results: [item, { ...item, ref: "span:second" }] };
      const maxBytes = compactJsonBytes({ ok: true, data: repeated, diagnostic: createDiagnosticReserve("writing_explore", "success") }) - 1;
      const fitted = fitBusinessData("writing_explore", repeated, maxBytes) as typeof repeated;
      expect(fitted.results).toEqual([item]);
      expect(fitted.results[0]!.evidence).toEqual(item.evidence);
      expect(fitted.truncated).toBe(true);
      expect(repeated.results).toHaveLength(2);
      const packet = await store.context("anchorone anchortwo", 5_000);
      const cap = compactJsonBytes({ ok: true, data: packet, diagnostic: createDiagnosticReserve("writing_context", "success") }) - 1;
      const fittedPacket = fitBusinessData("writing_context", packet, cap) as typeof packet;
      expect(fittedPacket.blocks).toEqual([]);
      expect(fittedPacket.omitted).toContainEqual({ ref: item.ref, reason: "response_limit", tokens: packet.blocks[0]!.tokens });
      const requiredPacket = { ...packet, blocks: packet.blocks.map(block => ({ ...block, required: true })) };
      const requiredCap = compactJsonBytes({ ok: true, data: requiredPacket, diagnostic: createDiagnosticReserve("writing_context", "success") }) - 1;
      expect(() => fitBusinessData("writing_context", requiredPacket, requiredCap)).toThrow(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }));
    });
  });
});
