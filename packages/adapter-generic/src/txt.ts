// TXT decoding and chapter splitting: extracted pure-ish ingestion helpers;
// behavior-frozen by tests/generic-txt.test.ts and tests/txt-numbering.test.ts.
import { basename, extname, relative } from "node:path";
import { stableId, type SourceDocument } from "@writing-mcp/core";
import { codedError } from "./errors.js";
import { chapterNumber } from "./numbering.js";

// AUD-029: per-file and per-work bounds keep full-text loading finite.
export interface TextLimits { maxDocumentBytes:number; maxTotalBytes:number }
export const DEFAULT_TEXT_LIMITS:TextLimits={maxDocumentBytes:16*1024*1024,maxTotalBytes:64*1024*1024};

export const decodeText=(data:Uint8Array)=>{if(data[0]===0xef&&data[1]===0xbb&&data[2]===0xbf)return new TextDecoder("utf-8",{fatal:true}).decode(data.subarray(3));try{return new TextDecoder("utf-8",{fatal:true}).decode(data);}catch{try{return new TextDecoder("gb18030",{fatal:true}).decode(data);}catch(error){throw codedError("TEXT_ENCODING_UNSUPPORTED","Text is neither valid UTF-8 nor GB18030",error);}}};

export function txtDocuments(file:string,root:string,workRef:string,content:string,mtimeMs:number):SourceDocument[]{
  const lines=content.replace(/\r\n?/g,"\n").split("\n"),headings:Array<{line:number;local:number;volume:number;title:string}>=[];let volume=1,previous=0;
  for(let line=0;line<lines.length;line++){const title=lines[line]!.trim(),match=/^(?:第([零〇○Ｏ０一二三四五六七八九十两百两\d]+)(?:章|回|节)|chapter\s+(\d+|[ivxlcdm]+))(?:\s+.*)?$/i.exec(title);if(!match)continue;const local=chapterNumber(match[1]??match[2]!);if(!local)continue;if(previous&&local<=previous)volume++;headings.push({line,local,volume,title});previous=local;}
  if(!headings.length)return[];
  const rel=relative(root,file).replaceAll("\\","/"),documents:SourceDocument[]=[];
  if(headings[0]!.line>0){const preface=lines.slice(0,headings[0]!.line).join("\n").trim();if(preface)documents.push({documentRef:stableId("doc",workRef,rel,"preface"),relativePath:`${rel}#preface`,absolutePath:file,title:`${basename(file,extname(file))} preface`,kind:"document",content:preface,sourceStartLine:1,sourceMtimeMs:mtimeMs,sourceSize:Buffer.byteLength(preface)});}
  for(let index=0;index<headings.length;index++){const heading=headings[index]!,end=headings[index+1]?.line??lines.length,piece=lines.slice(heading.line,end).join("\n").trimEnd(),locator=`v${heading.volume}-c${heading.local}`;documents.push({documentRef:stableId("doc",workRef,rel,locator),relativePath:`${rel}#${locator}`,absolutePath:file,title:heading.title,kind:"chapter",content:piece,chapterNumber:index+1,volumeNumber:heading.volume,localChapterNumber:heading.local,sourceStartLine:heading.line+1,sourceMtimeMs:mtimeMs,sourceSize:Buffer.byteLength(piece)});}
  return documents;
}
