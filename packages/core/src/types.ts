export type AdapterKind = "inkos" | "generic";
export type DocumentKind = "chapter" | "outline" | "character" | "state" | "foreshadow" | "document";
export type EntityKind = "Character" | "Location" | "Item" | "Event" | "Fact" | "Foreshadow" | "Chapter";
export type SourceKind = "native" | "deterministic" | "heuristic";

export interface Diagnostic { code: string; message: string; path?: string }
export interface WorkCandidate {
  workRef: string; title: string; rootPath: string; adapter: AdapterKind; capabilities: string[];
}
export interface ResolveResult {
  status: "resolved" | "ambiguous" | "unsupported";
  workRef?: string; candidates: WorkCandidate[]; diagnostics: Diagnostic[];
}
export interface SourceDocument {
  documentRef: string; relativePath: string; absolutePath: string; title: string;
  kind: DocumentKind; content: string; chapterNumber?: number; sourceMtimeMs: number; sourceSize: number;
}
export interface ParsedWork extends WorkCandidate { documents: SourceDocument[] }
export interface WorkAdapter {
  readonly kind: AdapterKind;
  discover(sourcePath: string): Promise<WorkCandidate[]>;
  load(candidate: WorkCandidate): Promise<ParsedWork>;
}
export interface IndexStats { added: number; updated: number; deleted: number; skipped: number; documents: number; spans: number; entities: number; edges: number }
export interface IndexResult { workRef: string; revision: number; schemaVersion: number; freshness: "fresh" | "stale" | "missing" | "incompatible"; stats: IndexStats; diagnostics: Diagnostic[]; elapsedMs: number }
export type ExploreOperation = "search" | "entity" | "neighborhood" | "timeline" | "document" | "stats";
export interface Evidence { documentRef: string; relativePath: string; startLine: number; endLine: number; excerpt: string }
export interface ExploreItem { ref: string; kind: string; title: string; score: number; sourceKind: SourceKind; confidence: number; evidence: Evidence; path?: string[] }
export interface ExploreResult { workRef: string; revision: number; freshness: "fresh"; operation: ExploreOperation; results: ExploreItem[]; ambiguous: ExploreItem[]; truncated: boolean; diagnostics: Diagnostic[] }
export type ContextLayer = "L0" | "L1" | "L2" | "L3";
export interface ContextBlock extends ExploreItem { layer: ContextLayer; tokens: number; required: boolean }
export interface ContextPacket { status: "complete" | "truncated" | "budget_unsatisfiable"; workRef: string; revision: number; budgetTokens: number; usedTokens: number; estimated: boolean; estimator: string; blocks: ContextBlock[]; omitted: Array<{ ref: string; reason: string; tokens: number }>; diagnostics: Diagnostic[] }
