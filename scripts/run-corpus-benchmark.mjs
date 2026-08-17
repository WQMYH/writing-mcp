#!/usr/bin/env node
// Corpus performance benchmark: index a corpus and measure P95 latency.
// Usage: node scripts/run-corpus-benchmark.mjs <corpus-directory> [output-file]
// Output: JSON report (index time, explore P95, context P95, memory, index size)

import { writeFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { WritingService } from "../packages/core/dist/index.js";
import { GenericAdapter } from "../packages/adapter-generic/dist/index.js";

const corpusDir = process.argv[2];
const outputFile = process.argv[3] || "corpus-benchmark-report.json";

if (!corpusDir) {
  console.error("Usage: node scripts/run-corpus-benchmark.mjs <corpus-directory> [output-file]");
  process.exit(1);
}

function measureMemory() {
  const mem = process.memoryUsage();
  return {
    rssMB: (mem.rss / (1024 * 1024)).toFixed(1),
    heapUsedMB: (mem.heapUsed / (1024 * 1024)).toFixed(1),
    heapTotalMB: (mem.heapTotal / (1024 * 1024)).toFixed(1),
    externalMB: (mem.external / (1024 * 1024)).toFixed(1),
  };
}

async function measureIndexSize(indexPath) {
  let totalSize = 0;
  async function scan(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.isFile()) {
        const info = await stat(fullPath);
        totalSize += info.size;
      }
    }
  }
  await scan(indexPath);
  return totalSize;
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

async function main() {
  console.error(`=== Corpus Performance Benchmark ===`);
  console.error(`Corpus: ${corpusDir}`);
  console.error(`Output: ${outputFile}`);
  console.error();

  const report = {
    corpus: corpusDir,
    timestamp: new Date().toISOString(),
    phases: {},
  };

  // Phase 1: Index
  console.error("Phase 1: Indexing corpus...");
  const memBefore = measureMemory();
  const indexStart = performance.now();
  
  const service = new WritingService([new GenericAdapter()]);
  
  const resolveResult = await service.resolve(corpusDir);
  const workRef = resolveResult.workRef;
  console.error(`  Resolved workRef: ${workRef}`);
  
  const indexResult = await service.index(workRef, "rebuild");
  const indexTime = performance.now() - indexStart;
  const memAfterIndex = measureMemory();
  const indexSize = await measureIndexSize(join(corpusDir, ".writing-index"));
  
  report.phases.index = {
    timeMs: indexTime.toFixed(0),
    timeSeconds: (indexTime / 1000).toFixed(2),
    documents: indexResult.stats.documents,
    spans: indexResult.stats.spans,
    entities: indexResult.stats.entities,
    edges: indexResult.stats.edges,
    indexSizeBytes: indexSize,
    indexSizeMB: (indexSize / (1024 * 1024)).toFixed(2),
    memoryBefore: memBefore,
    memoryAfter: memAfterIndex,
  };
  console.error(`  Index time: ${indexTime.toFixed(0)} ms (${(indexTime / 1000).toFixed(2)} s)`);
  console.error(`  Documents: ${indexResult.stats.documents}, Spans: ${indexResult.stats.spans}`);
  console.error(`  Entities: ${indexResult.stats.entities}, Edges: ${indexResult.stats.edges}`);
  console.error(`  Index size: ${(indexSize / (1024 * 1024)).toFixed(2)} MB`);
  console.error(`  Memory (heap): ${memBefore.heapUsedMB} MB → ${memAfterIndex.heapUsedMB} MB`);
  console.error();

  // Phase 2: Explore queries (search, entity, neighborhood, timeline)
  console.error("Phase 2: Running explore queries...");
  const exploreQueries = [
    { operation: "search", query: "克莱恩", limit: 20 },
    { operation: "search", query: "梅丽莎", limit: 20 },
    { operation: "search", query: "占卜", limit: 20 },
    { operation: "entity", query: "克莱恩·莫雷蒂", limit: 20 },
    { operation: "neighborhood", query: "克莱恩", maxHops: 2, limit: 50 },
    { operation: "timeline", query: "克莱恩", limit: 50 },
  ];
  
  const exploreLatencies = [];
  for (const q of exploreQueries) {
    const start = performance.now();
    const result = await service.explore(
      workRef,
      q.operation,
      q.query,
      q.limit,
      q.maxHops || 2,
      q.targetChapter
    );
    const latency = performance.now() - start;
    exploreLatencies.push(latency);
    console.error(`  ${q.operation}("${q.query}"): ${latency.toFixed(1)} ms, ${result.results.length} results`);
  }
  
  report.phases.explore = {
    queryCount: exploreQueries.length,
    latenciesMs: exploreLatencies.map(l => l.toFixed(1)),
    p50Ms: percentile(exploreLatencies, 50).toFixed(1),
    p95Ms: percentile(exploreLatencies, 95).toFixed(1),
    p99Ms: percentile(exploreLatencies, 99).toFixed(1),
    maxMs: Math.max(...exploreLatencies).toFixed(1),
  };
  console.error(`  P50: ${report.phases.explore.p50Ms} ms, P95: ${report.phases.explore.p95Ms} ms, P99: ${report.phases.explore.p99Ms} ms`);
  console.error();

  // Phase 3: Context assembly
  console.error("Phase 3: Running context assembly...");
  const contextQueries = [
    { query: "克莱恩的背景", budgetTokens: 4000 },
    { query: "梅丽莎和克莱恩的关系", budgetTokens: 4000 },
    { query: "占卜术的使用", budgetTokens: 4000 },
  ];
  
  const contextLatencies = [];
  const contextTokenCounts = [];
  for (const q of contextQueries) {
    const start = performance.now();
    const result = await service.context(workRef, q.query, q.budgetTokens);
    const latency = performance.now() - start;
    contextLatencies.push(latency);
    contextTokenCounts.push(result.usedTokens);
    console.error(`  context("${q.query}"): ${latency.toFixed(1)} ms, ${result.usedTokens} tokens, ${result.blocks.length} blocks`);
  }
  
  report.phases.context = {
    queryCount: contextQueries.length,
    latenciesMs: contextLatencies.map(l => l.toFixed(1)),
    p50Ms: percentile(contextLatencies, 50).toFixed(1),
    p95Ms: percentile(contextLatencies, 95).toFixed(1),
    p99Ms: percentile(contextLatencies, 99).toFixed(1),
    maxMs: Math.max(...contextLatencies).toFixed(1),
    tokenCounts: contextTokenCounts,
    avgTokens: (contextTokenCounts.reduce((a, b) => a + b, 0) / contextTokenCounts.length).toFixed(0),
  };
  console.error(`  P50: ${report.phases.context.p50Ms} ms, P95: ${report.phases.context.p95Ms} ms`);
  console.error(`  Avg tokens: ${report.phases.context.avgTokens}`);
  console.error();

  // Phase 4: Memory final
  console.error("Phase 4: Final memory measurement...");
  const memFinal = measureMemory();
  report.memory = {
    before: memBefore,
    afterIndex: memAfterIndex,
    final: memFinal,
  };
  console.error(`  Final memory (heap): ${memFinal.heapUsedMB} MB`);
  console.error();

  // Write report
  await writeFile(outputFile, JSON.stringify(report, null, 2));
  console.error(`=== Report written to ${outputFile} ===`);
  console.log(JSON.stringify(report, null, 2));
  
  service.close();
}

main().catch(error => {
  console.error("Error:", error.message);
  console.error(error.stack);
  process.exit(1);
});
