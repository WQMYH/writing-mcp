import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const clientSetupPath = fileURLToPath(new URL("../docs/CLIENT_SETUP.md", import.meta.url));
const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));

function fencedBlock(document: string, language: "json" | "toml"): string {
  const match = document.match(new RegExp("```" + language + "\\r?\\n([\\s\\S]*?)\\r?\\n```"));
  if (!match) throw new Error(`missing ${language} fenced block`);
  return match[1];
}

describe("M5 client setup documentation", () => {
  test("documents parseable, non-personal Qoder and Codex stdio configuration", async () => {
    const [document, readme] = await Promise.all([readFile(clientSetupPath, "utf8"), readFile(readmePath, "utf8")]);
    const qoder = JSON.parse(fencedBlock(document, "json")) as {
      mcpServers: Record<string, { type: string; command: string; args: string[]; cwd: string; env: Record<string, string> }>;
    };
    const qoderServer = qoder.mcpServers["writing-mcp"];

    expect(qoderServer).toMatchObject({
      type: "stdio",
      command: "node",
      args: ["<repo-root>/packages/mcp-server/dist/index.js"],
      cwd: "<repo-root>",
      env: { WRITING_MCP_ROOTS: "<authorized-writing-root>" },
    });

    const toml = fencedBlock(document, "toml");
    expect(toml).toMatch(/^\[mcp_servers\.writing-mcp]$/m);
    expect(toml).toMatch(/^command = "node"$/m);
    expect(toml).toMatch(/^args = \["<repo-root>\/packages\/mcp-server\/dist\/index\.js"\]$/m);
    expect(toml).toMatch(/^cwd = "<repo-root>"$/m);
    expect(toml).toMatch(/^\[mcp_servers\.writing-mcp\.env]$/m);
    expect(toml).toMatch(/^WRITING_MCP_ROOTS = "<authorized-writing-root>"$/m);

    for (const configuration of [fencedBlock(document, "json"), toml, readme]) {
      expect(configuration).toContain("<authorized-writing-root>");
      expect(configuration).not.toContain("C:\\Users");
      expect(configuration).not.toContain("E:\\Programming");
      expect(configuration).not.toMatch(/(?:token|secret)\s*=\s*["'][^"']+|(?:token|secret)\s*:\s*["'][^"']+/i);
    }
  });

  test("documents the supported stdio setup, call order, failures, and privacy boundary", async () => {
    const document = await readFile(clientSetupPath, "utf8");

    expect(document).toContain("Node.js 24");
    expect(document).toContain("pnpm build");
    expect(document).toContain("stdio");
    expect(document).toContain("<authorized-writing-root>");
    expect(document).toContain("writing_resolve");
    expect(document).toContain("writing_index(status)");
    expect(document).toContain("writing_diagnose(inspect)");
    expect(document).toContain("Qoder");
    expect(document).toContain("Codex");

    for (const failure of ["命令无法识别", "dist 尚未构建", "授权根拒绝", "INDEX_BUSY", "workRef 失效", "stdout 污染", "诊断报告位置与隐私"]) {
      expect(document).toContain(failure);
    }
    expect(document).toContain("不保存正文");
    expect(document).toContain("绝对路径");
    expect(document).toContain("v1");
  });
});
