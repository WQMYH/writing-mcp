// Factor ablation on the gold-span criterion (rewritten 2026-08-20).
// The old version mutated store.ts source with regex and parsed a dead
// console format — both voided with the old instrument. This version injects
// evaluator-only call-scoped options: no source mutation, no process-state
// switch, one index build, hit judgement imported from gold-hit.mjs only.
//
// Variants: baseline + one per factor. bm25 is split into TWO operations
// (ratified 2026-08-20): no_bm25_term (drop the score term, FTS candidates
// still merged) vs no_fts_merge (drop the FTS candidate merge; the term
// then naturally scores 0). no_alias removes both alias candidate terms and
// the aliasBoost factor, since aliases are one mechanism.
//
// Verdict per plan §251: recall@5 drops >2pp or MRR drops >5% relative
// → KEEP (factor matters); otherwise REMOVABLE on train. Holdout is NOT
// touched here — ablation decisions are made on train only.
//
// Usage: WRITING_MCP_PRIVATE_ACCEPTANCE=<json> node scripts/ablation-test.mjs
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GenericAdapter } from "../packages/adapter-generic/dist/index.js";
import { WritingService } from "../packages/core/dist/index.js";
import { splitAllSpans, buildGoldRefs, goldRank, splitFacts, territoriesFromParsedSpans } from "./gold-hit.mjs";

const QUERY_LIMIT=50;
const VARIANTS=[
  {name:"baseline",disabledFactors:[]},
  {name:"coverage(×4)",disabledFactors:["coverage"]},
  {name:"aliasBoost(+aliases)",disabledFactors:["alias"]},
  {name:"proximity",disabledFactors:["proximity"]},
  {name:"headingMatches(×0.5)",disabledFactors:["heading"]},
  {name:"bm25 term only",disabledFactors:["bm25Term"]},
  {name:"FTS candidate merge",disabledFactors:["ftsMerge"]},
  {name:"trustBonus(+0.25)",disabledFactors:["trust"]}
];

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
  const{train}=splitFacts(annotations.facts,territories);

  const measure=async(disabledFactors)=>{
    const ranks=[];
    for(const fact of train){
      const goldRefs=buildGoldRefs(fact,allSpans);
      if(!goldRefs.size)continue;
      const result=await service.evaluateSearch(resolved.workRef,fact.query,QUERY_LIMIT,{disabledFactors});
      ranks.push(goldRank(result.results,goldRefs,QUERY_LIMIT));
    }
    const denom=ranks.length;
    const recallAt=k=>denom?ranks.filter(rank=>rank>0&&rank<=k).length/denom:0;
    const metrics={facts:denom,recallAt5:recallAt(5),recallAt10:recallAt(10),recallAt50:recallAt(50),mrr:denom?ranks.reduce((sum,rank)=>sum+(rank>0?1/rank:0),0)/denom:0};
    if(!(metrics.recallAt5<=metrics.recallAt10&&metrics.recallAt10<=metrics.recallAt50))throw new Error(`Self-check failed under variant: recall not monotonic (${metrics.recallAt5}/${metrics.recallAt10}/${metrics.recallAt50})`);
    return metrics;
  };

  const rows=[];
  for(const variant of VARIANTS){
    const metrics=await measure(variant.disabledFactors);
    rows.push({variant:variant.name,disabledFactors:variant.disabledFactors,...metrics});
    console.error(`[ablation] ${variant.name}: recall@5=${(metrics.recallAt5*100).toFixed(2)}% @10=${(metrics.recallAt10*100).toFixed(2)}% @50=${(metrics.recallAt50*100).toFixed(2)}% MRR=${metrics.mrr.toFixed(4)}`);
  }
  const base=rows[0];
  const table=rows.map(row=>{
    const deltaRecall5=(row.recallAt5-base.recallAt5)*100;
    const deltaMrrRelative=base.mrr?(row.mrr-base.mrr)/base.mrr*100:0;
    const verdict=row===base?"baseline":deltaRecall5<-2||deltaMrrRelative<-5?"KEEP":"REMOVABLE";
    return{variant:row.variant,disabledFactors:row.disabledFactors,recallAt5:+row.recallAt5.toFixed(4),recallAt10:+row.recallAt10.toFixed(4),recallAt50:+row.recallAt50.toFixed(4),mrr:+row.mrr.toFixed(4),deltaRecall5pp:+deltaRecall5.toFixed(2),deltaMrrPct:+deltaMrrRelative.toFixed(2),verdict};
  });
  const report={schemaVersion:1,instrument:"gold-span hit (gold-hit.mjs), limit=50 true truncation, train split only",criterion:"recall@5 drop >2pp or MRR drop >5% relative => KEEP (plan §251)",splitInfo:{train:train.length,territories},baseline:base,table,note:"Evaluator-only call-scoped injection; no source mutation or environment switch; bm25 term and FTS candidate merge are separate operations"};
  const outPath=new URL("../reports/ablation-gold-span.json",import.meta.url);
  await writeFile(outPath,JSON.stringify(report,null,2),"utf8");
  console.error(`[ablation] report written to ${outPath.pathname}`);
  console.log(JSON.stringify(report,null,2));
}finally{service.close();}
