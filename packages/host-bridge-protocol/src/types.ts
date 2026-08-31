import type { z } from "zod";
import type {
  bridgeProcessStateSchema, bridgeSuccessEnvelopeSchema, chapterMappingSchema, derivedDataDeleteDataSchema,
  healthDataSchema, hostSnapshotDraftSchema, hostStatusProjectionSchema, pairDataSchema, pairRequestSchema,
  pluginStateSchema, projectBindingProjectionSchema, projectStatusDataSchema, sessionStateSchema,
  snapshotCategorySchema, snapshotDocumentSchema, snapshotResultDataSchema, toolProxyRequestSchema,
} from "./schemas.js";

export type SessionState = z.infer<typeof sessionStateSchema>;
export type BridgeProcessState = z.infer<typeof bridgeProcessStateSchema>;
export type PluginState = z.infer<typeof pluginStateSchema>;
export type SnapshotCategory = z.infer<typeof snapshotCategorySchema>;
export type SnapshotDocument = z.infer<typeof snapshotDocumentSchema>;
export type ChapterMapping = z.infer<typeof chapterMappingSchema>;
export type HostSnapshotDraft = z.infer<typeof hostSnapshotDraftSchema>;
export type ToolProxyRequest = z.infer<typeof toolProxyRequestSchema>;
export type HealthData = z.infer<typeof healthDataSchema>;
export type PairRequest = z.infer<typeof pairRequestSchema>;
export type PairData = z.infer<typeof pairDataSchema>;
export type ProjectStatusData = z.infer<typeof projectStatusDataSchema>;
export type SnapshotResultData = z.infer<typeof snapshotResultDataSchema>;
export type DerivedDataDeleteData = z.infer<typeof derivedDataDeleteDataSchema>;
export type ProjectBindingProjection = z.infer<typeof projectBindingProjectionSchema>;
export type HostStatusProjection = z.infer<typeof hostStatusProjectionSchema>;
export type BridgeSuccessEnvelope = z.infer<typeof bridgeSuccessEnvelopeSchema>;

/**
 * Per-row dimensions of the frozen auth matrix. Loopback and Host checks apply
 * to every request unconditionally, so they are documented in PROTOCOL.md and
 * not repeated per row.
 */
export interface AuthMatrixRow {
  method: string;
  route: string;
  origin: "required" | "if-present";
  bearer: boolean;
  pairingCode: boolean;
  pnaHeader: boolean;
}

export const AUTH_MATRIX: readonly AuthMatrixRow[] = [
  { method: "OPTIONS", route: "/v1/*", origin: "required", bearer: false, pairingCode: false, pnaHeader: true },
  { method: "GET", route: "/v1/health", origin: "if-present", bearer: false, pairingCode: false, pnaHeader: false },
  { method: "POST", route: "/v1/pair", origin: "required", bearer: false, pairingCode: true, pnaHeader: false },
  { method: "*", route: "/v1/*", origin: "required", bearer: true, pairingCode: false, pnaHeader: false },
];
