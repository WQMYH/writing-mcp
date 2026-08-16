import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REPORT_SCHEMA_VERSION = 1;
const MAX_GENERAL_EVENTS = 1_000;
const MAX_GENERAL_BYTES = 5 * 1024 * 1024;
const MAX_CAPTURE_CALLS = 500;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 100 * 1024 * 1024;
const MAX_CAPTURE_REF_ENTRIES = 100;

export type DiagnosticPurpose = "usage" | "development";
export type DiagnosticContentPolicy = "metadata" | "query";
export type DiagnosticOutcome = "success" | "failure";
export type DiagnosticPersistence = "persisted" | "skipped" | "failed";

export interface SafeErrorDetail {
  readonly code: string;
  readonly message: string;
  readonly recovery?: string;
}

export interface ExecutionSummary {
  readonly action: string;
  readonly outcome: DiagnosticOutcome;
  readonly message: string;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

export interface PostCallDiagnostic {
  readonly schemaVersion: number;
  readonly traceId: string;
  readonly tool: string;
  readonly outcome: DiagnosticOutcome;
  readonly recordedAt: string;
  readonly elapsedMs: number;
  readonly workRef?: string;
  readonly revision?: number;
  readonly persistence: DiagnosticPersistence;
  readonly artifactRef?: string;
  readonly artifactPath?: string;
  readonly artifactSha256?: string;
  readonly persistenceError?: string;
  readonly executionSummary: ExecutionSummary;
}

export interface RecordInvocationInput {
  readonly traceId: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly error?: SafeErrorDetail;
  readonly elapsedMs: number;
  readonly diagnosticRunRef?: string;
}

interface InvocationEvent {
  readonly schemaVersion: number;
  readonly traceId: string;
  readonly diagnosticRunRef?: string;
  readonly sequence?: number;
  readonly tool: string;
  readonly outcome: DiagnosticOutcome;
  readonly recordedAt: string;
  readonly elapsedMs: number;
  readonly workRef?: string;
  readonly revision?: number;
  readonly inputSummary: unknown;
  readonly outputSummary?: unknown;
  readonly outputHits?: unknown;
  readonly error?: { readonly code: string; readonly recoverable: boolean };
  readonly executionSummary: ExecutionSummary;
}

interface CaptureMeta {
  readonly schemaVersion: number;
  readonly diagnosticRunRef: string;
  readonly workRef: string;
  readonly purpose: "development";
  readonly contentPolicy: DiagnosticContentPolicy;
  readonly label?: string;
  readonly startedAt: string;
  readonly status: "active" | "closed";
  readonly nextSequence: number;
  readonly truncated: boolean;
  readonly artifact?: CaptureArtifactInfo;
}

export interface CaptureArtifactInfo {
  readonly artifactRef: string;
  readonly artifactPath: string;
  readonly schemaVersion: number;
  readonly sha256: string;
  readonly calls: number;
  readonly failures: number;
  readonly truncated: boolean;
}

export interface CaptureStartResult {
  readonly action: "start_capture";
  readonly workRef: string;
  readonly purpose: "development";
  readonly diagnosticRunRef: string;
  readonly contentPolicy: DiagnosticContentPolicy;
  readonly limits: { readonly calls: number; readonly bytes: number };
}

export interface CaptureFinishResult extends CaptureArtifactInfo {
  readonly action: "finish_capture";
  readonly workRef: string;
  readonly purpose: "development";
  readonly diagnosticRunRef: string;
  readonly formats: ReadonlyArray<"json" | "markdown">;
}

export interface InspectResult {
  readonly action: "inspect";
  readonly workRef: string;
  readonly purpose: DiagnosticPurpose;
  readonly status: "healthy" | "degraded";
  readonly eventHistoryAvailable: boolean;
  readonly recentEvents: ReadonlyArray<unknown>;
  readonly diagnosticsDirectory: string;
  readonly observationScope: "mcp_calls_only";
}

type DirectoryResolver = (workRef?: string) => string | undefined;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const asRecord = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export class DiagnosticRecorder {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly resolveDirectory: DirectoryResolver) {}

  // Diagnostic files are disposable derived artifacts. Keep detailed data on
  // disk only: never log it to stdout (reserved for MCP) or copy source excerpts,
  // absolute paths, stacks, SQL, or credentials into invocation reports.

  newTraceId(): string {
    return `trace-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  }

  async assertCaptureActive(workRef: string, diagnosticRunRef?: string): Promise<void> {
    if (!diagnosticRunRef) return;
    const meta = await this.readCaptureMeta(workRef, diagnosticRunRef);
    if (meta.status !== "active") throw codedError("DIAGNOSTIC_RUN_CLOSED", `Diagnostic run ${diagnosticRunRef} is already closed`);
  }

  async startCapture(workRef: string, label?: string, contentPolicy: DiagnosticContentPolicy = "metadata"): Promise<CaptureStartResult> {
    const directory = this.requireDirectory(workRef);
    await mkdir(join(directory, "runs"), { recursive: true });
    if (await directorySize(directory) >= MAX_DIAGNOSTIC_BYTES) {
      throw codedError("DIAGNOSTIC_STORAGE_LIMIT", "Diagnostic storage reached the 100 MiB limit; remove old derived reports before starting another capture");
    }
    const diagnosticRunRef = `diag-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const meta: CaptureMeta = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      diagnosticRunRef,
      workRef,
      purpose: "development",
      contentPolicy,
      ...(label?.trim() ? { label: sanitizeLabel(label) } : {}),
      startedAt: new Date().toISOString(),
      status: "active",
      nextSequence: 1,
      truncated: false,
    };
    await atomicWrite(this.metaPath(directory, diagnosticRunRef), JSON.stringify(meta, null, 2));
    await writeFile(this.eventsPath(directory, diagnosticRunRef), "", { flag: "wx" });
    return { action: "start_capture", workRef, purpose: "development", diagnosticRunRef, contentPolicy, limits: { calls: MAX_CAPTURE_CALLS, bytes: MAX_CAPTURE_BYTES } };
  }

  async finishCapture(workRef: string, diagnosticRunRef: string, formats: ReadonlyArray<"json" | "markdown"> = ["json"]): Promise<CaptureFinishResult> {
    return this.serial(diagnosticRunRef, async () => {
      const directory = this.requireDirectory(workRef);
      const meta = await this.readCaptureMeta(workRef, diagnosticRunRef);
      const normalizedFormats = [...new Set<"json" | "markdown">(["json", ...formats])];
      if (meta.status === "closed" && meta.artifact) {
        return { action: "finish_capture", workRef, purpose: "development", diagnosticRunRef, formats: normalizedFormats, ...meta.artifact };
      }
      const calls = await readJsonLines(this.eventsPath(directory, diagnosticRunRef)) as InvocationEvent[];
      const failures = calls.filter(call => call.outcome === "failure").length;
      const revisions = calls.map(call => call.revision).filter((value): value is number => typeof value === "number");
      const artifact = {
        schemaVersion: REPORT_SCHEMA_VERSION,
        diagnosticRunRef,
        workRef,
        status: meta.truncated ? "truncated" : "complete",
        purpose: "development",
        observationScope: "mcp_calls_only",
        contentPolicy: meta.contentPolicy,
        startedAt: meta.startedAt,
        finishedAt: new Date().toISOString(),
        revisions: { ...(revisions.length ? { before: revisions[0], after: revisions.at(-1) } : {}) },
        calls,
        findings: failures ? [{ code: "TOOL_FAILURES_OBSERVED", severity: "warning", evidenceRefs: calls.filter(call => call.error).map(call => call.traceId) }] : [],
        aggregate: { calls: calls.length, failures, elapsedMs: calls.reduce((sum, call) => sum + call.elapsedMs, 0) },
        ...(meta.truncated ? { truncation: { atSequence: meta.nextSequence - 1, omittedReason: "capture_limit" } } : {}),
        redactions: ["source_text", "returned_excerpts", "absolute_paths", "stack_traces", "sql", "credentials", "agent_reasoning", "non_mcp_tools"],
      };
      const json = JSON.stringify(artifact, null, 2);
      const jsonPath = join(directory, "runs", `${diagnosticRunRef}.json`);
      await atomicWrite(jsonPath, json);
      if (normalizedFormats.includes("markdown")) await atomicWrite(join(directory, "runs", `${diagnosticRunRef}.md`), renderCaptureMarkdown(artifact));
      const artifactInfo: CaptureArtifactInfo = {
        artifactRef: `diagnostic-artifact-${diagnosticRunRef}`,
        artifactPath: `runs/${diagnosticRunRef}.json`,
        schemaVersion: REPORT_SCHEMA_VERSION,
        sha256: hash(json),
        calls: calls.length,
        failures,
        truncated: meta.truncated,
      };
      const closed: CaptureMeta = { ...meta, status: "closed", artifact: artifactInfo };
      await atomicWrite(this.metaPath(directory, diagnosticRunRef), JSON.stringify(closed, null, 2));
      return { action: "finish_capture", workRef, purpose: "development", diagnosticRunRef, formats: normalizedFormats, ...artifactInfo };
    });
  }

  async inspect(workRef: string, purpose: DiagnosticPurpose, limit = 20): Promise<InspectResult> {
    const directory = this.requireDirectory(workRef);
    const events = await readJsonLines(join(directory, "diagnostics.jsonl"));
    const recent = events.slice(-Math.max(1, Math.min(limit, 100)));
    return {
      action: "inspect",
      workRef,
      purpose,
      status: recent.some(event => asRecord(event)?.outcome === "failure") ? "degraded" : "healthy",
      eventHistoryAvailable: events.length > 0,
      recentEvents: purpose === "development" ? recent : recent.map(effectView),
      diagnosticsDirectory: "diagnostics/",
      observationScope: "mcp_calls_only",
    };
  }

  async record(input: RecordInvocationInput): Promise<PostCallDiagnostic> {
    const recordedAt = new Date().toISOString();
    const outcome: DiagnosticOutcome = input.error ? "failure" : "success";
    const workRef = stringField(input.input, "workRef") ?? stringField(input.output, "workRef");
    const revision = numberField(input.output, "revision");
    const executionSummary = summarizeExecution(input.tool, outcome, input.output, input.error);
    const base: Omit<PostCallDiagnostic, "persistence"> = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      traceId: input.traceId,
      tool: input.tool,
      outcome,
      recordedAt,
      elapsedMs: input.elapsedMs,
      ...(workRef ? { workRef } : {}),
      ...(revision !== undefined ? { revision } : {}),
      executionSummary,
    };
    const directory = this.resolveDirectory(workRef);
    if (!directory) return { ...base, persistence: "skipped", persistenceError: "No authorized diagnostic directory is available" };
    const event: InvocationEvent = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      traceId: input.traceId,
      ...(input.diagnosticRunRef ? { diagnosticRunRef: input.diagnosticRunRef } : {}),
      tool: input.tool,
      outcome,
      recordedAt,
      elapsedMs: input.elapsedMs,
      ...(workRef ? { workRef } : {}),
      ...(revision !== undefined ? { revision } : {}),
      inputSummary: summarizeInput(input.input),
      ...(input.output ? { outputSummary: summarizeOutput(input.tool, input.output) } : {}),
      ...(input.error ? { error: { code: input.error.code, recoverable: input.error.code !== "INTERNAL_ERROR" } } : {}),
      executionSummary,
    };
    try {
      await mkdir(join(directory, "reports"), { recursive: true });
      await rotateGeneralEvents(join(directory, "diagnostics.jsonl"));
      await appendFile(join(directory, "diagnostics.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
      let capturePersistenceError: string | undefined;
      if (input.diagnosticRunRef && workRef) {
        try { await this.appendCaptureEvent(workRef, input.diagnosticRunRef, event, input.input, input.output); }
        catch (error) { capturePersistenceError = diagnosticWriteCode(error); }
      }
      const reportJson = JSON.stringify({ ...event, observationScope: "mcp_calls_only", redactions: ["source_text", "returned_excerpts", "absolute_paths", "stack_traces", "sql", "credentials"] }, null, 2);
      const reportName = `${input.traceId}.json`;
      await atomicWrite(join(directory, "reports", reportName), reportJson);
      return {
        ...base,
        persistence: "persisted",
        artifactRef: `diagnostic-artifact-${input.traceId}`,
        artifactPath: `reports/${reportName}`,
        artifactSha256: hash(reportJson),
        ...(capturePersistenceError ? { persistenceError: capturePersistenceError } : {}),
      };
    } catch (error) {
      return { ...base, persistence: "failed", persistenceError: diagnosticWriteCode(error) };
    }
  }

  private async appendCaptureEvent(workRef: string, diagnosticRunRef: string, event: InvocationEvent, rawInput: Readonly<Record<string, unknown>>, output?: Readonly<Record<string, unknown>>): Promise<void> {
    await this.serial(diagnosticRunRef, async () => {
      const directory = this.requireDirectory(workRef);
      const meta = await this.readCaptureMeta(workRef, diagnosticRunRef);
      if (meta.status !== "active") throw codedError("DIAGNOSTIC_RUN_CLOSED", `Diagnostic run ${diagnosticRunRef} is already closed`);
      const eventsPath = this.eventsPath(directory, diagnosticRunRef);
      const size = await fileSize(eventsPath);
      if (meta.nextSequence > MAX_CAPTURE_CALLS || size >= MAX_CAPTURE_BYTES) {
        if (!meta.truncated) await atomicWrite(this.metaPath(directory, diagnosticRunRef), JSON.stringify({ ...meta, truncated: true }, null, 2));
        return;
      }
      const query = meta.contentPolicy === "query" && typeof rawInput.query === "string" ? rawInput.query : undefined;
      const inputSummary = asRecord(event.inputSummary) ?? {};
      const hits = captureOutputHits(output);
      const sequenced: InvocationEvent = { ...event, sequence: meta.nextSequence, ...(query !== undefined ? { inputSummary: { ...inputSummary, query } } : {}), ...(hits ? { outputHits: hits } : {}) };
      await appendFile(eventsPath, `${JSON.stringify(sequenced)}\n`, "utf8");
      await atomicWrite(this.metaPath(directory, diagnosticRunRef), JSON.stringify({ ...meta, nextSequence: meta.nextSequence + 1 }, null, 2));
    });
  }

  private async readCaptureMeta(workRef: string, diagnosticRunRef: string): Promise<CaptureMeta> {
    const directory = this.requireDirectory(workRef);
    try {
      const parsed = JSON.parse(await readFile(this.metaPath(directory, diagnosticRunRef), "utf8")) as CaptureMeta;
      if (parsed.workRef !== workRef) throw codedError("DIAGNOSTIC_RUN_NOT_FOUND", `Diagnostic run ${diagnosticRunRef} does not belong to ${workRef}`);
      return parsed;
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "DIAGNOSTIC_RUN_NOT_FOUND") throw error;
      throw codedError("DIAGNOSTIC_RUN_NOT_FOUND", `Diagnostic run ${diagnosticRunRef} was not found`);
    }
  }

  private requireDirectory(workRef?: string): string {
    const directory = this.resolveDirectory(workRef);
    if (!directory) throw codedError("DIAGNOSTIC_RUN_NOT_FOUND", "No authorized diagnostic directory is available");
    return directory;
  }

  private metaPath(directory: string, diagnosticRunRef: string): string { return join(directory, "runs", `${diagnosticRunRef}.meta.json`); }
  private eventsPath(directory: string, diagnosticRunRef: string): string { return join(directory, "runs", `${diagnosticRunRef}.events.jsonl`); }

  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    const marker = current.then(() => undefined, () => undefined);
    this.queues.set(key, marker);
    try { return await current; } finally { if (this.queues.get(key) === marker) this.queues.delete(key); }
  }
}

function summarizeExecution(tool: string, outcome: DiagnosticOutcome, output?: Readonly<Record<string, unknown>>, error?: SafeErrorDetail): ExecutionSummary {
  if (error) return { action: tool, outcome, message: `${tool} failed with ${error.code}`, details: { errorCode: error.code } };
  const summary = summarizeOutput(tool, output ?? {});
  const details: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(summary)) if (["string", "number", "boolean"].includes(typeof value)) details[key] = value as string | number | boolean;
  return { action: tool, outcome, message: `${tool} completed`, details };
}

function summarizeInput(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  const safeStrings = new Set(["workRef", "adapterHint", "mode", "operation", "taskType", "purpose", "action", "diagnosticRunRef", "contentPolicy"]);
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") summary[key] = safeStrings.has(key) ? value : { type: "string", length: value.length, sha256: hash(value) };
    else if (Array.isArray(value)) summary[key] = { type: "array", length: value.length, sha256: hash(JSON.stringify(value)) };
    else if (["number", "boolean"].includes(typeof value) || value == null) summary[key] = value;
    else summary[key] = { type: "object", sha256: hash(JSON.stringify(value)) };
  }
  return summary;
}

function summarizeOutput(tool: string, output: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of ["status", "workRef", "revision", "schemaVersion", "freshness", "operation", "budgetTokens", "usedTokens", "estimated", "estimator", "truncated", "diagnosticRunRef", "artifactRef", "artifactPath"]) {
    const value = output[key]; if (["string", "number", "boolean"].includes(typeof value)) summary[key] = value;
  }
  for (const key of ["candidates", "results", "ambiguous", "blocks", "omitted", "diagnostics", "recentEvents"]) if (Array.isArray(output[key])) summary[`${key}Count`] = output[key].length;
  for (const key of ["stats", "metrics", "limits", "aggregate"]) if (asRecord(output[key])) summary[key] = output[key];
  summary.tool = tool;
  return summary;
}

// Bounded hit detail for development captures only (AUD-023): which refs were
// returned, with trust label, score, and a hash of their locators. Titles,
// excerpts, paths, and locator content itself never enter this view.
function captureOutputHits(output: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> | undefined {
  if (!output) return undefined;
  const itemEntry = (value: unknown, extra?: (item: Record<string, unknown>, entry: Record<string, unknown>) => void): Record<string, unknown> | undefined => {
    const item = asRecord(value);
    if (!item) return undefined;
    const entry: Record<string, unknown> = {};
    for (const key of ["ref", "kind", "sourceKind"]) { const field = item[key]; if (typeof field === "string") entry[key] = field; }
    if (typeof item.score === "number") entry.score = item.score;
    const locators = asRecord(item.evidence)?.locators;
    if (Array.isArray(locators) && locators.length) entry.locatorsSha256 = hash(JSON.stringify(locators));
    extra?.(item, entry);
    return entry;
  };
  const bounded = (values: unknown): unknown[] => Array.isArray(values) ? values.slice(0, MAX_CAPTURE_REF_ENTRIES) : [];
  const hits: Record<string, unknown> = {};
  for (const key of ["results", "ambiguous"] as const) {
    const entries = bounded(output[key]).map(value => itemEntry(value)).filter((entry): entry is Record<string, unknown> => entry !== undefined);
    if (entries.length) hits[key] = entries;
  }
  const blocks = bounded(output.blocks).map(value => itemEntry(value, (item, entry) => {
    if (typeof item.layer === "string") entry.layer = item.layer;
    if (typeof item.tokens === "number") entry.tokens = item.tokens;
    if (typeof item.required === "boolean") entry.required = item.required;
  })).filter((entry): entry is Record<string, unknown> => entry !== undefined);
  if (blocks.length) hits.blocks = blocks;
  const omitted = bounded(output.omitted).map(value => {
    const item = asRecord(value);
    if (!item) return undefined;
    const entry: Record<string, unknown> = {};
    if (typeof item.ref === "string") entry.ref = item.ref;
    if (typeof item.reason === "string") entry.reason = item.reason;
    if (typeof item.tokens === "number") entry.tokens = item.tokens;
    return entry;
  }).filter((entry): entry is Record<string, unknown> => entry !== undefined);
  if (omitted.length) hits.omitted = omitted;
  const candidates = bounded(output.candidates).map(value => {
    const item = asRecord(value);
    if (!item) return undefined;
    const entry: Record<string, unknown> = {};
    if (typeof item.workRef === "string") entry.workRef = item.workRef;
    if (typeof item.adapter === "string") entry.adapter = item.adapter;
    return entry;
  }).filter((entry): entry is Record<string, unknown> => entry !== undefined);
  if (candidates.length) hits.candidates = candidates;
  return Object.keys(hits).length ? hits : undefined;
}

function effectView(value: unknown): unknown {
  const event = asRecord(value);
  if (!event) return value;
  return { traceId: event.traceId, tool: event.tool, outcome: event.outcome, recordedAt: event.recordedAt, executionSummary: event.executionSummary };
}

function stringField(value: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined { const field = value?.[key]; return typeof field === "string" ? field : undefined; }
function numberField(value: Readonly<Record<string, unknown>> | undefined, key: string): number | undefined { const field = value?.[key]; return typeof field === "number" ? field : undefined; }
function sanitizeLabel(value: string): string { return value.trim().replace(/[\r\n\t]/g, " ").slice(0, 80); }

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJsonLines(path: string): Promise<unknown[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as unknown);
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function fileSize(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch (error) { if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return 0; throw error; }
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) total += entry.isDirectory() ? await directorySize(join(path, entry.name)) : await fileSize(join(path, entry.name));
  } catch (error) { if (!(typeof error === "object" && error && "code" in error && error.code === "ENOENT")) throw error; }
  return total;
}

async function rotateGeneralEvents(path: string): Promise<void> {
  const size = await fileSize(path);
  const events = await readJsonLines(path);
  if (size < MAX_GENERAL_BYTES && events.length < MAX_GENERAL_EVENTS) return;
  const retained = events.slice(-Math.floor(MAX_GENERAL_EVENTS / 2));
  await atomicWrite(path, retained.map(event => JSON.stringify(event)).join("\n") + (retained.length ? "\n" : ""));
}

function diagnosticWriteCode(error: unknown): string {
  return typeof error === "object" && error && "code" in error ? String(error.code) : "DIAGNOSTIC_WRITE_FAILED";
}

function renderCaptureMarkdown(artifact: Record<string, unknown>): string {
  const aggregate = asRecord(artifact.aggregate) ?? {};
  return [
    `# Writing MCP Diagnostic ${String(artifact.diagnosticRunRef)}`,
    "",
    `- Status: ${String(artifact.status)}`,
    `- Work: ${String(artifact.workRef)}`,
    `- Observation scope: MCP calls only`,
    `- Calls: ${String(aggregate.calls ?? 0)}`,
    `- Failures: ${String(aggregate.failures ?? 0)}`,
    `- Elapsed: ${String(aggregate.elapsedMs ?? 0)} ms`,
    "",
    "This report excludes agent reasoning, non-MCP tools, source text, absolute paths, stack traces, SQL, and credentials.",
    "",
  ].join("\n");
}
