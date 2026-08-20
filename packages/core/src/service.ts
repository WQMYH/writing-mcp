import type { AdapterKind, ContextOptions, ContextPacket, ExploreOperation, ExploreResult, IndexResult, ParsedWork, ResolveResult, SourceSnapshot, WorkAdapter, WorkCandidate } from "./types.js";
import { WritingStore } from "./store.js";
import { join } from "node:path";

const EXPLORE_TIME_LIMIT_MS = 30_000;

export class WritingService {
  private readonly works=new Map<string,WorkCandidate>(); private readonly active=new Map<string,{store:WritingStore;loadedFingerprint?:string;indexedFingerprint?:string}>();
  private readonly queues=new Map<string,Promise<void>>();
  constructor(private readonly adapters:WorkAdapter[],private readonly authorizedRoots?:string[]){}
  async resolve(sourcePath:string,adapterHint?:AdapterKind):Promise<ResolveResult>{
    if(this.authorizedRoots){const {assertAuthorizedPath}=await import("./ids.js");sourcePath=await assertAuthorizedPath(sourcePath,this.authorizedRoots);}
    const selected=adapterHint?this.adapters.filter(a=>a.kind===adapterHint):this.adapters.filter(a=>a.kind!=="generic");
    let candidates=(await Promise.all(selected.map(a=>a.discover(sourcePath)))).flat();
    if(!adapterHint&&candidates.length===0){const fallback=this.adapters.filter(a=>a.kind==="generic");candidates=(await Promise.all(fallback.map(a=>a.discover(sourcePath)))).flat();}
    for(const c of candidates)this.works.set(c.workRef,c);
    return{status:candidates.length===1?"resolved":candidates.length>1?"ambiguous":"unsupported",workRef:candidates.length===1?candidates[0]!.workRef:undefined,candidates,diagnostics:candidates.length?[]:[{code:"UNSUPPORTED_SOURCE",message:"No supported writing work found",path:sourcePath}]};
  }
  private async store(workRef:string){const active=this.active.get(workRef);if(active)return active.store;const candidate=this.candidate(workRef),loaded=await this.loadConsistent(candidate),store=new WritingStore(loaded.work);this.active.set(workRef,{store,loadedFingerprint:loaded.fingerprint});return store;}
  private candidate(workRef:string):WorkCandidate{const candidate=this.works.get(workRef);if(!candidate)throw Object.assign(new Error("Unknown workRef; call writing_resolve first"),{code:"WORK_REF_NOT_FOUND"});return candidate;}
  private adapter(candidate:WorkCandidate):WorkAdapter{const adapter=this.adapters.find(adapter=>adapter.kind===candidate.adapter);if(!adapter)throw Object.assign(new Error(`No adapter is registered for ${candidate.adapter}`),{code:"ADAPTER_NOT_FOUND"});return adapter;}
  private async serial<T>(workRef:string,action:()=>Promise<T>):Promise<T>{
    const previous=this.queues.get(workRef)??Promise.resolve();
    const current=previous.catch(()=>undefined).then(action);
    const marker=current.then(()=>undefined,()=>undefined);
    this.queues.set(workRef,marker);
    try{return await current;}finally{if(this.queues.get(workRef)===marker)this.queues.delete(workRef);}
  }
  private async indexUnlocked(workRef:string,mode:"status"|"incremental"|"rebuild",providedSnapshot?:SourceSnapshot):Promise<IndexResult>{
    const candidate=this.candidate(workRef),adapter=this.adapter(candidate),snapshot=providedSnapshot??await adapter.snapshot(candidate),previous=this.active.get(workRef);
    if(mode==="status"&&previous&&previous.loadedFingerprint===snapshot.fingerprint&&previous.indexedFingerprint===snapshot.fingerprint)return previous.store.index(mode);
    const loaded=await this.loadConsistent(candidate,snapshot),next=new WritingStore(loaded.work);
    try{const result=await next.index(mode),indexedFingerprint=mode==="status"&&result.freshness!=="fresh"?previous?.indexedFingerprint:loaded.fingerprint;this.active.set(workRef,{store:next,loadedFingerprint:loaded.fingerprint,indexedFingerprint});previous?.store.close();return result;}catch(error){next.close();throw error;}
  }
  private async loadConsistent(candidate:WorkCandidate,firstSnapshot?:SourceSnapshot):Promise<{work:ParsedWork;fingerprint:string}>{
    const adapter=this.adapter(candidate);for(let attempt=0;attempt<2;attempt++){try{const snapshot=attempt===0&&firstSnapshot?firstSnapshot:await adapter.snapshot(candidate),work=await adapter.load(candidate,snapshot),after=await adapter.snapshot(candidate);if(after.fingerprint===snapshot.fingerprint)return{work,fingerprint:after.fingerprint};}catch(error){const code=typeof error==="object"&&error&&"code" in error?String(error.code):undefined;if(code!=="SOURCE_SNAPSHOT_CHANGED"&&code!=="ENOENT"&&code!=="ENOTDIR")throw error;}}
    throw Object.assign(new Error("Source files changed while the work was being read; retry the operation"),{code:"SOURCE_CHANGED_DURING_READ"});
  }
  /** Reuse the existing store when the source fingerprint is unchanged; reload
   * only when files changed (AUD-021). The first query builds the store once. */
  private async ensureFresh(workRef:string):Promise<void>{
    const candidate=this.candidate(workRef),snapshot=await this.adapter(candidate).snapshot(candidate),active=this.active.get(workRef);
    if(active?.indexedFingerprint===snapshot.fingerprint)return;
    await this.indexUnlocked(workRef,"incremental",snapshot);
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
  close():void{for(const state of this.active.values())state.store.close();this.active.clear();this.queues.clear();}
}
