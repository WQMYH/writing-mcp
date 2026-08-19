// Failure attribution for gold-span misses (P5). Three-layer diagnosis:
//   L1 query-analysis — do any terms/aliasTerms of the query appear in the
//      gold span content at all? (terms mirrored from store.analyzeQuery)
//   L2 candidacy — is the gold span reachable by the LIKE candidate query,
//      and could candidateLimit (512) eviction cut it off?
//   L3 ranking — recompute the store's 6-factor score on the FULL gold span
//      content (mirror of searchRows; drift risk noted) and compare with the
//      returned top-50 scores.
// Diagnostic only — hit decisions always come from gold-hit.mjs.
// Usage: WRITING_MCP_PRIVATE_ACCEPTANCE=<json> node scripts/attribute-misses.mjs [ids...]
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GenericAdapter } from "../packages/adapter-generic/dist/index.js";
import { WritingService } from "../packages/core/dist/index.js";
import { splitAllSpans, buildGoldRefs, goldRank } from "./gold-hit.mjs";

const annotationPath=process.env.WRITING_MCP_PRIVATE_ACCEPTANCE;
if(!annotationPath)throw new Error("Set WRITING_MCP_PRIVATE_ACCEPTANCE");
const annotations=JSON.parse(await readFile(annotationPath,"utf8"));
const wanted=process.argv.slice(2);

// Mirror of WritingStore.analyzeQuery (store.ts) — keep in sync manually.
function analyzeQuery(query){
  const stopPhrases=["让我们先","请告诉我","我想知道","帮我查找","她在故事中","他在故事中","它在故事中","使用了什么","做了什么","发生了什么","这个角色","这个人物","去了哪里","来自哪里","以及","探索","检索","查找","告诉我","她是谁","他是谁","它是谁","是什么","是谁","在哪里","为什么","怎么样","如何","请问"];
  let normalized=query.normalize("NFKC").toLowerCase();for(const phrase of stopPhrases)normalized=normalized.replaceAll(phrase," ");const terms=[];
  for(const token of normalized.match(/[a-z0-9][a-z0-9_'-]*|[\u3400-\u9fff]+/g)??[]){
    if(!/^[\u3400-\u9fff]+$/.test(token)){terms.push(token);continue;}
    if(token.length<=4){if(token.length>=2)terms.push(token);continue;}
    for(const size of [3,2,4])for(let index=0;index+size<=token.length;index++)terms.push(token.slice(index,index+size));
  }
  return [...new Set(terms)].slice(0,48);
}
// Mirror of aliasTerms derivation in searchRows.
function aliasTermsFor(terms){
  return [...new Set(terms.flatMap(term=>/^[\u3400-\u9fff]{2,3}$/.test(term)?[`阿${term.at(-1)}`,`小${term.at(-1)}`,`老${term.at(-1)}`,...(term.length===3?[term.slice(1)]:[])]:[]).filter(alias=>!terms.includes(alias)))];
}
function termProximity(content,terms){
  if(terms.length<2)return terms.length;const occurrences=terms.map(term=>{const positions=[];let position=content.indexOf(term);while(position>=0){positions.push(position);position=content.indexOf(term,position+Math.max(1,term.length));}return positions;});let best=Infinity;for(const anchor of occurrences.flat()){const nearest=occurrences.map(positions=>positions.reduce((current,position)=>Math.abs(position-anchor)<Math.abs(current-anchor)?position:current,positions[0])),spread=Math.max(...nearest)-Math.min(...nearest);best=Math.min(best,spread);}return Number.isFinite(best)?1/(1+best/200):0;
}
function scoreRow(content,heading,terms,aliasTerms,bm25){
  const matched=terms.filter(term=>heading.includes(term)||content.includes(term)),aliasMatched=aliasTerms.filter(term=>heading.includes(term)||content.includes(term));
  const coverage=Math.min(1,matched.reduce((sum,term)=>sum+[...term].length,0)/12),aliasBoost=Math.min(.75,aliasMatched.length*.5),headingMatches=matched.filter(term=>heading.includes(term)).length,proximity=termProximity(content,[...matched,...aliasMatched]),trustBonus=matched.length?.25:0;
  return{score:coverage*4+aliasBoost+proximity+headingMatches*.5+Math.min(1,bm25/10)+trustBonus,matched,aliasMatched,coverage,aliasBoost,headingMatches,proximity,trustBonus};
}

const adapter=new GenericAdapter(),service=new WritingService([adapter],[dirname(annotations.work.sourcePath)]);
try{
  const resolved=await service.resolve(annotations.work.sourcePath,"generic");
  const parsed=await adapter.load(resolved.candidates[0]);
  const allSpans=splitAllSpans(parsed);
  await service.index(resolved.workRef,"rebuild");

  const targets=annotations.facts.filter(fact=>!wanted.length||wanted.includes(fact.id));
  const reports=[];
  for(const fact of targets){
    const goldRefs=buildGoldRefs(fact,allSpans);
    const goldSpans=allSpans.filter(span=>goldRefs.has(span.spanRef));
    const result=await service.explore(resolved.workRef,"search",fact.query,50);
    const rank=goldRank(result.results,goldRefs,50);
    const probe=rank<0?await service.explore(resolved.workRef,"search",fact.query,100):null;
    const rankAt100=probe?goldRank(probe.results,goldRefs,100):-1;
    const terms=analyzeQuery(fact.query),aliasTerms=aliasTermsFor(terms);
    const out={id:fact.id,required:fact.required,query:fact.query,rankAt50:rank,rankAt100,termsCount:terms.length,terms:terms.slice(0,24),goldSpanCount:goldRefs.size};

    // L1: which terms hit the gold content?
    const perGold=goldSpans.map(span=>{
      const matched=terms.filter(term=>span.content.includes(term)),aliasMatched=aliasTerms.filter(term=>span.content.includes(term));
      return{spanRef:span.spanRef,contentLen:span.content.length,matchedCount:matched.length,matched:matched.slice(0,12),aliasMatched};
    });
    out.L1_queryAnalysis={goldHits:perGold,verdict:perGold.some(g=>g.matchedCount>0||g.aliasMatched.length>0)?"terms reach gold span":"NO query term appears in gold span — recall impossible regardless of ranking"};

    // L2: candidacy pressure — how many spans LIKE-match the query terms,
    // and is that near the 512 candidate cap?
    const likeMatches=allSpans.filter(span=>[...terms,...aliasTerms].some(term=>span.content.includes(term)||String(span.heading??"").includes(term)));
    const goldInLike=likeMatches.some(span=>goldRefs.has(span.spanRef));
    out.L2_candidacy={likeMatchCount:likeMatches.length,candidateCap:512,goldReachableByLike:goldInLike,verdict:likeMatches.length>512?"candidate pressure: >512 LIKE matches, ordinal-ordered cap can evict gold":goldInLike?"gold reachable via LIKE":"gold relies on FTS merge only (or is not a candidate)"};

    // L3: mirror-scored gold vs returned scores (bm25 unknown for gold:
    // reported as range with bm25=0 and bm25=10).
    const goldScored=goldSpans.map(span=>{const zero=scoreRow(span.content,String(span.heading??""),terms,aliasTerms,0),max=scoreRow(span.content,String(span.heading??""),terms,aliasTerms,10);return{spanRef:span.spanRef,scoreBm25Zero:Number(zero.score.toFixed(3)),scoreBm25Max:Number(max.score.toFixed(3)),factors:{coverage:Number(zero.coverage.toFixed(3)),aliasBoost:Number(zero.aliasBoost.toFixed(2)),headingMatches:zero.headingMatches,proximity:Number(zero.proximity.toFixed(3)),trustBonus:zero.trustBonus}};});
    const returned=result.results.map((item,index)=>({rank:index+1,ref:item.ref,score:Number(item.score.toFixed(3))}));
    const cutoff=returned.at(-1)?.score??null;
    out.L3_ranking={goldScored,cutoffAt50:cutoff,top5:returned.slice(0,5),verdict:rank>0?`in-window at ${rank}`:rankAt100>0?`just outside window (rank@100=${rankAt100})`:"far outside window (>100)"};
    reports.push(out);
  }
  const rendered=JSON.stringify(reports,null,1);
  if(process.env.ATTRIBUTE_OUT)await writeFile(process.env.ATTRIBUTE_OUT,rendered+"\n","utf8");
  console.log(rendered);
}finally{service.close();}
