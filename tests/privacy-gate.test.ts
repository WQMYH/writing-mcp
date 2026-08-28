import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/privacy-gate.mjs", import.meta.url));
const SENTINEL = "SENTINEL-PRIVATE-CORPUS-TOKEN";
const markerEnv = { ...process.env, WRITING_MCP_PRIVACY_MARKERS: JSON.stringify([{ name: "sentinel", text: SENTINEL }]) };

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=gate-test", "-c", "user.email=gate@example.invalid", ...args], { cwd, encoding: "utf8" });
  expect(r.status, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
};
const gate = (cwd: string, scope: "history" | "worktree") => spawnSync(process.execPath, [SCRIPT, `--scope=${scope}`], { cwd, encoding: "utf8", env: markerEnv });
const commitAll = (root: string, message: string) => { git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", message); };
const initRepo = async () => {
  const root = await mkdtemp(join(tmpdir(), "writing-mcp-privacy-gate-"));
  git(root, "init", "--quiet");
  return root;
};

describe("privacy publication gate", () => {
  test("flags a tracked file containing a marker without echoing the matched text", async () => {
    const root = await initRepo();
    try {
      await writeFile(join(root, "notes.md"), `context ${SENTINEL} context\n`);
      commitAll(root, "add notes");
      const result = gate(root, "worktree");
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("sentinel");
      expect(result.stdout).toContain("notes.md");
      expect(result.stdout + result.stderr).not.toContain(SENTINEL);
      expect(gate(root, "history").status).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("history scope flags a marker already removed from the working tree", async () => {
    const root = await initRepo();
    try {
      await writeFile(join(root, "legacy.txt"), `private ${SENTINEL}\n`);
      commitAll(root, "commit with private reference");
      await writeFile(join(root, "legacy.txt"), "scrubbed\n");
      commitAll(root, "scrub local layout");
      expect(gate(root, "worktree").status).toBe(0);
      const history = gate(root, "history");
      expect(history.status).toBe(1);
      expect(history.stdout).toContain("legacy.txt@");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("flags a marker that only survives in a commit message", async () => {
    const root = await initRepo();
    try {
      await writeFile(join(root, "code.txt"), "harmless\n");
      commitAll(root, `feat: evaluated on ${SENTINEL}`);
      expect(gate(root, "worktree").status).toBe(0);
      const history = gate(root, "history");
      expect(history.status).toBe(1);
      expect(history.stdout).toContain("message@");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("passes when the leak survives only in a remote-tracking ref (stale server cache)", async () => {
    const root = await initRepo();
    try {
      await writeFile(join(root, "clean.txt"), "public\n");
      commitAll(root, "clean commit");
      const cleanSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
      // leaked commit exists solely under refs/remotes/*, unreachable from any local ref
      await writeFile(join(root, "leak.txt"), `private ${SENTINEL}\n`);
      git(root, "add", "leak.txt");
      git(root, "commit", "--quiet", "-m", "leaked");
      const leakSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
      git(root, "update-ref", "refs/remotes/origin/leaky", leakSha);
      // move every local branch back to the clean commit (init default branch name varies)
      const heads = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads"], { cwd: root, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
      for (const head of heads) git(root, "update-ref", head, cleanSha);
      expect(gate(root, "history").status).toBe(0);
      // but the same leak on a local branch must fail: force-push/purge pending means FAIL
      git(root, "update-ref", "refs/heads/leaky", leakSha);
      const blocked = gate(root, "history");
      expect(blocked.status).toBe(1);
      expect(blocked.stdout).toContain("leak.txt@");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("passes a repository without any marker", async () => {
    const root = await initRepo();
    try {
      await writeFile(join(root, "readme.md"), "public fixture only\n");
      commitAll(root, "clean commit");
      expect(gate(root, "worktree").status).toBe(0);
      expect(gate(root, "history").status).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
