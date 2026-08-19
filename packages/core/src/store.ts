import { DatabaseSync } from "node:sqlite";
import { mkdir, open as openFile, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { splitDocument, estimateTokens } from "./text.js";
import { stableId } from "./ids.js";
import { contextSourceProfile, dedupByEvidence, layerRank } from "./context-assembly.js";
import type { ContextBlock, ContextOptions, ContextPacket, EntityKind, ExploreItem, ExploreOperation, ExploreResult, IndexResult, ParsedWork } from "./types.js";

const SCHEMA_VERSION = 4;
const SOFTWARE_VERSION = "0.1.0";
const MAX_RESPONSE_BYTES = 200_000;
const json = (value: unknown) => JSON.stringify(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const asNumber = (value: unknown) => typeof value === "bigint" ? Number(value) : Number(value ?? 0);
const compareText = (left:string,right:string) => left < right ? -1 : left > right ? 1 : 0;

interface DocumentState {
  readonly document: ParsedWork["documents"][number];
  readonly sourceOrdinal: number;
  readonly contentHash: string;
  readonly semanticHash: string;
}

interface StoredDocumentState {
  readonly document_ref: string;
  readonly semantic_hash: string;
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error && "code" in error ? String(error.code) : undefined;

const codedError = (code: string, message: string, cause?: unknown): Error =>
  Object.assign(new Error(message, { cause }), { code });

export class WritingStore {
  private db?: DatabaseSync;
  private indexPath?: string;
  private schemaVersionOnDisk=0;
  constructor(private readonly work: ParsedWork,private readonly forcedIndexPath?:string,private readonly directRebuild=false,private readonly maxResponseBytes=MAX_RESPONSE_BYTES) {}

  private async prepareIndexLocation(): Promise<void> {
    if (this.indexPath) return;
    const dir = this.forcedIndexPath
      ? dirname(this.forcedIndexPath)
      : join(this.work.rootPath, ".writing-index", this.work.workRef.replace(":", "-"));
    await mkdir(dir, { recursive: true });
    if (!this.forcedIndexPath) {
      const cacheRoot = join(this.work.rootPath, ".writing-index");
      await mkdir(cacheRoot, { recursive: true });
      try {
        await writeFile(join(cacheRoot, ".gitignore"), "*\n!.gitignore\n", { flag: "wx" });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    this.indexPath = this.forcedIndexPath ?? join(dir, "index.sqlite");
  }

  private async open(): Promise<DatabaseSync> {
    if (this.db) return this.db;
    await this.prepareIndexLocation();
    const db = new DatabaseSync(this.indexPath!);
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
      CREATE TABLE IF NOT EXISTS works(work_ref TEXT PRIMARY KEY,adapter TEXT NOT NULL,source_path_hash TEXT NOT NULL,schema_version INTEGER NOT NULL,software_version TEXT NOT NULL,current_revision INTEGER);
      CREATE TABLE IF NOT EXISTS index_revisions(revision INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,source_snapshot_hash TEXT NOT NULL,stats_json TEXT NOT NULL,status TEXT NOT NULL,software_version TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents(document_ref TEXT PRIMARY KEY,relative_path TEXT UNIQUE NOT NULL,title TEXT NOT NULL,kind TEXT NOT NULL,chapter_number INTEGER,volume_number INTEGER,local_chapter_number INTEGER,source_ordinal INTEGER NOT NULL,source_start_line INTEGER NOT NULL,content_hash TEXT NOT NULL,semantic_hash TEXT NOT NULL,mtime_ms REAL NOT NULL,size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spans(span_ref TEXT PRIMARY KEY,document_ref TEXT NOT NULL,ordinal INTEGER NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,heading TEXT NOT NULL,content TEXT NOT NULL,FOREIGN KEY(document_ref) REFERENCES documents(document_ref) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS span_locators(span_ref TEXT NOT NULL,ordinal INTEGER NOT NULL,relative_path TEXT NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,PRIMARY KEY(span_ref,ordinal));
      CREATE VIRTUAL TABLE IF NOT EXISTS spans_fts USING fts5(span_ref UNINDEXED,heading,content,tokenize='trigram');
      CREATE TABLE IF NOT EXISTS entities(entity_ref TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,normalized_name TEXT NOT NULL,source_kind TEXT NOT NULL,confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),span_ref TEXT NOT NULL,identity_hash TEXT NOT NULL,evidence_hash TEXT NOT NULL,valid_from_chapter TEXT,valid_to_chapter TEXT,narrative_time TEXT,properties_json TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS entity_definitions(definition_ref TEXT PRIMARY KEY,entity_ref TEXT NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,normalized_name TEXT NOT NULL,source_kind TEXT NOT NULL,confidence REAL NOT NULL,span_ref TEXT NOT NULL,source_ordinal INTEGER NOT NULL,span_ordinal INTEGER NOT NULL,evidence_hash TEXT NOT NULL,properties_json TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases(entity_ref TEXT NOT NULL,alias TEXT NOT NULL,normalized_alias TEXT NOT NULL,PRIMARY KEY(entity_ref,normalized_alias));
      CREATE TABLE IF NOT EXISTS mentions(mention_ref TEXT PRIMARY KEY,entity_ref TEXT NOT NULL,span_ref TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,source_kind TEXT NOT NULL,confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),evidence_hash TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS edges(edge_ref TEXT PRIMARY KEY,source_ref TEXT NOT NULL,target_ref TEXT NOT NULL,kind TEXT NOT NULL,source_kind TEXT NOT NULL,confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),span_ref TEXT NOT NULL,identity_hash TEXT NOT NULL,evidence_hash TEXT NOT NULL,valid_from_chapter TEXT,valid_to_chapter TEXT,narrative_time TEXT,properties_json TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS edge_evidence(evidence_ref TEXT PRIMARY KEY,edge_ref TEXT NOT NULL,span_ref TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,evidence_hash TEXT NOT NULL,source_kind TEXT NOT NULL,confidence REAL NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS unresolved_mentions(mention_ref TEXT PRIMARY KEY,text TEXT NOT NULL,span_ref TEXT NOT NULL,reason TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(normalized_name);
      CREATE INDEX IF NOT EXISTS idx_entities_span_revision ON entities(span_ref,revision);
      CREATE INDEX IF NOT EXISTS idx_entity_definitions_entity ON entity_definitions(entity_ref,source_ordinal,span_ordinal,definition_ref);
      CREATE INDEX IF NOT EXISTS idx_entities_chapter_range ON entities(valid_from_chapter,valid_to_chapter);
      CREATE INDEX IF NOT EXISTS idx_mentions_entity ON mentions(entity_ref);
      CREATE INDEX IF NOT EXISTS idx_mentions_span_revision ON mentions(span_ref,revision);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_ref);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_ref);
      CREATE INDEX IF NOT EXISTS idx_edges_kind_revision ON edges(kind,revision);
      CREATE INDEX IF NOT EXISTS idx_edges_span ON edges(span_ref);
      CREATE INDEX IF NOT EXISTS idx_edge_evidence_edge ON edge_evidence(edge_ref,span_ref,start_offset);
      CREATE INDEX IF NOT EXISTS idx_edge_evidence_span ON edge_evidence(span_ref);
      CREATE INDEX IF NOT EXISTS idx_edges_chapter_range ON edges(valid_from_chapter,valid_to_chapter);
      CREATE INDEX IF NOT EXISTS idx_unresolved_span_revision ON unresolved_mentions(span_ref,revision);
      PRAGMA user_version=${SCHEMA_VERSION};
    `);
  }

  private backupPath(): string { return `${this.indexPath!}.previous`; }
  private lockPath(): string { return join(dirname(this.indexPath!), "write.lock"); }

  private async pathExists(path: string): Promise<boolean> {
    try { await stat(path); return true; }
    catch (error) { if (errorCode(error) === "ENOENT") return false; throw error; }
  }

  private processIsAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return errorCode(error) !== "ESRCH"; }
  }

  private async acquireWriteLock(): Promise<{ readonly token: string; release(): Promise<void> }> {
    const path = this.lockPath();
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = randomUUID();
      try {
        const handle = await openFile(path, "wx");
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); }
        finally { await handle.close(); }
        return {
          token,
          release: async () => {
            try {
              const current = JSON.parse(await readFile(path, "utf8")) as { token?: string };
              if (current.token === token) await rm(path, { force: true });
            } catch (error) {
              if (errorCode(error) !== "ENOENT") throw error;
            }
          },
        };
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        let owner: { pid?: number } | undefined;
        try { owner = JSON.parse(await readFile(path, "utf8")) as { pid?: number }; }
        catch (readError) {
          if (errorCode(readError) === "ENOENT") continue;
        }
        if (owner?.pid !== undefined && !this.processIsAlive(owner.pid)) {
          await rm(path, { force: true });
          continue;
        }
        throw codedError("INDEX_BUSY", `Derived index for ${this.work.workRef} is being updated by another process`);
      }
    }
    throw codedError("INDEX_BUSY", `Could not acquire the derived-index writer lock for ${this.work.workRef}`);
  }

  private async recoverInterruptedReplacement(): Promise<void> {
    const activePath = this.indexPath!;
    const backupPath = this.backupPath();
    if (!await this.pathExists(activePath) && await this.pathExists(backupPath)) {
      await rename(backupPath, activePath);
    }
    for (const name of await readdir(dirname(activePath))) {
      if (/^index\.[a-f0-9-]+\.tmp\.sqlite(?:-wal|-shm)?$/i.test(name)) {
        await rm(join(dirname(activePath), name), { force: true });
      }
    }
  }

  private async interruptedStatus(started: number): Promise<IndexResult | undefined> {
    if (this.forcedIndexPath) return undefined;
    await this.prepareIndexLocation();
    if (await this.pathExists(this.indexPath!) || !await this.pathExists(this.backupPath())) return undefined;
    return {
      workRef: this.work.workRef,
      revision: 0,
      schemaVersion: SCHEMA_VERSION,
      freshness: "stale",
      stats: { added: 0, updated: 0, deleted: 0, skipped: 0, documents: 0, spans: 0, entities: 0, edges: 0 },
      diagnostics: [{ code: "INDEX_RECOVERY_REQUIRED", message: "An interrupted atomic replacement will be recovered by the next incremental or rebuild operation" }],
      elapsedMs: performance.now() - started,
    };
  }

  private async withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    const lock = await this.acquireWriteLock();
    try {
      await this.recoverInterruptedReplacement();
      return await action();
    } finally {
      await lock.release();
    }
  }

  private async atomicRebuild(previousSchema?:number):Promise<IndexResult>{
    const activePath=this.indexPath!,temporaryPath=join(dirname(activePath),`index.${randomUUID()}.tmp.sqlite`),backupPath=this.backupPath();
    const temporary=new WritingStore(this.work,temporaryPath,true);
    try{
      const result=await temporary.index("rebuild");temporary.validateBuiltIndex();temporary.close();
      this.close();await rm(backupPath,{force:true});
      let backedUp=false;
      try{await stat(activePath);await rename(activePath,backupPath);backedUp=true;}catch(error){if(errorCode(error)!=="ENOENT")throw error;}
      try{await rename(temporaryPath,activePath);}catch(error){if(backedUp)await rename(backupPath,activePath);throw error;}
      await rm(backupPath,{force:true});this.schemaVersionOnDisk=0;
      return{...result,diagnostics:[...result.diagnostics,...(previousSchema==null?[]:[{code:"INDEX_SCHEMA_REBUILT",message:`Rebuilt derived index schema ${previousSchema} as ${SCHEMA_VERSION}`}]) ]};
    }catch(error){if(["EBUSY","EACCES","EPERM","SQLITE_BUSY"].includes(errorCode(error)??""))throw codedError("INDEX_BUSY",`Derived index for ${this.work.workRef} is in use`,error);throw error;}
    finally{temporary.close();for(const suffix of ["","-wal","-shm"])await rm(temporaryPath+suffix,{force:true});}
  }

  private validateBuiltIndex():void{const db=this.db!;const integrity=String((db.prepare("PRAGMA integrity_check").get() as Record<string,unknown>).integrity_check);if(integrity!=="ok")throw Object.assign(new Error(`Temporary index integrity check failed: ${integrity}`),{code:"INDEX_VALIDATION_FAILED"});const version=asNumber((db.prepare("PRAGMA user_version").get() as Record<string,unknown>).user_version);if(version!==SCHEMA_VERSION)throw Object.assign(new Error(`Temporary index schema is ${version}, expected ${SCHEMA_VERSION}`),{code:"INDEX_VALIDATION_FAILED"});const required=["works","index_revisions","documents","spans","span_locators","spans_fts","entities","entity_definitions","aliases","mentions","edges","edge_evidence","unresolved_mentions"];const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<Record<string,unknown>>).map(row=>String(row.name)));for(const table of required)if(!tables.has(table))throw Object.assign(new Error(`Temporary index is missing ${table}`),{code:"INDEX_VALIDATION_FAILED"});const revision=asNumber((db.prepare("SELECT COALESCE(MAX(revision),0) revision FROM index_revisions WHERE status='valid'").get() as Record<string,unknown>).revision);if(revision<1)throw Object.assign(new Error("Temporary index has no valid revision"),{code:"INDEX_VALIDATION_FAILED"});db.prepare("SELECT span_ref FROM spans LIMIT 1").all();}

  private documentStates(): DocumentState[] {
    return this.work.documents.map((document, sourceOrdinal) => {
      const contentHash = hash(document.content);
      const semanticHash = hash(json({
        documentRef: document.documentRef,
        relativePath: document.relativePath,
        title: document.title,
        kind: document.kind,
        chapterNumber: document.chapterNumber ?? null,
        volumeNumber: document.volumeNumber ?? null,
        localChapterNumber: document.localChapterNumber ?? null,
        sourceSegments: document.sourceSegments ?? null,
        sourceOrdinal,
        sourceStartLine: document.sourceStartLine ?? 1,
        contentHash,
      }));
      return { document, sourceOrdinal, contentHash, semanticHash };
    });
  }

  async index(mode: "status" | "incremental" | "rebuild"): Promise<IndexResult> {
    const started = performance.now();
    await this.prepareIndexLocation();
    if (mode === "status") {
      const interrupted = await this.interruptedStatus(started);
      if (interrupted) return interrupted;
    }
    if (mode !== "status" && !this.directRebuild) {
      return this.withWriteLock(() => this.indexUnlocked(mode));
    }
    return this.indexUnlocked(mode);
  }

  private async indexUnlocked(mode: "status" | "incremental" | "rebuild"): Promise<IndexResult> {
    const started = performance.now(); let db = await this.open();const diagnostics:IndexResult["diagnostics"]=[];
    if(this.schemaVersionOnDisk!==0&&this.schemaVersionOnDisk!==SCHEMA_VERSION){if(mode==="status")return{workRef:this.work.workRef,revision:0,schemaVersion:SCHEMA_VERSION,freshness:"incompatible",stats:{added:0,updated:0,deleted:0,skipped:0,documents:0,spans:0,entities:0,edges:0},diagnostics:[{code:"INDEX_SCHEMA_INCOMPATIBLE",message:`Index schema ${this.schemaVersionOnDisk} is incompatible with ${SCHEMA_VERSION}`}],elapsedMs:performance.now()-started};return this.atomicRebuild(this.schemaVersionOnDisk);}
    if(mode==="rebuild"&&!this.directRebuild)return this.atomicRebuild();
    const revisionRow = db.prepare("SELECT COALESCE(MAX(revision),0) revision FROM index_revisions").get() as Record<string, unknown>;
    const currentRevision = asNumber(revisionRow.revision);
    const states = this.documentStates();
    const current = new Map(states.map(state => [state.document.documentRef, state]));
    const existing = new Map<string,string>();
    if(mode!=="rebuild")for (const row of db.prepare("SELECT document_ref,semantic_hash FROM documents").all() as unknown as StoredDocumentState[]) existing.set(String(row.document_ref),String(row.semantic_hash));
    let added=0,updated=0,skipped=0,deleted=0;
    for(const [ref,state] of current){if(existing.get(ref)===state.semanticHash)skipped++;else if(existing.has(ref))updated++;else added++;}
    for(const ref of existing.keys())if(!current.has(ref))deleted++;
    if (mode === "status") {
      const changed = added > 0 || updated > 0 || deleted > 0;
      return {
        workRef: this.work.workRef,
        revision: currentRevision,
        schemaVersion: SCHEMA_VERSION,
        freshness: currentRevision ? (changed ? "stale" : "fresh") : "missing",
        stats: { added, updated, deleted, skipped, ...this.counts(db) },
        contextSources: this.contextSourceCounts(db),
        diagnostics: changed ? [{ code: "INDEX_SOURCE_CHANGED", message: "Source documents differ from the current valid index revision" }] : diagnostics,
        elapsedMs: performance.now()-started,
      };
    }
    if(mode==="incremental"&&currentRevision>0&&added===0&&updated===0&&deleted===0)return{workRef:this.work.workRef,revision:currentRevision,schemaVersion:SCHEMA_VERSION,freshness:"fresh",stats:{added,updated,deleted,skipped,...this.counts(db)},diagnostics,elapsedMs:performance.now()-started};
    const snapshotHash=hash(states.map(state=>`${state.document.documentRef}:${state.semanticHash}`).sort().join("\n"));
    db.exec("BEGIN");
    try {
      if(mode==="rebuild")db.exec("DELETE FROM edge_evidence; DELETE FROM mentions; DELETE FROM edges; DELETE FROM aliases; DELETE FROM entity_definitions; DELETE FROM entities; DELETE FROM span_locators; DELETE FROM spans_fts; DELETE FROM spans; DELETE FROM documents;");
      const revision=asNumber((db.prepare("INSERT INTO index_revisions(created_at,source_snapshot_hash,stats_json,status,software_version) VALUES(?,?,?,?,?) RETURNING revision").get(new Date().toISOString(),snapshotHash,"{}","building",SOFTWARE_VERSION) as Record<string,unknown>).revision);
      const changedDocumentRefs=new Set<string>([...current.keys()].filter(ref=>mode==="rebuild"||existing.get(ref)!==current.get(ref)!.semanticHash));
      for(const ref of existing.keys())if(!current.has(ref))changedDocumentRefs.add(ref);
      const previousEntityNames=mode==="rebuild"?new Set<string>():this.entityNamesForDocuments(db,changedDocumentRefs);
      const chapterStructureChanged=mode==="rebuild"||this.documentsContainKind(db,changedDocumentRefs,"chapter")||this.work.documents.some(doc=>changedDocumentRefs.has(doc.documentRef)&&doc.kind==="chapter");
      const present = new Set<string>();
      for (const state of states) {
        const doc = state.document;
        present.add(doc.documentRef);
        if (mode!=="rebuild"&&existing.get(doc.documentRef)===state.semanticHash) continue;
        this.deleteDocument(db,doc.documentRef);
        db.prepare("INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(doc.documentRef,doc.relativePath,doc.title,doc.kind,doc.chapterNumber??null,doc.volumeNumber??null,doc.localChapterNumber??null,state.sourceOrdinal,doc.sourceStartLine??1,state.contentHash,state.semanticHash,doc.sourceMtimeMs,doc.sourceSize);
        const spans=splitDocument(doc,(n)=>stableId("span",doc.documentRef,String(n)));
        for(const span of spans){
          db.prepare("INSERT INTO spans VALUES(?,?,?,?,?,?,?)").run(span.spanRef,span.documentRef,span.ordinal,span.startLine,span.endLine,span.heading,span.content);
          for(const [locatorOrdinal,locator] of span.locators.entries())db.prepare("INSERT INTO span_locators VALUES(?,?,?,?,?)").run(span.spanRef,locatorOrdinal,locator.relativePath,locator.startLine,locator.endLine);
          db.prepare("INSERT INTO spans_fts VALUES(?,?,?)").run(span.spanRef,span.heading,span.content);
          const edgeRef=stableId("edge",doc.documentRef,span.spanRef,"contains"),identityHash=hash(`${doc.documentRef}\0${span.spanRef}\0contains`),evidenceHash=hash(span.content);
          db.prepare("INSERT INTO edges VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(edgeRef,doc.documentRef,span.spanRef,"contains","native",1,span.spanRef,identityHash,evidenceHash,null,null,null,json({ordinal:span.ordinal}),revision);
          db.prepare("INSERT INTO edge_evidence VALUES(?,?,?,?,?,?,?,?,?)").run(stableId("edge-evidence",edgeRef,span.spanRef,"0"),edgeRef,span.spanRef,0,span.content.length,evidenceHash,"native",1,revision);
        }
      }
      for(const ref of existing.keys()) if(!present.has(ref))this.deleteDocument(db,ref);
      if(mode==="rebuild")this.rebuildEntities(db,revision);
      else this.updateDerivedGraph(db,revision,changedDocumentRefs,previousEntityNames,chapterStructureChanged);
      const stats={added,updated,deleted,skipped,...this.counts(db)};
      db.prepare("UPDATE index_revisions SET stats_json=?,status='valid' WHERE revision=?").run(json(stats),revision);
      db.prepare("INSERT OR REPLACE INTO works VALUES(?,?,?,?,?,?)").run(this.work.workRef,this.work.adapter,hash(this.work.sourcePath??this.work.rootPath),SCHEMA_VERSION,SOFTWARE_VERSION,revision);
      db.prepare("INSERT OR REPLACE INTO metadata VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
      db.exec("COMMIT");
      return {workRef:this.work.workRef,revision,schemaVersion:SCHEMA_VERSION,freshness:"fresh",stats,diagnostics,elapsedMs:performance.now()-started};
    } catch(error){db.exec("ROLLBACK");throw error;}
  }

  private deleteDocument(db:DatabaseSync,ref:string){
    const spanRefs=(db.prepare("SELECT span_ref FROM spans WHERE document_ref=?").all(ref) as Array<Record<string,unknown>>).map(r=>String(r.span_ref));
    for(const spanRef of spanRefs){
      db.prepare("DELETE FROM edge_evidence WHERE span_ref=?").run(spanRef);
      db.prepare("DELETE FROM span_locators WHERE span_ref=?").run(spanRef);
      db.prepare("DELETE FROM spans_fts WHERE span_ref=?").run(spanRef);
      db.prepare("DELETE FROM mentions WHERE span_ref=?").run(spanRef);
      db.prepare("DELETE FROM unresolved_mentions WHERE span_ref=?").run(spanRef);
      db.prepare("DELETE FROM edges WHERE span_ref=?").run(spanRef);
      db.prepare("DELETE FROM entity_definitions WHERE span_ref=?").run(spanRef);
    }
    db.prepare("DELETE FROM edges WHERE source_ref=? OR target_ref=?").run(ref,ref);
    db.prepare("DELETE FROM documents WHERE document_ref=?").run(ref);
  }

  private entityNamesForDocuments(db:DatabaseSync,refs:Set<string>):Set<string>{if(!refs.size)return new Set();const placeholders=[...refs].map(()=>"?").join(",");const rows=db.prepare(`SELECT DISTINCT e.name FROM entities e JOIN spans s ON s.span_ref=e.span_ref WHERE s.document_ref IN (${placeholders})`).all(...refs) as Array<Record<string,unknown>>;return new Set(rows.map(row=>String(row.name)));}
  private documentsContainKind(db:DatabaseSync,refs:Set<string>,kind:string):boolean{if(!refs.size)return false;const placeholders=[...refs].map(()=>"?").join(",");return asNumber((db.prepare(`SELECT COUNT(*) count FROM documents WHERE document_ref IN (${placeholders}) AND kind=?`).get(...refs,kind) as Record<string,unknown>).count)>0;}
  private rowsForDocuments(db:DatabaseSync,refs?:Set<string>):Array<Record<string,unknown>>{if(!refs)return db.prepare("SELECT s.span_ref,s.ordinal span_ordinal,s.heading,s.content,d.document_ref,d.kind,d.chapter_number,d.volume_number,d.local_chapter_number,d.source_ordinal FROM spans s JOIN documents d ON d.document_ref=s.document_ref ORDER BY d.source_ordinal,s.ordinal,s.span_ref").all() as Array<Record<string,unknown>>;if(!refs.size)return[];const placeholders=[...refs].map(()=>"?").join(",");return db.prepare(`SELECT s.span_ref,s.ordinal span_ordinal,s.heading,s.content,d.document_ref,d.kind,d.chapter_number,d.volume_number,d.local_chapter_number,d.source_ordinal FROM spans s JOIN documents d ON d.document_ref=s.document_ref WHERE d.document_ref IN (${placeholders}) ORDER BY d.source_ordinal,s.ordinal,s.span_ref`).all(...refs) as Array<Record<string,unknown>>;}
  private rebuildEntities(db:DatabaseSync,revision:number){
    db.exec("DELETE FROM edge_evidence WHERE edge_ref IN (SELECT edge_ref FROM edges WHERE kind!='contains');DELETE FROM mentions;DELETE FROM unresolved_mentions;DELETE FROM edges WHERE kind!='contains';DELETE FROM aliases;DELETE FROM entity_definitions;DELETE FROM entities;");
    const rows=this.rowsForDocuments(db);
    this.insertEntitiesForRows(db,rows,revision);
    this.reconcileEntityCanonicals(db,revision);
    this.refreshReferencesForRows(db,rows,revision);
    this.rebuildPrecedes(db,revision);
  }

  private updateDerivedGraph(db:DatabaseSync,revision:number,changedDocumentRefs:Set<string>,previousEntityNames:Set<string>,chapterStructureChanged:boolean){
    const changedRows=this.rowsForDocuments(db,changedDocumentRefs);
    const currentEntityNames=this.insertEntitiesForRows(db,changedRows,revision);
    this.reconcileEntityCanonicals(db,revision);
    const affectedNames=new Set([...previousEntityNames,...currentEntityNames]);
    const rowsByRef=new Map(changedRows.map(row=>[String(row.span_ref),row]));
    if(affectedNames.size){
      const normalizedNames=new Set([...affectedNames].map(name=>name.toLowerCase()));
      const allRows=this.rowsForDocuments(db),allRowsByRef=new Map(allRows.map(row=>[String(row.span_ref),row]));
      for(const row of allRows){
        const content=String(row.content);
        if([...affectedNames].some(name=>content.includes(name)))rowsByRef.set(String(row.span_ref),row);
      }
      for(const row of db.prepare("SELECT DISTINCT span_ref,text FROM unresolved_mentions").all() as Array<Record<string,unknown>>){
        if(normalizedNames.has(String(row.text).toLowerCase())){
          const match=allRowsByRef.get(String(row.span_ref));
          if(match)rowsByRef.set(String(match.span_ref),match);
        }
      }
    }
    this.refreshReferencesForRows(db,[...rowsByRef.values()],revision);
    if(chapterStructureChanged)this.rebuildPrecedes(db,revision);
  }

  private insertEntitiesForRows(db:DatabaseSync,rows:Array<Record<string,unknown>>,revision:number):Set<string>{
    const insertedNames=new Set<string>();
    const insertEntity=(kind:EntityKind,name:string,row:Record<string,unknown>,sourceKind="native",properties:Record<string,unknown>={})=>{
      const normalized=name.toLowerCase(),spanRef=String(row.span_ref),documentRef=String(row.document_ref);
      const ref=kind==="Chapter"?stableId("entity",this.work.workRef,kind,documentRef):stableId("entity",this.work.workRef,kind,normalized);
      const definitionRef=stableId("entity-definition",ref,spanRef),evidenceHash=hash(String(row.content));
      db.prepare("INSERT OR REPLACE INTO entity_definitions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(definitionRef,ref,kind,name,normalized,sourceKind,1,spanRef,asNumber(row.source_ordinal),asNumber(row.span_ordinal),evidenceHash,json(properties),revision);
      insertedNames.add(name);
    };
    const documentKinds:Record<string,EntityKind>={chapter:"Chapter",outline:"OutlineNode",state:"Fact",foreshadow:"Foreshadow"};
    for(const row of rows){
      const heading=String(row.heading).replace(/^#+\s*/,"").trim(),docKind=String(row.kind);
      if(documentKinds[docKind]&&heading)insertEntity(documentKinds[docKind]!,heading,row,"native",{documentKind:docKind});
      if(docKind==="character"&&heading&&!/^(角色|人物|characters?)$/i.test(heading))insertEntity("Character",heading,row);
      const explicit=/^(?:地点|location)\s*[:：]\s*(.+)$/i.exec(heading)??/^(?:物品|item)\s*[:：]\s*(.+)$/i.exec(heading)??/^(?:事件|event)\s*[:：]\s*(.+)$/i.exec(heading);
      if(explicit){const kind=/^(?:地点|location)/i.test(heading)?"Location":/^(?:物品|item)/i.test(heading)?"Item":"Event";insertEntity(kind,explicit[1]!.trim(),row,"deterministic",{marker:heading.split(/[:：]/,1)[0]});}
    }
    return insertedNames;
  }

  private reconcileEntityCanonicals(db:DatabaseSync,revision:number){
    const definitions=db.prepare("SELECT * FROM entity_definitions ORDER BY entity_ref,source_ordinal,span_ordinal,definition_ref").all() as Array<Record<string,unknown>>;
    const canonical=new Map<string,Record<string,unknown>>();
    for(const definition of definitions)if(!canonical.has(String(definition.entity_ref)))canonical.set(String(definition.entity_ref),definition);
    const existing=new Set((db.prepare("SELECT entity_ref FROM entities").all() as Array<Record<string,unknown>>).map(row=>String(row.entity_ref)));
    for(const entityRef of existing)if(!canonical.has(entityRef)){
      db.prepare("DELETE FROM edge_evidence WHERE edge_ref IN (SELECT edge_ref FROM edges WHERE source_ref=? OR target_ref=?)").run(entityRef,entityRef);
      db.prepare("DELETE FROM edges WHERE source_ref=? OR target_ref=?").run(entityRef,entityRef);
      db.prepare("DELETE FROM aliases WHERE entity_ref=?").run(entityRef);
      db.prepare("DELETE FROM entities WHERE entity_ref=?").run(entityRef);
    }
    for(const [entityRef,definition] of canonical){
      const kind=String(definition.kind),spanRef=String(definition.span_ref),identityHash=hash(`${this.work.workRef}\0${kind}\0${entityRef}`),evidenceHash=String(definition.evidence_hash);
      const chapterRef=kind==="Chapter"?entityRef:null;
      const previous=db.prepare("SELECT span_ref,identity_hash,evidence_hash,properties_json,revision FROM entities WHERE entity_ref=?").get(entityRef) as Record<string,unknown>|undefined;
      const unchanged=previous&&String(previous.span_ref)===spanRef&&String(previous.identity_hash)===identityHash&&String(previous.evidence_hash)===evidenceHash&&String(previous.properties_json)===String(definition.properties_json);
      const entityRevision=unchanged?asNumber(previous.revision):revision;
      db.prepare("INSERT OR REPLACE INTO entities VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(entityRef,String(definition.kind),String(definition.name),String(definition.normalized_name),String(definition.source_kind),Number(definition.confidence),spanRef,identityHash,evidenceHash,chapterRef,chapterRef,null,String(definition.properties_json),entityRevision);
      db.prepare("INSERT OR REPLACE INTO aliases VALUES(?,?,?)").run(entityRef,String(definition.name),String(definition.normalized_name));
    }
  }

  private refreshReferencesForRows(db:DatabaseSync,rows:Array<Record<string,unknown>>,revision:number){
    const entities=db.prepare("SELECT entity_ref,name,normalized_name,valid_from_chapter,valid_to_chapter FROM entities").all() as Array<Record<string,unknown>>;
    const byName=new Map(entities.map(entity=>[String(entity.normalized_name),entity]));
    for(const row of rows){
      const spanRef=String(row.span_ref),documentRef=String(row.document_ref),content=String(row.content);
      db.prepare("DELETE FROM mentions WHERE span_ref=?").run(spanRef);
      db.prepare("DELETE FROM unresolved_mentions WHERE span_ref=?").run(spanRef);
      db.prepare("DELETE FROM edge_evidence WHERE span_ref=? AND edge_ref IN (SELECT edge_ref FROM edges WHERE kind!='contains')").run(spanRef);
      db.prepare("DELETE FROM edges WHERE span_ref=? AND kind!='contains'").run(spanRef);
      for(const entity of entities){
        const name=String(entity.name);let position=content.indexOf(name);
        const from=entity.valid_from_chapter==null?null:String(entity.valid_from_chapter),to=entity.valid_to_chapter==null?null:String(entity.valid_to_chapter);
        while(position>=0){
          const end=position+name.length,evidenceHash=hash(content.slice(position,end)),edgeRef=stableId("edge",String(entity.entity_ref),documentRef,"appears_in"),identityHash=hash(`${entity.entity_ref}\0${documentRef}\0appears_in`);
          db.prepare("INSERT OR IGNORE INTO mentions VALUES(?,?,?,?,?,?,?,?,?)").run(stableId("mention",spanRef,String(entity.entity_ref),String(position),"deterministic"),String(entity.entity_ref),spanRef,position,end,"deterministic",1,evidenceHash,revision);
          db.prepare("INSERT OR IGNORE INTO edges VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(edgeRef,String(entity.entity_ref),documentRef,"appears_in","deterministic",1,spanRef,identityHash,evidenceHash,from,to,null,"{}",revision);
          db.prepare("INSERT OR REPLACE INTO edge_evidence VALUES(?,?,?,?,?,?,?,?,?)").run(stableId("edge-evidence",edgeRef,spanRef,String(position),"deterministic"),edgeRef,spanRef,position,end,evidenceHash,"deterministic",1,revision);
          position=content.indexOf(name,position+Math.max(1,name.length));
        }
      }
      for(const match of content.matchAll(/\[\[([^[\]\n]{1,100})\]\]/g)){
        const text=match[1]!.trim(),entity=byName.get(text.toLowerCase());
        if(!entity){db.prepare("INSERT OR IGNORE INTO unresolved_mentions VALUES(?,?,?,?,?)").run(stableId("unresolved",spanRef,text,String(match.index)),text,spanRef,"NO_MATCHING_ENTITY",revision);continue;}
        const entityRef=String(entity.entity_ref),offset=match.index??0,from=entity.valid_from_chapter==null?null:String(entity.valid_from_chapter),to=entity.valid_to_chapter==null?null:String(entity.valid_to_chapter);
        const end=offset+text.length,evidenceHash=hash(content.slice(offset,end)),edgeRef=stableId("edge",documentRef,entityRef,"mentions"),identityHash=hash(`${documentRef}\0${entityRef}\0mentions`);
        db.prepare("INSERT OR IGNORE INTO mentions VALUES(?,?,?,?,?,?,?,?,?)").run(stableId("mention",spanRef,entityRef,String(offset),"native"),entityRef,spanRef,offset,end,"native",1,evidenceHash,revision);
        db.prepare("INSERT OR IGNORE INTO edges VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(edgeRef,documentRef,entityRef,"mentions","native",1,spanRef,identityHash,evidenceHash,from,to,null,"{}",revision);
        db.prepare("INSERT OR REPLACE INTO edge_evidence VALUES(?,?,?,?,?,?,?,?,?)").run(stableId("edge-evidence",edgeRef,spanRef,String(offset),"native"),edgeRef,spanRef,offset,end,evidenceHash,"native",1,revision);
      }
    }
    db.prepare("DELETE FROM edges WHERE kind!='contains' AND kind!='precedes' AND edge_ref NOT IN (SELECT DISTINCT edge_ref FROM edge_evidence)").run();
  }

  private rebuildPrecedes(db:DatabaseSync,revision:number){
    db.prepare("DELETE FROM edges WHERE kind='precedes'").run();
    db.prepare("DELETE FROM edge_evidence WHERE edge_ref NOT IN (SELECT edge_ref FROM edges)").run();
    const chapters=(db.prepare("SELECT e.entity_ref,d.source_ordinal,e.span_ref,s.content FROM entities e JOIN spans s ON s.span_ref=e.span_ref JOIN documents d ON d.document_ref=s.document_ref WHERE e.kind='Chapter' ORDER BY d.source_ordinal,s.ordinal,e.entity_ref").all() as Array<Record<string,unknown>>).map(row=>({ref:String(row.entity_ref),spanRef:String(row.span_ref),content:String(row.content)}));
    for(let index=1;index<chapters.length;index++){const before=chapters[index-1]!,after=chapters[index]!,edgeRef=stableId("edge",before.ref,after.ref,"precedes"),identityHash=hash(`${before.ref}\0${after.ref}\0precedes`),evidenceHash=hash(after.content);db.prepare("INSERT OR REPLACE INTO edges VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(edgeRef,before.ref,after.ref,"precedes","native",1,after.spanRef,identityHash,evidenceHash,before.ref,after.ref,null,json({order:index}),revision);db.prepare("INSERT OR REPLACE INTO edge_evidence VALUES(?,?,?,?,?,?,?,?,?)").run(stableId("edge-evidence",edgeRef,after.spanRef,"0"),edgeRef,after.spanRef,0,after.content.length,evidenceHash,"native",1,revision);}
  }

  private counts(db=this.db!){const n=(t:string)=>asNumber((db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as Record<string,unknown>).n);return {documents:n("documents"),spans:n("spans"),entities:n("entities"),edges:n("edges")};}

  // AUD-012 residual: source directory observable — expose what context sources
  // are available for a work, grouped by layer (L1/L2/L3) and by kind. This
  // lets the Agent see what kinds of context are available before calling
  // writing_context, without guessing from entity/document counts alone.
  private contextSourceCounts(db:DatabaseSync):{byLayer:Record<string,number>;byKind:Record<string,number>}{
    const rows=db.prepare("SELECT kind,COUNT(*) n FROM documents GROUP BY kind ORDER BY kind").all() as Array<{kind:string;n:number}>;
    const byLayer:Record<string,number>={L1:0,L2:0,L3:0},byKind:Record<string,number>={};
    for(const row of rows){
      const kind=row.kind,count=asNumber(row.n);
      byKind[kind]=(byKind[kind]??0)+count;
      const profile=contextSourceProfile(kind,false);
      byLayer[profile.layer]=(byLayer[profile.layer]??0)+count;
    }
    return {byLayer,byKind};
  }

  async explore(operation:ExploreOperation,query="",limit=20,maxHops=2,targetChapter?:number):Promise<ExploreResult>{if(query.length>2048)throw codedError("QUERY_TOO_LARGE","Query exceeds the 2048-character deterministic limit");const started=performance.now(),db=await this.open();const revision=asNumber((db.prepare("SELECT COALESCE(MAX(revision),0) revision FROM index_revisions").get() as Record<string,unknown>).revision);limit=Math.max(1,Math.min(100,Math.trunc(limit)));maxHops=Math.max(0,Math.min(3,maxHops));let rows:Array<Record<string,unknown>>=[],ambiguousRows:Array<Record<string,unknown>>=[],diagnostics:ExploreResult["diagnostics"]=[];
    if(operation==="stats"){const c={...this.counts(db),contextSources:this.contextSourceCounts(db)};rows=[{span_ref:"stats",heading:"Index statistics",content:json(c),relative_path:".writing-index",start_line:1,end_line:1,score:1,kind:"stats"}];}
    else if(operation==="entity"||operation==="neighborhood"){const lookup=this.entityRows(db,query,limit);rows=lookup.rows;ambiguousRows=lookup.ambiguous;diagnostics=lookup.diagnostics;}
    else if(operation==="document"){rows=db.prepare("SELECT s.span_ref,s.heading,s.content,s.document_ref,d.relative_path,s.start_line,s.end_line,1 score,d.kind FROM spans s JOIN documents d ON d.document_ref=s.document_ref WHERE d.relative_path LIKE ? OR d.title LIKE ? ORDER BY d.source_ordinal,s.ordinal,s.span_ref LIMIT ?").all(`%${query}%`,`%${query}%`,limit) as Array<Record<string,unknown>>;}
    else if(operation==="timeline"){const timeline=this.timelineRows(db,query,limit,targetChapter);rows=timeline.rows;diagnostics=timeline.diagnostics;}
    else {const searched=this.searchRows(db,query,limit);rows=searched.rows;diagnostics=searched.diagnostics;}
    const locatorsBySpan=this.locatorMap(db,rows.map(row=>String(row.span_ref)));
    let results=rows.map(row=>this.item({...row,revision,locators:locatorsBySpan.get(String(row.span_ref))}));let visitedNodes=results.length,maxActualHops=0,omittedEstimate=0,truncated=false;
    if(operation==="neighborhood"&&results.length&&!diagnostics.some(item=>item.code==="AMBIGUOUS_ENTITY")){const expanded=this.expandNeighborhood(db,results,limit,maxHops);results=expanded.results;visitedNodes=expanded.visitedNodes;maxActualHops=expanded.maxActualHops;omittedEstimate=expanded.omittedEstimate;truncated=expanded.truncated;}
    const candidateCount=results.length,returned=results.slice(0,limit);truncated ||= candidateCount>limit;omittedEstimate+=Math.max(0,candidateCount-limit);
    const ambiguous=ambiguousRows.slice(0,limit).map(row=>this.item({...row,locators:this.locatorMap(db,[String(row.span_ref)]).get(String(row.span_ref))}));
    const cap=this.maxResponseBytes;
    if(JSON.stringify({results:returned,ambiguous}).length>cap){
      const trimmed:ExploreItem[]=[];let used=0;
      for(const item of returned){const bytes=JSON.stringify(item).length;if(used+bytes<=cap){trimmed.push(item);used+=bytes;}}
      const responseDiagnostics=[...diagnostics,{code:"RESPONSE_TRUNCATED",message:`Serialized response exceeded the ${cap}-byte deterministic limit; ${returned.length-trimmed.length} result(s) were dropped`}];
      return {workRef:this.work.workRef,revision,freshness:"fresh",operation,results:trimmed,ambiguous:[],truncated:true,metrics:{candidateCount,returnedCount:trimmed.length,visitedNodes,maxActualHops,omittedEstimate,elapsedMs:performance.now()-started},diagnostics:responseDiagnostics};
    }
    return {workRef:this.work.workRef,revision,freshness:"fresh",operation,results:returned,ambiguous,truncated,metrics:{candidateCount,returnedCount:returned.length,visitedNodes,maxActualHops,omittedEstimate,elapsedMs:performance.now()-started},diagnostics};}
  private item(r:Record<string,unknown>):ExploreItem{const sourceKind=String(r.source_kind??"deterministic"),excerpt=String(r.content).slice(0,900),locators=Array.isArray(r.locators)?r.locators as ExploreItem["evidence"]["locators"]:undefined;return {ref:String(r.ref??r.span_ref),kind:String(r.kind??"span"),title:String(r.heading),score:Number(r.score??0),sourceKind:sourceKind==="native"||sourceKind==="heuristic"?sourceKind:"deterministic",confidence:Number(r.confidence??1),evidence:{documentRef:String(r.document_ref??r.span_ref),relativePath:String(r.relative_path),startLine:asNumber(r.start_line),endLine:asNumber(r.end_line),excerpt,evidenceHash:hash(excerpt),revision:asNumber(r.revision),...(locators?.length?{locators}:{})}};}

  private spanLocators(db:DatabaseSync,spanRef:string){return (db.prepare("SELECT relative_path,start_line,end_line FROM span_locators WHERE span_ref=? ORDER BY ordinal").all(spanRef) as Array<Record<string,unknown>>).map(row=>({relativePath:String(row.relative_path),startLine:asNumber(row.start_line),endLine:asNumber(row.end_line)}));}

  private locatorMap(db:DatabaseSync,spanRefs:string[]):Map<string,NonNullable<ExploreItem["evidence"]["locators"]>>{
    const unique=[...new Set(spanRefs)];if(!unique.length)return new Map();const placeholders=unique.map(()=>"?").join(","),map=new Map<string,NonNullable<ExploreItem["evidence"]["locators"]>>();
    for(const row of db.prepare(`SELECT span_ref,ordinal,relative_path,start_line,end_line FROM span_locators WHERE span_ref IN (${placeholders}) ORDER BY span_ref,ordinal`).all(...unique) as Array<Record<string,unknown>>){const ref=String(row.span_ref),locator={relativePath:String(row.relative_path),startLine:asNumber(row.start_line),endLine:asNumber(row.end_line)};const existing=map.get(ref);if(existing)existing.push(locator);else map.set(ref,[locator]);}
    return map;
  }

  private timelineRows(db:DatabaseSync,query:string,limit:number,targetChapter?:number):{rows:Array<Record<string,unknown>>;diagnostics:ExploreResult["diagnostics"]}
  {
    const diagnostics:ExploreResult["diagnostics"]=[];
    const chapterOrder=new Map<string,number>();
    const chapters=db.prepare("SELECT e.entity_ref FROM entities e JOIN spans s ON s.span_ref=e.span_ref JOIN documents d ON d.document_ref=s.document_ref WHERE e.kind='Chapter' ORDER BY d.source_ordinal,s.ordinal,e.entity_ref").all() as Array<Record<string,unknown>>;
    chapters.forEach((row,index)=>chapterOrder.set(String(row.entity_ref),index));
    const position=(ref:unknown)=>ref==null?Number.MAX_SAFE_INTEGER:chapterOrder.get(String(ref))??Number.MAX_SAFE_INTEGER;
    // Chapter-tense filtering (AUD-012): a temporal item is valid at the
    // 1-based anchor when from <= anchor <= to; an unbounded from means the
    // book start and an unbounded to means the book end.
    const anchor=targetChapter==null?null:Math.max(1,Math.trunc(targetChapter))-1;
    const validAtAnchor=(row:Record<string,unknown>)=>anchor==null||((row.valid_from_chapter==null?-1:position(row.valid_from_chapter))<=anchor&&(row.valid_to_chapter==null?Number.MAX_SAFE_INTEGER:position(row.valid_to_chapter))>=anchor);
    const normalized=query.normalize("NFKC").trim().toLowerCase(),temporal="(valid_from_chapter IS NOT NULL OR valid_to_chapter IS NOT NULL OR narrative_time IS NOT NULL)";
    const entityRows=db.prepare(`SELECT e.entity_ref ref,e.span_ref,e.name heading,e.kind,s.content,s.document_ref,d.relative_path,s.start_line,s.end_line,e.source_kind,e.confidence,e.revision,e.valid_from_chapter,e.valid_to_chapter,e.narrative_time FROM entities e JOIN spans s ON s.span_ref=e.span_ref JOIN documents d ON d.document_ref=s.document_ref WHERE ${temporal} ORDER BY e.entity_ref`).all() as Array<Record<string,unknown>>;
    const edgeRows=db.prepare(`SELECT e.edge_ref ref,e.span_ref,e.kind||': '||COALESCE(sn.name,e.source_ref)||' → '||COALESCE(tn.name,e.target_ref) heading,e.kind||'-relation' kind,s.content,s.document_ref,d.relative_path,s.start_line,s.end_line,e.source_kind,e.confidence,e.revision,e.valid_from_chapter,e.valid_to_chapter,e.narrative_time FROM edges e LEFT JOIN entities sn ON sn.entity_ref=e.source_ref LEFT JOIN entities tn ON tn.entity_ref=e.target_ref JOIN spans s ON s.span_ref=e.span_ref JOIN documents d ON d.document_ref=s.document_ref WHERE e.kind='precedes' ORDER BY e.edge_ref`).all() as Array<Record<string,unknown>>;
    const merged=[...entityRows,...edgeRows].filter(row=>validAtAnchor(row)&&(!normalized||String(row.heading).toLowerCase().includes(normalized))).sort((left,right)=>position(left.valid_from_chapter)-position(right.valid_from_chapter)||position(left.valid_to_chapter)-position(right.valid_to_chapter)||compareText(String(left.narrative_time??""),String(right.narrative_time??""))||compareText(String(left.ref),String(right.ref)));
    if(!merged.length)diagnostics.push({code:"NO_RESULTS",message:anchor==null?"No entity or relation carries temporal attributes (valid_from_chapter, valid_to_chapter, or narrative_time)":`No temporal item is valid at target chapter ${anchor+1}`});
    else diagnostics.push({code:"TIMELINE_PROJECTION",message:anchor==null?`Timeline projected ${merged.length} temporal item(s) ordered by chapter position, then narrative time, then reference`:`Timeline projected ${merged.length} temporal item(s) valid at target chapter ${anchor+1}, ordered by chapter position, then narrative time, then reference`});
    return{rows:merged.slice(0,limit),diagnostics};
  }

  private entityRows(db:DatabaseSync,query:string,limit:number):{rows:Array<Record<string,unknown>>;ambiguous:Array<Record<string,unknown>>;diagnostics:ExploreResult["diagnostics"]}{
    const normalized=query.normalize("NFKC").trim().toLowerCase(),pattern=`%${normalized.replaceAll("%","\\%").replaceAll("_","\\_")}%`;
    if(!normalized)return{rows:[],ambiguous:[],diagnostics:[{code:"NO_MATCHING_TERMS",message:"The entity query contains no searchable name"}]};
    const rows=db.prepare(`SELECT e.entity_ref ref,e.span_ref,e.name heading,e.normalized_name,s.content,s.document_ref,d.relative_path,s.start_line,s.end_line,e.kind,e.source_kind,e.confidence,e.evidence_hash,e.revision FROM aliases a JOIN entities e ON e.entity_ref=a.entity_ref JOIN spans s ON s.span_ref=e.span_ref JOIN documents d ON d.document_ref=s.document_ref WHERE a.normalized_alias LIKE ? ESCAPE '\\' ORDER BY CASE WHEN a.normalized_alias=? THEN 0 ELSE 1 END,e.normalized_name,e.entity_ref LIMIT ?`).all(pattern,normalized,limit) as Array<Record<string,unknown>>;
    const exact=rows.filter(row=>String(row.normalized_name)===normalized),ambiguous:Array<Record<string,unknown>>=[],diagnostics:ExploreResult["diagnostics"]=[];
    if(exact.length>1){ambiguous.push(...exact);diagnostics.push({code:"AMBIGUOUS_ENTITY",message:`${exact.length} entities share the requested canonical name; no candidate was selected automatically`});}
    for(const row of rows){
      const alternatives=db.prepare(`SELECT ed.definition_ref ref,ed.span_ref,ed.name heading,s.content,s.document_ref,d.relative_path,s.start_line,s.end_line,ed.kind||'Definition' kind,ed.source_kind,ed.confidence,ed.evidence_hash,ed.revision FROM entity_definitions ed JOIN entities e ON e.entity_ref=ed.entity_ref JOIN spans s ON s.span_ref=ed.span_ref JOIN documents d ON d.document_ref=s.document_ref WHERE ed.entity_ref=? AND ed.span_ref!=e.span_ref ORDER BY ed.source_ordinal,ed.span_ordinal,ed.definition_ref`).all(String(row.ref)) as Array<Record<string,unknown>>;
      ambiguous.push(...alternatives);
    }
    if(!rows.length){
      const unresolved=db.prepare(`SELECT u.mention_ref ref,u.span_ref,u.text heading,s.content,s.document_ref,d.relative_path,s.start_line,s.end_line,'unresolved' kind,'deterministic' source_kind,1 confidence,u.revision FROM unresolved_mentions u JOIN spans s ON s.span_ref=u.span_ref JOIN documents d ON d.document_ref=s.document_ref WHERE lower(u.text)=? ORDER BY d.source_ordinal,s.ordinal,u.mention_ref LIMIT ?`).all(normalized,limit) as Array<Record<string,unknown>>;
      if(unresolved.length){ambiguous.push(...unresolved);diagnostics.push({code:"UNRESOLVED_REFERENCE",message:"Matching source references exist but do not resolve to a canonical entity"});}
      else diagnostics.push({code:"NO_RESULTS",message:"No entity, alias, or unresolved reference matched the query"});
    }
    return{rows,ambiguous,diagnostics};
  }

  private searchRows(db:DatabaseSync,query:string,limit:number):{rows:Array<Record<string,unknown>>;diagnostics:ExploreResult["diagnostics"]}{
    const terms=this.analyzeQuery(query);if(!terms.length)return{rows:[],diagnostics:[{code:"NO_MATCHING_TERMS",message:"The query contains no searchable deterministic terms"}]};const ablate=new Set((process.env.WRITING_MCP_ABLATE??"").split(",").map(flag=>flag.trim()).filter(Boolean));const aliasTerms=ablate.has("no_alias")?[]:[...new Set(terms.flatMap(term=>/^[\u3400-\u9fff]{2,3}$/.test(term)?[`阿${term.at(-1)}`,`小${term.at(-1)}`,`老${term.at(-1)}`,...(term.length===3?[term.slice(1)]:[])]:[]).filter(alias=>!terms.includes(alias)))],searchTerms=[...terms,...aliasTerms];
    const base="SELECT s.span_ref,s.heading,s.content,s.document_ref,d.relative_path,s.start_line,s.end_line,d.kind FROM spans s JOIN documents d ON d.document_ref=s.document_ref",candidates=new Map<string,Record<string,unknown>>(),candidateLimit=Math.min(512,Math.max(64,limit*12));
    const escaped=searchTerms.map(term=>`%${term.replaceAll("\\","\\\\").replaceAll("%","\\%").replaceAll("_","\\_")}%`),where=searchTerms.map(()=>"(s.heading LIKE ? ESCAPE '\\' OR s.content LIKE ? ESCAPE '\\')").join(" OR ");
    for(const row of db.prepare(`${base} WHERE ${where} ORDER BY d.source_ordinal,s.ordinal,s.span_ref LIMIT ?`).all(...escaped.flatMap(value=>[value,value]),candidateLimit) as Array<Record<string,unknown>>)candidates.set(String(row.span_ref),row);
    const diagnostics:ExploreResult["diagnostics"]=[{code:"QUERY_ANALYZED",message:`Deterministic query analysis produced ${terms.length} term(s)`}];
    const ftsTerms=terms.filter(term=>[...term].length>=3);if(!ablate.has("no_fts_merge")&&ftsTerms.length)try{const fts=ftsTerms.map(term=>`"${term.replaceAll('"','')}"`).join(" OR ");for(const row of db.prepare("SELECT s.span_ref,s.heading,s.content,s.document_ref,d.relative_path,s.start_line,s.end_line,d.kind,-bm25(spans_fts) bm25_score FROM spans_fts JOIN spans s USING(span_ref) JOIN documents d ON d.document_ref=s.document_ref WHERE spans_fts MATCH ? ORDER BY bm25(spans_fts),d.source_ordinal,s.ordinal,s.span_ref LIMIT ?").all(fts,candidateLimit) as Array<Record<string,unknown>>)candidates.set(String(row.span_ref),row);}catch(error){diagnostics.push({code:"FTS_DEGRADED",message:`FTS lookup failed; deterministic LIKE candidates were retained (${errorCode(error)??"unknown"})`});}
    const candidateRows=[...candidates.values()],rows=candidateRows.map((row):Record<string,unknown>=>{const heading=String(row.heading),content=String(row.content),matched=terms.filter(term=>heading.includes(term)||content.includes(term)),aliasMatched=aliasTerms.filter(term=>heading.includes(term)||content.includes(term)),excerpt=this.bestEvidenceWindow(content,[...matched,...aliasMatched]),coverage=ablate.has("no_coverage")?0:Math.min(1,matched.reduce((sum,term)=>sum+[...term].length,0)/12),aliasBoost=ablate.has("no_alias")?0:Math.min(.75,aliasMatched.length*.5),headingMatches=ablate.has("no_heading")?0:matched.filter(term=>heading.includes(term)).length,proximity=ablate.has("no_proximity")?0:this.termProximity(content,[...matched,...aliasMatched]),trustBonus=ablate.has("no_trust")?0:matched.length?.25:0;return{...row,content:excerpt,source_kind:matched.length?"deterministic":"heuristic",score:coverage*4+aliasBoost+proximity+headingMatches*.5+(ablate.has("no_bm25_term")?0:Math.min(1,Number(row.bm25_score??0)/10))+trustBonus};}).sort((left,right)=>Number(right.score)-Number(left.score)||compareText(String(left.relative_path),String(right.relative_path))||asNumber(left.start_line)-asNumber(right.start_line)||compareText(String(left.span_ref),String(right.span_ref))).slice(0,limit);
    if(!rows.length)diagnostics.push({code:"NO_RESULTS",message:"No indexed evidence matched the analyzed query terms"});
    return{rows,diagnostics};
  }

  private analyzeQuery(query:string):string[]{
    const stopPhrases=["让我们先","请告诉我","我想知道","帮我查找","她在故事中","他在故事中","它在故事中","使用了什么","做了什么","发生了什么","这个角色","这个人物","去了哪里","来自哪里","以及","探索","检索","查找","告诉我","她是谁","他是谁","它是谁","是什么","是谁","在哪里","为什么","怎么样","如何","请问"];
    let normalized=query.normalize("NFKC").toLowerCase();for(const phrase of stopPhrases)normalized=normalized.replaceAll(phrase," ");const terms:string[]=[];
    for(const token of normalized.match(/[a-z0-9][a-z0-9_'-]*|[\u3400-\u9fff]+/g)??[]){
      if(!/^[\u3400-\u9fff]+$/.test(token)){terms.push(token);continue;}
      if(token.length<=4){if(token.length>=2)terms.push(token);continue;}
      for(const size of [3,2,4])for(let index=0;index+size<=token.length;index++)terms.push(token.slice(index,index+size));
    }
    return [...new Set(terms)].slice(0,48);
  }

  private termProximity(content:string,terms:string[]):number{
    if(terms.length<2)return terms.length;const occurrences=terms.map(term=>{const positions:number[]=[];let position=content.indexOf(term);while(position>=0){positions.push(position);position=content.indexOf(term,position+Math.max(1,term.length));}return positions;});let best=Infinity;for(const anchor of occurrences.flat()){const nearest=occurrences.map(positions=>positions.reduce((current,position)=>Math.abs(position-anchor)<Math.abs(current-anchor)?position:current,positions[0]!)),spread=Math.max(...nearest)-Math.min(...nearest);best=Math.min(best,spread);}return Number.isFinite(best)?1/(1+best/200):0;
  }

  private bestEvidenceWindow(content:string,terms:string[],width=900):string{
    if(content.length<=width)return content;const occurrences=new Map<string,number[]>(),anchors:number[]=[];for(const term of terms){const positions:number[]=[];let position=content.indexOf(term);while(position>=0){positions.push(position);anchors.push(position);position=content.indexOf(term,position+Math.max(1,term.length));}occurrences.set(term,positions);}if(!anchors.length)return content.slice(0,width);const separator="\n…\n",chunkCount=3,chunkWidth=Math.floor((width-separator.length*(chunkCount-1))/chunkCount),ranked=anchors.map(anchor=>{const start=Math.max(0,Math.min(content.length-chunkWidth,anchor-Math.floor(chunkWidth/2))),end=start+chunkWidth,near=[...occurrences.values()].flatMap(positions=>{const inside=positions.filter(position=>position>=start&&position<end);return inside.length?[inside.reduce((best,position)=>Math.abs(position-anchor)<Math.abs(best-anchor)?position:best)]:[];}),spread=near.length?Math.max(...near)-Math.min(...near):chunkWidth;return{start,coverage:near.length,spread};}).sort((left,right)=>right.coverage-left.coverage||left.spread-right.spread||left.start-right.start),selected:Array<{start:number;coverage:number;spread:number}>=[];for(const candidate of ranked){if(selected.every(existing=>Math.abs(existing.start-candidate.start)>=chunkWidth)){selected.push(candidate);if(selected.length===chunkCount)break;}}while(selected.length<chunkCount){const fallback=Math.floor((content.length-chunkWidth)*selected.length/(chunkCount-1));if(selected.every(existing=>Math.abs(existing.start-fallback)>=chunkWidth/2))selected.push({start:fallback,coverage:0,spread:chunkWidth});else break;}return selected.sort((a,b)=>a.start-b.start).map(candidate=>content.slice(candidate.start,candidate.start+chunkWidth)).join(separator);
  }

  private nodeItem(db:DatabaseSync,ref:string,score:number):ExploreItem|undefined{
    const entity=db.prepare("SELECT e.entity_ref ref,e.span_ref,e.kind,e.name heading,s.content,s.document_ref,d.relative_path,s.start_line,s.end_line,e.source_kind,e.confidence,e.evidence_hash,e.revision FROM entities e JOIN spans s ON s.span_ref=e.span_ref JOIN documents d ON d.document_ref=s.document_ref WHERE e.entity_ref=?").get(ref) as Record<string,unknown>|undefined;
    if(entity)return{...this.item({...entity,score,locators:this.spanLocators(db,String(entity.span_ref??entity.ref))}),sourceKind:String(entity.source_kind) as ExploreItem["sourceKind"],confidence:Number(entity.confidence)};
    const span=db.prepare("SELECT s.span_ref ref,d.kind,s.heading,s.content,s.document_ref,d.relative_path,s.start_line,s.end_line FROM spans s JOIN documents d ON d.document_ref=s.document_ref WHERE s.span_ref=?").get(ref) as Record<string,unknown>|undefined;
    if(span)return this.item({...span,score,revision:this.validRevision(db),locators:this.spanLocators(db,String(span.ref))});
    const document=db.prepare("SELECT d.document_ref ref,s.span_ref,d.kind,d.title heading,s.content,d.document_ref,d.relative_path,s.start_line,s.end_line FROM documents d JOIN spans s ON s.document_ref=d.document_ref WHERE d.document_ref=? ORDER BY s.ordinal LIMIT 1").get(ref) as Record<string,unknown>|undefined;
    return document?this.item({...document,score,revision:this.validRevision(db),locators:this.spanLocators(db,String(document.span_ref??""))}):undefined;
  }

  private validRevision(db:DatabaseSync):number{return asNumber((db.prepare("SELECT COALESCE(MAX(revision),0) revision FROM index_revisions WHERE status='valid'").get() as Record<string,unknown>).revision);}

  private expandNeighborhood(db:DatabaseSync,seeds:ExploreItem[],limit:number,maxHops:number){
    const fanOut=64,globalLimit=512,visited=new Set(seeds.map(seed=>seed.ref)),results=[...seeds],states=new Map(seeds.map(seed=>[seed.ref,{hop:0,path:[seed.ref],pathEvidence:[] as NonNullable<ExploreItem["pathEvidence"]>}]));let frontier=[...new Set(seeds.map(seed=>seed.ref))],maxActualHops=0,omittedEstimate=0,truncated=false;
    for(let hop=0;hop<maxHops&&frontier.length;hop++){
      const values=frontier.map(()=>"(?)").join(",");
      const rows=db.prepare(`WITH frontier(ref) AS (VALUES ${values}) SELECT owner_ref,edge_ref,kind,source_ref,target_ref,source_kind,confidence,span_ref,evidence_hash,revision,document_ref,relative_path,start_line,end_line,content FROM (SELECT owner_ref,edge_ref,kind,source_ref,target_ref,source_kind,confidence,span_ref,evidence_hash,revision,document_ref,relative_path,start_line,end_line,content,ROW_NUMBER() OVER (PARTITION BY owner_ref ORDER BY kind,edge_ref) rn FROM (SELECT f.ref owner_ref,e.edge_ref,e.kind,e.source_ref,e.target_ref,e.source_kind,e.confidence,e.span_ref,e.evidence_hash,e.revision,s.document_ref,d.relative_path,s.start_line,s.end_line,s.content FROM edges e JOIN frontier f ON f.ref=e.source_ref JOIN spans s ON s.span_ref=e.span_ref JOIN documents d ON d.document_ref=s.document_ref UNION ALL SELECT f.ref owner_ref,e.edge_ref,e.kind,e.source_ref,e.target_ref,e.source_kind,e.confidence,e.span_ref,e.evidence_hash,e.revision,s.document_ref,d.relative_path,s.start_line,s.end_line,s.content FROM edges e JOIN frontier f ON f.ref=e.target_ref JOIN spans s ON s.span_ref=e.span_ref JOIN documents d ON d.document_ref=s.document_ref WHERE e.source_ref!=e.target_ref)) WHERE rn<=? ORDER BY owner_ref,kind,edge_ref`).all(...frontier,fanOut+1) as Array<Record<string,unknown>>;
      const byOwner=new Map<string,Array<Record<string,unknown>>>();for(const row of rows){const owner=String(row.owner_ref),list=byOwner.get(owner);if(list)list.push(row);else byOwner.set(owner,[row]);}
      const edgeLocators=this.locatorMap(db,rows.map(row=>String(row.span_ref))),nodeRefs:string[]=[];const nodeByKey=new Map<string,ExploreItem|undefined>();
      for(const ownerRef of frontier){const edges=(byOwner.get(ownerRef)??[]).slice(0,fanOut);for(const edge of edges){const outgoing=String(edge.source_ref)===ownerRef,nextRef=String(outgoing?edge.target_ref:edge.source_ref);if(!visited.has(nextRef)&&visited.size+nodeRefs.length<globalLimit&&!nodeByKey.has(nextRef)){nodeRefs.push(nextRef);nodeByKey.set(nextRef,undefined);}}}
      const nodesByKey=new Map<string,ExploreItem|undefined>();for(const ref of nodeRefs)nodesByKey.set(ref,this.nodeItem(db,ref,1/(hop+2)));
      const next:string[]=[];
      for(const ownerRef of frontier){
        const edges=byOwner.get(ownerRef)??[],state=states.get(ownerRef)!;if(edges.length>fanOut){truncated=true;omittedEstimate+=edges.length-fanOut;}
        for(const edge of edges.slice(0,fanOut)){const outgoing=String(edge.source_ref)===ownerRef,nextRef=String(outgoing?edge.target_ref:edge.source_ref);if(visited.has(nextRef))continue;if(visited.size>=globalLimit){truncated=true;omittedEstimate++;continue;}const node=nodesByKey.has(nextRef)?nodesByKey.get(nextRef):this.nodeItem(db,nextRef,1/(hop+2));if(!node)continue;const locators=edgeLocators.get(String(edge.span_ref))??[],excerpt=String(edge.content).slice(0,900);const pathEvidence=[...state.pathEvidence,{edgeRef:String(edge.edge_ref),edgeKind:String(edge.kind),direction:outgoing?"outgoing" as const:"incoming" as const,sourceRef:String(edge.source_ref),targetRef:String(edge.target_ref),sourceKind:String(edge.source_kind) as ExploreItem["sourceKind"],confidence:Number(edge.confidence),evidence:{documentRef:String(edge.document_ref),relativePath:String(edge.relative_path),startLine:asNumber(edge.start_line),endLine:asNumber(edge.end_line),excerpt,evidenceHash:hash(excerpt),revision:asNumber(edge.revision),...(locators.length?{locators}:{})}}];visited.add(nextRef);maxActualHops=Math.max(maxActualHops,hop+1);results.push({...node,path:[...state.path,String(edge.kind),nextRef],pathEvidence});states.set(nextRef,{hop:hop+1,path:[...state.path,String(edge.kind),nextRef],pathEvidence});next.push(nextRef);}
      }
      frontier=next;
    }
    return{results:results.sort((a,b)=>b.score-a.score||a.ref.localeCompare(b.ref)).slice(0,Math.max(limit,1)+globalLimit),visitedNodes:visited.size,maxActualHops,omittedEstimate,truncated};
  }
  async context(query:string,budgetTokens:number,requiredRefs:string[]=[],options:ContextOptions={}):Promise<ContextPacket>{const refLists=[requiredRefs,options.excludeRefs??[],options.entityRefs??[],options.documentRefs??[]];for(const list of refLists)if(list.length>128||list.some(ref=>ref.length>256))throw codedError("CONTEXT_REFS_TOO_LARGE","a ref list exceeds 128 items or a 256-character reference");if(!Number.isFinite(budgetTokens)||budgetTokens<1||budgetTokens>1_000_000)throw codedError("BUDGET_OUT_OF_RANGE","budgetTokens must be between 1 and 1000000");const excludeRefs=options.excludeRefs??[],entityRefs=options.entityRefs??[],documentRefs=options.documentRefs??[],targetChapter=options.targetChapter;const explored=await this.explore("search",query,50,2);const requiredSet=new Set(requiredRefs),excludedSet=new Set(excludeRefs);const excluded:Array<{ref:string;tokens:number}>=[],candidates:ContextBlock[]=[];for(const r of explored.results){const required=requiredSet.has(r.ref),profile=contextSourceProfile(r.kind,required),block={...r,layer:profile.layer,tokens:estimateTokens(r.evidence.excerpt),required};if(!required&&excludedSet.has(r.ref)){excluded.push({ref:block.ref,tokens:block.tokens});continue;}candidates.push(block);}
    const{kept,duplicates}=dedupByEvidence([...candidates.filter(c=>c.required),...candidates.filter(c=>!c.required)]);const poolRefs=new Set(kept.map(c=>c.ref)),direct:ContextBlock[]=[],pinned:ContextBlock[]=[],unresolved:string[]=[];const db=await this.open();for(const ref of [...new Set(requiredRefs)]){if(poolRefs.has(ref))continue;const node=this.nodeItem(db,ref,1);if(node)direct.push({...node,layer:"L0",tokens:estimateTokens(node.evidence.excerpt),required:true});else unresolved.push(ref);}
    // AUD-012 pinned boundaries (2026-08-18 review): pinned refs resolve directly
    // and are NOT folded by evidence dedup (explicit requests survive, like
    // requiredRefs); a pinned ref already in the kept pool is skipped here and
    // keeps its search-hit rank. Documented in the writing_context description.
    for(const ref of [...new Set([...entityRefs,...documentRefs])]){if(poolRefs.has(ref)||requiredSet.has(ref))continue;if(excludedSet.has(ref)){excluded.push({ref,tokens:0});continue;}const node=this.nodeItem(db,ref,1);if(node){const profile=contextSourceProfile(node.kind,false);pinned.push({...node,layer:profile.layer,tokens:estimateTokens(node.evidence.excerpt),required:false});}else unresolved.push(ref);}
    const chapterByDoc=new Map<string,number>();if(targetChapter!=null){const docRefs=[...new Set([...kept,...direct,...pinned].map(c=>c.evidence.documentRef))];if(docRefs.length){const placeholders=docRefs.map(()=>"?").join(",");for(const row of db.prepare(`SELECT document_ref,chapter_number FROM documents WHERE document_ref IN (${placeholders})`).all(...docRefs) as Array<Record<string,unknown>>)if(row.chapter_number!=null)chapterByDoc.set(String(row.document_ref),asNumber(row.chapter_number));}}
    const anchorKey=(c:ContextBlock):[number,number]=>{if(targetChapter==null)return[0,0];const n=chapterByDoc.get(c.evidence.documentRef);if(n==null)return[3,0];if(n===targetChapter)return[0,0];return n<targetChapter?[1,targetChapter-n]:[2,n-targetChapter];};
    const pinnedRefs=new Set(pinned.map(c=>c.ref)),byFill=(a:ContextBlock,b:ContextBlock)=>layerRank(a.layer)-layerRank(b.layer)||(pinnedRefs.has(a.ref)?0:1)-(pinnedRefs.has(b.ref)?0:1)||anchorKey(a)[0]-anchorKey(b)[0]||anchorKey(a)[1]-anchorKey(b)[1]||b.score-a.score||contextSourceProfile(a.kind,false).priority-contextSourceProfile(b.kind,false).priority||compareText(a.ref,b.ref);
    const required=[...kept.filter(c=>c.required),...direct],min=required.reduce((n,c)=>n+c.tokens,0);if(min>budgetTokens)return{status:"budget_unsatisfiable",workRef:this.work.workRef,revision:explored.revision,budgetTokens,usedTokens:0,estimated:true,estimator:"mixed-cjk-v1",blocks:[],omitted:[...kept.map(c=>({ref:c.ref,reason:"required_minimum_exceeds_budget",tokens:c.tokens})),...direct.map(c=>({ref:c.ref,reason:"required_minimum_exceeds_budget",tokens:c.tokens})),...pinned.map(c=>({ref:c.ref,reason:"budget_limit",tokens:c.tokens})),...duplicates.map(c=>({ref:c.ref,reason:"duplicate_evidence",tokens:c.tokens})),...excluded.map(c=>({ref:c.ref,reason:"excluded",tokens:c.tokens})),...unresolved.map(ref=>({ref,reason:"not_found",tokens:0}))],diagnostics:[]};const optional=[...pinned,...kept.filter(c=>!c.required)].sort(byFill);const blocks:ContextBlock[]=[];let used=0;for(const c of [...required,...optional]){if(blocks.some(b=>b.ref===c.ref))continue;if(used+c.tokens<=budgetTokens){blocks.push(c);used+=c.tokens;}}const omitted=[...excluded.map(c=>({ref:c.ref,reason:"excluded",tokens:c.tokens})),...duplicates.map(c=>({ref:c.ref,reason:"duplicate_evidence",tokens:c.tokens})),...[...pinned,...kept].filter(c=>!c.required&&!blocks.some(b=>b.ref===c.ref)).map(c=>({ref:c.ref,reason:"budget_limit",tokens:c.tokens})),...direct.filter(c=>!blocks.some(b=>b.ref===c.ref)).map(c=>({ref:c.ref,reason:"budget_limit",tokens:c.tokens})),...unresolved.map(ref=>({ref,reason:"not_found",tokens:0}))];return{status:omitted.length?"truncated":"complete",workRef:this.work.workRef,revision:explored.revision,budgetTokens,usedTokens:used,estimated:true,estimator:"mixed-cjk-v1",blocks,omitted,diagnostics:explored.diagnostics};}
  close(){this.db?.close();this.db=undefined;}
}
