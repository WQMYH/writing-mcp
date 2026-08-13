import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { splitDocument, estimateTokens } from "./text.js";
import { stableId } from "./ids.js";
import type { ContextBlock, ContextPacket, ExploreItem, ExploreOperation, ExploreResult, IndexResult, ParsedWork } from "./types.js";

const SCHEMA_VERSION = 1;
const json = (value: unknown) => JSON.stringify(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const asNumber = (value: unknown) => typeof value === "bigint" ? Number(value) : Number(value ?? 0);

export class WritingStore {
  private db?: DatabaseSync;
  private indexPath?: string;
  private schemaVersionOnDisk=0;
  constructor(private readonly work: ParsedWork) {}

  private async open(): Promise<DatabaseSync> {
    if (this.db) return this.db;
    const dir = join(this.work.rootPath, ".writing-index", this.work.workRef.replace(":", "-"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(this.work.rootPath, ".writing-index", ".gitignore"), "*\n!.gitignore\n", { flag: "w" });
    this.indexPath = join(dir, "index.sqlite");
    const db = new DatabaseSync(this.indexPath);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.schemaVersionOnDisk=asNumber((db.prepare("PRAGMA user_version").get() as Record<string,unknown>).user_version);
    if(this.schemaVersionOnDisk!==0&&this.schemaVersionOnDisk!==SCHEMA_VERSION){this.db=db;return db;}
    this.initializeSchema(db);
    this.db = db;
    return db;
  }

  private initializeSchema(db:DatabaseSync):void{
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,stats_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents(document_ref TEXT PRIMARY KEY,relative_path TEXT UNIQUE NOT NULL,title TEXT NOT NULL,kind TEXT NOT NULL,chapter_number INTEGER,content_hash TEXT NOT NULL,mtime_ms REAL NOT NULL,size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spans(span_ref TEXT PRIMARY KEY,document_ref TEXT NOT NULL,ordinal INTEGER NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,heading TEXT NOT NULL,content TEXT NOT NULL,FOREIGN KEY(document_ref) REFERENCES documents(document_ref) ON DELETE CASCADE);
      CREATE VIRTUAL TABLE IF NOT EXISTS spans_fts USING fts5(span_ref UNINDEXED,heading,content,tokenize='trigram');
      CREATE TABLE IF NOT EXISTS entities(entity_ref TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,normalized_name TEXT NOT NULL,source_kind TEXT NOT NULL,confidence REAL NOT NULL,span_ref TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases(entity_ref TEXT NOT NULL,alias TEXT NOT NULL,normalized_alias TEXT NOT NULL,PRIMARY KEY(entity_ref,normalized_alias));
      CREATE TABLE IF NOT EXISTS mentions(mention_ref TEXT PRIMARY KEY,entity_ref TEXT NOT NULL,span_ref TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,source_kind TEXT NOT NULL,confidence REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS edges(edge_ref TEXT PRIMARY KEY,source_ref TEXT NOT NULL,target_ref TEXT NOT NULL,kind TEXT NOT NULL,source_kind TEXT NOT NULL,confidence REAL NOT NULL,span_ref TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS unresolved_mentions(mention_ref TEXT PRIMARY KEY,text TEXT NOT NULL,span_ref TEXT NOT NULL,reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(normalized_name);
      CREATE INDEX IF NOT EXISTS idx_mentions_entity ON mentions(entity_ref);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_ref);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_ref);
      PRAGMA user_version=${SCHEMA_VERSION};
    `);
  }

  private async rebuildIncompatibleSchema():Promise<DatabaseSync>{const path=this.indexPath!;this.db?.close();this.db=undefined;for(const suffix of ["","-wal","-shm"])await rm(path+suffix,{force:true});this.schemaVersionOnDisk=0;return this.open();}

  async index(mode: "status" | "incremental" | "rebuild"): Promise<IndexResult> {
    const started = performance.now(); let db = await this.open();const diagnostics:IndexResult["diagnostics"]=[];
    if(this.schemaVersionOnDisk!==0&&this.schemaVersionOnDisk!==SCHEMA_VERSION){if(mode==="status")return{workRef:this.work.workRef,revision:0,schemaVersion:SCHEMA_VERSION,freshness:"incompatible",stats:{added:0,updated:0,deleted:0,skipped:0,documents:0,spans:0,entities:0,edges:0},diagnostics:[{code:"INDEX_SCHEMA_INCOMPATIBLE",message:`Index schema ${this.schemaVersionOnDisk} is incompatible with ${SCHEMA_VERSION}`}],elapsedMs:performance.now()-started};const previous=this.schemaVersionOnDisk;db=await this.rebuildIncompatibleSchema();mode="rebuild";diagnostics.push({code:"INDEX_SCHEMA_REBUILT",message:`Rebuilt derived index schema ${previous} as ${SCHEMA_VERSION}`});}
    const revisionRow = db.prepare("SELECT COALESCE(MAX(id),0) id FROM revisions").get() as Record<string, unknown>;
    const currentRevision = asNumber(revisionRow.id);
    if (mode === "status") return { workRef: this.work.workRef, revision: currentRevision, schemaVersion: SCHEMA_VERSION, freshness: currentRevision ? "fresh" : "missing", stats: { added: 0, updated: 0, deleted: 0, skipped: 0, ...this.counts() }, diagnostics, elapsedMs: performance.now()-started };
    const existing = new Map<string,string>();
    if(mode!=="rebuild")for (const row of db.prepare("SELECT document_ref,content_hash FROM documents").all() as Array<Record<string,unknown>>) existing.set(String(row.document_ref),String(row.content_hash));
    let added=0,updated=0,skipped=0,deleted=0;
    db.exec("BEGIN");
    try {
      if(mode==="rebuild")db.exec("DELETE FROM mentions; DELETE FROM edges; DELETE FROM aliases; DELETE FROM entities; DELETE FROM spans_fts; DELETE FROM spans; DELETE FROM documents;");
      const present = new Set<string>();
      for (const doc of this.work.documents) {
        present.add(doc.documentRef); const contentHash=hash(doc.content);
        if (existing.get(doc.documentRef)===contentHash) { skipped++; continue; }
        if (existing.has(doc.documentRef)) updated++; else added++;
        this.deleteDocument(db,doc.documentRef);
        db.prepare("INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)").run(doc.documentRef,doc.relativePath,doc.title,doc.kind,doc.chapterNumber??null,contentHash,doc.sourceMtimeMs,doc.sourceSize);
        const spans=splitDocument(doc,(n)=>stableId("span",doc.documentRef,String(n)));
        for(const span of spans){db.prepare("INSERT INTO spans VALUES(?,?,?,?,?,?,?)").run(span.spanRef,span.documentRef,span.ordinal,span.startLine,span.endLine,span.heading,span.content);db.prepare("INSERT INTO spans_fts VALUES(?,?,?)").run(span.spanRef,span.heading,span.content);db.prepare("INSERT INTO edges VALUES(?,?,?,?,?,?,?)").run(stableId("edge",doc.documentRef,span.spanRef,"contains"),doc.documentRef,span.spanRef,"contains","native",1,span.spanRef);}
      }
      for(const ref of existing.keys()) if(!present.has(ref)){this.deleteDocument(db,ref);deleted++;}
      if(mode==="incremental"&&currentRevision>0&&added===0&&updated===0&&deleted===0){db.exec("ROLLBACK");return{workRef:this.work.workRef,revision:currentRevision,schemaVersion:SCHEMA_VERSION,freshness:"fresh",stats:{added,updated,deleted,skipped,...this.counts(db)},diagnostics:[],elapsedMs:performance.now()-started};}
      this.rebuildEntities(db);
      const stats={added,updated,deleted,skipped,...this.counts(db)};
      db.prepare("INSERT INTO revisions(created_at,stats_json) VALUES(?,?)").run(new Date().toISOString(),json(stats));
      db.prepare("INSERT OR REPLACE INTO metadata VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
      db.exec("COMMIT");
      const revision=asNumber((db.prepare("SELECT MAX(id) id FROM revisions").get() as Record<string,unknown>).id);
      return {workRef:this.work.workRef,revision,schemaVersion:SCHEMA_VERSION,freshness:"fresh",stats,diagnostics,elapsedMs:performance.now()-started};
    } catch(error){db.exec("ROLLBACK");throw error;}
  }

  private deleteDocument(db:DatabaseSync,ref:string){const spanRefs=(db.prepare("SELECT span_ref FROM spans WHERE document_ref=?").all(ref) as Array<Record<string,unknown>>).map(r=>String(r.span_ref));for(const s of spanRefs){db.prepare("DELETE FROM spans_fts WHERE span_ref=?").run(s);db.prepare("DELETE FROM mentions WHERE span_ref=?").run(s);db.prepare("DELETE FROM unresolved_mentions WHERE span_ref=?").run(s);db.prepare("DELETE FROM edges WHERE span_ref=?").run(s);db.prepare("DELETE FROM aliases WHERE entity_ref IN (SELECT entity_ref FROM entities WHERE span_ref=?)").run(s);db.prepare("DELETE FROM entities WHERE span_ref=?").run(s);}db.prepare("DELETE FROM documents WHERE document_ref=?").run(ref);}
  private rebuildEntities(db:DatabaseSync){
    db.exec("DELETE FROM mentions;DELETE FROM unresolved_mentions;DELETE FROM edges WHERE kind!='contains';DELETE FROM aliases;DELETE FROM entities;");
    const rows=db.prepare("SELECT s.span_ref,s.heading,s.content,d.document_ref,d.kind,d.chapter_number FROM spans s JOIN documents d ON d.document_ref=s.document_ref ORDER BY d.chapter_number,s.ordinal").all() as Array<Record<string,unknown>>;
    const insertEntity=(kind:string,name:string,spanRef:string,sourceKind="native")=>{const normalized=name.toLowerCase(),ref=stableId("entity",kind,normalized);db.prepare("INSERT OR IGNORE INTO entities VALUES(?,?,?,?,?,?,?)").run(ref,kind,name,normalized,sourceKind,1,spanRef);db.prepare("INSERT OR IGNORE INTO aliases VALUES(?,?,?)").run(ref,name,normalized);return ref;};
    const documentKinds:Record<string,string>={chapter:"Chapter",outline:"OutlineNode",state:"Fact",foreshadow:"Foreshadow"};const chapterEntities:Array<{ref:string;number:number;spanRef:string}>=[];
    for(const row of rows){const heading=String(row.heading).replace(/^#+\s*/,"").trim(),docKind=String(row.kind),spanRef=String(row.span_ref);if(documentKinds[docKind]&&heading){const ref=insertEntity(documentKinds[docKind]!,heading,spanRef);if(docKind==="chapter"&&row.chapter_number!=null)chapterEntities.push({ref,number:asNumber(row.chapter_number),spanRef});}if(docKind==="character"&&heading&&!/^(角色|人物|characters?)$/i.test(heading))insertEntity("Character",heading,spanRef);const explicit=/^(?:地点|location)\s*[:：]\s*(.+)$/i.exec(heading)??/^(?:物品|item)\s*[:：]\s*(.+)$/i.exec(heading)??/^(?:事件|event)\s*[:：]\s*(.+)$/i.exec(heading);if(explicit){const kind=/^(?:地点|location)/i.test(heading)?"Location":/^(?:物品|item)/i.test(heading)?"Item":"Event";insertEntity(kind,explicit[1]!.trim(),spanRef,"deterministic");}}
    chapterEntities.sort((a,b)=>a.number-b.number);for(let i=1;i<chapterEntities.length;i++){const before=chapterEntities[i-1]!,after=chapterEntities[i]!;db.prepare("INSERT OR IGNORE INTO edges VALUES(?,?,?,?,?,?,?)").run(stableId("edge",before.ref,after.ref,"precedes"),before.ref,after.ref,"precedes","native",1,after.spanRef);}
    const entities=db.prepare("SELECT entity_ref,name,normalized_name FROM entities").all() as Array<Record<string,unknown>>;const byName=new Map(entities.map(e=>[String(e.normalized_name),e]));for(const s of rows){for(const e of entities){const name=String(e.name),pos=String(s.content).indexOf(name);if(pos<0)continue;const m=stableId("mention",String(s.span_ref),String(e.entity_ref),String(pos));db.prepare("INSERT OR IGNORE INTO mentions VALUES(?,?,?,?,?,?,?)").run(m,String(e.entity_ref),String(s.span_ref),pos,pos+name.length,"deterministic",1);db.prepare("INSERT OR IGNORE INTO edges VALUES(?,?,?,?,?,?,?)").run(stableId("edge",String(e.entity_ref),String(s.document_ref),"appears_in"),String(e.entity_ref),String(s.document_ref),"appears_in","deterministic",1,String(s.span_ref));}for(const match of String(s.content).matchAll(/\[\[([^\[\]\n]{1,100})\]\]/g)){const text=match[1]!.trim(),entity=byName.get(text.toLowerCase());if(!entity){db.prepare("INSERT OR IGNORE INTO unresolved_mentions VALUES(?,?,?,?)").run(stableId("unresolved",String(s.span_ref),text,String(match.index)),text,String(s.span_ref),"NO_MATCHING_ENTITY");continue;}const entityRef=String(entity.entity_ref),offset=match.index??0;db.prepare("INSERT OR IGNORE INTO mentions VALUES(?,?,?,?,?,?,?)").run(stableId("mention",String(s.span_ref),entityRef,String(offset)),entityRef,String(s.span_ref),offset,offset+text.length,"native",1);db.prepare("INSERT OR IGNORE INTO edges VALUES(?,?,?,?,?,?,?)").run(stableId("edge",String(s.document_ref),entityRef,"mentions"),String(s.document_ref),entityRef,"mentions","native",1,String(s.span_ref));}}}
  private counts(db=this.db!){const n=(t:string)=>asNumber((db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as Record<string,unknown>).n);return {documents:n("documents"),spans:n("spans"),entities:n("entities"),edges:n("edges")};}

  async explore(operation:ExploreOperation,query="",limit=20,maxHops=2):Promise<ExploreResult>{const db=await this.open();const revision=asNumber((db.prepare("SELECT COALESCE(MAX(id),0) id FROM revisions").get() as Record<string,unknown>).id);let rows:Array<Record<string,unknown>>=[];
    if(operation==="stats"){const c=this.counts(db);rows=[{span_ref:"stats",heading:"Index statistics",content:json(c),relative_path:".writing-index",start_line:1,end_line:1,score:1,kind:"stats"}];}
    else if(operation==="entity"||operation==="neighborhood"){const normalized=query.toLowerCase();rows=(db.prepare("SELECT e.entity_ref span_ref,e.name heading,e.normalized_name,s.content,d.relative_path,s.start_line,s.end_line,e.kind FROM entities e JOIN spans s ON s.span_ref=e.span_ref JOIN documents d ON d.document_ref=s.document_ref").all() as Array<Record<string,unknown>>).filter(r=>String(r.normalized_name).includes(normalized)).map(r=>({...r,score:String(r.normalized_name)===normalized?2:1})).sort((a,b)=>Number(b.score)-Number(a.score)).slice(0,limit);}
    else if(operation==="document"){rows=db.prepare("SELECT s.span_ref,s.heading,s.content,d.relative_path,s.start_line,s.end_line,1 score,d.kind FROM spans s JOIN documents d ON d.document_ref=s.document_ref WHERE d.relative_path LIKE ? OR d.title LIKE ? LIMIT ?").all(`%${query}%`,`%${query}%`,limit) as Array<Record<string,unknown>>;}
    else {const terms=query.trim().split(/\s+/).filter(Boolean);const q=terms.map(v=>`"${v.replaceAll('"','')}"`).join(" OR ")||"*";if(terms.some(v=>[...v].length<3)){rows=(db.prepare("SELECT s.span_ref,s.heading,s.content,d.relative_path,s.start_line,s.end_line,d.kind FROM spans s JOIN documents d ON d.document_ref=s.document_ref").all() as Array<Record<string,unknown>>).filter(r=>terms.some(term=>String(r.heading).includes(term)||String(r.content).includes(term))).slice(0,limit).map(r=>({...r,score:1}));}else try{rows=db.prepare("SELECT s.span_ref,s.heading,s.content,d.relative_path,s.start_line,s.end_line,-bm25(spans_fts) score,d.kind FROM spans_fts JOIN spans s USING(span_ref) JOIN documents d ON d.document_ref=s.document_ref WHERE spans_fts MATCH ? ORDER BY bm25(spans_fts) LIMIT ?").all(q,limit) as Array<Record<string,unknown>>;}catch{rows=[];}}
    const results=rows.map(r=>this.item(r));if(operation==="neighborhood"&&results[0]){const root=String((rows[0]!).span_ref);const edges=db.prepare("SELECT e.kind edge_kind,e.target_ref,s.span_ref,s.heading,s.content,d.relative_path,s.start_line,s.end_line,d.kind FROM edges e LEFT JOIN spans s ON s.document_ref=e.target_ref OR s.span_ref=e.target_ref LEFT JOIN documents d ON d.document_ref=s.document_ref WHERE e.source_ref=? LIMIT ?").all(root,Math.max(limit-1,0)) as Array<Record<string,unknown>>;for(const e of edges)if(e.span_ref)results.push({...this.item({...e,score:.5}),path:[root,String(e.edge_kind),String(e.span_ref)]});}
    return {workRef:this.work.workRef,revision,freshness:"fresh",operation,results:results.slice(0,limit),ambiguous:[],truncated:results.length>limit,diagnostics:[]};}
  private item(r:Record<string,unknown>):ExploreItem{return {ref:String(r.span_ref),kind:String(r.kind??"span"),title:String(r.heading),score:Number(r.score??0),sourceKind:"deterministic",confidence:1,evidence:{documentRef:String(r.span_ref),relativePath:String(r.relative_path),startLine:asNumber(r.start_line),endLine:asNumber(r.end_line),excerpt:String(r.content).slice(0,900)}};}
  async context(query:string,budgetTokens:number,requiredRefs:string[]=[]):Promise<ContextPacket>{const explored=await this.explore("search",query,50,2);const candidates:ContextBlock[]=explored.results.map((r,i)=>({...r,layer:i<3?"L1":i<10?"L2":"L3",tokens:estimateTokens(r.evidence.excerpt),required:requiredRefs.includes(r.ref)}));const required=candidates.filter(c=>c.required),min=required.reduce((n,c)=>n+c.tokens,0);if(min>budgetTokens)return{status:"budget_unsatisfiable",workRef:this.work.workRef,revision:explored.revision,budgetTokens,usedTokens:0,estimated:true,estimator:"mixed-cjk-v1",blocks:[],omitted:candidates.map(c=>({ref:c.ref,reason:"required_minimum_exceeds_budget",tokens:c.tokens})),diagnostics:[]};const blocks:ContextBlock[]=[];let used=0;for(const c of [...required,...candidates.filter(c=>!c.required)]){if(blocks.some(b=>b.ref===c.ref))continue;if(used+c.tokens<=budgetTokens){blocks.push(c);used+=c.tokens;}}const omitted=candidates.filter(c=>!blocks.some(b=>b.ref===c.ref)).map(c=>({ref:c.ref,reason:"budget_limit",tokens:c.tokens}));return{status:omitted.length?"truncated":"complete",workRef:this.work.workRef,revision:explored.revision,budgetTokens,usedTokens:used,estimated:true,estimator:"mixed-cjk-v1",blocks,omitted,diagnostics:[]};}
  close(){this.db?.close();this.db=undefined;}
}
