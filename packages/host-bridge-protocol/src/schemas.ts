import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const PROTOCOL_VERSION_SCHEMA = z.literal(1);

export const BRIDGE_LOOPBACK_HOST = "127.0.0.1";
export const BRIDGE_DEFAULT_PORT = 48_931;

export const LIMITS = {
  maxDocumentBytes: 16 * 1024 * 1024,
  maxTotalDocumentBytes: 64 * 1024 * 1024,
  maxDocuments: 4096,
  maxRawBodyBytes: 72 * 1024 * 1024,
} as const;

export const TIMEOUTS = {
  toolMs: 15_000,
  snapshotMs: 120_000,
} as const;

export const AUTH = {
  pairingCodeTtlMs: 600_000,
  pairingCodeMinEntropyBits: 128,
  tokenTtlMs: 3_600_000,
} as const;

export const HOST_PROJECT_ID_MAX = 128;
export const hostProjectIdSchema = z.string().min(1).max(HOST_PROJECT_ID_MAX).regex(/^[A-Za-z0-9._:-]+$/);

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const sha256Schema = z.string().regex(SHA256_PATTERN);

export const SNAPSHOT_CATEGORIES = ["project", "world", "character", "outline", "chapter", "foreshadow"] as const;
export const snapshotCategorySchema = z.enum(SNAPSHOT_CATEGORIES);

export function validateRelativePath(value: string): boolean {
  if (value.includes("\\") || value.includes("\0")) return false;
  if (!value.endsWith(".md")) return false;
  if (value.startsWith("/")) return false;
  for (const segment of value.split("/")) {
    if (segment.length === 0 || segment === "." || segment === ".." || segment.startsWith(".")) return false;
  }
  return true;
}

const CHAPTER_KEY_PATTERN = /^(?:n:(?:0|[1-9][0-9]*)|s:.+)$/;

export const snapshotDocumentSchema = z.strictObject({
  relativePath: z.string().refine(validateRelativePath),
  category: snapshotCategorySchema,
  mediaType: z.literal("text/markdown"),
  content: z.string(),
  sha256: sha256Schema,
});

export const chapterMappingSchema = z.strictObject({
  chapterKey: z.string().regex(CHAPTER_KEY_PATTERN),
  ordinal: z.number().int().min(1),
});

export const chapterMappingsSchema = z.array(chapterMappingSchema).superRefine((chapters, ctx) => {
  const sorted = [...chapters].sort((left, right) => left.ordinal - right.ordinal);
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index].ordinal !== index + 1) {
      ctx.addIssue({ code: "custom", message: "chapter ordinals must be contiguous integers starting at 1" });
      return;
    }
  }
  const keys = new Set(chapters.map((chapter) => chapter.chapterKey));
  if (keys.size !== chapters.length) {
    ctx.addIssue({ code: "custom", message: "chapterKey must be unique" });
  }
});

const documentListSchema = z.array(snapshotDocumentSchema).max(LIMITS.maxDocuments).superRefine((documents, ctx) => {
  const paths = new Set(documents.map((document) => document.relativePath));
  if (paths.size !== documents.length) {
    ctx.addIssue({ code: "custom", message: "relativePath must be unique" });
  }
});

export const hostSnapshotDraftSchema = z.strictObject({
  protocolVersion: PROTOCOL_VERSION_SCHEMA,
  pluginId: z.literal("storyforge"),
  hostProjectId: hostProjectIdSchema,
  hostRevision: z.string().min(1).max(256).optional(),
  documents: documentListSchema,
  chapters: chapterMappingsSchema,
  claimedSnapshotHash: sha256Schema,
});

export const sessionStateSchema = z.enum(["unpaired", "paired", "expired"]);
export const bridgeProcessStateSchema = z.enum(["starting", "ready", "degraded", "stopped"]);
export const pluginStateSchema = z.enum(["enabled", "disabled", "revoked"]);
export const projectBindingStateSchema = z.enum(["empty", "snapshotting", "indexing", "fresh", "stale", "degraded"]);

export const BRIDGE_ERROR_CODES = [
  "BRIDGE_PAIRING_CODE_INVALID",
  "BRIDGE_PAIRING_CODE_EXPIRED",
  "BRIDGE_TOKEN_EXPIRED",
  "BRIDGE_HOST_DENIED",
  "BRIDGE_ORIGIN_DENIED",
  "BRIDGE_REQUEST_TOO_LARGE",
  "BRIDGE_PROJECT_ID_INVALID",
  "BRIDGE_TOOL_REQUEST_INVALID",
  "BRIDGE_SNAPSHOT_INVALID",
  "BRIDGE_SNAPSHOT_ACTIVATION_FAILED",
  "BRIDGE_BINDING_DEGRADED",
  "BRIDGE_MCP_UNAVAILABLE",
  "BRIDGE_PLUGIN_DISABLED",
  "DERIVED_DATA_BUSY",
] as const;

export const bridgeErrorCodeSchema = z.enum(BRIDGE_ERROR_CODES);

export const bridgeErrorSchema = z.strictObject({
  code: bridgeErrorCodeSchema,
  message: z.string(),
  traceId: z.string().optional(),
});

export const bridgeSuccessEnvelopeSchema = z.strictObject({
  protocolVersion: PROTOCOL_VERSION_SCHEMA,
  ok: z.literal(true),
  data: z.unknown(),
});

export const bridgeFailureEnvelopeSchema = z.strictObject({
  protocolVersion: PROTOCOL_VERSION_SCHEMA,
  ok: z.literal(false),
  error: bridgeErrorSchema,
});

export const toolProxyRequestSchema = z.strictObject({
  protocolVersion: PROTOCOL_VERSION_SCHEMA,
  arguments: z.record(z.string(), z.unknown()),
});

export const healthDataSchema = z.strictObject({
  processState: bridgeProcessStateSchema,
  requiresPairing: z.boolean(),
});

export const pairRequestSchema = z.strictObject({
  pairingCode: z.string().min(1).max(128),
});

export const pairDataSchema = z.strictObject({
  token: z.string().min(1),
  tokenExpiresInSeconds: z.number().int().positive(),
});

export const projectStatusDataSchema = z.strictObject({
  hostProjectId: hostProjectIdSchema,
  bindingState: projectBindingStateSchema,
  snapshotHash: sha256Schema.optional(),
  workRef: z.string().optional(),
});

export const snapshotResultDataSchema = z.strictObject({
  snapshotHash: sha256Schema,
  outcome: z.enum(["activated", "noop"]),
  bindingState: projectBindingStateSchema,
});

export const derivedDataDeleteDataSchema = z.strictObject({
  bindingState: z.literal("empty"),
});

export const projectBindingProjectionSchema = z.strictObject({
  hostProjectId: hostProjectIdSchema,
  bindingState: projectBindingStateSchema,
});

export const hostStatusProjectionSchema = z.strictObject({
  sessionState: sessionStateSchema,
  processState: bridgeProcessStateSchema,
  pluginState: pluginStateSchema,
  projects: z.array(projectBindingProjectionSchema),
});
