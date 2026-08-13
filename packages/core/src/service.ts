import type { AdapterKind, ContextPacket, ExploreOperation, ExploreResult, IndexResult, ResolveResult, WorkAdapter, WorkCandidate } from "./types.js";
import { WritingStore } from "./store.js";

export class WritingService {
  private readonly works=new Map<string,WorkCandidate>(); private readonly stores=new Map<string,WritingStore>();
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
  async index(workRef:string,mode:"status"|"incremental"|"rebuild"):Promise<IndexResult>{
    if(mode!=="status"){
      const candidate=this.works.get(workRef);
      if(!candidate)throw Object.assign(new Error("Unknown workRef; call writing_resolve first"),{code:"WORK_REF_NOT_FOUND"});
      const adapter=this.adapters.find(a=>a.kind===candidate.adapter)!;
      this.stores.get(workRef)?.close();
      this.stores.set(workRef,new WritingStore(await adapter.load(candidate)));
    }
    return (await this.store(workRef)).index(mode);
  }
  async explore(workRef:string,operation:ExploreOperation,query="",limit=20,maxHops=2):Promise<ExploreResult>{await this.index(workRef,"incremental");return (await this.store(workRef)).explore(operation,query,limit,maxHops);}
  async context(workRef:string,query:string,budgetTokens:number,requiredRefs:string[]=[]):Promise<ContextPacket>{await this.index(workRef,"incremental");return (await this.store(workRef)).context(query,budgetTokens,requiredRefs);}
  close():void{for(const store of this.stores.values())store.close();this.stores.clear();}
}
