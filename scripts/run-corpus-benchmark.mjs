#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { WritingService } from "../packages/core/dist/index.js";
import { GenericAdapter } from "../packages/adapter-generic/dist/index.js";

const [corpusArg, tasksArg, reportArg] = process.argv.slice(2);
const corpusPath = corpusArg ?? process.env.WRITING_MCP_PRIVATE_CORPUS;
const tasksPath = tasksArg ?? process.env.WRITING_MCP_CORPUS_TASKS;
if (!corpusPath) throw new Error("Set WRITING_MCP_PRIVATE_CORPUS or pass <corpus-path> to run-corpus-benchmark.mjs");
if (!tasksPath) throw new Error("Set WRITING_MCP_CORPUS_TASKS or pass <tasks-json> to run-corpus-benchmark.mjs");
const corpus = resolve(corpusPath), corpusStat = await stat(corpus);
const defaultReportDirectory = join(corpusStat.isDirectory() ? corpus : dirname(corpus), ".writing-index", "benchmarks");
const reportDirectory = resolve(reportArg ?? process.env.WRITING_MCP_PRIVATE_REPORT_DIR ?? defaultReportDirectory);
const tasks = JSON.parse(await readFile(tasksPath, "utf8"));
if (!Array.isArray(tasks.explore) || !Array.isArray(tasks.context) || !tasks.explore.length || !tasks.context.length) throw new Error("Corpus task JSON must contain non-empty explore and context arrays");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const stats = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : 0; };
const maxIndexPerMillionMs = Number(process.env.WRITING_MCP_CORPUS_MAX_INDEX_PER_MILLION_MS ?? 60000), maxExploreP95Ms = Number(process.env.WRITING_MCP_CORPUS_MAX_EXPLORE_P95_MS ?? 1000), maxContextP95Ms = Number(process.env.WRITING_MCP_CORPUS_MAX_CONTEXT_P95_MS ?? 500);
if (![maxIndexPerMillionMs, maxExploreP95Ms, maxContextP95Ms].every((value) => Number.isFinite(value) && value > 0)) throw new Error("Corpus gate thresholds must be finite numbers greater than zero");
const delimiter = "\n\n--- writing-mcp-token-material-v1 ---\n\n";
await mkdir(reportDirectory, { recursive: true });
const service = new WritingService([new GenericAdapter()]);
try {
  const resolved = await service.resolve(corpus, "generic");
  if (resolved.status !== "resolved" || !resolved.workRef) throw new Error(`Corpus resolution failed: ${resolved.status}`);
  const candidate = resolved.candidates[0], adapter = new GenericAdapter(), parsed = await adapter.load(candidate);
  const fullInputText = parsed.documents.map((document) => document.content).join(delimiter), parsedChars = parsed.documents.reduce((total, document) => total + document.content.length, 0);
  if (!parsedChars) throw new Error("Corpus contains no parsed input characters");
  const indexStarted = performance.now(); await service.index(resolved.workRef, "rebuild"); const indexMs = performance.now() - indexStarted;
  const exploreLatencies = [], contextLatencies = [], contexts = [];
  for (const task of tasks.explore) { const started = performance.now(); await service.explore(resolved.workRef, task.operation ?? "search", task.query ?? "", task.limit ?? 20, task.maxHops ?? 2, task.targetChapter); exploreLatencies.push(performance.now() - started); }
  for (const task of tasks.context) { const started = performance.now(), packet = await service.context(resolved.workRef, task.query ?? "", task.budgetTokens ?? 1000, task.requiredRefs ?? [], task.options ?? {}); contextLatencies.push(performance.now() - started); const packetText = JSON.stringify(packet), accountedText = JSON.stringify(packet.blocks); contexts.push({ query: task.query ?? "", packet: { ...packet, refs: packet.blocks.map((block) => block.ref), serialization: { text: packetText, chars: packetText.length, utf8Bytes: Buffer.byteLength(packetText, "utf8"), sha256: sha256(packetText) } }, accountedSerialization: { version: "context-blocks-json-v1", text: accountedText, chars: accountedText.length, utf8Bytes: Buffer.byteLength(accountedText, "utf8"), sha256: sha256(accountedText) }, estimator: packet.estimator, usedTokens: packet.usedTokens, accountingScope: "evidence_excerpts_only", refs: packet.blocks.map((block) => block.ref) }); }
  const indexPerMillionMs = indexMs / parsedChars * 1_000_000, exploreP95Ms = stats(exploreLatencies), contextP95Ms = stats(contextLatencies);
  const material = { schemaVersion: "token-evaluation-materials-v1", delimiter: { version: "writing-mcp-token-material-v1", value: delimiter }, accountingScope: "evidence_excerpts_only", externalTokenResult: "not_evaluated", estimator: "mixed-cjk-v1", fullInput: { text: fullInputText, chars: fullInputText.length, utf8Bytes: Buffer.byteLength(fullInputText, "utf8"), sha256: sha256(fullInputText) }, contexts };
  const report = { schemaVersion: 2, corpus: basename(corpus), parsedChars, index: { elapsedMs: indexMs, normalizedMsPerMillionChars: indexPerMillionMs }, explore: { count: exploreLatencies.length, p95Ms: exploreP95Ms }, context: { count: contextLatencies.length, p95Ms: contextP95Ms }, gates: { maxIndexPerMillionMs, maxExploreP95Ms, maxContextP95Ms }, accountingScope: "evidence_excerpts_only", externalTokenResult: "not_evaluated" };
  await writeFile(join(reportDirectory, "corpus-benchmark-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(join(reportDirectory, "token-evaluation-materials.json"), JSON.stringify(material, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (indexPerMillionMs > maxIndexPerMillionMs || exploreP95Ms > maxExploreP95Ms || contextP95Ms > maxContextP95Ms) { if (indexPerMillionMs > maxIndexPerMillionMs) console.error("Index time per million parsed characters exceeded threshold"); if (exploreP95Ms > maxExploreP95Ms) console.error("Explore P95 exceeded threshold"); if (contextP95Ms > maxContextP95Ms) console.error("Context P95 exceeded threshold"); process.exitCode = 1; }
} finally { service.close(); }
