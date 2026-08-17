// Generic work adapter: discovery (AUD-026 work boundary) and load
// orchestration. Ingestion strategies live in dedicated modules:
// numbering.ts (AUD-027 chapter numbers), txt.ts (TXT decode/split,
// AUD-029 text limits), epub.ts (EPUB parsing, AUD-028 resource limits).
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { assertWithin, safeRealpath, stableId, type ParsedWork, type SourceDocument, type WorkAdapter, type WorkCandidate } from "@writing-mcp/core";
import { codedError } from "./errors.js";
import { bestEffortEpubTitle, epubDocuments, DEFAULT_EPUB_LIMITS, type EpubLimits } from "./epub.js";
import { decodeText, txtDocuments, DEFAULT_TEXT_LIMITS, type TextLimits } from "./txt.js";
import { chapterOf } from "./numbering.js";

export { DEFAULT_EPUB_LIMITS, type EpubLimits } from "./epub.js";
export { DEFAULT_TEXT_LIMITS, type TextLimits } from "./txt.js";

const supported = new Set([".md", ".markdown", ".txt", ".epub"]);
const titleOf = (path: string, content: string) => content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(path, extname(path));

async function filesUnder(path: string,root?:string,visited=new Set<string>()): Promise<string[]> {
  const real=await safeRealpath(path),safeRoot=root??real;assertWithin(safeRoot,real);if(visited.has(real))return[];visited.add(real);const info = await stat(real); if (info.isFile()) return supported.has(extname(real).toLowerCase()) ? [real] : [];
  const out: string[] = []; for (const entry of await readdir(real, { withFileTypes: true })) { if (entry.name.startsWith(".") || entry.name === "node_modules") continue; const child=join(real,entry.name);const childReal=await safeRealpath(child);assertWithin(safeRoot,childReal);if(entry.isDirectory()) out.push(...await filesUnder(childReal,safeRoot,visited)); else if(supported.has(extname(entry.name).toLowerCase())) out.push(childReal); } return out.sort();
}

export class GenericAdapter implements WorkAdapter {
  readonly kind="generic" as const;
  private readonly epubLimits:EpubLimits;
  private readonly textLimits:TextLimits;
  constructor(options?:{epub?:Partial<EpubLimits>;text?:Partial<TextLimits>}){this.epubLimits={...DEFAULT_EPUB_LIMITS,...options?.epub};this.textLimits={...DEFAULT_TEXT_LIMITS,...options?.text};}
  async discover(sourcePath:string):Promise<WorkCandidate[]>{try{const real=await safeRealpath(sourcePath);const files=await filesUnder(real);if(!files.length)return[];const directory=(await stat(real)).isDirectory();
    // AUD-026 work boundary: each EPUB is a self-contained book container and
    // becomes its own candidate (identical to resolving the file directly);
    // remaining text files merge into one directory work. Multiple candidates
    // surface as ambiguity instead of one silently merged work.
    if(!directory){const epub=extname(real).toLowerCase()===".epub";let title=basename(real,extname(real));if(epub)title=await bestEffortEpubTitle(real)??title;return[{workRef:stableId("work","generic",real),title,rootPath:dirname(real),sourcePath:real,adapter:this.kind,capabilities:["documents","full_text",...(epub?["epub" as const]:[])]}];}
    const epubs=files.filter(file=>extname(file).toLowerCase()===".epub"),texts=files.filter(file=>extname(file).toLowerCase()!==".epub"),candidates:WorkCandidate[]=[];
    for(const epub of epubs)candidates.push({workRef:stableId("work","generic",epub),title:await bestEffortEpubTitle(epub)??basename(epub,extname(epub)),rootPath:dirname(epub),sourcePath:epub,adapter:this.kind,capabilities:["documents","full_text","epub"]});
    if(texts.length)candidates.push({workRef:stableId("work","generic",real),title:basename(real),rootPath:real,sourcePath:real,adapter:this.kind,capabilities:["documents","full_text"]});
    return candidates;}catch(error){if(typeof error==="object"&&error&&"code" in error&&error.code==="PATH_NOT_ALLOWED")throw error;return[];}}
  async load(candidate:WorkCandidate):Promise<ParsedWork>{const epubCapable=candidate.capabilities.includes("epub");const files=(await filesUnder(candidate.sourcePath??candidate.rootPath)).filter(file=>epubCapable||extname(file).toLowerCase()!==".epub");const documents:SourceDocument[]=[];let totalTextBytes=0;for(const file of files){const extension=extname(file).toLowerCase();if(extension===".epub"){documents.push(...await epubDocuments(file,candidate.rootPath,candidate.workRef,candidate.title,this.epubLimits));continue;}const info=await stat(file),data=await readFile(file);
      // AUD-029: deterministic per-file and per-work size bounds; breaches
      // are stable error codes, never unbounded memory growth.
      if(data.byteLength>this.textLimits.maxDocumentBytes)throw codedError("SOURCE_FILE_TOO_LARGE","Text file exceeds the per-file size limit");
      totalTextBytes+=data.byteLength;if(totalTextBytes>this.textLimits.maxTotalBytes)throw codedError("SOURCE_TOTAL_TOO_LARGE","Combined work text exceeds the total size limit");
      const content=decodeText(data);if(extension===".txt"){const chapters=txtDocuments(file,candidate.rootPath,candidate.workRef,content,info.mtimeMs);if(chapters.length){documents.push(...chapters);continue;}}const title=titleOf(file,content);const label=(file+" "+title).toLowerCase();const kind=/chapter|章节|第\s*(?:\d+|[零〇○ｏ０一二三四五六七八九十两百两]+)\s*(?:章|回|节)/i.test(label)?"chapter":/characters?|角色|人物/.test(label)?"character":"document";documents.push({documentRef:stableId("doc",candidate.workRef,relative(candidate.rootPath,file)),relativePath:relative(candidate.rootPath,file).replaceAll("\\","/"),absolutePath:file,title,kind,content,chapterNumber:chapterOf(title),sourceMtimeMs:info.mtimeMs,sourceSize:info.size});}return{...candidate,documents};}
}
