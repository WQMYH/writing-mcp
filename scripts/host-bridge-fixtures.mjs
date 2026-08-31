// Generates the canonical host-bridge protocol fixtures consumed by both repos
// (writing-mcp validates them against @writing-mcp/host-bridge-protocol and
// @writing-mcp/host-plugin-storyforge; Storyforge mirrors the validation via its
// own protocol-contract test without a second hand-written expectation set).
//
// This script MUST stay implementation-independent: it derives every expected
// value from the frozen rules in docs/host-bridge/PROTOCOL.md using plain
// node:crypto, so a drift in the package implementations is caught by the tests
// instead of being baked into the fixtures.
//
// Usage: node scripts/host-bridge-fixtures.mjs  (idempotent, deterministic)

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "host-bridge-protocol");
mkdirSync(outDir, { recursive: true });

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

writeFileSync(join(outDir, "protocol-v1.json"), JSON.stringify({
  protocolVersion: 1,
  limits: { maxDocumentBytes: 16 * 1024 * 1024, maxTotalDocumentBytes: 64 * 1024 * 1024, maxDocuments: 4096, maxRawBodyBytes: 72 * 1024 * 1024 },
  timeouts: { toolMs: 15000, snapshotMs: 120000 },
  auth: { pairingCodeTtlMs: 600000, pairingCodeMinEntropyBits: 128, tokenTtlMs: 3600000 },
  bridge: { host: "127.0.0.1", port: 48931 },
  errorCodes: [
    "BRIDGE_PAIRING_CODE_INVALID", "BRIDGE_PAIRING_CODE_EXPIRED", "BRIDGE_TOKEN_EXPIRED",
    "BRIDGE_HOST_DENIED", "BRIDGE_ORIGIN_DENIED", "BRIDGE_REQUEST_TOO_LARGE",
    "BRIDGE_PROJECT_ID_INVALID", "BRIDGE_TOOL_REQUEST_INVALID", "BRIDGE_SNAPSHOT_INVALID", "BRIDGE_SNAPSHOT_ACTIVATION_FAILED",
    "BRIDGE_BINDING_DEGRADED", "BRIDGE_MCP_UNAVAILABLE", "BRIDGE_PLUGIN_DISABLED", "DERIVED_DATA_BUSY",
  ],
  authMatrix: [
    { method: "OPTIONS", route: "/v1/*", origin: "required", bearer: false, pairingCode: false, pnaHeader: true },
    { method: "GET", route: "/v1/health", origin: "if-present", bearer: false, pairingCode: false, pnaHeader: false },
    { method: "POST", route: "/v1/pair", origin: "required", bearer: false, pairingCode: true, pnaHeader: false },
    { method: "*", route: "/v1/*", origin: "required", bearer: true, pairingCode: false, pnaHeader: false },
  ],
}, null, 2) + "\n");

// canonicalSnapshotDocuments + computeSnapshotHash per PROTOCOL.md §8: sort by
// relativePath (UTF-16 code-unit order), then sha256 over the JSON of
// { protocolVersion, documents: [{ relativePath, category, sha256 }] }.
const canonical = (documents) => [...documents]
  .sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0))
  .map((document) => ({ relativePath: document.relativePath, category: document.category, sha256: document.sha256 }));
const snapshotHash = (protocolVersion, documents) => sha256(JSON.stringify({ protocolVersion, documents: canonical(documents) }));

const contentOf = {
  storyCore: "# 故事核心\n\n修真世界，凡人逆流而上。",
  linChe: "# 林澈\n\n主角，青溪镇出身，性格坚韧。",
  world: "# 世界设定\n\n九洲大地，灵气分五行。",
  outline: "# 第一卷大纲\n\n林澈离乡，初入宗门。",
  foreshadow: "# 伏笔-001\n\n镇口古井在第三章泛起蓝光。",
  chapter1: "# 第一章 离乡\n\n林澈背起行囊，回头看了一眼晨雾中的青溪镇。",
};

const documents = [
  { relativePath: "chapters/第一章.md", category: "chapter", sha256: sha256(contentOf.chapter1), content: contentOf.chapter1 },
  { relativePath: "project/story-core.md", category: "project", sha256: sha256(contentOf.storyCore), content: contentOf.storyCore },
  { relativePath: "characters/林澈.md", category: "character", sha256: sha256(contentOf.linChe), content: contentOf.linChe },
  { relativePath: "world/世界设定.md", category: "world", sha256: sha256(contentOf.world), content: contentOf.world },
  { relativePath: "outline/第一卷大纲.md", category: "outline", sha256: sha256(contentOf.outline), content: contentOf.outline },
  { relativePath: "foreshadows/伏笔-001.md", category: "foreshadow", sha256: sha256(contentOf.foreshadow), content: contentOf.foreshadow },
];

const draft = {
  protocolVersion: 1,
  pluginId: "storyforge",
  hostProjectId: "123",
  hostRevision: "rev-0001",
  documents: documents.map(({ relativePath, category, sha256: hash, content }) => ({ relativePath, category, mediaType: "text/markdown", content, sha256: hash })),
  chapters: [
    { chapterKey: "n:1", ordinal: 1 },
    { chapterKey: "n:2", ordinal: 2 },
    { chapterKey: "s:legacy-003", ordinal: 3 },
  ],
  claimedSnapshotHash: snapshotHash(1, documents),
};

writeFileSync(join(outDir, "snapshot-draft-valid.json"), JSON.stringify(draft, null, 2) + "\n");

const hashDocuments = (relativePaths) => relativePaths.map((entry) => ({ relativePath: entry.path, category: entry.category, sha256: sha256(`content:${entry.path}`) }));
writeFileSync(join(outDir, "hash-vectors.json"), JSON.stringify({
  canonicalRule: "sha256(JSON.stringify({ protocolVersion, documents: [{ relativePath, category, sha256 }] sorted by relativePath }))",
  contentHashVectors: [
    { name: "hello", content: "hello", expected: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" },
    { name: "empty", content: "", expected: sha256("") },
    { name: "unicode", content: "第一章", expected: sha256("第一章") },
  ],
  vectors: [
    { name: "empty-documents", protocolVersion: 1, documents: [], expected: snapshotHash(1, []) },
    {
      name: "unsorted-unicode-paths",
      protocolVersion: 1,
      documents: hashDocuments([
        { path: "chapters/第一章.md", category: "chapter" },
        { path: "a.md", category: "project" },
        { path: "世界/设定.md", category: "world" },
      ]),
      expected: snapshotHash(1, hashDocuments([
        { path: "chapters/第一章.md", category: "chapter" },
        { path: "a.md", category: "project" },
        { path: "世界/设定.md", category: "world" },
      ])),
    },
    {
      name: "single-document",
      protocolVersion: 1,
      documents: hashDocuments([{ path: "project/story-core.md", category: "project" }]),
      expected: snapshotHash(1, hashDocuments([{ path: "project/story-core.md", category: "project" }])),
    },
  ],
}, null, 2) + "\n");

writeFileSync(join(outDir, "manifest-storyforge.json"), JSON.stringify({
  id: "storyforge",
  apiVersion: 1,
  hostCompatibility: { bridgeProtocol: "^1" },
  minimumPermissions: ["export:snapshot", "invoke:tools", "delete:derived"],
  exportCategories: ["project", "world", "character", "outline", "chapter", "foreshadow"],
  license: "AGPL-3.0-only",
  testMatrix: { node: ["24"], browsers: ["chromium"], platforms: ["win32", "darwin", "linux"] },
}, null, 2) + "\n");

console.log(`fixtures written to ${outDir}`);
