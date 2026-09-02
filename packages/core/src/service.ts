import type { AdapterKind, ContextOptions, ContextPacket, ExploreOperation, ExploreResult, IndexResult, ParsedWork, ResolveResult, SearchExperimentOptions, SourceSnapshot, WorkAdapter, WorkCandidate } from "./types.js";
import { WritingStore } from "./store.js";
import { join } from "node:path";

const DEFAULT_QUERY_TIME_LIMIT_MS = 30_000;

export interface WritingServiceOptions {
  readonly queryTimeLimitMs?: number;
}

export class WritingService {
  private readonly works=new Map<string,WorkCandidate>(); private readonly active=new Map<string,{store:WritingStore;loadedFingerprint?:string;indexedFingerprint?:string}>();
  private readonly queues=new Map<string,Promise<void>>();
  private readonly queryTimeLimitMs:number;
  private closing?:Promise<void>;
  constructor(private readonly adapters:WorkAdapter[],private readonly authorizedRoots?:string[],options:WritingServiceOptions={}){this.queryTimeLimitMs=Math.max(1,Math.trunc(options.queryTimeLimitMs??DEFAULT_QUERY_TIME_LIMIT_MS));}
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
  private serial<T>(workRef:string,action:()=>Promise<T>,timeout?:{code:string;label:string}):Promise<T>{
    const previous=this.queues.get(workRef)??Promise.resolve();
    const scheduled=previous.catch(()=>undefined).then(()=>{
      const actionPromise=Promise.resolve().then(action);
      if(!timeout)return{actionPromise,resultPromise:actionPromise};
      let timer:ReturnType<typeof setTimeout>;
      const timeoutPromise=new Promise<T>((_resolve,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(`${timeout.label} exceeded the ${this.queryTimeLimitMs}ms execution time limit`),{code:timeout.code})),this.queryTimeLimitMs);timer.unref?.();});
      return{actionPromise,resultPromise:Promise.race([actionPromise,timeoutPromise]).finally(()=>clearTimeout(timer))};
    });
    const marker=scheduled.then(({actionPromise})=>actionPromise.then(()=>undefined,()=>undefined),()=>undefined);
    this.queues.set(workRef,marker);
    void marker.then(()=>{if(this.queues.get(workRef)===marker)this.queues.delete(workRef);});
    return scheduled.then(({resultPromise})=>resultPromise);
  }
  private async indexUnlocked(workRef:string,mode:"status"|"incremental"|"rebuild"):Promise<IndexResult>{
    const candidate=this.candidate(workRef),previous=this.active.get(workRef);
    if(mode==="status"&&previous){const snapshot=await this.snapshotConsistent(candidate);if(previous.loadedFingerprint===snapshot.fingerprint&&previous.indexedFingerprint===snapshot.fingerprint)return previous.store.index(mode);}
    const loaded=await this.loadConsistent(candidate),next=new WritingStore(loaded.work);
    try{const result=await next.index(mode),indexedFingerprint=mode==="status"&&result.freshness!=="fresh"?previous?.indexedFingerprint:loaded.fingerprint;this.active.set(workRef,{store:next,loadedFingerprint:loaded.fingerprint,indexedFingerprint});previous?.store.close();return result;}catch(error){next.close();throw error;}
  }
  private sourceChanged(error:unknown):boolean{const code=typeof error==="object"&&error&&"code" in error?String(error.code):undefined;return code==="SOURCE_SNAPSHOT_CHANGED"||code==="ENOENT"||code==="ENOTDIR";}
  private async snapshotConsistent(candidate:WorkCandidate):Promise<SourceSnapshot>{const adapter=this.adapter(candidate);for(let attempt=0;attempt<2;attempt++){try{return await adapter.snapshot(candidate);}catch(error){if(!this.sourceChanged(error))throw error;}}throw Object.assign(new Error("Source files changed while the work was being read; retry the operation"),{code:"SOURCE_CHANGED_DURING_READ"});}
  private async loadConsistent(candidate:WorkCandidate):Promise<{work:ParsedWork;fingerprint:string}>{
    const adapter=this.adapter(candidate);for(let attempt=0;attempt<2;attempt++){try{const snapshot=await adapter.snapshot(candidate),work=await adapter.load(candidate,snapshot),after=await adapter.snapshot(candidate);if(after.fingerprint===snapshot.fingerprint)return{work,fingerprint:after.fingerprint};}catch(error){if(!this.sourceChanged(error))throw error;}}
    throw Object.assign(new Error("Source files changed while the work was being read; retry the operation"),{code:"SOURCE_CHANGED_DURING_READ"});
  }
  /** Reuse the existing store when the source fingerprint is unchanged; reload
   * only when files changed (AUD-021). The first query builds the store once. */
  private async ensureFresh(workRef:string):Promise<void>{
    const candidate=this.candidate(workRef),snapshot=await this.snapshotConsistent(candidate),active=this.active.get(workRef);
    if(active?.indexedFingerprint===snapshot.fingerprint)return;
    await this.indexUnlocked(workRef,"incremental");
  }
  async index(workRef:string,mode:"status"|"incremental"|"rebuild"):Promise<IndexResult>{return this.serial(workRef,async()=>this.indexUnlocked(workRef,mode));}
  async explore(workRef:string,operation:ExploreOperation,query="",limit=20,maxHops=2,targetChapter?:number):Promise<ExploreResult>{
    return this.serial(workRef,async()=>{await this.ensureFresh(workRef);return (await this.store(workRef)).explore(operation,query,limit,maxHops,targetChapter);},{code:"EXPLORE_TIME_LIMIT_EXCEEDED",label:"Explore"});
  }
  /** Evaluator-only: options are scoped to this call and never stored. */
  async evaluateSearch(workRef:string,query:string,limit:number,options:SearchExperimentOptions):Promise<ExploreResult>{return this.serial(workRef,async()=>{await this.ensureFresh(workRef);return (await this.store(workRef)).evaluateSearch(query,limit,options);},{code:"EVALUATE_SEARCH_TIME_LIMIT_EXCEEDED",label:"Evaluator search"});}
  async context(workRef:string,query:string,budgetTokens:number,requiredRefs:string[]=[],options:ContextOptions={}):Promise<ContextPacket>{return this.serial(workRef,async()=>{await this.ensureFresh(workRef);return (await this.store(workRef)).context(query,budgetTokens,requiredRefs,options);},{code:"CONTEXT_TIME_LIMIT_EXCEEDED",label:"Context"});}
  diagnosticDirectory(workRef?:string):string|undefined{const candidate=workRef?this.works.get(workRef):undefined;const root=candidate?.rootPath??this.authorizedRoots?.[0];if(!root)return undefined;const scope=candidate?workRef!.replaceAll(":","-"):"_server";return join(root,".writing-index",scope,"diagnostics");}
  close():void|Promise<void>{if(this.closing)return this.closing;const finish=()=>{for(const state of this.active.values())state.store.close();this.active.clear();this.queues.clear();};const pending=[...this.queues.values()];if(!pending.length){finish();return;}this.closing=Promise.allSettled(pending).then(finish);return this.closing;}
}
