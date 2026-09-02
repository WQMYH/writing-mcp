import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

import { GenericAdapter } from "@writing-mcp/adapter-generic";

describe("generic adapter pre-read text limits", () => {
  test("rejects an oversized file before allocating its contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-pre-read-file-"));
    const reader = vi.mocked(readFile);
    try {
      await writeFile(join(dir, "huge.md"), "# heading\n" + "x".repeat(256));
      const adapter = new GenericAdapter({ text: { maxDocumentBytes: 64, maxTotalBytes: 1_024 } });
      const candidate = (await adapter.discover(dir))[0]!;
      const snapshot = await adapter.snapshot(candidate);
      reader.mockClear();

      await expect(adapter.load(candidate, snapshot)).rejects.toMatchObject({ code: "SOURCE_FILE_TOO_LARGE" });
      expect(reader).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stops before reading the file that would exceed the work total", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-pre-read-total-"));
    const reader = vi.mocked(readFile);
    try {
      await writeFile(join(dir, "a.md"), "a".repeat(40));
      await writeFile(join(dir, "b.md"), "b".repeat(40));
      const adapter = new GenericAdapter({ text: { maxDocumentBytes: 100, maxTotalBytes: 60 } });
      const candidate = (await adapter.discover(dir))[0]!;
      const snapshot = await adapter.snapshot(candidate);
      reader.mockClear();

      await expect(adapter.load(candidate, snapshot)).rejects.toMatchObject({ code: "SOURCE_TOTAL_TOO_LARGE" });
      expect(reader).toHaveBeenCalledTimes(1);
      expect(reader).toHaveBeenCalledWith(join(dir, "a.md"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
