import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GenericAdapter } from "../packages/adapter-generic/dist/index.js";
import { WritingService } from "../packages/core/dist/index.js";
import { splitAllSpans, buildGoldRefs, goldRank, splitFacts, territoriesFromParsedSpans } from "./gold-hit.mjs";

export const GATE_RECALL_50 = .9;

export async function measureGoldEvidence(annotationPath) {
  if (!annotationPath) throw new Error("Set WRITING_MCP_PRIVATE_ACCEPTANCE to the local annotation JSON path");
  const annotations = JSON.parse(await readFile(annotationPath, "utf8"));
  if (annotations?.schemaVersion !== 2 || annotations?.work?.private !== true || !Array.isArray(annotations?.facts)) throw new Error("Private annotation data must use schemaVersion 2, private=true, and a facts array");
  const adapter = new GenericAdapter(), service = new WritingService([adapter], [dirname(annotations.work.sourcePath)]);
  try {
    const resolved = await service.resolve(annotations.work.sourcePath, "generic");
    if (resolved.status !== "resolved" || !resolved.workRef) throw new Error(`Source resolution failed: ${resolved.status}`);
    const parsed = await adapter.load(resolved.candidates[0]);
    const allSpans = splitAllSpans(parsed);
    await service.index(resolved.workRef, "rebuild");
    const territories = territoriesFromParsedSpans(allSpans);
    if (!territories.length) throw new Error("No chapter headings found; cannot gate on the volume-aware split");
    const { train, holdout } = splitFacts(annotations.facts, territories);
    const measure = async (facts) => {
      const ranks = [], requiredRanks = [];
      for (const fact of facts) { const refs = buildGoldRefs(fact, allSpans); if (!refs.size) continue; const result = await service.explore(resolved.workRef, "search", fact.query, 50); const rank = goldRank(result.results, refs, 50); ranks.push(rank); if (fact.required) requiredRanks.push(rank); }
      const recall = (k) => ranks.length ? ranks.filter((rank) => rank > 0 && rank <= k).length / ranks.length : 0;
      return { facts: ranks.length, recallAt5: recall(5), recallAt10: recall(10), recallAt50: recall(50), mrr: ranks.length ? ranks.reduce((sum, rank) => sum + (rank > 0 ? 1 / rank : 0), 0) / ranks.length : 0, requiredCount: requiredRanks.length, requiredRecallAt50: requiredRanks.length ? requiredRanks.filter((rank) => rank > 0 && rank <= 50).length / requiredRanks.length : 1 };
    };
    const trainMetrics = await measure(train), holdoutMetrics = await measure(holdout);
    const gates = [["train", trainMetrics], ["holdout", holdoutMetrics]].flatMap(([split, metrics]) => [{ name: `${split} recall@50 >= 0.90`, pass: metrics.recallAt50 >= GATE_RECALL_50 }, { name: `${split} required recall@50 == 1.00`, pass: metrics.requiredRecallAt50 === 1 }]);
    return { annotations, territories, trainCount: train.length, holdoutCount: holdout.length, train: trainMetrics, holdout: holdoutMetrics, gates, verdict: gates.every((gate) => gate.pass) ? "PASS" : "FAIL" };
  } finally { service.close(); }
}

const round = (metrics) => ({ recallAt5: +metrics.recallAt5.toFixed(4), recallAt10: +metrics.recallAt10.toFixed(4), recallAt50: +metrics.recallAt50.toFixed(4), mrr: +metrics.mrr.toFixed(4), requiredRecallAt50: metrics.requiredRecallAt50 });
export function goldSnapshot(measurement, gitCommit) { return { schemaVersion: 2, instrument: "gold-span hit (gold-hit.mjs), limit=50 true truncation, volume-aware head/tail split", criterion: "gold span = full-content literal evidenceQuote containment; hit = span ref in top-k", gates: { recall50Min: GATE_RECALL_50, requiredRecall50: 1 }, gitCommit, train: { count: measurement.trainCount, ...round(measurement.train) }, holdout: { count: measurement.holdoutCount, ...round(measurement.holdout) }, territories: measurement.territories, verdict: measurement.verdict }; }
