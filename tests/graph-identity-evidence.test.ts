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
  test.each(["alice", "ALICE", "aLiCe"])("refreshes unchanged [[%s]] references when owners are added/deleted/renamed (W-MCP-009)", async name => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-owner-refresh-")), ref = stableId("work", "graph-test", root);
    const character = document(ref, "role.md", "Alice", "character", "# Alice");
    const chapter = document(ref, "one.md", "Arrival", "chapter", `# Arrival\n[[${name}]] arrives.`, 1);
    const other = document(ref, "location.md", "Location: ALICE", "document", "# Location: ALICE");
    const work = workAt(root, [character, chapter]), store = new WritingStore(work);
    const references = (path: string) => {
      const db = new DatabaseSync(path, { readOnly: true });
      try { return {
        edges: db.prepare("SELECT e.edge_ref,e.source_ref,e.target_ref,e.confidence,ee.span_ref,ee.start_offset,ee.end_offset,ee.evidence_hash FROM edges e JOIN edge_evidence ee ON ee.edge_ref=e.edge_ref WHERE e.kind='mentions' ORDER BY e.edge_ref,ee.span_ref").all(),
        unresolved: db.prepare("SELECT text,reason FROM unresolved_mentions ORDER BY text,span_ref").all(),
      }; } finally { db.close(); }
    };
    try {
      await store.index("rebuild");
      expect(references(indexPath(work)).edges).toHaveLength(1);
      for (const phase of ["add", "delete", "rename", "restore"]) {
        if (phase === "add") work.documents.push(other);
        if (phase === "delete") work.documents.splice(work.documents.indexOf(other), 1);
        if (phase === "rename" || phase === "restore") {
          character.title = phase === "rename" ? "Beryl" : "Alice";
          character.content = `# ${character.title}`; character.sourceSize = Buffer.byteLength(character.content);
        }
        await store.index("incremental");
        const state = references(indexPath(work));
        if (phase === "add" || phase === "rename") {
          expect(state.edges).toHaveLength(0);
          expect(state.unresolved).toEqual([{ text: name, reason: phase === "add" ? "AMBIGUOUS_ALIAS" : "NO_MATCHING_ENTITY" }]);
        } else { expect(state.edges).toHaveLength(1); expect(state.unresolved).toEqual([]); }
        const cold = new WritingStore(work, join(root, "cold.sqlite"));
        try { await cold.index("rebuild"); expect(state).toEqual(references(join(root, "cold.sqlite"))); } finally { cold.close(); }
        await store.index("incremental"); expect(references(indexPath(work))).toEqual(state);
      }
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("invalidates references to an old persisted alias when its owner disappears (W-MCP-009)", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-old-alias-refresh-")), ref = stableId("work", "graph-test", root);
    const character = document(ref, "role.md", "Alice", "character", "# Alice"), chapter = document(ref, "one.md", "Arrival", "chapter", "# Arrival", 1);
    const work = workAt(root, [character, chapter]), store = new WritingStore(work);
    try {
      await store.index("rebuild");
      const db = new DatabaseSync(indexPath(work));
      try {
        const owner = String(db.prepare("SELECT entity_ref FROM entities WHERE name='Alice'").get()!.entity_ref);
        db.prepare("INSERT INTO aliases VALUES(?,?,?)").run(owner, "Scout", "scout");
        chapter.content += "\n[[scout]] arrives."; chapter.sourceSize = Buffer.byteLength(chapter.content);
        await store.index("incremental");
        expect(db.prepare("SELECT COUNT(*) count FROM edges WHERE kind='mentions'").get()).toEqual({ count: 1 });
        character.title = "Beryl"; character.content = "# Beryl"; character.sourceSize = Buffer.byteLength(character.content);
        await store.index("incremental");
        expect(db.prepare("SELECT text,reason FROM unresolved_mentions").all()).toEqual([{ text: "scout", reason: "NO_MATCHING_ENTITY" }]);
        expect(db.prepare("SELECT COUNT(*) count FROM edges WHERE kind='mentions'").get()).toEqual({ count: 0 });
      } finally { db.close(); }
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("normalizes canonical-equivalent entity names and native references consistently (W-MCP-005)", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-nfc-owner-")), ref = stableId("work", "graph-test", root);
    const work = workAt(root, [
      document(ref, "a.md", "Café", "character", "# Café\nFirst definition."),
      document(ref, "b.md", "Cafe\u0301", "character", "# Cafe\u0301\nSecond definition."),
      document(ref, "one.md", "Arrival", "chapter", "# Arrival\n[[CAFE\u0301]] arrives.", 1),
    ]);
    const store = new WritingStore(work);
    try {
      await store.index("rebuild");
      const db = new DatabaseSync(indexPath(work), { readOnly: true });
      try {
        expect(db.prepare("SELECT name,normalized_name FROM entities WHERE kind='Character'").all()).toEqual([{ name: "Café", normalized_name: "café" }]);
        expect(db.prepare("SELECT COUNT(*) count FROM edges WHERE kind='mentions' AND source_ref=?").get(work.documents[2]!.documentRef)).toEqual({ count: 1 });
      } finally { db.close(); }
      for (const query of ["Café", "Cafe\u0301", "CAFÉ"]) {
        const result = await store.explore("entity", query, 20, 0);
        expect(result.results.map(item => item.title)).toEqual(["Café"]);
        expect(result.ambiguous.map(item => item.title)).toEqual(["Cafe\u0301"]);
      }
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("keeps compatibility-distinct owners addressable by their original names and stable refs (W-MCP-005)", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-compat-owner-")), ref = stableId("work", "graph-test", root);
    const work = workAt(root, [document(ref, "ascii.md", "Alice", "character", "# Alice"), document(ref, "wide.md", "Ａlice", "character", "# Ａlice")]);
    const store = new WritingStore(work);
    try {
      await store.index("rebuild");
      const db = new DatabaseSync(indexPath(work), { readOnly: true });
      let owners: Array<{ entity_ref: string; name: string }>;
      try { owners = db.prepare("SELECT entity_ref,name FROM entities WHERE kind='Character'").all() as typeof owners; } finally { db.close(); }
      expect(owners).toHaveLength(2);
      for (const owner of owners) {
        expect((await store.explore("entity", owner.name, 20, 0)).results.map(item => item.ref)).toEqual([owner.entity_ref]);
        expect((await store.explore("neighborhood", owner.entity_ref, 20, 0)).results.map(item => item.title)).toEqual([owner.name]);
      }
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("finds canonically equivalent unresolved references without rewriting source evidence (W-MCP-005)", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-unresolved-nfc-")), ref = stableId("work", "graph-test", root);
    const work = workAt(root, [document(ref, "one.md", "Waiting", "chapter", "# Waiting\n[[E\u0301LODIE]] is unknown.", 1)]), store = new WritingStore(work);
    try {
      await store.index("rebuild");
      const result = await store.explore("entity", "Élodie", 20, 0);
      expect(result.results).toHaveLength(0);
      expect(result.diagnostics.map(item => item.code)).toContain("UNRESOLVED_REFERENCE");
      expect(result.ambiguous.map(item => item.title)).toEqual(["E\u0301LODIE"]);
      expect(result.ambiguous[0]!.evidence.excerpt).toContain("[[E\u0301LODIE]]");
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("recomputes Chapter title aliases without dropping other persisted aliases (W-MCP-013)", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-title-alias-")), ref = stableId("work", "graph-test", root);
    const chapter = document(ref, "one.md", "Opening Gate", "chapter", "# Opening Gate\nDawn.", 1);
    const witness = document(ref, "two.md", "After", "chapter", "# After\n[[Opening Gate]] and [[Opening]].", 2);
    const work = workAt(root, [document(ref, "role.md", "Iona", "character", "# Iona"), chapter, witness]);
    const store = new WritingStore(work);
    const chapterState = (path: string) => {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        return {
          aliases: db.prepare("SELECT e.entity_ref,a.alias,a.normalized_alias FROM aliases a JOIN entities e ON e.entity_ref=a.entity_ref WHERE e.kind='Chapter' ORDER BY e.entity_ref,a.normalized_alias").all(),
          references: db.prepare("SELECT source_ref,target_ref FROM edges WHERE kind='mentions' ORDER BY source_ref,target_ref").all(),
          unresolved: db.prepare("SELECT text,reason FROM unresolved_mentions ORDER BY text").all(),
        };
      } finally { db.close(); }
    };
    try {
      await store.index("rebuild");
      const identity = (await store.explore("entity", "Opening Gate", 20, 0)).results[0]!.ref;
      const db = new DatabaseSync(indexPath(work));
      try {
        const owner = db.prepare("SELECT entity_ref FROM entities WHERE name='Iona'").get()!;
        db.prepare("INSERT INTO aliases VALUES(?,?,?)").run(String(owner.entity_ref), "Nightbird", "nightbird");
        db.prepare("INSERT INTO aliases VALUES(?,?,?)").run(identity, "Ancient title", "ancient title");
      } finally { db.close(); }
      for (const title of ["Opening", "Opening Gate"]) {
        chapter.title = title; chapter.content = `# ${title}\nDawn.`; chapter.sourceSize = Buffer.byteLength(chapter.content);
        await store.index("incremental");
        const state = chapterState(indexPath(work));
        expect(state.aliases.filter(row => row.entity_ref === identity)).toEqual([{ entity_ref: identity, alias: title, normalized_alias: title.toLowerCase() }]);
        expect((await store.explore("entity", "Nightbird", 20, 0)).results.map(item => item.title)).toEqual(["Iona"]);
        const cold = new WritingStore(work, join(root, "cold.sqlite"));
        try { await cold.index("rebuild"); expect(state).toEqual(chapterState(join(root, "cold.sqlite"))); } finally { cold.close(); }
        await store.index("incremental");
        expect(chapterState(indexPath(work))).toEqual(state);
        store.close();
        expect((await store.explore("entity", title, 20, 0)).results[0]!.ref).toBe(identity);
      }
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test.each([
    { kind: "character", title: "Iona" },
    { kind: "foreshadow", title: "Iona" },
    { kind: "outline", title: "Iona" },
    { kind: "state", title: "Iona" },
    { kind: "document", title: "Location: Iona" },
    { kind: "document", title: "Location: Unreferenced" },
  ] as const)("preserves chapter sequence after a $kind dossier edit ($title), W-MCP-012", async ({ kind, title }) => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-precedes-edit-"));
    const ref = stableId("work", "graph-test", root);
    const dossier = document(ref, "dossier.md", title, kind, `# ${title}\nInitial dossier.`);
    const work = workAt(root, [
      dossier,
      document(ref, "chapter-01.md", "Chapter 1 Dawn", "chapter", "# Chapter 1 Dawn\nThe sky lightens.", 1),
      document(ref, "chapter-02.md", "Chapter 2 Gate", "chapter", "# Chapter 2 Gate\nIona opens the gate.", 2),
      document(ref, "chapter-03.md", "Chapter 3 Night", "chapter", "# Chapter 3 Night\nThe lamps go out.", 3),
    ]);
    const sequence = async (store: WritingStore) => (await store.explore("timeline", "", 100, 0)).results
      .filter(item => item.kind === "precedes-relation")
      .map(item => ({ ref: item.ref, title: item.title }));
    const store = new WritingStore(work);
    try {
      await store.index("incremental");
      const before = await sequence(store);
      expect(before.map(item => item.title)).toEqual([
        "precedes: Chapter 1 Dawn → Chapter 2 Gate",
        "precedes: Chapter 2 Gate → Chapter 3 Night",
      ]);
      dossier.content = `# ${title}\nA revised dossier with a longer biography.`;
      dossier.sourceSize = Buffer.byteLength(dossier.content);
      const updated = await store.index("incremental");
      expect(updated.stats).toMatchObject({ updated: 1, skipped: 3 });
      expect(await sequence(store)).toEqual(before);
      const db = new DatabaseSync(indexPath(work), { readOnly: true });
      try {
        expect(db.prepare("SELECT COUNT(*) AS count FROM edge_evidence ee JOIN edges e ON e.edge_ref=ee.edge_ref WHERE e.kind='precedes'").get()).toEqual({ count: 2 });
      } finally { db.close(); }
      await store.index("incremental");
      expect(await sequence(store)).toEqual(before);
      store.close();
      const reopened = new WritingStore(work);
      try { expect(await sequence(reopened)).toEqual(before); } finally { reopened.close(); }
      const cold = new WritingStore(work, join(root, "cold.sqlite"));
      try {
        await cold.index("rebuild");
        expect(await sequence(cold)).toEqual(before);
      } finally { cold.close(); }
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

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
