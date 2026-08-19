// Gold-evidence gate + baseline snapshot (plan §266 formal deliverables).
// Runs the gold-span instrument on train and holdout, applies the sufficiency
// gates, and pins the passing numbers as reports/gold-evidence-baseline.json —
// the comparison anchor for later mechanism changes (PRF query expansion).
//
// Gates: train recall@50 >= 0.90 and required recall@50 == 1.00 (plan §251);
// holdout reported as validation but gated separately with the same thresholds.
// Exit 1 on any gate failure so this script can sit behind a gate entry later.
//
// Usage: WRITING_MCP_PRIVATE_ACCEPTANCE=<json> node scripts/gate-gold-evidence.mjs
import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GenericAdapter } from "../packages/adapter-generic/dist/index.js";
import { WritingService } from "../packages/core/dist/index.js";
import { splitAllSpans, buildGoldRefs, goldRank, splitFacts, territoriesFromParsedSpans } from "./gold-hit.mjs";

const QUERY_LIMIT=50,GATE_RECALL_50=.9;

const annotationPath=process.env.WRITING_MCP_PRIVATE_ACCEPTANCE;
if(!annotationPath)throw new Error("Set WRITING_MCP_PRIVATE_ACCEPTANCE to the local annotation JSON path");
const annotations=JSON.parse(await readFile(annotationPath,"utf8"));
if(annotations?.schemaVersion!==2||annotations?.work?.private!==true||!Array.isArray(annotations?.facts))throw new Error("Private annotation data must use schemaVersion 2, private=true, and a facts array");

const adapter=new GenericAdapter(),service=new WritingService([adapter],[dirname(annotations.work.sourcePath)]);
try{
  const resolved=await service.resolve(annotations.work.sourcePath,"generic");
  if(resolved.status!=="resolved"||!resolved.workRef)throw new Error(`Source resolution failed: ${resolved.status}`);
  const parsed=await adapter.load(resolved.candidates[0]);
  const allSpans=splitAllSpans(parsed);
  await service.index(resolved.workRef,"rebuild");
  const territories=territoriesFromParsedSpans(allSpans);
  if(!territories.length)throw new Error("No chapter headings found; cannot gate on the volume-aware split");
  const{train,holdout}=splitFacts(annotations.facts,territories);

  const measure=async facts=>{
    const ranks=[],requiredRanks=[];
    for(const fact of facts){
      const goldRefs=buildGoldRefs(fact,allSpans);
      if(!goldRefs.size)continue;
      const result=await service.explore(resolved.workRef,"search",fact.query,QUERY_LIMIT);
      const rank=goldRank(result.results,goldRefs,QUERY_LIMIT);
      ranks.push(rank);
      if(fact.required===true)requiredRanks.push(rank);
    }
    const recallAt=k=>ranks.length?ranks.filter(rank=>rank>0&&rank<=k).length/ranks.length:0;
    const metrics={facts:ranks.length,recallAt5:recallAt(5),recallAt10:recallAt(10),recallAt50:recallAt(50),mrr:ranks.length?ranks.reduce((sum,rank)=>sum+(rank>0?1/rank:0),0)/ranks.length:0,requiredCount:requiredRanks.length,requiredRecallAt50:requiredRanks.length?requiredRanks.filter(rank=>rank>0&&rank<=QUERY_LIMIT).length/requiredRanks.length:1};
    if(!(metrics.recallAt5<=metrics.recallAt10&&metrics.recallAt10<=metrics.recallAt50))throw new Error("Self-check failed: recall not monotonic");
    return metrics;
  };

  const trainMetrics=await measure(train),holdoutMetrics=await measure(holdout);
  const gates=[
    {name:"train recall@50 >= 0.90",pass:trainMetrics.recallAt50>=GATE_RECALL_50},
    {name:"train required recall@50 == 1.00",pass:trainMetrics.requiredRecallAt50===1},
    {name:"holdout recall@50 >= 0.90",pass:holdoutMetrics.recallAt50>=GATE_RECALL_50},
    {name:"holdout required recall@50 == 1.00",pass:holdoutMetrics.requiredRecallAt50===1}
  ];

  let gitCommit=null;
  try{gitCommit=execSync("git rev-parse HEAD",{encoding:"utf8"}).trim();}catch{/* not in a repository */}
  const snapshot={schemaVersion:1,instrument:"gold-span hit (gold-hit.mjs), limit=50 true truncation, volume-aware head/tail split",criterion:"gold span = full-content literal evidenceQuote containment; hit = span ref in top-k",gates:{recall50Min:GATE_RECALL_50,requiredRecall50:1},gitCommit,generatedAt:new Date().toISOString(),train:{count:train.length,...round(trainMetrics)},holdout:{count:holdout.length,...round(holdoutMetrics)},territories,verdict:gates.every(gate=>gate.pass)?"PASS":"FAIL"};
  const outPath=new URL("../reports/gold-evidence-baseline.json",import.meta.url);
  await writeFile(outPath,JSON.stringify(snapshot,null,2),"utf8");
  for(const gate of gates)console.error(`[gate] ${gate.pass?"PASS":"FAIL"}  ${gate.name}`);
  console.error(`[gate] train: @5=${(trainMetrics.recallAt5*100).toFixed(2)}% @10=${(trainMetrics.recallAt10*100).toFixed(2)}% @50=${(trainMetrics.recallAt50*100).toFixed(2)}% MRR=${trainMetrics.mrr.toFixed(4)} required@50=${trainMetrics.requiredRecallAt50}`);
  console.error(`[gate] holdout: @5=${(holdoutMetrics.recallAt5*100).toFixed(2)}% @10=${(holdoutMetrics.recallAt10*100).toFixed(2)}% @50=${(holdoutMetrics.recallAt50*100).toFixed(2)}% MRR=${holdoutMetrics.mrr.toFixed(4)} required@50=${holdoutMetrics.requiredRecallAt50}`);
  console.error(`[gate] baseline snapshot written to ${outPath.pathname}; verdict=${snapshot.verdict}`);
  console.log(JSON.stringify(snapshot,null,2));
  if(snapshot.verdict!=="PASS")process.exitCode=1;
}finally{service.close();}

function round(metrics){return{recallAt5:+metrics.recallAt5.toFixed(4),recallAt10:+metrics.recallAt10.toFixed(4),recallAt50:+metrics.recallAt50.toFixed(4),mrr:+metrics.mrr.toFixed(4),requiredRecallAt50:metrics.requiredRecallAt50};}
