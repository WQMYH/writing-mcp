import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { DiagnosticRetention } from "../packages/mcp-server/src/diagnostic-retention.js";

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

async function fixtureFile(path: string, content: string, mtimeMs: number): Promise<void> {
  await writeFile(path, content, "utf8");
  const time = new Date(mtimeMs);
  await utimes(path, time, time);
}

describe("diagnostic retention", () => {
  test("amortizes scans until either the write cadence or added-byte threshold is reached", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-retention-cadence-"));
    try {
      const byWrites = new DiagnosticRetention({ maxDirectoryBytes: 10_000, scanEveryWrites: 3, scanEveryAddedBytes: 10_000 });
      await byWrites.maintain(root);
      expect(byWrites.stats(root).scans).toBe(1);
      await byWrites.maintain(root, { writes: 1, addedBytes: 1 });
      await byWrites.maintain(root, { writes: 1, addedBytes: 1 });
      expect(byWrites.stats(root).scans).toBe(1);
      await byWrites.maintain(root, { writes: 1, addedBytes: 1 });
      expect(byWrites.stats(root).scans).toBe(2);

      const byBytes = new DiagnosticRetention({ maxDirectoryBytes: 10_000, scanEveryWrites: 100, scanEveryAddedBytes: 8 });
      await byBytes.maintain(root);
      await byBytes.maintain(root, { writes: 1, addedBytes: 7 });
      expect(byBytes.stats(root).scans).toBe(1);
      await byBytes.maintain(root, { writes: 1, addedBytes: 1 });
      expect(byBytes.stats(root).scans).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("coalesces simultaneous first-use maintenance for one directory into one scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-retention-coalesce-"));
    try {
      const retention = new DiagnosticRetention({ maxDirectoryBytes: 10_000 });
      await Promise.all(Array.from({ length: 12 }, () => retention.maintain(root)));
      expect(retention.stats(root).scans).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("uses the production 64-write and 1 MiB scan defaults exactly", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-retention-defaults-"));
    try {
      const byWrites = new DiagnosticRetention();
      await byWrites.maintain(root);
      for (let index = 0; index < 63; index++) await byWrites.maintain(root, { writes: 1, addedBytes: 1 });
      expect(byWrites.stats(root).scans).toBe(1);
      await byWrites.maintain(root, { writes: 1, addedBytes: 1 });
      expect(byWrites.stats(root).scans).toBe(2);

      const byBytes = new DiagnosticRetention();
      await byBytes.maintain(root);
      await byBytes.maintain(root, { writes: 1, addedBytes: 1024 * 1024 - 1 });
      expect(byBytes.stats(root).scans).toBe(1);
      await byBytes.maintain(root, { writes: 1, addedBytes: 1 });
      expect(byBytes.stats(root).scans).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("deletes reports before older closed captures and orders equal mtimes by normalized filename", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-retention-order-"));
    const reports = join(root, "reports"), runs = join(root, "runs");
    await mkdir(reports, { recursive: true }); await mkdir(runs, { recursive: true });
    const old = Date.UTC(2026, 0, 1), newer = Date.UTC(2026, 0, 2);
    await fixtureFile(join(reports, "a.json"), "a".repeat(80), newer);
    await fixtureFile(join(reports, "b.json"), "b".repeat(80), newer);
    const meta = JSON.stringify({ status: "closed", diagnosticRunRef: "diag-closed" });
    await fixtureFile(join(runs, "diag-closed.meta.json"), meta, old);
    await fixtureFile(join(runs, "diag-closed.events.jsonl"), "e".repeat(80), old);
    const total = 160 + bytes(meta) + 80;
    try {
      const retention = new DiagnosticRetention({ maxDirectoryBytes: total - 80, scanEveryWrites: 64, scanEveryAddedBytes: 1_000_000 });
      await retention.maintain(root);
      expect(await exists(join(reports, "a.json"))).toBe(false);
      expect(await exists(join(reports, "b.json"))).toBe(true);
      expect(await exists(join(runs, "diag-closed.meta.json"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("orders equal mtimes by normalized Unicode code points, independent of host locale", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-retention-code-point-order-"));
    const reports = join(root, "reports");
    await mkdir(reports, { recursive: true });
    const sameTime = Date.UTC(2026, 0, 1);
    const bmpName = "\uE000.json";
    const astralName = "\u{10000}.json";
    await fixtureFile(join(reports, bmpName), "a".repeat(80), sameTime);
    await fixtureFile(join(reports, astralName), "b".repeat(80), sameTime);
    try {
      const retention = new DiagnosticRetention({ maxDirectoryBytes: 80 });
      await retention.maintain(root);
      expect(await exists(join(reports, bmpName))).toBe(false);
      expect(await exists(join(reports, astralName))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("removes closed capture groups as a unit but never removes an active capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-retention-captures-"));
    const runs = join(root, "runs"); await mkdir(runs, { recursive: true });
    const activeMeta = JSON.stringify({ status: "active", diagnosticRunRef: "diag-active" });
    const closedMeta = JSON.stringify({ status: "closed", diagnosticRunRef: "diag-closed" });
    for (const [ref, meta] of [["diag-active", activeMeta], ["diag-closed", closedMeta]] as const) {
      await fixtureFile(join(runs, `${ref}.meta.json`), meta, Date.UTC(2026, 0, ref === "diag-active" ? 1 : 2));
      await fixtureFile(join(runs, `${ref}.events.jsonl`), ref.repeat(20), Date.UTC(2026, 0, ref === "diag-active" ? 1 : 2));
    }
    const activeBytes = bytes(activeMeta) + bytes("diag-active".repeat(20));
    try {
      const retention = new DiagnosticRetention({ maxDirectoryBytes: activeBytes, scanEveryWrites: 64, scanEveryAddedBytes: 1_000_000 });
      await retention.maintain(root);
      expect(await exists(join(runs, "diag-active.meta.json"))).toBe(true);
      expect(await exists(join(runs, "diag-active.events.jsonl"))).toBe(true);
      expect(await exists(join(runs, "diag-closed.meta.json"))).toBe(false);
      expect(await exists(join(runs, "diag-closed.events.jsonl"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("defers cleanup behind a live owner and converges after that lock is released", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-retention-lock-"));
    const reports = join(root, "reports"); await mkdir(reports, { recursive: true });
    await writeFile(join(reports, "old.json"), "x".repeat(100));
    await writeFile(join(root, ".cleanup.lock"), JSON.stringify({ pid: process.pid, token: "other-live-owner", createdAt: "2026-01-01T00:00:00.000Z" }));
    try {
      const retention = new DiagnosticRetention({ maxDirectoryBytes: 10, scanEveryWrites: 64, scanEveryAddedBytes: 1_000_000 });
      expect((await retention.maintain(root)).cleanup).toBe("deferred");
      expect(await exists(join(reports, "old.json"))).toBe(true);
      expect(retention.takeNotice(root)).toBe("DIAGNOSTIC_CLEANUP_DEFERRED");
      await rm(join(root, ".cleanup.lock"));
      expect((await retention.maintain(root)).cleanup).toBe("converged");
      expect(await exists(join(reports, "old.json"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("reclaims a cleanup lock whose owner process is dead", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-retention-stale-lock-"));
    const reports = join(root, "reports"); await mkdir(reports, { recursive: true });
    await writeFile(join(reports, "old.json"), "x".repeat(100));
    await writeFile(join(root, ".cleanup.lock"), JSON.stringify({ pid: 424242, token: "dead-owner", createdAt: "2026-01-01T00:00:00.000Z" }));
    try {
      const retention = new DiagnosticRetention({ maxDirectoryBytes: 10, isProcessAlive: pid => pid !== 424242 });
      expect((await retention.maintain(root)).cleanup).toBe("converged");
      expect(await exists(join(reports, "old.json"))).toBe(false);
      expect(await readFile(join(root, ".cleanup.lock"), "utf8")).not.toContain("dead-owner");
    } catch (error) {
      if (!(typeof error === "object" && error && "code" in error && error.code === "ENOENT")) throw error;
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("reclaims a malformed stale lock and tolerates files that vanish during scan or deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-retention-enoent-"));
    const reports = join(root, "reports"); await mkdir(reports, { recursive: true });
    const scannedAway = join(reports, "scanned-away.json");
    const deletedAway = join(reports, "deleted-away.json");
    await writeFile(scannedAway, "x".repeat(100));
    await writeFile(deletedAway, "x".repeat(100));
    await writeFile(join(root, ".cleanup.lock"), "{truncated");
    try {
      const retention = new DiagnosticRetention({
        maxDirectoryBytes: 10,
        beforeScanStat: async path => { if (path === scannedAway) await rm(path); },
        beforeDelete: async path => { if (path === deletedAway) await rm(path); },
      });
      expect((await retention.maintain(root)).cleanup).toBe("converged");
      expect(await exists(scannedAway)).toBe(false);
      expect(await exists(deletedAway)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("does not steal a replacement live lock while reclaiming a malformed stale lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-mcp-retention-replacement-lock-"));
    const reports = join(root, "reports"); await mkdir(reports, { recursive: true });
    await writeFile(join(reports, "old.json"), "x".repeat(100));
    const lockPath = join(root, ".cleanup.lock");
    await writeFile(lockPath, "{truncated");
    try {
      const retention = new DiagnosticRetention({
        maxDirectoryBytes: 10,
        beforeReclaimRename: async () => {
          await rm(lockPath);
          await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "replacement-live", createdAt: "2026-01-01T00:00:00.000Z" }));
        },
      });
      expect((await retention.maintain(root)).cleanup).toBe("deferred");
      expect(await exists(join(reports, "old.json"))).toBe(true);
      expect(await readFile(lockPath, "utf8")).toContain("replacement-live");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
