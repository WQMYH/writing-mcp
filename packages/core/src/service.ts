import type { AdapterKind, ContextOptions, ContextPacket, ExploreOperation, ExploreResult, IndexResult, ParsedWork, ResolveResult, WorkAdapter, WorkCandidate } from "./types.js";
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
  private async store(workRef:string){let store=this.stores.get(workRef);if(store)return store;const candidate=this.works.get(workRef);if(!candidate)throw Object.assign(new Error("Unknown workRef; call writing_resolve first"),{code:"WORK_REF_NOT_FOUND"});store=new WritingStore(await this.loadConsistent(candidate));this.stores.set(workRef,store);return store;}
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
    // Mtime/size fast path (status only): the source fingerprint is the file
    // name+mtime+size directory, so an unchanged fingerprint means adapter.load
    // would produce an identical ParsedWork and the semantic snapshot verdict
    // cannot change — reuse the existing store instead of re-reading every
    // source file. Any file change falls through to the full semantic path;
    // incremental/rebuild never use the fast path.
    // Record fingerprint inside indexUnlocked to eliminate double-computation
    // race (f3ddd1f review finding F1): compute once, record before return.
    const existing=this.stores.get(workRef);
    if(mode==="status"&&existing){
      const fingerprint=await this.sourceFingerprint(candidate);
      if(this.fingerprints.get(workRef)===fingerprint){
        // Fast path hit: record the fingerprint we actually used
        this.fingerprints.set(workRef,fingerprint);
        return existing.index(mode);
      }
    }
    const next=new WritingStore(await this.loadConsistent(candidate));
    this.stores.get(workRef)?.close();
    this.stores.set(workRef,next);
    // Full path: record fingerprint after loading (captures any changes during load)
    const fingerprint=await this.sourceFingerprint(candidate);
    this.fingerprints.set(workRef,fingerprint);
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
  /** AUD-029: verify the source fingerprint before and after the adapter
   * read; a mid-read change would otherwise mix states from different times
   * into one snapshot. Retry once so a transient write can settle, then fail
   * with a stable code instead of indexing mixed state. */
  private async loadConsistent(candidate:WorkCandidate):Promise<ParsedWork>{
    const adapter=this.adapters.find(a=>a.kind===candidate.adapter)!;
    for(let attempt=0;attempt<2;attempt++){
      const before=await this.sourceFingerprint(candidate);
      const work=await adapter.load(candidate);
      const after=await this.sourceFingerprint(candidate);
      if(after===before)return work;
    }
    throw Object.assign(new Error("Source files changed while the work was being read; retry the operation"),{code:"SOURCE_CHANGED_DURING_READ"});
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
  async index(workRef:string,mode:"status"|"incremental"|"rebuild"):Promise<IndexResult>{return this.serial(workRef,async()=>this.indexUnlocked(workRef,mode));}
  async explore(workRef:string,operation:ExploreOperation,query="",limit=20,maxHops=2,targetChapter?:number):Promise<ExploreResult>{
    const started=performance.now();
    const result=await this.serial(workRef,async()=>{await this.ensureFresh(workRef);return (await this.store(workRef)).explore(operation,query,limit,maxHops,targetChapter);});
    const elapsedMs=performance.now()-started;
    if(elapsedMs>EXPLORE_TIME_LIMIT_MS)throw Object.assign(new Error(`Explore exceeded the ${EXPLORE_TIME_LIMIT_MS}ms deterministic time limit (took ${Math.trunc(elapsedMs)}ms)`),{code:"EXPLORE_TIME_LIMIT_EXCEEDED"});
    return result;
  }
  async context(workRef:string,query:string,budgetTokens:number,requiredRefs:string[]=[],options:ContextOptions={}):Promise<ContextPacket>{return this.serial(workRef,async()=>{await this.ensureFresh(workRef);return (await this.store(workRef)).context(query,budgetTokens,requiredRefs,options);});}
  diagnosticDirectory(workRef?:string):string|undefined{const candidate=workRef?this.works.get(workRef):undefined;const root=candidate?.rootPath??this.authorizedRoots?.[0];if(!root)return undefined;const scope=candidate?workRef!.replaceAll(":","-"):"_server";return join(root,".writing-index",scope,"diagnostics");}
  close():void{for(const store of this.stores.values())store.close();this.stores.clear();this.queues.clear();this.fingerprints.clear();}
}
