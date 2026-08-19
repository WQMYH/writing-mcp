// Reranking evaluation instrument — rewritten 2026-08-20 after the previous
// instrument was voided (weak word-co-occurrence proxy, recall@k ignored k).
//
// Hit criterion (single host: scripts/gold-hit.mjs): a fact hits at cutoff k
// iff one of the first k returned spans has ref ∈ goldRefs(fact). Gold refs
// are built over the FULL parsed span set via verbatim evidenceQuote
// containment. One query at limit=50; recall@5/10/50 slice the same run.
//
// Instrument self-checks (fail the run if violated):
//   1. monotonicity   recall@5 <= recall@10 <= recall@50 (per split)
//   2. negative ctrl  a synthetic fact whose quote exists nowhere must score
//                     hit=false / goldRank=-1 / goldSpanCount=0 — guards
//                     against an always-true instrument
//   3. smoke          the negative control query returns results at all
//
// Facts with goldSpanCount=0 (quote verbatim-absent, annotation or chunking
// anomaly) are excluded from the recall denominator and reported in
// annotation_anomalies; a required fact in that bucket is a hard warning.
//
// Usage: WRITING_MCP_PRIVATE_ACCEPTANCE=<annotation json> node scripts/evaluate-reranking.mjs [train|holdout|all]
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GenericAdapter } from "../packages/adapter-generic/dist/index.js";
import { WritingService } from "../packages/core/dist/index.js";
import { splitAllSpans, buildGoldRefs, goldRank, quoteExposed, chaptersOf, splitFacts } from "./gold-hit.mjs";

const CUTS=[5,10,50],QUERY_LIMIT=50;
const annotationPath=process.env.WRITING_MCP_PRIVATE_ACCEPTANCE;
if(!annotationPath)throw new Error("Set WRITING_MCP_PRIVATE_ACCEPTANCE to the local annotation JSON path");
const splitArg=process.argv[2]??"train";
if(!["train","holdout","all"].includes(splitArg))throw new Error(`Unknown split "${splitArg}" (use train|holdout|all)`);
const annotations=JSON.parse(await readFile(annotationPath,"utf8"));
if(annotations?.schemaVersion!==2||annotations?.work?.private!==true||!Array.isArray(annotations?.facts))throw new Error("Private annotation data must use schemaVersion 2, private=true, and a facts array");

const{train,holdout,head,tail}=splitFacts(annotations.facts);
const evalFacts=splitArg==="train"?train:splitArg==="holdout"?holdout:annotations.facts;

const adapter=new GenericAdapter(),service=new WritingService([adapter],[dirname(annotations.work.sourcePath)]);
try{
  const resolved=await service.resolve(annotations.work.sourcePath,"generic");
  if(resolved.status!=="resolved"||!resolved.workRef)throw new Error(`Source resolution failed: ${resolved.status}`);
  const parsed=await adapter.load(resolved.candidates[0]);
  const allSpans=splitAllSpans(parsed);
  await service.index(resolved.workRef,"rebuild");

  const negatives=[{id:"__negative_control__",query:"zzqqxx 不存在的事实 校验探针",evidenceQuotes:["ZZQQXX_仪表阴性对照_此引文必然不存在于任何 span"],required:false}];
  const perFact=[],anomalies=[],negativeFindings=[];

  for(const fact of evalFacts){
    const goldRefs=buildGoldRefs(fact,allSpans);
    if(goldRefs.size===0){
      anomalies.push({id:fact.id,required:fact.required===true,reason:"no span verbatim-contains any evidenceQuote"});
      continue;
    }
    const result=await service.explore(resolved.workRef,"search",fact.query,QUERY_LIMIT);
    const rank=goldRank(result.results,goldRefs,QUERY_LIMIT);
    perFact.push({id:fact.id,required:fact.required===true,category:fact.category,chapters:chaptersOf(fact),goldSpanCount:goldRefs.size,returnedCount:result.results.length,rank,goldScore:rank>=0?result.results[rank-1].score:null,cutoffScore:result.results.at(-1)?.score??null,quoteExposed:quoteExposed(result.results,fact)});
  }
  for(const neg of negatives){
    const goldRefs=buildGoldRefs(neg,allSpans);
    const result=await service.explore(resolved.workRef,"search",neg.query,QUERY_LIMIT);
    const rank=goldRank(result.results,goldRefs,QUERY_LIMIT);
    negativeFindings.push({id:neg.id,goldSpanCount:goldRefs.size,returnedCount:result.results.length,rank,hit:rank>0});
    if(goldRefs.size!==0)throw new Error("Instrument self-check failed: negative-control quote found in corpus");
    if(rank>0)throw new Error("Instrument self-check failed: negative control reported a hit");
    if(result.results.length===0)throw new Error("Instrument self-check failed: negative-control query returned nothing — search path may be broken");
  }

  const denom=perFact.length;
  const recallAt=k=>denom?perFact.filter(row=>row.rank>0&&row.rank<=k).length/denom:0;
  const mrr=denom?perFact.reduce((sum,row)=>sum+(row.rank>0?1/row.rank:0),0)/denom:0;
  const requiredFacts=perFact.filter(row=>row.required);
  const requiredRecallAt=k=>requiredFacts.length?requiredFacts.filter(row=>row.rank>0&&row.rank<=k).length/requiredFacts.length:1;
  const failed=perFact.filter(row=>row.rank<0||row.rank>CUTS[0]).map(row=>row.id);

  const metrics={factsEvaluated:denom,recallAt5:recallAt(5),recallAt10:recallAt(10),recallAt50:recallAt(50),mrr,requiredTotal:requiredFacts.length,requiredRecallAt50:requiredRecallAt(50)};
  if(!(metrics.recallAt5<=metrics.recallAt10&&metrics.recallAt10<=metrics.recallAt50))throw new Error(`Instrument self-check failed: recall not monotonic (${metrics.recallAt5}/${metrics.recallAt10}/${metrics.recallAt50})`);

  const requiredAnomalies=anomalies.filter(a=>a.required);
  const gateSufficiency=metrics.recallAt50>=.9;
  const report={schemaVersion:3,instrument:"gold-span hit (gold-hit.mjs), limit=50 true truncation",split:splitArg,splitInfo:{train:train.length,holdout:holdout.length,headChapters:head,tailChapters:tail},corpus:{spans:allSpans.length},metrics,gates:{sufficiencyRecall50:.9,sufficiencyPass:gateSufficiency,requiredRecallMustBe:1,requiredPass:metrics.requiredRecallAt50>=1},selfChecks:{monotonicity:"pass",negativeControl:negativeFindings,note:"violations throw before this report exists"},annotationAnomalies:anomalies,requiredAnomalyWarnings:requiredAnomalies,failedFacts:failed,perFact};
  console.log(JSON.stringify(report,null,2));
  if(!gateSufficiency||metrics.requiredRecallAt50<1||requiredAnomalies.length)process.exitCode=1;
}finally{service.close();}
