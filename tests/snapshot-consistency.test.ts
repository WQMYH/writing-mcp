import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { GenericAdapter } from "@writing-mcp/adapter-generic";
import { WritingService, type ParsedWork, type SourceSnapshot, type WorkAdapter, type WorkCandidate } from "@writing-mcp/core";

// AUD-029: loading reads multiple files over a time window; the source may
// change mid-read and produce a snapshot that mixes different states. The
// service must verify the source fingerprint before and after the read and
// surface a stable error instead of silently indexing a mixed snapshot. The
// generic adapter must also bound per-file text size with a stable error.

describe("snapshot consistency (AUD-029)", () => {
  test("rejects with SOURCE_CHANGED_DURING_READ when the source keeps changing during reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-aud029-change-"));
    const source = join(dir, "novel");
    let calls = 0;
    const delegate = new GenericAdapter();
    const adapter: WorkAdapter = {
      kind: "generic",
      discover: path => delegate.discover(path),
      snapshot: candidate => delegate.snapshot(candidate),
      load: async (candidate: WorkCandidate, snapshot?: SourceSnapshot): Promise<ParsedWork> => {
        calls++;
        await writeFile(join(source, "chapter-01.md"), `# 篡改${calls}\n第 ${calls} 次中途改写源文件。`);
        return delegate.load(candidate, snapshot);
      },
    };
    const service = new WritingService([adapter]);
    try {
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "chapter-01.md"), "# 第一章\n原始正文。");
      const resolved = await service.resolve(source, "generic");
      expect(resolved.status).toBe("resolved");
      await expect(service.index(resolved.workRef!, "rebuild")).rejects.toMatchObject({ code: "SOURCE_CHANGED_DURING_READ" });
    } finally {
      service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recovers when the source stabilizes before the bounded retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-aud029-retry-"));
    const source = join(dir, "novel");
    let calls = 0;
    const delegate = new GenericAdapter();
    const adapter: WorkAdapter = {
      kind: "generic",
      discover: path => delegate.discover(path),
      snapshot: candidate => delegate.snapshot(candidate),
      load: async (candidate: WorkCandidate, snapshot?: SourceSnapshot): Promise<ParsedWork> => {
        calls++;
        if (calls === 1) await writeFile(join(source, "chapter-01.md"), "# 稳定\n改写一次后不再变化。");
        return delegate.load(candidate, snapshot);
      },
    };
    const service = new WritingService([adapter]);
    try {
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "chapter-01.md"), "# 第一章\n原始正文。");
      const resolved = await service.resolve(source, "generic");
      expect(resolved.status).toBe("resolved");
      const indexed = await service.index(resolved.workRef!, "rebuild");
      expect(indexed.stats.documents).toBeGreaterThan(0);
    } finally {
      service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects an oversized text file with SOURCE_FILE_TOO_LARGE", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-aud029-large-"));
    await writeFile(join(dir, "huge.md"), "# 大文件\n" + "甲".repeat(600));
    const adapter = new GenericAdapter({ text: { maxDocumentBytes: 100 } });
    try {
      await expect(adapter.load((await adapter.discover(dir))[0]!)).rejects.toMatchObject({ code: "SOURCE_FILE_TOO_LARGE" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("loads text within the default per-file limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-aud029-default-"));
    await writeFile(join(dir, "one.md"), "# 正常\n正文。");
    const adapter = new GenericAdapter();
    try {
      const work = await adapter.load((await adapter.discover(dir))[0]!);
      expect(work.documents).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("rejects a work whose combined text exceeds the total limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-aud029-total-"));
    await writeFile(join(dir, "a.md"), "# 甲\n" + "甲".repeat(200));
    await writeFile(join(dir, "b.md"), "# 乙\n" + "乙".repeat(200));
    const adapter = new GenericAdapter({ text: { maxDocumentBytes: 10_000, maxTotalBytes: 300 } });
    try {
      await expect(adapter.load((await adapter.discover(dir))[0]!)).rejects.toMatchObject({ code: "SOURCE_TOTAL_TOO_LARGE" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
