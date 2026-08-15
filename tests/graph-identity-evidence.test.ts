import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { stableId, WritingStore, type ParsedWork, type SourceDocument } from "@writing-mcp/core";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const workAt = (rootPath: string, documents: SourceDocument[]): ParsedWork => ({
  workRef: stableId("work", "graph-test", rootPath),
  title: "Graph test",
  rootPath,
  adapter: "generic",
  capabilities: [],
  documents,
});
const document = (
  workRef: string,
  relativePath: string,
  title: string,
  kind: SourceDocument["kind"],
  content: string,
  chapterNumber?: number,
): SourceDocument => ({
  documentRef: stableId("doc", workRef, relativePath),
  relativePath,
  absolutePath: relativePath,
  title,
  kind,
  content,
  chapterNumber,
  sourceMtimeMs: 1,
  sourceSize: Buffer.byteLength(content),
});
const indexPath = (work: ParsedWork) => join(work.rootPath, ".writing-index", work.workRef.replace(":", "-"), "index.sqlite");

describe("schema v4 graph identity and evidence", () => {
  test("keeps duplicate chapter titles distinct and orders them by source ordinal", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-chapter-identity-"));
    const ref = stableId("work", "graph-test", root);
    const work = workAt(root, [
      document(ref, "volume-1/one.md", "第一章", "chapter", "# 第一章\n甲。", 1),
      document(ref, "volume-1/two.md", "第二章", "chapter", "# 第二章\n乙。", 2),
      document(ref, "volume-2/one.md", "第一章", "chapter", "# 第一章\n丙。", 1),
    ]);
    const store = new WritingStore(work);
    try { await store.index("rebuild"); } finally { store.close(); }
    const db = new DatabaseSync(indexPath(work), { readOnly: true });
    try {
      const chapters = db.prepare(`SELECT e.entity_ref,d.relative_path FROM entities e JOIN spans s ON s.span_ref=e.span_ref JOIN documents d ON d.document_ref=s.document_ref WHERE e.kind='Chapter' ORDER BY d.source_ordinal`).all() as Array<{ entity_ref: string; relative_path: string }>;
      expect(chapters).toHaveLength(3);
      expect(new Set(chapters.map(row => row.entity_ref)).size).toBe(3);
      expect(chapters.map(row => row.relative_path)).toEqual(["volume-1/one.md", "volume-1/two.md", "volume-2/one.md"]);
      const order = db.prepare("SELECT source_ref,target_ref FROM edges WHERE kind='precedes' ORDER BY json_extract(properties_json,'$.order')").all();
      expect(order).toEqual([
        { source_ref: chapters[0]!.entity_ref, target_ref: chapters[1]!.entity_ref },
        { source_ref: chapters[1]!.entity_ref, target_ref: chapters[2]!.entity_ref },
      ]);
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("separates stable identity hashes from verifiable evidence hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-evidence-hash-"));
    const ref = stableId("work", "graph-test", root);
    const work = workAt(root, [document(ref, "one.md", "第一章", "chapter", "# 第一章\n可验证证据。", 1)]);
    const store = new WritingStore(work);
    try {
      await store.index("rebuild");
      const explored=await store.explore("search","可验证证据",10,0);
      expect(explored.results[0]?.evidence.evidenceHash).toBe(digest(explored.results[0]!.evidence.excerpt));
      expect(explored.results[0]?.evidence.revision).toBe(1);
    } finally { store.close(); }
    const db = new DatabaseSync(indexPath(work), { readOnly: true });
    try {
      const span = db.prepare("SELECT span_ref,content FROM spans").get() as { span_ref: string; content: string };
      const entity = db.prepare("SELECT identity_hash,evidence_hash,revision FROM entities WHERE kind='Chapter'").get() as { identity_hash: string; evidence_hash: string; revision: number };
      expect(entity.identity_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(entity.evidence_hash).toBe(digest(span.content));
      expect(entity.identity_hash).not.toBe(entity.evidence_hash);
      expect(entity.revision).toBe(1);
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("records every mention and every relationship evidence occurrence", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-multi-evidence-"));
    const ref = stableId("work", "graph-test", root);
    const work = workAt(root, [
      document(ref, "character.md", "Alice", "character", "# Alice\n角色定义。"),
      document(ref, "chapter.md", "Opening", "chapter", "# Opening\nAlice met Alice.\n## Later\nAlice left.", 1),
    ]);
    const store = new WritingStore(work);
    try { await store.index("rebuild"); } finally { store.close(); }
    const db = new DatabaseSync(indexPath(work), { readOnly: true });
    try {
      const mentions = db.prepare(`SELECT m.start_offset,m.end_offset FROM mentions m JOIN entities e ON e.entity_ref=m.entity_ref JOIN spans s ON s.span_ref=m.span_ref JOIN documents d ON d.document_ref=s.document_ref WHERE d.relative_path='chapter.md' AND m.source_kind='deterministic' AND e.name='Alice' ORDER BY s.ordinal,m.start_offset`).all();
      expect(mentions).toHaveLength(3);
      const evidence = db.prepare(`SELECT ee.start_offset,ee.end_offset FROM edge_evidence ee JOIN edges e ON e.edge_ref=ee.edge_ref JOIN entities entity ON entity.entity_ref=e.source_ref WHERE e.kind='appears_in' AND entity.name='Alice' ORDER BY ee.span_ref,ee.start_offset`).all();
      expect(evidence).toHaveLength(4);
      expect(db.prepare("SELECT COUNT(*) count FROM edges e JOIN entities entity ON entity.entity_ref=e.source_ref WHERE e.kind='appears_in' AND entity.name='Alice'").get()).toEqual({ count: 2 });
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("keeps all same-name definitions and deterministically promotes the remaining source", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-canonical-source-"));
    const ref = stableId("work", "graph-test", root);
    const firstDefinition = document(ref, "a.md", "Alice", "character", "# Alice\n第一份定义。");
    const secondDefinition = document(ref, "b.md", "Alice", "character", "# Alice\n第二份定义。");
    const initial = workAt(root, [firstDefinition, secondDefinition]);
    const first = new WritingStore(initial);
    let entityRef = "";
    try { await first.index("rebuild"); } finally { first.close(); }
    let db = new DatabaseSync(indexPath(initial), { readOnly: true });
    try {
      const canonical = db.prepare(`SELECT e.entity_ref,d.relative_path FROM entities e JOIN spans s ON s.span_ref=e.span_ref JOIN documents d ON d.document_ref=s.document_ref WHERE e.kind='Character'`).get() as { entity_ref: string; relative_path: string };
      entityRef = canonical.entity_ref;
      expect(canonical.relative_path).toBe("a.md");
      expect(db.prepare("SELECT COUNT(*) count FROM entity_definitions WHERE entity_ref=?").get(entityRef)).toEqual({ count: 2 });
    } finally { db.close(); }

    const updated = workAt(root, [secondDefinition]);
    const second = new WritingStore(updated);
    try { await second.index("incremental"); } finally { second.close(); }
    db = new DatabaseSync(indexPath(updated), { readOnly: true });
    try {
      const promoted = db.prepare(`SELECT e.entity_ref,d.relative_path FROM entities e JOIN spans s ON s.span_ref=e.span_ref JOIN documents d ON d.document_ref=s.document_ref WHERE e.kind='Character'`).get() as { entity_ref: string; relative_path: string };
      expect(promoted).toEqual({ entity_ref: entityRef, relative_path: "b.md" });
      expect(db.prepare("SELECT COUNT(*) count FROM entity_definitions WHERE entity_ref=?").get(entityRef)).toEqual({ count: 1 });
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });
});
