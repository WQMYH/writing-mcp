import type { PostCallDiagnostic, SafeErrorDetail } from "./diagnostics.js";

export const STRUCTURED_RESULT_MAX_BYTES = 200_000;
export const DIAGNOSTIC_MAX_BYTES = 8_192;
export const MARKDOWN_MAX_BYTES = 16_384;

type JsonRecord = Record<string, unknown>;
type ReturnedError = SafeErrorDetail & { traceId: string };
export type StructuredResult =
  | { ok: true; data: JsonRecord; diagnostic: PostCallDiagnostic }
  | { ok: false; error: ReturnedError; diagnostic: PostCallDiagnostic };

export function compactJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function createDiagnosticReserve(tool: string, outcome: "success" | "failure"): PostCallDiagnostic {
  const diagnostic: PostCallDiagnostic = {
    schemaVersion: 1,
    traceId: "trace-reserved",
    tool,
    outcome,
    recordedAt: "2000-01-01T00:00:00.000Z",
    elapsedMs: 0,
    persistence: "skipped",
    executionSummary: { action: tool, outcome, message: "", details: {} },
  };
  const padding = DIAGNOSTIC_MAX_BYTES - compactJsonBytes(diagnostic);
  if (padding < 0) throw new Error("Diagnostic reserve metadata exceeds its byte budget");
  const reserved = { ...diagnostic, executionSummary: { ...diagnostic.executionSummary, message: "x".repeat(padding) } };
  if (compactJsonBytes(reserved) !== DIAGNOSTIC_MAX_BYTES) throw new Error("Diagnostic reserve does not occupy its exact byte budget");
  return reserved;
}

export function fitBusinessData(tool: string, value: JsonRecord, maxBytes = STRUCTURED_RESULT_MAX_BYTES): JsonRecord {
  const reserve = createDiagnosticReserve(tool, "success");
  const fits = (data: JsonRecord): boolean => compactJsonBytes({ ok: true, data, diagnostic: reserve }) <= maxBytes;
  if (fits(value)) return value;
  if (tool === "writing_explore") return reduceExplore(value, fits);
  if (tool === "writing_context") return reduceContext(value, fits);
  if (tool === "writing_resolve") return reduceResolve(value, fits);
  if (tool === "writing_diagnose") return reduceDiagnose(value, fits);
  throw responseTooLarge(tool);
}

function reduceExplore(value: JsonRecord, fits: (data: JsonRecord) => boolean): JsonRecord {
  const originalAmbiguous = arrayOfRecords(value.ambiguous);
  const originalResults = arrayOfRecords(value.results);
  const metrics = asRecord(value.metrics);
  if (!metrics) throw responseTooLarge("writing_explore");
  let keptAmbiguous = [...originalAmbiguous];
  let keptResults = [...originalResults];
  let dropped = 0;
  const diagnostics = upsertTruncationDiagnostic(value.diagnostics, "Response data was deterministically reduced to the MCP byte limit.");
  const build = (): JsonRecord => ({
    ...value,
    ambiguous: keptAmbiguous,
    results: keptResults,
    truncated: true,
    metrics: {
      ...metrics,
      returnedCount: keptResults.length,
      omittedEstimate: numeric(metrics.omittedEstimate) + dropped,
    },
    diagnostics,
  });
  let reduced = build();
  while (!fits(reduced) && keptAmbiguous.length) {
    keptAmbiguous = keptAmbiguous.slice(0, -1);
    dropped += 1;
    reduced = build();
  }
  while (!fits(reduced) && keptResults.length) {
    keptResults = keptResults.slice(0, -1);
    dropped += 1;
    reduced = build();
  }
  if (!fits(reduced)) throw responseTooLarge("writing_explore");
  return reduced;
}

function reduceContext(value: JsonRecord, fits: (data: JsonRecord) => boolean): JsonRecord {
  let blocks = arrayOfRecords(value.blocks);
  let omitted = arrayOfRecords(value.omitted);
  const build = (): JsonRecord => ({
    ...value,
    status: value.status === "budget_unsatisfiable" ? "budget_unsatisfiable" : "truncated",
    blocks,
    omitted,
    usedTokens: blocks.reduce((sum, block) => sum + numeric(block.tokens), 0),
  });
  let reduced = build();
  for (const layer of ["L3", "L2", "L1", "L0"] as const) {
    while (!fits(reduced)) {
      let removable = -1;
      for (let index = 0; index < blocks.length; index += 1) if (blocks[index]?.layer === layer && blocks[index]?.required !== true) removable = index;
      if (removable < 0) break;
      const [removed] = blocks.splice(removable, 1);
      if (!removed) break;
      const row = { ref: String(removed.ref ?? ""), reason: "response_limit", tokens: numeric(removed.tokens) };
      const existing = omitted.findIndex(item => item.ref === row.ref);
      omitted = existing >= 0 ? omitted.map((item, index) => index === existing ? row : item) : [...omitted, row];
      reduced = build();
    }
    if (fits(reduced)) return reduced;
  }
  throw responseTooLarge("writing_context");
}

function reduceResolve(value: JsonRecord, fits: (data: JsonRecord) => boolean): JsonRecord {
  const status = value.status;
  if (status === "unsupported") throw responseTooLarge("writing_resolve");
  let candidates = arrayOfRecords(value.candidates);
  const selectedWorkRef = status === "resolved" && typeof value.workRef === "string" ? value.workRef : undefined;
  if (status === "resolved" && !candidates.some(candidate => candidate.workRef === selectedWorkRef)) throw responseTooLarge("writing_resolve");
  const diagnostics = upsertTruncationDiagnostic(value.diagnostics, "Candidate list was deterministically reduced to the MCP byte limit.");
  const base = { ...value };
  if (status === "ambiguous") delete base.workRef;
  const build = (): JsonRecord => ({ ...base, candidates, diagnostics });
  let reduced = build();
  while (!fits(reduced)) {
    let removable = candidates.length - 1;
    while (removable >= 0 && selectedWorkRef !== undefined && candidates[removable]?.workRef === selectedWorkRef) removable -= 1;
    if (removable < 0) throw responseTooLarge("writing_resolve");
    candidates = candidates.filter((_, index) => index !== removable);
    reduced = build();
  }
  return reduced;
}

function reduceDiagnose(value: JsonRecord, fits: (data: JsonRecord) => boolean): JsonRecord {
  if (!Array.isArray(value.recentEvents)) throw responseTooLarge("writing_diagnose");
  let recentEvents = [...value.recentEvents];
  const build = (): JsonRecord => ({ ...value, recentEvents, truncated: true });
  let reduced = build();
  while (!fits(reduced) && recentEvents.length) {
    recentEvents = recentEvents.slice(0, -1);
    reduced = build();
  }
  if (!fits(reduced)) throw responseTooLarge("writing_diagnose");
  return reduced;
}

export function boundDiagnostic(diagnostic: PostCallDiagnostic, maxBytes = DIAGNOSTIC_MAX_BYTES): PostCallDiagnostic {
  let bounded = clone(diagnostic);
  if (compactJsonBytes(bounded) <= maxBytes) return bounded;
  for (const key of ["persistenceError", "artifactSha256", "artifactPath", "artifactRef", "revision", "workRef"] as const) {
    delete (bounded as unknown as JsonRecord)[key];
    if (compactJsonBytes(bounded) <= maxBytes) return bounded;
  }
  const details = { ...bounded.executionSummary.details };
  for (const key of Object.keys(details).sort().reverse()) {
    delete details[key];
    bounded = { ...bounded, executionSummary: { ...bounded.executionSummary, details } };
    if (compactJsonBytes(bounded) <= maxBytes) return bounded;
  }
  bounded = truncateDiagnosticMessage(bounded, maxBytes);
  if (compactJsonBytes(bounded) > maxBytes) throw new Error("Required diagnostic fields exceed the diagnostic byte limit");
  return bounded;
}

function truncateDiagnosticMessage(diagnostic: PostCallDiagnostic, maxBytes: number): PostCallDiagnostic {
  const chars = [...diagnostic.executionSummary.message];
  let low = 0;
  let high = chars.length;
  let best = { ...diagnostic, executionSummary: { ...diagnostic.executionSummary, message: "" } };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { ...diagnostic, executionSummary: { ...diagnostic.executionSummary, message: chars.slice(0, middle).join("") } };
    if (compactJsonBytes(candidate) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

export function boundError(tool: string, detail: ReturnedError, maxBytes = STRUCTURED_RESULT_MAX_BYTES): ReturnedError {
  const reserve = createDiagnosticReserve(tool, "failure");
  const fits = (error: ReturnedError): boolean => compactJsonBytes({ ok: false, error, diagnostic: reserve }) <= maxBytes;
  const safe: { code: string; message: string; traceId: string; recovery?: string } = {
    code: truncateUtf8(detail.code, 256),
    message: detail.message,
    traceId: detail.traceId,
    ...(detail.recovery ? { recovery: detail.recovery } : {}),
  };
  if (fits(safe)) return safe;
  delete safe.recovery;
  if (fits(safe)) return safe;
  const chars = [...safe.message];
  let low = 0;
  let high = chars.length;
  let best = { ...safe, message: "" };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { ...safe, message: chars.slice(0, middle).join("") };
    if (fits(candidate)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (!fits(best)) throw new Error("Required error fields exceed the structured response byte limit");
  return best;
}

export function assembleResult(result: StructuredResult): { content: Array<{ type: "text"; text: string }>; structuredContent: { result: StructuredResult }; isError?: true } {
  if (compactJsonBytes(result) > STRUCTURED_RESULT_MAX_BYTES) throw new Error("Final structured result exceeds the server byte limit");
  const text = renderMarkdown(result);
  return {
    content: [{ type: "text", text }],
    structuredContent: { result },
    ...(!result.ok ? { isError: true as const } : {}),
  };
}

export function renderMarkdown(result: StructuredResult): string {
  const diagnostic = result.diagnostic;
  const lines = [
    `# ${diagnostic.tool}`,
    "",
    `- Outcome: ${result.ok ? "success" : "failure"}`,
    `- Trace: ${diagnostic.traceId}`,
  ];
  if (diagnostic.artifactRef) lines.push(`- Diagnostic artifact: ${diagnostic.artifactRef}`);
  if (result.ok) {
    const data = result.data;
    for (const key of ["workRef", "revision", "status"] as const) if (data[key] !== undefined) lines.push(`- ${key}: ${String(data[key])}`);
    const kept = firstArrayLength(data, ["results", "blocks", "candidates", "recentEvents"]);
    const metrics = asRecord(data.metrics);
    const omitted = Array.isArray(data.omitted) ? data.omitted.length : typeof metrics?.omittedEstimate === "number" ? metrics.omittedEstimate : Array.isArray(data.ambiguous) ? data.ambiguous.length : undefined;
    if (kept !== undefined) lines.push(`- Kept: ${kept}`);
    if (omitted !== undefined) lines.push(`- Omitted: ${omitted}`);
    if (data.truncated === true) lines.push("- Truncated: true (RESPONSE_TRUNCATED)");
  } else {
    lines.push(`- Error: ${result.error.code}`);
    lines.push(`- Message: ${result.error.message}`);
    if (result.error.recovery) lines.push(`- Recovery: ${result.error.recovery}`);
  }
  return truncateUtf8(`${lines.join("\n")}\n`, MARKDOWN_MAX_BYTES);
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let used = 0;
  let output = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > maxBytes) break;
    output += character;
    used += size;
  }
  return output;
}

function upsertTruncationDiagnostic(value: unknown, message: string): JsonRecord[] {
  const diagnostics = arrayOfRecords(value).filter(item => item.code !== "RESPONSE_TRUNCATED");
  return [...diagnostics, { code: "RESPONSE_TRUNCATED", message }];
}

function firstArrayLength(value: JsonRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) if (Array.isArray(value[key])) return value[key].length;
  return undefined;
}

function responseTooLarge(tool: string): Error {
  return Object.assign(new Error(`${tool} cannot produce a schema-valid result within the MCP response byte limit`), { code: "RESPONSE_TOO_LARGE" });
}

function numeric(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function asRecord(value: unknown): JsonRecord | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined; }
function arrayOfRecords(value: unknown): JsonRecord[] { return Array.isArray(value) ? value.filter((item): item is JsonRecord => asRecord(item) !== undefined) : []; }
function clone<T>(value: T): T { return structuredClone(value); }
