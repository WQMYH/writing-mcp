import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { stableId, WritingStore, type ParsedWork, type SourceDocument } from "@writing-mcp/core";

describe("document literal substring search", () => {
  test("treats percent, underscore, and backslash as literal query text", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "writing-mcp-document-like-"));
    const workRef = stableId("work", "document-like", rootPath);
    const document = (relativePath: string, title: string): SourceDocument => ({
      documentRef: stableId("doc", workRef, relativePath),
      relativePath,
      absolutePath: join(rootPath, relativePath),
      title,
      kind: "document",
      content: `# ${title}\n正文`,
      sourceMtimeMs: 1,
      sourceSize: title.length + 4,
    });
    const work: ParsedWork = {
      workRef,
      title: "DocumentLike",
      rootPath,
      adapter: "generic",
      capabilities: [],
      documents: [
        document("percent%note.md", "Percent title"),
        document("under_score.md", "Under title"),
        document("backslash.md", "Back\\slash title"),
        document("plain.md", "Plain title"),
      ],
    };
    const store = new WritingStore(work);
    try {
      await store.index("rebuild");
      const matchingDocuments = async (query: string) =>
        new Set((await store.explore("document", query, 20, 0)).results.map(item => item.evidence.documentRef));

      expect(await matchingDocuments("%")).toEqual(new Set([work.documents[0]!.documentRef]));
      expect(await matchingDocuments("_")).toEqual(new Set([work.documents[1]!.documentRef]));
      expect(await matchingDocuments("\\")).toEqual(new Set([work.documents[2]!.documentRef]));
    } finally {
      store.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
