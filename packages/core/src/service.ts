import type { AdapterKind, ContextPacket, ExploreOperation, ExploreResult, IndexResult, ResolveResult, WorkAdapter, WorkCandidate } from "./types.js";
import { WritingStore } from "./store.js";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";

const EXPLORE_TIME_LIMIT_MS = 30_000;

export class WritingService {
  private readonly works=new Map<string,WorkCandidate>(); private readonly stores=new Map<string,WritingStore>();
  private readonly queues=new Map<string,Promise<void>>();
  private readonly fingerprints=new Map<string,string>();
  constructor(private readonly adapters:WorkAdapter[],private readonly authorizedRoots?:string[]){}
  async resolve(sourcePath:string,adapterHint?:AdapterKind):Promise<ResolveResult>{
    if(this.authorizedRoots){const {assertAuthorizedPath}=await import("./ids.js");sourcePath=await assertAuthorizedPath(sourcePath,this.authorizedRoots);}
    const selected=adapterHint?this.adapters.filter(a=>a.kind===adapterHint):this.adapters.filter(a=>a.kind!=="generic");
    let candidates=(await Promise.all(selected.map(a=>a.discover(sourcePath)))).flat();
    if(!adapterHint&&candidates.length===0){const fallback=this.adapters.filter(a=>a.kind==="generic");candidates=(await Promise.all(fallback.map(a=>a.discover(sourcePath)))).flat();}
    for(const c of candidates)this.works.set(c.workRef,c);
    return{status:candidates.length===1?"resolved":candidates.length>1?"ambiguous":"unsupported",workRef:candidates.length===1?candidates[0]!.workRef:undefined,candidates,diagnostics:candidates.length?[]:[{code:"UNSUPPORTED_SOURCE",message:"No supported writing work found",path:sourcePath}]};
  }
  private async store(workRef:string){let store=this.stores.get(workRef);if(store)return store;const candidate=this.works.get(workRef);if(!candidate)throw Object.assign(new Error("Unknown workRef; call writing_resolve first"),{code:"WORK_REF_NOT_FOUND"});const adapter=this.adapters.find(a=>a.kind===candidate.adapter)!;store=new WritingStore(await adapter.load(candidate));this.stores.set(workRef,store);return store;}
  private async serial<T>(workRef:string,action:()=>Promise<T>):Promise<T>{
    const previous=this.queues.get(workRef)??Promise.resolve();
    const current=previous.catch(()=>undefined).then(action);
    const marker=current.then(()=>undefined,()=>undefined);
    this.queues.set(workRef,marker);
    try{return await current;}finally{if(this.queues.get(workRef)===marker)this.queues.delete(workRef);}
  }
  private async indexUnlocked(workRef:string,mode:"status"|"incremental"|"rebuild"):Promise<IndexResult>{
    const candidate=this.works.get(workRef);
    if(!candidate)throw Object.assign(new Error("Unknown workRef; call writing_resolve first"),{code:"WORK_REF_NOT_FOUND"});
    const adapter=this.adapters.find(a=>a.kind===candidate.adapter)!;
    const next=new WritingStore(await adapter.load(candidate));
    this.stores.get(workRef)?.close();
    this.stores.set(workRef,next);
    return next.index(mode);
  }
  /**
   * Lightweight source fingerprint: file names plus (mtimeMs,size) for every
   * supported source file under the work root. Content edits touch mtime, so an
   * unchanged fingerprint means the derived index needs no reload. EPUB/TXT/MD
   * reading is deferred to adapter.load, which only runs when the fingerprint
   * changes (AUD-021: explore/context must not re-read the whole work per call).
   */
  private async sourceFingerprint(candidate:WorkCandidate):Promise<string>{
    const root=candidate.sourcePath??candidate.rootPath;
    const entries:string[]=[];
    const walk=async(dir:string,depth:number):Promise<void>=>{
      if(depth>12)return;
      let names:string[];
      try{names=await readdir(dir,{withFileTypes:true}).then(list=>list.map(e=>e.name));}catch{return;}
      for(const name of names){if(name.startsWith(".")||name==="node_modules")continue;const full=join(dir,name);let info;try{info=await stat(full);}catch{continue;}if(info.isDirectory()){entries.push(`d:${name}`);await walk(full,depth+1);}else if(info.isFile()){entries.push(`f:${name}:${Math.trunc(info.mtimeMs)}:${info.size}`);}}
    };
    await walk(root,0);
    entries.sort();
    return entries.join("|");
  }
  /** Reuse the existing store when the source fingerprint is unchanged; reload
   * only when files changed (AUD-021). The first query builds the store once. */
  private async ensureFresh(workRef:string):Promise<void>{
    const candidate=this.works.get(workRef);
    if(!candidate)throw Object.assign(new Error("Unknown workRef; call writing_resolve first"),{code:"WORK_REF_NOT_FOUND"});
    const fingerprint=await this.sourceFingerprint(candidate);
    const previous=this.fingerprints.get(workRef);
    this.fingerprints.set(workRef,fingerprint);
    if(!this.stores.has(workRef)){await this.indexUnlocked(workRef,"incremental");return;}
    if(previous===undefined||previous===fingerprint)return;
    await this.indexUnlocked(workRef,"incremental");
  }
  async index(workRef:string,mode:"status"|"incremental"|"rebuild"):Promise<IndexResult>{return this.serial(workRef,async()=>{const result=await this.indexUnlocked(workRef,mode);if(mode!=="status"){const candidate=this.works.get(workRef);if(candidate)this.fingerprints.set(workRef,await this.sourceFingerprint(candidate));}return result;});}
  async explore(workRef:string,operation:ExploreOperation,query="",limit=20,maxHops=2,targetChapter?:number):Promise<ExploreResult>{
    const started=performance.now();
    const result=await this.serial(workRef,async()=>{await this.ensureFresh(workRef);return (await this.store(workRef)).explore(operation,query,limit,maxHops,targetChapter);});
    const elapsedMs=performance.now()-started;
    if(elapsedMs>EXPLORE_TIME_LIMIT_MS)throw Object.assign(new Error(`Explore exceeded the ${EXPLORE_TIME_LIMIT_MS}ms deterministic time limit (took ${Math.trunc(elapsedMs)}ms)`),{code:"EXPLORE_TIME_LIMIT_EXCEEDED"});
    return result;
  }
  async context(workRef:string,query:string,budgetTokens:number,requiredRefs:string[]=[]):Promise<ContextPacket>{return this.serial(workRef,async()=>{await this.ensureFresh(workRef);return (await this.store(workRef)).context(query,budgetTokens,requiredRefs);});}
  diagnosticDirectory(workRef?:string):string|undefined{const candidate=workRef?this.works.get(workRef):undefined;const root=candidate?.rootPath??this.authorizedRoots?.[0];if(!root)return undefined;const scope=candidate?workRef!.replaceAll(":","-"):"_server";return join(root,".writing-index",scope,"diagnostics");}
  close():void{for(const store of this.stores.values())store.close();this.stores.clear();this.queues.clear();this.fingerprints.clear();}
}
