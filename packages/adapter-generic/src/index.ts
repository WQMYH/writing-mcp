import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, posix, relative } from "node:path";
import JSZip from "jszip";
import { assertWithin, safeRealpath, stableId, type ParsedWork, type SourceDocument, type WorkAdapter, type WorkCandidate } from "@writing-mcp/core";

const supported = new Set([".md", ".markdown", ".txt", ".epub"]);
const titleOf = (path: string, content: string) => content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(path, extname(path));
const chapterOf = (title: string) => Number(title.match(/(?:第\s*)?(\d+)\s*(?:章|chapter)?/i)?.[1]) || undefined;
const codedError=(code:string,message:string,cause?:unknown)=>Object.assign(new Error(message,{cause}),{code});
const chineseDigits:Record<string,number>={"零":0,"〇":0,"○":0,"Ｏ":0,"０":0,"一":1,"二":2,"两":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9};
const chapterNumber=(value:string)=>{if(/^\d+$/.test(value))return Number(value);const [tens,ones]=value.split("十");if(value.includes("十"))return(tens?chineseDigits[tens]??0:1)*10+(ones?chineseDigits[ones]??0:0);return chineseDigits[value];};
const decodeText=(data:Uint8Array)=>{if(data[0]===0xef&&data[1]===0xbb&&data[2]===0xbf)return new TextDecoder("utf-8",{fatal:true}).decode(data.subarray(3));try{return new TextDecoder("utf-8",{fatal:true}).decode(data);}catch{try{return new TextDecoder("gb18030",{fatal:true}).decode(data);}catch(error){throw codedError("TEXT_ENCODING_UNSUPPORTED","Text is neither valid UTF-8 nor GB18030",error);}}};

function txtDocuments(file:string,root:string,workRef:string,content:string,mtimeMs:number):SourceDocument[]{
  const lines=content.replace(/\r\n?/g,"\n").split("\n"),headings:Array<{line:number;local:number;volume:number;title:string}>=[];let volume=1,previous=0;
  for(let line=0;line<lines.length;line++){const title=lines[line]!.trim(),match=/^(?:第([零〇○Ｏ０一二三四五六七八九十两\d]+)(?:章|回|节)|chapter\s+(\d+|[ivxlcdm]+))(?:\s+.*)?$/i.exec(title);if(!match)continue;const local=match[1]?chapterNumber(match[1]):Number(match[2]);if(!local)continue;if(previous&&local<=previous)volume++;headings.push({line,local,volume,title});previous=local;}
  if(!headings.length)return[];
  const rel=relative(root,file).replaceAll("\\","/"),documents:SourceDocument[]=[];
  if(headings[0]!.line>0){const preface=lines.slice(0,headings[0]!.line).join("\n").trim();if(preface)documents.push({documentRef:stableId("doc",workRef,rel,"preface"),relativePath:`${rel}#preface`,absolutePath:file,title:`${basename(file,extname(file))} preface`,kind:"document",content:preface,sourceStartLine:1,sourceMtimeMs:mtimeMs,sourceSize:Buffer.byteLength(preface)});}
  for(let index=0;index<headings.length;index++){const heading=headings[index]!,end=headings[index+1]?.line??lines.length,piece=lines.slice(heading.line,end).join("\n").trimEnd(),locator=`v${heading.volume}-c${heading.local}`;documents.push({documentRef:stableId("doc",workRef,rel,locator),relativePath:`${rel}#${locator}`,absolutePath:file,title:heading.title,kind:"chapter",content:piece,chapterNumber:index+1,sourceStartLine:heading.line+1,sourceMtimeMs:mtimeMs,sourceSize:Buffer.byteLength(piece)});}
  return documents;
}

async function filesUnder(path: string,root?:string,visited=new Set<string>()): Promise<string[]> {
  const real=await safeRealpath(path),safeRoot=root??real;assertWithin(safeRoot,real);if(visited.has(real))return[];visited.add(real);const info = await stat(real); if (info.isFile()) return supported.has(extname(real).toLowerCase()) ? [real] : [];
  const out: string[] = []; for (const entry of await readdir(real, { withFileTypes: true })) { if (entry.name.startsWith(".") || entry.name === "node_modules") continue; const child=join(real,entry.name);const childReal=await safeRealpath(child);assertWithin(safeRoot,childReal);if(entry.isDirectory()) out.push(...await filesUnder(childReal,safeRoot,visited)); else if(supported.has(extname(entry.name).toLowerCase())) out.push(childReal); } return out.sort();
}

interface EpubManifestItem { href:string; mediaType?:string; properties?:string }
interface EpubSpineItem { idref:string; linear?:string }
interface EpubChunk { entryPath:string; content:string; fallbackTitle:string }

const xmlAttribute=(tag:string,name:string)=>tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`,"i"))?.[1];
const decodeXml=(value:string)=>value.replace(/&#x([0-9a-f]+);/gi,(_,code:string)=>String.fromCodePoint(Number.parseInt(code,16))).replace(/&#(\d+);/g,(_,code:string)=>String.fromCodePoint(Number(code))).replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&quot;/gi,"\"").replace(/&apos;|&#39;/gi,"'");
const plainXmlText=(value:string)=>decodeXml(value.replace(/<[^>]+>/g,"")).trim();

async function epubPackage(zip:JSZip):Promise<{opfPath:string;opf:string;title?:string;manifest:Map<string,EpubManifestItem>;spine:EpubSpineItem[]}>{
  const container=await zip.file("META-INF/container.xml")?.async("string"),rootfile=container?.match(/<rootfile\b[^>]*>/i)?.[0],opfPath=rootfile?xmlAttribute(rootfile,"full-path"):undefined;
  if(!opfPath)throw codedError("EPUB_CONTAINER_MISSING","EPUB container does not declare an OPF package");
  const opf=await zip.file(opfPath)?.async("string");if(!opf)throw codedError("EPUB_OPF_MISSING","EPUB OPF package is missing");
  const manifest=new Map<string,EpubManifestItem>();
  for(const match of opf.matchAll(/<item\b[^>]*>/gi)){const tag=match[0],id=xmlAttribute(tag,"id"),href=xmlAttribute(tag,"href");if(id&&href)manifest.set(id,{href,mediaType:xmlAttribute(tag,"media-type"),properties:xmlAttribute(tag,"properties")});}
  const spine:EpubSpineItem[]=[];
  for(const match of opf.matchAll(/<itemref\b[^>]*>/gi)){const tag=match[0],idref=xmlAttribute(tag,"idref");if(idref)spine.push({idref,linear:xmlAttribute(tag,"linear")});}
  const rawTitle=opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1],title=rawTitle?plainXmlText(rawTitle):undefined;
  return{opfPath,opf,title:title||undefined,manifest,spine};
}

async function bestEffortEpubTitle(path:string):Promise<string|undefined>{
  try{const zip=await JSZip.loadAsync(await readFile(path));return(await epubPackage(zip)).title;}catch{return undefined;}
}

function htmlText(html:string):{content:string;fallbackTitle?:string}{
  const body=html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]??html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi,"");
  const heading=body.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1];
  const content=decodeXml(body.replace(/<!--[\s\S]*?-->/g,"").replace(/<(script|style|nav)\b[^>]*>[\s\S]*?<\/\1>/gi,"").replace(/<br\s*\/?\s*>/gi,"\n").replace(/<\/(?:p|div|li|tr|blockquote|h[1-6]|section|article)>/gi,"\n").replace(/<[^>]+>/g,"")).replace(/\u00a0/g," ").replace(/[ \t]+\n/g,"\n").replace(/\n[ \t]+/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
  return{content,...(heading?{fallbackTitle:plainXmlText(heading).slice(0,100)}:{})};
}

const epubChapterHeading=(value:string)=>/^(?:第([零〇○Ｏ０一二三四五六七八九十两\d]+)(?:章|回|节)|chapter\s+(\d+))(?:\s+.*)?$/i.exec(value);
const epubPartHeading=(value:string)=>/^.{0,80}[（(](?:上|中|下|尾部|终章)[）)]$/.test(value);
const coverLike=(entryPath:string,item:EpubManifestItem,text:string,title?:string)=>{const normalized=text.trim().toLowerCase();return /(?:^|\/)(?:cover|titlepage)[^/]*\.(?:x?html?|htm)$/i.test(entryPath)&&(normalized==="cover"||normalized==="封面"||normalized.length<3)||(item.properties?.split(/\s+/).includes("nav")??false)||(title?.trim().toLowerCase()==="cover"&&normalized.length<200);};

function splitEpubChunks(path:string,root:string,workRef:string,chunks:EpubChunk[],mtimeMs:number,bookTitle:string):SourceDocument[]{
  // Conversion tools commonly split XHTML by size rather than by chapter. Keep
  // a pending chapter across spine files and split only at explicit headings;
  // reverting to one-spine-item-per-chapter would silently destroy structure.
  const epubRel=relative(root,path).replaceAll("\\","/"),documents:SourceDocument[]=[];
  const headingCount=chunks.reduce((count,chunk)=>count+chunk.content.split("\n").filter(line=>epubChapterHeading(line.trim())).length,0);
  if(!headingCount)return chunks.map((chunk,index)=>({documentRef:stableId("doc",workRef,epubRel,chunk.entryPath),relativePath:`${epubRel}#${chunk.entryPath}`,absolutePath:path,title:chunk.fallbackTitle||chunk.content.split("\n").find(Boolean)?.slice(0,100)||`Chapter ${index+1}`,kind:"chapter",content:chunk.content,chapterNumber:index+1,sourceStartLine:1,sourceMtimeMs:mtimeMs,sourceSize:Buffer.byteLength(chunk.content)}));

  type Pending={title:string;local:number;volume:number;entryPath:string;startLine:number;lines:string[]};
  type Loose={entryPath:string;startLine:number;lines:string[]};
  let pending:Pending|undefined,preface:Loose|undefined,between:Loose|undefined,previousLocal=0,volume=1,sequence=0;
  const addLoose=(target:Loose|undefined,entryPath:string,line:number,value:string):Loose=>{const next=target??{entryPath,startLine:line,lines:[]};next.lines.push(value);return next;};
  const finishPending=()=>{if(!pending)return;const content=pending.lines.join("\n").trim();if(content){sequence++;const locator=`v${pending.volume}-c${pending.local}`;documents.push({documentRef:stableId("doc",workRef,epubRel,locator),relativePath:`${epubRel}#${pending.entryPath}::${locator}`,absolutePath:path,title:pending.title,kind:"chapter",content,chapterNumber:sequence,sourceStartLine:pending.startLine,sourceMtimeMs:mtimeMs,sourceSize:Buffer.byteLength(content)});}pending=undefined;};
  const finishLoose=(loose:Loose|undefined,title:string,kind:"chapter"|"document")=>{if(!loose)return;const content=loose.lines.join("\n").trim();if(!content)return;if(kind==="chapter")sequence++;const locator=kind==="chapter"?`section-${sequence}`:"preface";documents.push({documentRef:stableId("doc",workRef,epubRel,locator),relativePath:`${epubRel}#${loose.entryPath}::${locator}`,absolutePath:path,title,kind,content,...(kind==="chapter"?{chapterNumber:sequence}:{}),sourceStartLine:loose.startLine,sourceMtimeMs:mtimeMs,sourceSize:Buffer.byteLength(content)});};

  for(const chunk of chunks){const lines=chunk.content.replace(/\r\n?/g,"\n").split("\n");for(let index=0;index<lines.length;index++){const line=lines[index]!,trimmed=line.trim(),heading=epubChapterHeading(trimmed);if(heading){finishPending();if(!previousLocal&&preface){finishLoose(preface,`${bookTitle} preface`,"document");preface=undefined;}if(previousLocal&&chapterNumber(heading[1]??heading[2]!)!<=previousLocal)volume++;const local=chapterNumber(heading[1]??heading[2]!)!;previousLocal=local;const prefix=between?.lines??[];pending={title:trimmed,local,volume,entryPath:chunk.entryPath,startLine:index+1,lines:[...prefix,trimmed]};between=undefined;continue;}if(trimmed&&epubPartHeading(trimmed)){finishPending();between=addLoose(undefined,chunk.entryPath,index+1,line);continue;}if(pending)pending.lines.push(line);else if(between)between.lines.push(line);else preface=addLoose(preface,chunk.entryPath,index+1,line);}}
  finishPending();
  if(preface)finishLoose(preface,`${bookTitle} preface`,"document");
  if(between)finishLoose(between,between.lines.find(line=>line.trim())?.trim()??`${bookTitle} tail`,"chapter");
  return documents;
}

async function epubDocuments(path:string,root:string,workRef:string,bookTitle:string):Promise<SourceDocument[]>{
  const data=await readFile(path);let zip:JSZip;try{zip=await JSZip.loadAsync(data);}catch(error){throw codedError("EPUB_INVALID_ZIP","EPUB is not a readable ZIP container",error);}const pkg=await epubPackage(zip),opfDir=posix.dirname(pkg.opfPath),info=await stat(path),chunks:EpubChunk[]=[];
  for(const spineItem of pkg.spine){if(spineItem.linear?.toLowerCase()==="no")continue;const item=pkg.manifest.get(spineItem.idref);if(!item)continue;let decodedHref:string;try{decodedHref=decodeURIComponent(item.href.split("#")[0]!);}catch(error){throw codedError("EPUB_HREF_INVALID",`EPUB manifest contains an invalid href: ${item.href}`,error);}const entryPath=posix.normalize(posix.join(opfDir==="."?"":opfDir,decodedHref)).replace(/^\/+/,"");if(entryPath.startsWith("../"))throw codedError("EPUB_HREF_INVALID",`EPUB manifest href escapes the package root: ${item.href}`);const html=await zip.file(entryPath)?.async("string");if(!html)continue;const parsed=htmlText(html);if(!parsed.content||coverLike(entryPath,item,parsed.content,parsed.fallbackTitle))continue;chunks.push({entryPath,content:parsed.content,fallbackTitle:parsed.fallbackTitle??parsed.content.split("\n").find(Boolean)?.slice(0,100)??`Chapter ${chunks.length+1}`});}
  if(!chunks.length)throw codedError("EPUB_NO_READABLE_SPINE","EPUB contains no readable spine chapters");const documents=splitEpubChunks(path,root,workRef,chunks,info.mtimeMs,pkg.title??bookTitle);if(!documents.length)throw codedError("EPUB_NO_READABLE_SPINE","EPUB contains no readable spine chapters");return documents;
}

export class GenericAdapter implements WorkAdapter {
  readonly kind="generic" as const;
  async discover(sourcePath:string):Promise<WorkCandidate[]>{try{const real=await safeRealpath(sourcePath);const files=await filesUnder(real);if(!files.length)return[];const directory=(await stat(real)).isDirectory();const root=directory?real:dirname(real);let title=directory?basename(real):basename(real,extname(real));if(files.length===1&&extname(files[0]!).toLowerCase()===".epub")title=await bestEffortEpubTitle(files[0]!)??title;return[{workRef:stableId("work","generic",real),title,rootPath:root,sourcePath:real,adapter:this.kind,capabilities:["documents","full_text","epub"]}];}catch(error){if(typeof error==="object"&&error&&"code" in error&&error.code==="PATH_NOT_ALLOWED")throw error;return[];}}
  async load(candidate:WorkCandidate):Promise<ParsedWork>{const files=await filesUnder(candidate.sourcePath??candidate.rootPath);const documents:SourceDocument[]=[];for(const file of files){const extension=extname(file).toLowerCase();if(extension===".epub"){documents.push(...await epubDocuments(file,candidate.rootPath,candidate.workRef,candidate.title));continue;}const info=await stat(file),content=decodeText(await readFile(file));if(extension===".txt"){const chapters=txtDocuments(file,candidate.rootPath,candidate.workRef,content,info.mtimeMs);if(chapters.length){documents.push(...chapters);continue;}}const title=titleOf(file,content);const label=(file+" "+title).toLowerCase();const kind=/chapter|章节|第\s*\d+\s*章/i.test(label)?"chapter":/characters?|角色|人物/.test(label)?"character":"document";documents.push({documentRef:stableId("doc",candidate.workRef,relative(candidate.rootPath,file)),relativePath:relative(candidate.rootPath,file).replaceAll("\\","/"),absolutePath:file,title,kind,content,chapterNumber:chapterOf(title),sourceMtimeMs:info.mtimeMs,sourceSize:info.size});}return{...candidate,documents};}
}
