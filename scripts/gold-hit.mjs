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

// (volume, chapter) pairs a fact touches; used for the holdout split and
// chapter-level diagnostics only — never for hit. Volume is part of the
// identity: chapter numbers restart per volume, so bare numbers collide
// across volumes (P1 fix, 2026-08-20). Range refs ({from,to}) expand fully.
export function chaptersOf(fact){
  const out=[];
  for(const ref of chapterRefsOf(fact)){
    if(Number.isInteger(ref?.chapter))out.push({volume:ref.volume,chapter:ref.chapter});
    else if(Number.isInteger(ref?.from)&&Number.isInteger(ref?.to))for(let c=ref.from;c<=ref.to;c++)out.push({volume:ref.volume,chapter:c});
  }
  return out;
}

// Holdout territories (plan §250 "前3+后2" applied per volume): the first 3
// and last 2 chapter numbers of each volume's TRUE chapter range. The range
// comes from the corpus (via territoriesFromParsedSpans), not annotation
// coverage — annotations only cover part of the book, so deriving the range
// from facts alone is wrong (P1, 2026-08-20).
export function splitFacts(facts,territories){
  const zones=territories.map(t=>{const all=[...t.chapters].sort((a,b)=>a-b);return all.length<6?{volume:t.volume,head:all,tail:[]}:{volume:t.volume,head:all.slice(0,3),tail:all.slice(-2)};});
  const inTerritory=({volume,chapter})=>zones.some(t=>t.volume===volume&&(t.head.includes(chapter)||t.tail.includes(chapter)));
  const holdout=facts.filter(fact=>chaptersOf(fact).some(inTerritory));
  const holdoutIds=new Set(holdout.map(fact=>fact.id));
  return{train:facts.filter(fact=>!holdoutIds.has(fact.id)),holdout,territories:zones};
}

// Derive per-volume chapter ranges from the corpus's OWN chapter headings in
// source order (single source of truth for chapter parsing). A new volume
// starts only when chapter 1 follows a higher chapter number (chapter 1 also
// opens spans of the SAME chapter — repeated numbers never split). Mid-volume
// ordering anomalies in the corpus (e.g. …18,20,19,20…) must NOT split
// volumes; per-volume sets are deduped and sorted. Returns [{volume,chapters}].
export function territoriesFromParsedSpans(allSpans){
  const volumes=[];
  let lastNumber=0;
  for(const span of allSpans){
    const match=String(span.heading??"").trim().match(/^第(.+)章$/);
    if(!match)continue;
    const number=cnToInt(match[1]);
    if(number==null||number===lastNumber)continue;
    if(number===1&&lastNumber>1)volumes.push([]);
    if(!volumes.length)volumes.push([]);
    volumes.at(-1).push(number);
    lastNumber=number;
  }
  return volumes.map((chapters,index)=>({volume:index+1,chapters:[...new Set(chapters)].sort((a,b)=>a-b)}));
}

export function cnToInt(text){
  if(/^\d+$/.test(text))return Number(text);
  const digits={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  let total=0,current=0;
  for(const char of text){
    if(char in digits)current=digits[char];
    else if(char==="十")total+=(current||1)*10,current=0;
    else if(char==="百")total+=(current||1)*100,current=0;
    else if(char==="千")total+=(current||1)*1000,current=0;
    else return null;
  }
  return total+current;
}
