// Deterministic EPUB parsing (AUD-028 resource limits, AUD-026 work boundary):
// extracted pure-ish ingestion pipeline; behavior-frozen by tests/epub.test.ts
// and tests/epub-resource-limits.test.ts.
import { readFile, stat } from "node:fs/promises";
import { posix, relative } from "node:path";
import JSZip from "jszip";
import { stableId, type SourceDocument } from "@writing-mcp/core";
import { codedError } from "./errors.js";
import { chapterNumber } from "./numbering.js";

export interface EpubManifestItem { href:string; mediaType?:string; properties?:string }
export interface EpubSpineItem { idref:string; linear?:string }
export interface EpubChunk { entryPath:string; content:string; fallbackTitle:string }
// AUD-028: deterministic ingestion limits guard against ZIP bombs and
// unbounded packages. Injected via `new GenericAdapter({ epub })`.
export interface EpubLimits { maxEntries:number; maxDocumentBytes:number; maxTotalBytes:number }
export const DEFAULT_EPUB_LIMITS:EpubLimits={maxEntries:4096,maxDocumentBytes:16*1024*1024,maxTotalBytes:64*1024*1024};

const xmlAttribute=(tag:string,name:string)=>tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`,"i"))?.[1];
const decodeXml=(value:string)=>value.replace(/&#x([0-9a-f]+);/gi,(_,code:string)=>String.fromCodePoint(Number.parseInt(code,16))).replace(/&#(\d+);/g,(_,code:string)=>String.fromCodePoint(Number(code))).replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&quot;/gi,"\"").replace(/&apos;|&#39;/gi,"'");
const plainXmlText=(value:string)=>decodeXml(value.replace(/<[^>]+>/g,"")).trim();

export async function epubPackage(zip:JSZip,limits:EpubLimits):Promise<{opfPath:string;opf:string;title?:string;manifest:Map<string,EpubManifestItem>;spine:EpubSpineItem[]}>{
  const container=await zip.file("META-INF/container.xml")?.async("string"),rootfile=container?.match(/<rootfile\b[^>]*>/i)?.[0],opfPath=rootfile?xmlAttribute(rootfile,"full-path"):undefined;
  if(!opfPath)throw codedError("EPUB_CONTAINER_MISSING","EPUB container does not declare an OPF package");
  const opf=await zip.file(opfPath)?.async("string");if(!opf)throw codedError("EPUB_OPF_MISSING","EPUB OPF package is missing");
  if(opf.length>limits.maxDocumentBytes)throw codedError("EPUB_DOCUMENT_TOO_LARGE","EPUB OPF package exceeds the per-document size limit");
  const manifest=new Map<string,EpubManifestItem>();
  for(const match of opf.matchAll(/<item\b[^>]*>/gi)){const tag=match[0],id=xmlAttribute(tag,"id"),href=xmlAttribute(tag,"href");if(id&&href)manifest.set(id,{href,mediaType:xmlAttribute(tag,"media-type"),properties:xmlAttribute(tag,"properties")});}
  const spine:EpubSpineItem[]=[];
  for(const match of opf.matchAll(/<itemref\b[^>]*>/gi)){const tag=match[0],idref=xmlAttribute(tag,"idref");if(idref)spine.push({idref,linear:xmlAttribute(tag,"linear")});}
  const rawTitle=opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1],title=rawTitle?plainXmlText(rawTitle):undefined;
  return{opfPath,opf,title:title||undefined,manifest,spine};
}

export async function bestEffortEpubTitle(path:string):Promise<string|undefined>{
  try{const zip=await JSZip.loadAsync(await readFile(path));return(await epubPackage(zip,DEFAULT_EPUB_LIMITS)).title;}catch{return undefined;}
}

export function htmlText(html:string):{content:string;fallbackTitle?:string}{
  const body=html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]??html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi,"");
  const heading=body.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1];
  const content=decodeXml(body.replace(/<!--[\s\S]*?-->/g,"").replace(/<(script|style|nav)\b[^>]*>[\s\S]*?<\/\1>/gi,"").replace(/<br\s*\/?\s*>/gi,"\n").replace(/<\/(?:p|div|li|tr|blockquote|h[1-6]|section|article)>/gi,"\n").replace(/<[^>]+>/g,"")).replace(/\u00a0/g," ").replace(/[ \t]+\n/g,"\n").replace(/\n[ \t]+/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
  return{content,...(heading?{fallbackTitle:plainXmlText(heading).slice(0,100)}:{})};
}

const epubChapterHeading=(value:string)=>/^(?:第([零〇○Ｏ０一二三四五六七八九十两\d]+)(?:章|回|节)|chapter\s+(\d+))(?:\s+.*)?$/i.exec(value);
const epubPartHeading=(value:string)=>/^.{0,80}[（(](?:上|中|下|尾部|终章)[）)]$/.test(value);
const coverLike=(entryPath:string,item:EpubManifestItem,text:string,title?:string)=>{const normalized=text.trim().toLowerCase();return /(?:^|\/)(?:cover|titlepage)[^/]*\.(?:x?html?|htm)$/i.test(entryPath)&&(normalized==="cover"||normalized==="封面"||normalized.length<3)||(item.properties?.split(/\s+/).includes("nav")??false)||(title?.trim().toLowerCase()==="cover"&&normalized.length<200);};

export function splitEpubChunks(path:string,root:string,workRef:string,chunks:EpubChunk[],mtimeMs:number,bookTitle:string):SourceDocument[]{
  // Conversion tools commonly split XHTML by size rather than by chapter. Keep
  // a pending chapter across spine files and split only at explicit headings;
  // reverting to one-spine-item-per-chapter would silently destroy structure.
  const epubRel=relative(root,path).replaceAll("\\","/"),documents:SourceDocument[]=[];
  const headingCount=chunks.reduce((count,chunk)=>count+chunk.content.split("\n").filter(line=>epubChapterHeading(line.trim())).length,0);
  if(!headingCount)return chunks.map((chunk,index)=>({documentRef:stableId("doc",workRef,epubRel,chunk.entryPath),relativePath:`${epubRel}#${chunk.entryPath}`,absolutePath:path,title:chunk.fallbackTitle||chunk.content.split("\n").find(Boolean)?.slice(0,100)||`Chapter ${index+1}`,kind:"chapter",content:chunk.content,chapterNumber:index+1,volumeNumber:1,localChapterNumber:index+1,sourceStartLine:1,sourceSegments:[{relativePath:`${epubRel}#${chunk.entryPath}`,startLine:1,endLine:chunk.content.split("\n").length,documentStartLine:1,documentEndLine:chunk.content.split("\n").length}],sourceMtimeMs:mtimeMs,sourceSize:Buffer.byteLength(chunk.content)}));

  type Segment={entryPath:string;startLine:number;endLine:number;documentStartLine:number;documentEndLine:number};
  type Pending={title:string;local:number;volume:number;entryPath:string;startLine:number;lines:string[];segments:Segment[]};
  type Loose={entryPath:string;startLine:number;lines:string[];segments:Segment[]};
  let pending:Pending|undefined,preface:Loose|undefined,between:Loose|undefined,previousLocal=0,volume=1,sequence=0;
  const append=(target:{lines:string[];segments:Segment[]},entryPath:string,line:number,value:string)=>{const documentLine=target.lines.length+1,last=target.segments.at(-1);target.lines.push(value);if(last&&last.entryPath===entryPath&&last.endLine+1===line){last.endLine=line;last.documentEndLine=documentLine;}else target.segments.push({entryPath,startLine:line,endLine:line,documentStartLine:documentLine,documentEndLine:documentLine});};
  const sourceSegments=(segments:Segment[])=>segments.map(segment=>({relativePath:`${epubRel}#${segment.entryPath}`,startLine:segment.startLine,endLine:segment.endLine,documentStartLine:segment.documentStartLine,documentEndLine:segment.documentEndLine}));
  const addLoose=(target:Loose|undefined,entryPath:string,line:number,value:string):Loose=>{const next=target??{entryPath,startLine:line,lines:[],segments:[]};append(next,entryPath,line,value);return next;};
  const finishPending=()=>{if(!pending)return;const content=pending.lines.join("\n").trimEnd();if(content){sequence++;const locator=`v${pending.volume}-c${pending.local}`;documents.push({documentRef:stableId("doc",workRef,epubRel,locator),relativePath:`${epubRel}#${pending.entryPath}::${locator}`,absolutePath:path,title:pending.title,kind:"chapter",content,chapterNumber:sequence,volumeNumber:pending.volume,localChapterNumber:pending.local,sourceStartLine:pending.startLine,sourceSegments:sourceSegments(pending.segments),sourceMtimeMs:mtimeMs,sourceSize:Buffer.byteLength(content)});}pending=undefined;};
  const finishLoose=(loose:Loose|undefined,title:string,kind:"chapter"|"document")=>{if(!loose)return;const content=loose.lines.join("\n").trimEnd();if(!content)return;if(kind==="chapter")sequence++;const locator=kind==="chapter"?`section-${sequence}`:"preface";documents.push({documentRef:stableId("doc",workRef,epubRel,locator),relativePath:`${epubRel}#${loose.entryPath}::${locator}`,absolutePath:path,title,kind,content,...(kind==="chapter"?{chapterNumber:sequence,volumeNumber:volume,localChapterNumber:sequence}:{}),sourceStartLine:loose.startLine,sourceSegments:sourceSegments(loose.segments),sourceMtimeMs:mtimeMs,sourceSize:Buffer.byteLength(content)});};

  for(const chunk of chunks){const lines=chunk.content.replace(/\r\n?/g,"\n").split("\n");for(let index=0;index<lines.length;index++){const line=lines[index]!,sourceLine=index+1,trimmed=line.trim(),heading=epubChapterHeading(trimmed);if(heading){finishPending();if(!previousLocal&&preface){finishLoose(preface,`${bookTitle} preface`,"document");preface=undefined;}if(previousLocal&&chapterNumber(heading[1]??heading[2]!)!<=previousLocal)volume++;const local=chapterNumber(heading[1]??heading[2]!)!;previousLocal=local;const prefix=between;pending={title:trimmed,local,volume,entryPath:prefix?.entryPath??chunk.entryPath,startLine:prefix?.startLine??sourceLine,lines:prefix?[...prefix.lines]:[],segments:prefix?prefix.segments.map(segment=>({...segment})):[]};append(pending,chunk.entryPath,sourceLine,trimmed);between=undefined;continue;}if(trimmed&&epubPartHeading(trimmed)){finishPending();between=addLoose(undefined,chunk.entryPath,sourceLine,line);continue;}if(pending)append(pending,chunk.entryPath,sourceLine,line);else if(between)append(between,chunk.entryPath,sourceLine,line);else preface=addLoose(preface,chunk.entryPath,sourceLine,line);}}
  finishPending();
  if(preface)finishLoose(preface,`${bookTitle} preface`,"document");
  if(between)finishLoose(between,between.lines.find(line=>line.trim())?.trim()??`${bookTitle} tail`,"chapter");
  return documents;
}

export async function epubDocuments(path:string,root:string,workRef:string,bookTitle:string,limits:EpubLimits):Promise<SourceDocument[]>{
  const data=await readFile(path);let zip:JSZip;try{zip=await JSZip.loadAsync(data);}catch(error){throw codedError("EPUB_INVALID_ZIP","EPUB is not a readable ZIP container",error);}
  // AUD-028: deterministic resource limits guard against ZIP bombs and
  // unbounded packages; every breach is a stable error code, never a hang.
  const entryCount=Object.keys(zip.files).length;if(entryCount>limits.maxEntries)throw codedError("EPUB_TOO_MANY_ENTRIES",`EPUB contains ${entryCount} ZIP entries, above the limit of ${limits.maxEntries}`);
  const pkg=await epubPackage(zip,limits),opfDir=posix.dirname(pkg.opfPath),info=await stat(path),chunks:EpubChunk[]=[];let totalDecoded=0;
  for(const spineItem of pkg.spine){if(spineItem.linear?.toLowerCase()==="no")continue;const item=pkg.manifest.get(spineItem.idref);if(!item)continue;let decodedHref:string;try{decodedHref=decodeURIComponent(item.href.split("#")[0]!);}catch(error){throw codedError("EPUB_HREF_INVALID",`EPUB manifest contains an invalid href: ${item.href}`,error);}const entryPath=posix.normalize(posix.join(opfDir==="."?"":opfDir,decodedHref)).replace(/^\/+/g,"");if(entryPath.startsWith("../"))throw codedError("EPUB_HREF_INVALID",`EPUB manifest href escapes the package root: ${item.href}`);const html=await zip.file(entryPath)?.async("string");if(!html)continue;if(html.length>limits.maxDocumentBytes)throw codedError("EPUB_DOCUMENT_TOO_LARGE",`EPUB spine document ${entryPath} exceeds the per-document size limit`);totalDecoded+=html.length;if(totalDecoded>limits.maxTotalBytes)throw codedError("EPUB_TOTAL_TOO_LARGE","EPUB total decoded spine exceeds the package size limit");const parsed=htmlText(html);if(!parsed.content||coverLike(entryPath,item,parsed.content,parsed.fallbackTitle))continue;chunks.push({entryPath,content:parsed.content,fallbackTitle:parsed.fallbackTitle??parsed.content.split("\n").find(Boolean)?.slice(0,100)??`Chapter ${chunks.length+1}`});}
  if(!chunks.length)throw codedError("EPUB_NO_READABLE_SPINE","EPUB contains no readable spine chapters");const documents=splitEpubChunks(path,root,workRef,chunks,info.mtimeMs,pkg.title??bookTitle);if(!documents.length)throw codedError("EPUB_NO_READABLE_SPINE","EPUB contains no readable spine chapters");return documents;
}
