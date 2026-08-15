import type { AdapterKind, ContextPacket, ExploreOperation, ExploreResult, IndexResult, ResolveResult, WorkAdapter, WorkCandidate } from "./types.js";
import { WritingStore } from "./store.js";
import { join } from "node:path";

export class WritingService {
  private readonly works=new Map<string,WorkCandidate>(); private readonly stores=new Map<string,WritingStore>();
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
  async index(workRef:string,mode:"status"|"incremental"|"rebuild"):Promise<IndexResult>{return this.serial(workRef,()=>this.indexUnlocked(workRef,mode));}
  async explore(workRef:string,operation:ExploreOperation,query="",limit=20,maxHops=2):Promise<ExploreResult>{return this.serial(workRef,async()=>{await this.indexUnlocked(workRef,"incremental");return (await this.store(workRef)).explore(operation,query,limit,maxHops);});}
  async context(workRef:string,query:string,budgetTokens:number,requiredRefs:string[]=[]):Promise<ContextPacket>{return this.serial(workRef,async()=>{await this.indexUnlocked(workRef,"incremental");return (await this.store(workRef)).context(query,budgetTokens,requiredRefs);});}
  diagnosticDirectory(workRef?:string):string|undefined{const candidate=workRef?this.works.get(workRef):undefined;const root=candidate?.rootPath??this.authorizedRoots?.[0];if(!root)return undefined;const scope=candidate?workRef!.replaceAll(":","-"):"_server";return join(root,".writing-index",scope,"diagnostics");}
  close():void{for(const store of this.stores.values())store.close();this.stores.clear();this.queues.clear();}
}
