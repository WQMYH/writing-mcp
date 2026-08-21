import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

  test("general JSONL rotation keeps a bounded event count under the injected limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-diagnostics-rotation-"));
    const workRef = "work:test";
    const recorder = new DiagnosticRecorder(ref => ref === workRef ? join(root, "diagnostics") : undefined, { generalEvents: 8 });
    try {
      for (let index = 0; index < 12; index++) {
        await recorder.record({ traceId: `trace-${index}`, tool: "writing_explore", input: { workRef, operation: "search" }, output: { workRef, revision: 1, freshness: "fresh", operation: "search", results: [] }, elapsedMs: 1 });
      }
      const lines = (await readFile(join(root, "diagnostics", "diagnostics.jsonl"), "utf8")).split(/\r?\n/).filter(line => line.length > 0);
      expect(lines.length).toBeLessThanOrEqual(8);
      expect(lines.map(line => JSON.parse(line) as { traceId: string }).map(event => event.traceId)).toContain("trace-11");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("concurrent records serialize general JSONL writes without loss or corruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-diagnostics-concurrency-"));
    const workRef = "work:test";
    const recorder = new DiagnosticRecorder(ref => ref === workRef ? join(root, "diagnostics") : undefined, { generalEvents: 8 });
    try {
      const diagnostics = await Promise.all(Array.from({ length: 20 }, (_, index) => recorder.record({ traceId: `trace-${index}`, tool: "writing_explore", input: { workRef, operation: "search" }, output: { workRef, revision: 1, freshness: "fresh", operation: "search", results: [] }, elapsedMs: 1 })));
      expect(diagnostics.map(item => item.persistence)).toEqual(Array.from({ length: 20 }, () => "persisted"));
      const lines = (await readFile(join(root, "diagnostics", "diagnostics.jsonl"), "utf8")).split(/\r?\n/).filter(line => line.length > 0);
      const traceIds = lines.map(line => (JSON.parse(line) as { traceId: string }).traceId);
      expect(new Set(traceIds).size).toBe(traceIds.length);
      expect(traceIds.length).toBeLessThanOrEqual(8);
      // Serialization preserves submission order; the last submitted event survives rotation.
      expect(traceIds.at(-1)).toBe("trace-19");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("general JSONL write failure degrades to a failed persistence report", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-diagnostics-writefail-"));
    const workRef = "work:test";
    // Make diagnostics.jsonl a directory so every write to it fails deterministically.
    await mkdir(join(root, "diagnostics", "diagnostics.jsonl"), { recursive: true });
    const recorder = new DiagnosticRecorder(ref => ref === workRef ? join(root, "diagnostics") : undefined);
    try {
      const diagnostic = await recorder.record({ traceId: "trace-fail", tool: "writing_explore", input: { workRef }, output: { workRef, revision: 1 }, elapsedMs: 1 });
      expect(diagnostic).toMatchObject({ outcome: "success", persistence: "failed" });
      expect(diagnostic.persistenceError).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps a returned per-call report even when its maintenance pass must trim reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-diagnostics-returned-report-"));
    const workRef = "work:test", directory = join(root, "diagnostics");
    const recorder = new DiagnosticRecorder(ref => ref === workRef ? directory : undefined, undefined, { maxDirectoryBytes: 1 });
    try {
      const diagnostic = await recorder.record({ traceId: "trace-returned-report", tool: "writing_explore", input: { workRef }, output: { workRef, revision: 1 }, elapsedMs: 1 });
      await stat(join(directory, diagnostic.artifactPath!));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("keeps a returned capture artifact when finishing it triggers retention", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-diagnostics-returned-capture-"));
    const workRef = "work:test", directory = join(root, "diagnostics");
    const recorder = new DiagnosticRecorder(ref => ref === workRef ? directory : undefined, undefined, { maxDirectoryBytes: 1 });
    try {
      const started = await recorder.startCapture(workRef);
      const finished = await recorder.finishCapture(workRef, started.diagnosticRunRef);
      await stat(join(directory, finished.artifactPath));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("accounts for the capture-truncation metadata rewrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-diagnostics-capture-truncation-"));
    const workRef = "work:test", directory = join(root, "diagnostics");
    const recorder = new DiagnosticRecorder(ref => ref === workRef ? directory : undefined, { captureCalls: 1 }, { scanEveryWrites: 8, scanEveryAddedBytes: 1_000_000 });
    try {
      const started = await recorder.startCapture(workRef);
      await recorder.record({ traceId: "trace-first", tool: "writing_explore", input: { workRef, diagnosticRunRef: started.diagnosticRunRef }, output: { workRef, revision: 1 }, elapsedMs: 1, diagnosticRunRef: started.diagnosticRunRef });
      await recorder.record({ traceId: "trace-truncated", tool: "writing_explore", input: { workRef, diagnosticRunRef: started.diagnosticRunRef }, output: { workRef, revision: 1 }, elapsedMs: 1, diagnosticRunRef: started.diagnosticRunRef });
      const meta = JSON.parse(await readFile(join(directory, "runs", `${started.diagnosticRunRef}.meta.json`), "utf8")) as { truncated: boolean };
      expect(meta.truncated).toBe(true);
      expect(recorder.retentionStats(workRef).scans).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("records cooperative cleanup deferral without failing the diagnostic write", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-diagnostics-deferred-"));
    const workRef = "work:test", directory = join(root, "diagnostics");
    await mkdir(join(directory, "reports"), { recursive: true });
    await writeFile(join(directory, "reports", "old.json"), "x".repeat(100));
    await writeFile(join(directory, ".cleanup.lock"), JSON.stringify({ pid: process.pid, token: "live-other", createdAt: "2026-01-01T00:00:00.000Z" }));
    const recorder = new DiagnosticRecorder(ref => ref === workRef ? directory : undefined, undefined, { maxDirectoryBytes: 10 });
    try {
      const diagnostic = await recorder.record({ traceId: "trace-deferred", tool: "writing_explore", input: { workRef }, output: { workRef, revision: 1 }, elapsedMs: 1 });
      expect(diagnostic).toMatchObject({ persistence: "persisted", persistenceError: "DIAGNOSTIC_CLEANUP_DEFERRED" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("starting a capture uses retention maintenance while protecting the new active group", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-diagnostics-start-retention-"));
    const workRef = "work:test", directory = join(root, "diagnostics"), reports = join(directory, "reports");
    await mkdir(reports, { recursive: true });
    await writeFile(join(reports, "old.json"), "x".repeat(100));
    const recorder = new DiagnosticRecorder(ref => ref === workRef ? directory : undefined, undefined, { maxDirectoryBytes: 10 });
    try {
      const started = await recorder.startCapture(workRef);
      await expect(stat(join(reports, "old.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await stat(join(directory, "runs", `${started.diagnosticRunRef}.meta.json`));
      await stat(join(directory, "runs", `${started.diagnosticRunRef}.events.jsonl`));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
