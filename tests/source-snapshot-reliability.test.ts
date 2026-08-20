import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { GenericAdapter } from "@writing-mcp/adapter-generic";
import { WritingService, type ParsedWork, type WorkAdapter, type WorkCandidate } from "@writing-mcp/core";

interface SnapshotEntry { relativePath: string; absolutePath: string; size: number; mtimeNs: string }
interface Snapshot { rootPath: string; entries: readonly SnapshotEntry[]; fingerprint: string }
type SnapshotAdapter = WorkAdapter & { snapshot(candidate: WorkCandidate): Promise<Snapshot> };

const snapshotOf = (adapter: WorkAdapter, candidate: WorkCandidate) => (adapter as SnapshotAdapter).snapshot(candidate);

class CountingGenericAdapter extends GenericAdapter {
  loadCount = 0;
  override async load(candidate: WorkCandidate): Promise<ParsedWork> {
    this.loadCount++;
    return super.load(candidate);
  }
}

class IncrementalFailureAdapter extends GenericAdapter {
  failIncremental = false;
  override async load(candidate: WorkCandidate, snapshot?: Snapshot): Promise<ParsedWork> {
    const work = await super.load(candidate, snapshot);
    if (!this.failIncremental || !work.documents[0]) return work;
    const first = work.documents[0];
    return { ...work, documents: [...work.documents, { ...first, documentRef: `${first.documentRef}-duplicate` }] };
  }
}

describe("Task 1 SourceSnapshot reliability", () => {
  test("enumerates nested files by their complete relative paths without a depth limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-source-snapshot-depth-"));
    const source = join(dir, "novel");
    const first = join(source, "left");
    const second = join(source, "right");
    let deep = source;
    try {
      await mkdir(first, { recursive: true });
      await mkdir(second, { recursive: true });
      await writeFile(join(first, "chapter.md"), "# Left\nleft content");
      await writeFile(join(second, "chapter.md"), "# Right\nright content");
      for (let i = 0; i < 14; i++) deep = join(deep, `level-${i}`);
      await mkdir(deep, { recursive: true });
      await writeFile(join(deep, "deep.md"), "# Deep\ndeep content");
      const adapter = new GenericAdapter();
      const candidate = {
        workRef: "work:source-snapshot-link",
        title: "novel",
        rootPath: source,
        sourcePath: source,
        adapter: "generic" as const,
        capabilities: ["documents", "full_text"] as const,
      };
      const snapshot = await snapshotOf(adapter, candidate);
      expect(snapshot.entries.map(entry => entry.relativePath)).toEqual(expect.arrayContaining([
        "left/chapter.md", "right/chapter.md", `${Array.from({ length: 14 }, (_, i) => `level-${i}`).join("/")}/deep.md`,
      ]));
      expect(new Set(snapshot.entries.map(entry => entry.relativePath)).size).toBe(snapshot.entries.length);
      expect(snapshot.entries.every(entry => /^\d+$/.test(entry.mtimeNs) && entry.size >= 0)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("snapshot changes for single-file edits and add/delete operations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-source-snapshot-mutations-"));
    const source = join(dir, "novel");
    try {
      await mkdir(source);
      const first = join(source, "one.md");
      const second = join(source, "two.md");
      await writeFile(first, "# One\noriginal");
      const adapter = new GenericAdapter();
      const candidate = (await adapter.discover(source))[0]!;
      const original = await snapshotOf(adapter, candidate);
      await writeFile(first, "# One\nupdated and larger");
      const changed = await snapshotOf(adapter, candidate);
      await writeFile(second, "# Two\nadded");
      const added = await snapshotOf(adapter, candidate);
      await rm(second);
      const deleted = await snapshotOf(adapter, candidate);
      expect(changed.fingerprint).not.toBe(original.fingerprint);
      expect(added.fingerprint).not.toBe(changed.fingerprint);
      expect(deleted.fingerprint).not.toBe(added.fingerprint);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("rejects a source entry that resolves outside its snapshot root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-source-snapshot-link-"));
    const source = join(dir, "novel");
    const outside = join(dir, "outside.md");
    try {
      await mkdir(source);
      await writeFile(outside, "# Outside\nnot authorized");
      await symlink(outside, join(source, "escape.md"), "file");
      const adapter = new GenericAdapter();
      const candidate: WorkCandidate = {
        workRef: "work:source-snapshot-link",
        title: "novel",
        rootPath: source,
        sourcePath: source,
        adapter: "generic",
        capabilities: ["documents", "full_text"],
      };
      await expect(snapshotOf(adapter, candidate)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("status stale is followed by incremental indexing before explore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-source-snapshot-stale-"));
    const source = join(dir, "novel");
    const service = new WritingService([new GenericAdapter()]);
    try {
      await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
      const workRef = (await service.resolve(source, "generic")).workRef!;
      await service.index(workRef, "rebuild");
      const marker = `snapshot-new-${Date.now()}`;
      await writeFile(join(source, "chapter-01.md"), `# 第一章\n${marker}`);
      expect((await service.index(workRef, "status")).freshness).toBe("stale");
      const found = await service.explore(workRef, "search", marker);
      expect(found.results.some(result => result.evidence.excerpt.includes(marker))).toBe(true);
    } finally { service.close(); await rm(dir, { recursive: true, force: true }); }
  });

  test("unchanged snapshot keeps the status and query fast paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-source-snapshot-fast-"));
    const source = join(dir, "novel");
    const adapter = new CountingGenericAdapter();
    const service = new WritingService([adapter]);
    try {
      await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
      const workRef = (await service.resolve(source, "generic")).workRef!;
      await service.index(workRef, "rebuild");
      const loads = adapter.loadCount;
      await service.index(workRef, "status");
      await service.explore(workRef, "search", "铜钥匙");
      expect(adapter.loadCount).toBe(loads);
    } finally { service.close(); await rm(dir, { recursive: true, force: true }); }
  });

  test("an incremental failure retains the old usable index and does not advance freshness", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-source-snapshot-rollback-"));
    const source = join(dir, "novel");
    const adapter = new IncrementalFailureAdapter();
    const service = new WritingService([adapter]);
    try {
      await cp(new URL("../fixtures/generic-novel", import.meta.url), source, { recursive: true });
      const workRef = (await service.resolve(source, "generic")).workRef!;
      await service.index(workRef, "rebuild");
      const marker = `recovered-after-failure-${Date.now()}`;
      await writeFile(join(source, "chapter-01.md"), `# 第一章\n${marker}`);
      adapter.failIncremental = true;
      await expect(service.index(workRef, "incremental")).rejects.toThrow();
      adapter.failIncremental = false;
      const found = await service.explore(workRef, "search", marker);
      expect(found.results.some(result => result.evidence.excerpt.includes(marker))).toBe(true);
    } finally { service.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
