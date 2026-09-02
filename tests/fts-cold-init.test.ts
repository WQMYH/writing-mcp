import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

const waitFor = async (condition: () => Promise<boolean>): Promise<void> => {
  const deadline = performance.now() + 10_000;
  while (!await condition()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for cold-init workers");
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
};

describe("FTS cold initialization", () => {
  test("serializes concurrent schema bootstrap across processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-fts-cold-"));
    const readyDir = join(dir, "ready");
    const startPath = join(dir, "start");
    const indexPath = join(dir, "index.sqlite");
    const coreUrl = pathToFileURL(resolve("packages/core/dist/index.js")).href;
    await mkdir(readyDir);
    const script = `
      import { writeFile, stat } from "node:fs/promises";
      import { join } from "node:path";
      import { setTimeout as delay } from "node:timers/promises";
      import { WritingStore } from ${JSON.stringify(coreUrl)};
      const [root, indexPath, readyDir, startPath] = process.argv.slice(1);
      await writeFile(join(readyDir, String(process.pid)), "ready");
      for (;;) { try { await stat(startPath); break; } catch { await delay(5); } }
      const work = { workRef: "work:cold-init", title: "cold", rootPath: root, sourcePath: root, adapter: "generic", capabilities: ["documents", "full_text"], documents: [] };
      const store = new WritingStore(work, indexPath);
      try { await store.index("status"); } finally { store.close(); }
    `;
    const workers = Array.from({ length: 12 }, () => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, indexPath, readyDir, startPath], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      return new Promise<{ code: number | null; stderr: string }>((resolveChild, rejectChild) => {
        child.once("error", rejectChild);
        child.once("exit", code => resolveChild({ code, stderr }));
      });
    });
    try {
      await waitFor(async () => (await readdir(readyDir)).length === workers.length);
      await writeFile(startPath, "go");
      const exits = await Promise.all(workers);
      expect(exits).toEqual(Array.from({ length: workers.length }, () => ({ code: 0, stderr: "" })));
      const db = new DatabaseSync(indexPath, { readOnly: true });
      try {
        expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(4);
        expect((db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE name='spans_fts'").get() as { count: number }).count).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
