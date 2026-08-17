export type AdapterKind = "inkos" | "generic";
export type DocumentKind = "chapter" | "outline" | "character" | "state" | "foreshadow" | "document";
export type EntityKind = "Character" | "Location" | "Item" | "Event" | "Fact" | "Foreshadow" | "Chapter" | "OutlineNode";
export type EdgeKind = "contains" | "appears_in" | "precedes";
export type WorkCapability = "documents" | "full_text" | "epub" | "chapters" | "characters" | "outline" | "state" | "foreshadow";
export type SourceKind = "native" | "deterministic" | "heuristic";

// Frozen deterministic-extraction vocabulary (AUD-022). Indexing must only
// produce entity/edge kinds listed here; adapters must only declare these
// capabilities. Extending any list requires an M0 contract amendment, and
// unimplemented relations are never advertised as existing capabilities.
export const ENTITY_KINDS: readonly EntityKind[] = ["Character", "Location", "Item", "Event", "Fact", "Foreshadow", "Chapter", "OutlineNode"];
export const EDGE_KINDS: readonly EdgeKind[] = ["contains", "appears_in", "precedes"];
export const WORK_CAPABILITIES: readonly WorkCapability[] = ["documents", "full_text", "epub", "chapters", "characters", "outline", "state", "foreshadow"];

export interface Diagnostic { code: string; message: string; path?: string }
export interface WorkCandidate {
  workRef: string; title: string; rootPath: string; sourcePath?: string; adapter: AdapterKind; capabilities: WorkCapability[];
}
export interface ResolveResult {
  status: "resolved" | "ambiguous" | "unsupported";
  workRef?: string; candidates: WorkCandidate[]; diagnostics: Diagnostic[];
}
export interface SourceDocument {
  documentRef: string; relativePath: string; absolutePath: string; title: string;
  kind: DocumentKind; content: string; chapterNumber?: number; volumeNumber?: number; localChapterNumber?: number; sourceStartLine?: number; sourceMtimeMs: number; sourceSize: number;
  sourceSegments?: SourceSegment[];
}
export interface SourceSegment { relativePath: string; startLine: number; endLine: number; documentStartLine: number; documentEndLine: number }
export interface ParsedWork extends WorkCandidate { documents: SourceDocument[] }
export interface WorkAdapter {
  readonly kind: AdapterKind;
  discover(sourcePath: string): Promise<WorkCandidate[]>;
  load(candidate: WorkCandidate): Promise<ParsedWork>;
}
export interface IndexStats { added: number; updated: number; deleted: number; skipped: number; documents: number; spans: number; entities: number; edges: number }
export interface IndexResult { workRef: string; revision: number; schemaVersion: number; freshness: "fresh" | "stale" | "missing" | "incompatible"; stats: IndexStats; diagnostics: Diagnostic[]; elapsedMs: number }
export type ExploreOperation = "search" | "entity" | "neighborhood" | "timeline" | "document" | "stats";
export interface EvidenceLocator { relativePath: string; startLine: number; endLine: number }
export interface Evidence { documentRef: string; relativePath: string; startLine: number; endLine: number; excerpt: string; evidenceHash: string; revision: number; locators?: EvidenceLocator[] }
export interface PathEvidence { edgeRef: string; edgeKind: string; direction: "outgoing" | "incoming"; sourceRef: string; targetRef: string; sourceKind: SourceKind; confidence: number; evidence: Evidence }
export interface ExploreItem { ref: string; kind: string; title: string; score: number; sourceKind: SourceKind; confidence: number; evidence: Evidence; path?: string[]; pathEvidence?: PathEvidence[] }
export interface ExploreMetrics { candidateCount: number; returnedCount: number; visitedNodes: number; maxActualHops: number; omittedEstimate: number; elapsedMs: number }
export interface ExploreResult { workRef: string; revision: number; freshness: "fresh"; operation: ExploreOperation; results: ExploreItem[]; ambiguous: ExploreItem[]; truncated: boolean; metrics: ExploreMetrics; diagnostics: Diagnostic[] }
export type ContextLayer = "L0" | "L1" | "L2" | "L3";
// AUD-012 value-open (2026-08-17): taskType is an Agent-side workflow label.
// The five original values stay as documented conventions; any future string is
// accepted (recorded, never driving assembly) so new task types emerge from
// real usage without an MCP release (see plan §8 Step 6 anti-bloat boundary).
export type TaskType = "continue_chapter" | "draft_chapter" | "revise" | "answer" | "custom" | (string & {});
export interface ContextOptions { excludeRefs?: string[]; entityRefs?: string[]; documentRefs?: string[]; targetChapter?: number; taskType?: TaskType }
export interface ContextBlock extends ExploreItem { layer: ContextLayer; tokens: number; required: boolean }
export interface ContextPacket { status: "complete" | "truncated" | "budget_unsatisfiable"; workRef: string; revision: number; budgetTokens: number; usedTokens: number; estimated: boolean; estimator: string; blocks: ContextBlock[]; omitted: Array<{ ref: string; reason: string; tokens: number }>; diagnostics: Diagnostic[] }
