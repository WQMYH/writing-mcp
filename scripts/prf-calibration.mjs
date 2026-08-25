#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GenericAdapter } from "../packages/adapter-generic/dist/index.js";
import { WritingService } from "../packages/core/dist/index.js";
import { buildGoldRefs, goldRank, splitAllSpans, splitFacts, territoriesFromParsedSpans } from "./gold-hit.mjs";

const annotationPath = process.env.WRITING_MCP_PRIVATE_ACCEPTANCE;
if (!annotationPath) throw new Error("Set WRITING_MCP_PRIVATE_ACCEPTANCE to the local annotation JSON path");
const annotations = JSON.parse(await readFile(annotationPath, "utf8"));
if (annotations?.schemaVersion !== 2 || annotations?.work?.private !== true || !Array.isArray(annotations?.facts)) {
  throw new Error("Private annotation data must use schemaVersion 2, private=true, and a facts array");
}

const grid = [5, 8, 12].flatMap((topK) => [4, 6, 8].flatMap((termCount) => [0.15, 0.25, 0.35].map((weight) => ({ topK, termCount, weight }))));
const adapter = new GenericAdapter();
const service = new WritingService([adapter], [dirname(annotations.work.sourcePath)]);
const closeEnough = (left, right) => left + 1e-12 >= right;

try {
  const resolved = await service.resolve(annotations.work.sourcePath, "generic");
  if (resolved.status !== "resolved" || !resolved.workRef) throw new Error(`Source resolution failed: ${resolved.status}`);
  const parsed = await adapter.load(resolved.candidates[0]);
  const allSpans = splitAllSpans(parsed);
  const territories = territoriesFromParsedSpans(allSpans);
  if (!territories.length) throw new Error("No chapter headings found; cannot calibrate PRF partitions");
  const { train, holdout } = splitFacts(annotations.facts, territories);
  await service.index(resolved.workRef, "rebuild");

  const measure = async (facts, limit, prf) => {
    const ranks = [], requiredRanks = [];
    for (const fact of facts) {
      const goldRefs = buildGoldRefs(fact, allSpans);
      if (!goldRefs.size) continue;
      // Leakage boundary: only the query and evaluator-owned PRF configuration cross into core.
      const result = await service.evaluateSearch(resolved.workRef, fact.query, limit, prf ? { prf } : {});
      const rank = goldRank(result.results, goldRefs, limit);
      ranks.push(rank);
      if (fact.required) requiredRanks.push(rank);
    }
    const recall = (k) => ranks.length ? ranks.filter((rank) => rank > 0 && rank <= k).length / ranks.length : 0;
    return {
      facts: ranks.length,
      recallAt5: recall(5),
      recallAt10: recall(10),
      recallAt20: recall(20),
      recallAt50: recall(50),
      mrr: ranks.length ? ranks.reduce((sum, rank) => sum + (rank > 0 ? 1 / rank : 0), 0) / ranks.length : 0,
      requiredCount: requiredRanks.length,
      requiredRecallAt20: requiredRanks.length ? requiredRanks.filter((rank) => rank > 0 && rank <= 20).length / requiredRanks.length : 1,
      requiredRecallAt50: requiredRanks.length ? requiredRanks.filter((rank) => rank > 0 && rank <= 50).length / requiredRanks.length : 1,
    };
  };
  const round = (metrics) => Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, typeof value === "number" && !Number.isInteger(value) ? +value.toFixed(6) : value]));
  const trainBaseline = await measure(train, 50);
  const candidates = [];
  for (const configuration of grid) candidates.push({ configuration, metrics: await measure(train, 50, configuration) });
  const noRegression = (candidate, baseline) => closeEnough(candidate.recallAt5, baseline.recallAt5) && closeEnough(candidate.recallAt10, baseline.recallAt10) && closeEnough(candidate.mrr, baseline.mrr) && closeEnough(candidate.recallAt50, baseline.recallAt50) && closeEnough(candidate.requiredRecallAt50, baseline.requiredRecallAt50);
  candidates.sort((left, right) => right.metrics.recallAt5 - left.metrics.recallAt5 || right.metrics.mrr - left.metrics.mrr || left.configuration.topK - right.configuration.topK || left.configuration.termCount - right.configuration.termCount || left.configuration.weight - right.configuration.weight);
  const selected = candidates.find((candidate) => noRegression(candidate.metrics, trainBaseline));
  if (!selected) throw new Error("Frozen PRF grid produced no train no-regression candidate");
  const holdoutBaseline = await measure(holdout, 50);
  const holdoutSelected = await measure(holdout, 50, selected.configuration);
  const privateBaseline = await measure(annotations.facts, 20);
  const privateSelected = await measure(annotations.facts, 20, selected.configuration);
  const gates = [
    { name: "train recall@5/recall@10/MRR/recall@50/required@50 do not regress", pass: noRegression(selected.metrics, trainBaseline) },
    { name: "holdout recall@5/recall@10/MRR/recall@50/required@50 do not regress", pass: noRegression(holdoutSelected, holdoutBaseline) },
    { name: "private top-20 recall >= 0.90", pass: privateSelected.recallAt20 >= 0.9 },
    { name: "private top-20 required recall == 1.00", pass: privateSelected.requiredRecallAt20 === 1 },
  ];
  const report = {
    schemaVersion: 1,
    instrument: "gold-span PRF calibration; train-only selection, holdout-only validation",
    grid: { topK: [5, 8, 12], termCount: [4, 6, 8], weight: [0.15, 0.25, 0.35] },
    split: { train: train.length, holdout: holdout.length, territories },
    trainBaseline: round(trainBaseline),
    selected: { configuration: selected.configuration, train: round(selected.metrics) },
    holdout: { baseline: round(holdoutBaseline), selected: round(holdoutSelected) },
    privateTop20: { baseline: round(privateBaseline), selected: round(privateSelected) },
    candidates: candidates.map((candidate) => ({ configuration: candidate.configuration, train: round(candidate.metrics) })),
    gates,
    verdict: gates.every((gate) => gate.pass) ? "CALIBRATION_PASS" : "CALIBRATION_BLOCKED",
    note: "This evaluator may read labels to score results; core receives only query plus call-scoped PRF settings. Public, performance, and determinism gates remain separate release requirements.",
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict !== "CALIBRATION_PASS") process.exitCode = 1;
} finally {
  service.close();
}
