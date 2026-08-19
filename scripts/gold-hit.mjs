// Single host of the gold-span hit criterion (ratified 2026-08-20).
// Every evaluation surface — run-private-acceptance.mjs, evaluate-reranking.mjs,
// and any future gate script — MUST import from here; no second implementation.
//
// Criterion: a fact hits at cutoff k iff one of the first k returned spans has
// ref ∈ goldRefs(fact), where goldRefs(fact) = { span : span.content verbatim
// contains any of fact.evidenceQuotes }. Gold refs are built over the FULL
// parsed span set (not over returned excerpts); excerpt truncation therefore
// never affects hit. Quote exposure in returned excerpts is a separate
// diagnostic (quoteExposed), never part of hit.
import { splitDocument, stableId } from "../packages/core/dist/index.js";

export function splitAllSpans(parsed){
  return parsed.documents.flatMap(document=>splitDocument(document,ordinal=>stableId("span",document.documentRef,String(ordinal))));
}

// Union over all quotes: any quote contained counts (multi-quote facts included).
export function buildGoldRefs(fact,allSpans){
  const quotes=fact.evidenceQuotes??[];
  return new Set(allSpans.filter(span=>quotes.some(quote=>span.content.includes(quote))).map(span=>span.spanRef));
}

// 1-based rank of the first gold span within `cutoff` results, or -1.
export function goldRank(results,goldRefs,cutoff){
  for(let i=0;i<Math.min(results.length,cutoff);i++){
    if(goldRefs.has(results[i].ref))return i+1;
  }
  return -1;
}

// Diagnostic only: does any returned excerpt expose any evidence quote?
export function quoteExposed(results,fact){
  return fact.evidenceQuotes.some(quote=>results.some(item=>item.evidence?.excerpt?.includes(quote)));
}

export function chapterRefsOf(fact){
  return Array.isArray(fact.expectedChapters)?fact.expectedChapters:[fact.expectedChapters];
}

// Chapters a fact touches; used for the holdout split and chapter-level
// diagnostics only — never for hit. Range refs ({from,to}) expand fully.
export function chaptersOf(fact){
  const out=[];
  for(const ref of chapterRefsOf(fact)){
    if(Number.isInteger(ref?.chapter))out.push(ref.chapter);
    else if(Number.isInteger(ref?.from)&&Number.isInteger(ref?.to))for(let c=ref.from;c<=ref.to;c++)out.push(c);
  }
  return out;
}

// Holdout = facts touching the first 3 or last 2 distinct chapter numbers
// (plan §250). Deterministic from the annotation set alone.
export function splitFacts(facts){
  const all=[...new Set(facts.flatMap(chaptersOf))].sort((a,b)=>a-b);
  if(all.length<6)return{train:facts,holdout:[],head:[],tail:[]};
  const head=all.slice(0,3),tail=all.slice(-2);
  const holdout=facts.filter(fact=>chaptersOf(fact).some(c=>head.includes(c)||tail.includes(c)));
  const holdoutIds=new Set(holdout.map(fact=>fact.id));
  return{train:facts.filter(fact=>!holdoutIds.has(fact.id)),holdout,head,tail};
}
