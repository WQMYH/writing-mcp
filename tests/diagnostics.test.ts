import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { DiagnosticRecorder } from "../packages/mcp-server/src/diagnostics.js";

describe("diagnostic recorder", () => {
  test("writes redacted per-call reports and deterministic capture artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-diagnostics-"));
    const workRef = "work:test";
    const recorder = new DiagnosticRecorder(ref => ref === workRef ? join(root, "diagnostics") : undefined);
    try {
      const started = await recorder.startCapture(workRef, "small user flow", "metadata");
      const diagnostic = await recorder.record({
        traceId: recorder.newTraceId(),
        tool: "writing_explore",
        input: { workRef, operation: "search", query: "secret query text", diagnosticRunRef: started.diagnosticRunRef },
        output: { workRef, revision: 4, freshness: "fresh", operation: "search", results: [{ evidence: { excerpt: "secret source excerpt" } }], truncated: false },
        elapsedMs: 12,
        diagnosticRunRef: started.diagnosticRunRef,
      });
      expect(diagnostic).toMatchObject({ persistence: "persisted", tool: "writing_explore", outcome: "success", revision: 4 });
      const invocation = await readFile(join(root, "diagnostics", diagnostic.artifactPath!), "utf8");
      expect(invocation).not.toContain("secret query text");
      expect(invocation).not.toContain("secret source excerpt");
      expect(invocation).toContain("sha256");

      const finished = await recorder.finishCapture(workRef, started.diagnosticRunRef, ["json", "markdown"]);
      const capture = await readFile(join(root, "diagnostics", finished.artifactPath), "utf8");
      expect(capture).not.toContain("secret query text");
      expect(capture).not.toContain("secret source excerpt");
      expect(finished.calls).toBe(1);
      await stat(join(root, "diagnostics", "runs", `${started.diagnosticRunRef}.md`));
      expect(await recorder.finishCapture(workRef, started.diagnosticRunRef, ["json"])).toMatchObject({ artifactRef: finished.artifactRef, sha256: finished.sha256 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("records an explicitly opted-in query and reports unavailable persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-diagnostics-query-"));
    const workRef = "work:test";
    const recorder = new DiagnosticRecorder(ref => ref === workRef ? join(root, "diagnostics") : undefined);
    try {
      const started = await recorder.startCapture(workRef, undefined, "query");
      await recorder.record({ traceId: recorder.newTraceId(), tool: "writing_context", input: { workRef, query: "explicit diagnostic query", budgetTokens: 200 }, output: { workRef, revision: 1, status: "complete", usedTokens: 40, budgetTokens: 200, blocks: [] }, elapsedMs: 5, diagnosticRunRef: started.diagnosticRunRef });
      const finished = await recorder.finishCapture(workRef, started.diagnosticRunRef);
      expect(await readFile(join(root, "diagnostics", finished.artifactPath), "utf8")).toContain("explicit diagnostic query");

      const skipped = await new DiagnosticRecorder(() => undefined).record({ traceId: "trace-test", tool: "writing_resolve", input: { sourcePath: "sensitive/path" }, error: { code: "SOURCE_NOT_FOUND", message: "not found" }, elapsedMs: 1 });
      expect(skipped).toMatchObject({ persistence: "skipped", outcome: "failure" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("development capture persists bounded hit refs, scores, and locator hashes without excerpts", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-diagnostics-hits-"));
    const workRef = "work:test";
    const recorder = new DiagnosticRecorder(ref => ref === workRef ? join(root, "diagnostics") : undefined);
    try {
      const started = await recorder.startCapture(workRef, undefined, "metadata");
      await recorder.record({
        traceId: recorder.newTraceId(),
        tool: "writing_explore",
        input: { workRef, operation: "search", query: "北塔", diagnosticRunRef: started.diagnosticRunRef },
        output: { workRef, revision: 2, freshness: "fresh", operation: "search", truncated: false, results: [{ ref: "span:chapter-1#1", kind: "span", title: "第一章", score: 1.9, sourceKind: "deterministic", confidence: 1, evidence: { documentRef: "doc:chapter-1", relativePath: "第一章.md", startLine: 1, endLine: 9, excerpt: "secret excerpt content", evidenceHash: "h", revision: 2, locators: [{ relativePath: "第一章.md", startLine: 1, endLine: 9 }] } }], ambiguous: [] },
        elapsedMs: 7,
        diagnosticRunRef: started.diagnosticRunRef,
      });
      await recorder.record({
        traceId: recorder.newTraceId(),
        tool: "writing_context",
        input: { workRef, query: "北塔", budgetTokens: 500, diagnosticRunRef: started.diagnosticRunRef },
        output: { workRef, revision: 2, status: "complete", usedTokens: 120, budgetTokens: 500, estimated: true, estimator: "char/2", blocks: [{ ref: "entity:character:yu", kind: "Character", title: "语笙", score: 2, sourceKind: "native", confidence: 1, evidence: { documentRef: "doc:roles", relativePath: "roles.md", startLine: 1, endLine: 3, excerpt: "secret block excerpt", evidenceHash: "h", revision: 2 }, layer: "L0", tokens: 40, required: true }], omitted: [{ ref: "span:missing", reason: "not_found", tokens: 0 }], diagnostics: [] },
        elapsedMs: 9,
        diagnosticRunRef: started.diagnosticRunRef,
      });
      const finished = await recorder.finishCapture(workRef, started.diagnosticRunRef);
      const capture = await readFile(join(root, "diagnostics", finished.artifactPath), "utf8");
      expect(capture).not.toContain("secret excerpt content");
      expect(capture).not.toContain("secret block excerpt");
      const artifact = JSON.parse(capture) as { calls: Array<{ tool: string; outputHits?: { results?: Array<Record<string, unknown>>; blocks?: Array<Record<string, unknown>>; omitted?: Array<Record<string, unknown>> } }> };
      const exploreCall = artifact.calls.find(call => call.tool === "writing_explore");
      expect(exploreCall?.outputHits?.results?.[0]).toMatchObject({ ref: "span:chapter-1#1", kind: "span", sourceKind: "deterministic", score: 1.9 });
      expect(exploreCall?.outputHits?.results?.[0]?.locatorsSha256).toEqual(expect.any(String));
      // Locators are only observable through their hash; titles and excerpts never enter hits.
      expect(JSON.stringify(exploreCall?.outputHits)).not.toContain("第一章.md");
      expect(JSON.stringify(exploreCall?.outputHits)).not.toContain("第一章");
      const contextCall = artifact.calls.find(call => call.tool === "writing_context");
      expect(contextCall?.outputHits?.blocks?.[0]).toMatchObject({ ref: "entity:character:yu", sourceKind: "native", layer: "L0", tokens: 40, required: true });
      expect(contextCall?.outputHits?.omitted?.[0]).toMatchObject({ ref: "span:missing", reason: "not_found", tokens: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
