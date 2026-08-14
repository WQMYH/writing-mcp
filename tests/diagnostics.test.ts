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
});
