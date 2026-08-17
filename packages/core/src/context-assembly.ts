import type { ContextLayer, Evidence } from "./types.js";

// AUD-013 source provider registry: deterministic kind → semantic layer mapping.
// L0 is reserved for task goals and mandatory constraints (required blocks are
// promoted at assembly time); L1 holds directly relevant characters/facts/
// foreshadowing; L2 holds chapters/events/local outline; L3 holds background
// and supplementary material (README「上下文压缩」). The registry is frozen
// pure data — minTokens/preferredTokens/maxTokens remain reserved for a future
// budget-aware provider and are deliberately not declared yet.
export interface ContextSourceProfile { layer: ContextLayer; priority: number }

export const CONTEXT_SOURCE_REGISTRY: Readonly<Record<string, ContextSourceProfile>> = {
  Character: { layer: "L1", priority: 0 },
  Fact: { layer: "L1", priority: 1 },
  Foreshadow: { layer: "L1", priority: 2 },
  Chapter: { layer: "L2", priority: 0 },
  Event: { layer: "L2", priority: 1 },
  OutlineNode: { layer: "L2", priority: 2 },
  Location: { layer: "L3", priority: 0 },
  Item: { layer: "L3", priority: 1 },
};

export const DEFAULT_CONTEXT_SOURCE_PROFILE: ContextSourceProfile = { layer: "L3", priority: 9 };

// AUD-013 kind normalization: context candidates come from search rows whose
// kind is the lowercase document kind (d.kind), not the entity kind. Document
// kinds normalize to their entity counterparts (same mapping store.ts uses
// when deriving entities from document headings); "document" and unknown
// kinds stay background material (L3).
export const DOCUMENT_KIND_ALIASES: Readonly<Record<string, string>> = {
  character: "Character",
  state: "Fact",
  foreshadow: "Foreshadow",
  chapter: "Chapter",
  outline: "OutlineNode",
};

export function contextSourceProfile(kind: string, required: boolean): ContextSourceProfile {
  if (required) return { layer: "L0", priority: 0 };
  return CONTEXT_SOURCE_REGISTRY[kind] ?? CONTEXT_SOURCE_REGISTRY[DOCUMENT_KIND_ALIASES[kind] ?? ""] ?? DEFAULT_CONTEXT_SOURCE_PROFILE;
}

export function layerRank(layer: ContextLayer): number {
  return layer === "L0" ? 0 : layer === "L1" ? 1 : layer === "L2" ? 2 : 3;
}

// AUD-012 direction (2026-08-17): taskType is an Agent-side workflow label and
// NEVER drives assembly — MCP must not guess authoring intent (Reference §5.5's
// rejected smart-routing). The Agent expresses assembly constraints via
// query/requiredRefs/entityRefs/documentRefs/targetChapter/excludeRefs/budget;
// taskType is accepted, validated, and recorded by the server layer only. The
// previously drafted strategy engine (per-taskType layer fill orders) was
// rejected and is intentionally absent: assembly fills L0 → L1 → L2 → L3
// deterministically, with targetChapter proximity and pinning as tie-breakers.

// AUD-013 evidence dedup: fold candidates sharing an evidenceHash, keeping the
// first occurrence in the given order (deterministic). Callers that must never
// fold certain blocks (e.g. required refs) place them first, so their hashes
// claim precedence and later duplicates collapse against them.
export function dedupByEvidence<T extends { evidence: Evidence }>(items: readonly T[]): { kept: T[]; duplicates: T[] } {
  const kept: T[] = [], duplicates: T[] = [], seen = new Set<string>();
  for (const item of items) {
    const hash = item.evidence.evidenceHash;
    if (seen.has(hash)) { duplicates.push(item); continue; }
    seen.add(hash);
    kept.push(item);
  }
  return { kept, duplicates };
}
