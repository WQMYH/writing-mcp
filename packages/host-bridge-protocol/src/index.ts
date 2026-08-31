import { createHash } from "node:crypto";
import type { SnapshotCategory } from "./types.js";

export * from "./schemas.js";
export * from "./types.js";

export function computeContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface SnapshotHashDocument {
  relativePath: string;
  category: SnapshotCategory;
  sha256: string;
}

export function canonicalSnapshotDocuments(documents: readonly SnapshotHashDocument[]): Array<{ relativePath: string; category: SnapshotCategory; sha256: string }> {
  return [...documents]
    .sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0))
    .map((document) => ({ relativePath: document.relativePath, category: document.category, sha256: document.sha256 }));
}

export function computeSnapshotHash(protocolVersion: number, documents: readonly SnapshotHashDocument[]): string {
  return createHash("sha256").update(JSON.stringify({ protocolVersion, documents: canonicalSnapshotDocuments(documents) }), "utf8").digest("hex");
}

export function computeProjectKey(pluginId: string, origin: string, hostProjectId: string): string {
  return createHash("sha256").update(`${pluginId}\0${origin}\0${hostProjectId}`, "utf8").digest("hex").slice(0, 32);
}
