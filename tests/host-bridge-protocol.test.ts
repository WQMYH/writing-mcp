import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  AUTH, AUTH_MATRIX, BRIDGE_DEFAULT_PORT, BRIDGE_ERROR_CODES, LIMITS, PROTOCOL_VERSION, TIMEOUTS,
  bridgeFailureEnvelopeSchema, bridgeSuccessEnvelopeSchema, bridgeProcessStateSchema,
  computeContentHash, computeProjectKey, computeSnapshotHash, hostProjectIdSchema,
  hostSnapshotDraftSchema, pluginStateSchema, projectBindingStateSchema, sessionStateSchema,
  toolProxyRequestSchema, validateRelativePath,
} from "../packages/host-bridge-protocol/src/index.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/host-bridge-protocol/${name}`, import.meta.url), "utf8"));
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const validDocument = { relativePath: "project/story-core.md", category: "project", mediaType: "text/markdown", content: "# 故事核心", sha256: sha256("# 故事核心") };
const validDraft = {
  protocolVersion: 1,
  pluginId: "storyforge",
  hostProjectId: "123",
  documents: [validDocument, { ...validDocument, relativePath: "chapters/第一章.md", category: "chapter" }],
  chapters: [{ chapterKey: "n:1", ordinal: 1 }, { chapterKey: "n:2", ordinal: 2 }],
  claimedSnapshotHash: sha256("anything"),
};

describe("host bridge protocol v1 (HB-M0)", () => {
  test("draft and envelope schemas reject unknown fields", () => {
    expect(hostSnapshotDraftSchema.safeParse({ ...validDraft, extra: true }).success).toBe(false);
    expect(hostSnapshotDraftSchema.safeParse({ ...validDraft, documents: [{ ...validDocument, extra: 1 }] }).success).toBe(false);
    expect(bridgeSuccessEnvelopeSchema.safeParse({ protocolVersion: 1, ok: true, data: {}, extra: 1 }).success).toBe(false);
    expect(bridgeFailureEnvelopeSchema.safeParse({ protocolVersion: 1, ok: false, error: { code: "DERIVED_DATA_BUSY", message: "x" }, extra: 1 }).success).toBe(false);
  });

  test("hostProjectId accepts only 1-128 chars of [A-Za-z0-9._:-]", () => {
    for (const bad of ["", "a".repeat(129), "a/b", "a b", "项目", "a\nb", "a\\b"]) {
      expect(hostProjectIdSchema.safeParse(bad).success).toBe(false);
    }
    for (const good of ["123", "abc-._:X", "a".repeat(128)]) {
      expect(hostProjectIdSchema.safeParse(good).success).toBe(true);
    }
  });

  test("chapter ordinals must be contiguous from 1 and chapter keys unique", () => {
    expect(hostSnapshotDraftSchema.safeParse({ ...validDraft, chapters: [] }).success).toBe(true);
    expect(hostSnapshotDraftSchema.safeParse({ ...validDraft, chapters: [{ chapterKey: "n:2", ordinal: 1 }, { chapterKey: "n:1", ordinal: 2 }] }).success).toBe(true);
    expect(hostSnapshotDraftSchema.safeParse({ ...validDraft, chapters: [{ chapterKey: "n:1", ordinal: 1 }, { chapterKey: "n:2", ordinal: 3 }] }).success).toBe(false);
    expect(hostSnapshotDraftSchema.safeParse({ ...validDraft, chapters: [{ chapterKey: "n:1", ordinal: 2 }] }).success).toBe(false);
    expect(hostSnapshotDraftSchema.safeParse({ ...validDraft, chapters: [{ chapterKey: "n:1", ordinal: 1 }, { chapterKey: "n:1", ordinal: 2 }] }).success).toBe(false);
  });

  test("documents must not repeat a relativePath", () => {
    expect(hostSnapshotDraftSchema.safeParse({ ...validDraft, documents: [validDocument, { ...validDocument }] }).success).toBe(false);
  });

  test("relativePath rejects escape and non-markdown forms, accepts unicode posix paths", () => {
    for (const bad of ["a\\b.md", "../x.md", "a/./b.md", "a/../b.md", "a/.hidden/b.md", "a/b.txt", "/abs.md", "a//b.md", "a/b.md\0", ".md", "a/b.md/"]) {
      expect(validateRelativePath(bad)).toBe(false);
    }
    for (const good of ["a/b.md", "中文/第一章.md", "deep/nested/dir/name.md", "世界设定-卷一.md"]) {
      expect(validateRelativePath(good)).toBe(true);
    }
    expect(hostSnapshotDraftSchema.safeParse({ ...validDraft, documents: [{ ...validDocument, relativePath: "../escape.md" }] }).success).toBe(false);
  });

  test("sha256 fields are lowercase 64-hex and protocolVersion only accepts 1", () => {
    expect(hostSnapshotDraftSchema.safeParse({ ...validDraft, claimedSnapshotHash: "ABCDEF" }).success).toBe(false);
    expect(hostSnapshotDraftSchema.safeParse({ ...validDraft, claimedSnapshotHash: sha256("x").slice(1) }).success).toBe(false);
    expect(hostSnapshotDraftSchema.safeParse({ ...validDraft, protocolVersion: 2 }).success).toBe(false);
    expect(hostSnapshotDraftSchema.safeParse({ ...validDraft, protocolVersion: "1" }).success).toBe(false);
    expect(hostSnapshotDraftSchema.safeParse({ ...validDraft, pluginId: "inkos" }).success).toBe(false);
  });

  test("tool proxy requests carry protocolVersion and an arguments record only", () => {
    expect(toolProxyRequestSchema.safeParse({ protocolVersion: 1, arguments: { sourcePath: "x" } }).success).toBe(true);
    expect(toolProxyRequestSchema.safeParse({ protocolVersion: 1 }).success).toBe(false);
    expect(toolProxyRequestSchema.safeParse({ protocolVersion: 1, arguments: {}, workRef: "x" }).success).toBe(false);
  });

  test("state enums stay orthogonal", () => {
    expect(sessionStateSchema.safeParse("paired").success).toBe(true);
    expect(bridgeProcessStateSchema.safeParse("ready").success).toBe(true);
    expect(pluginStateSchema.safeParse("revoked").success).toBe(true);
    expect(projectBindingStateSchema.safeParse("degraded").success).toBe(true);
    expect(projectBindingStateSchema.safeParse("paired").success).toBe(false);
    expect(pluginStateSchema.safeParse("fresh").success).toBe(false);
  });

  test("auth matrix keeps pairing/OPTIONS/health bearer-free and business endpoints bearer-gated", () => {
    const options = AUTH_MATRIX.find((row) => row.method === "OPTIONS");
    const health = AUTH_MATRIX.find((row) => row.route === "/v1/health");
    const pair = AUTH_MATRIX.find((row) => row.route === "/v1/pair");
    const business = AUTH_MATRIX.find((row) => row.method === "*");
    expect(options?.bearer).toBe(false);
    expect(options?.pairingCode).toBe(false);
    expect(options?.pnaHeader).toBe(true);
    expect(health?.bearer).toBe(false);
    expect(health?.origin).toBe("if-present");
    expect(pair?.bearer).toBe(false);
    expect(pair?.pairingCode).toBe(true);
    expect(business?.bearer).toBe(true);
    expect(business?.pairingCode).toBe(false);
    expect(business?.route).toBe("/v1/*");
    expect(AUTH_MATRIX.filter((row) => !row.bearer).map((row) => `${row.method} ${row.route}`)).toEqual(["OPTIONS /v1/*", "GET /v1/health", "POST /v1/pair"]);
  });

  test("frozen constants match the canonical protocol fixture", () => {
    const protocol = fixture("protocol-v1.json");
    expect(protocol.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(protocol.errorCodes).toEqual([...BRIDGE_ERROR_CODES]);
    expect(protocol.limits).toEqual({ ...LIMITS });
    expect(protocol.timeouts).toEqual({ ...TIMEOUTS });
    expect(protocol.auth).toEqual({ ...AUTH });
    expect(protocol.bridge).toEqual({ host: "127.0.0.1", port: BRIDGE_DEFAULT_PORT });
  });

  test("computeProjectKey matches an independent sha256 vector", () => {
    const input = ["storyforge", "http://localhost:1111", "123"].join("\0");
    const expected = createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
    expect(computeProjectKey("storyforge", "http://localhost:1111", "123")).toBe(expected);
    expect(computeProjectKey("storyforge", "http://127.0.0.1:1111", "123")).not.toBe(expected);
    expect(computeProjectKey("storyforge", "http://localhost:1111", "123")).toMatch(/^[0-9a-f]{32}$/);
  });

  test("computeContentHash matches the published sha256 vector for 'hello'", () => {
    expect(computeContentHash("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(computeContentHash("# 故事核心")).toBe(sha256("# 故事核心"));
  });

  test("computeSnapshotHash is order-stable, version-scoped, and pinned by fixture vectors", () => {
    const a = { relativePath: "a.md", category: "project" as const, sha256: sha256("a") };
    const b = { relativePath: "中文/b.md", category: "chapter" as const, sha256: sha256("b") };
    expect(computeSnapshotHash(1, [a, b])).toBe(computeSnapshotHash(1, [b, a]));
    expect(computeSnapshotHash(1, [a, b])).not.toBe(computeSnapshotHash(2, [a, b]));
    expect(computeSnapshotHash(1, [a, b])).not.toBe(computeSnapshotHash(1, [a]));
    const vectors = fixture("hash-vectors.json") as { vectors: Array<{ name: string; protocolVersion: number; documents: Array<{ relativePath: string; category: "project" | "world" | "character" | "outline" | "chapter" | "foreshadow"; sha256: string }>; expected: string }> };
    for (const vector of vectors.vectors) {
      expect(computeSnapshotHash(vector.protocolVersion, vector.documents)).toBe(vector.expected);
    }
  });

  test("canonical snapshot draft fixture parses", () => {
    expect(hostSnapshotDraftSchema.safeParse(fixture("snapshot-draft-valid.json")).success).toBe(true);
  });
});
