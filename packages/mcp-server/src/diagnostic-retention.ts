import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_SCAN_WRITES = 64;
const DEFAULT_SCAN_BYTES = 1024 * 1024;
const LOCK_NAME = ".cleanup.lock";

export interface DiagnosticRetentionOptions {
  readonly maxDirectoryBytes?: number;
  readonly scanEveryWrites?: number;
  readonly scanEveryAddedBytes?: number;
  readonly pid?: number;
  readonly now?: () => number;
  readonly isProcessAlive?: (pid: number) => boolean;
  /** @internal Deterministic filesystem-race seam for evaluator tests. */
  readonly beforeScanStat?: (path: string) => void | Promise<void>;
  /** @internal Deterministic filesystem-race seam for evaluator tests. */
  readonly beforeDelete?: (path: string) => void | Promise<void>;
  /** @internal Deterministic lock-replacement seam for evaluator tests. */
  readonly beforeReclaimRename?: (path: string) => void | Promise<void>;
}

export interface RetentionDelta { readonly writes?: number; readonly addedBytes?: number; readonly protectedPaths?: readonly string[] }
export interface RetentionOutcome { readonly cleanup: "not_needed" | "converged" | "deferred" | "limited"; readonly bytes: number }
export interface RetentionStats { readonly scans: number; readonly estimatedBytes: number; readonly cleanupDeferred: boolean }

interface DirectoryState {
  exactBytes?: number;
  addedBytes: number;
  writes: number;
  scans: number;
  cleanupDeferred: boolean;
}

interface StoredFile { readonly path: string; readonly relativePath: string; readonly size: number; readonly mtimeMs: number }
interface DirectorySnapshot { readonly bytes: number; readonly files: readonly StoredFile[] }

export class DiagnosticRetention {
  private readonly states = new Map<string, DirectoryState>();
  private readonly maxBytes: number;
  private readonly scanWrites: number;
  private readonly scanBytes: number;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly beforeScanStat?: (path: string) => void | Promise<void>;
  private readonly beforeDelete?: (path: string) => void | Promise<void>;
  private readonly beforeReclaimRename?: (path: string) => void | Promise<void>;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options?: DiagnosticRetentionOptions) {
    this.maxBytes = options?.maxDirectoryBytes ?? DEFAULT_MAX_BYTES;
    this.scanWrites = options?.scanEveryWrites ?? DEFAULT_SCAN_WRITES;
    this.scanBytes = options?.scanEveryAddedBytes ?? DEFAULT_SCAN_BYTES;
    this.pid = options?.pid ?? process.pid;
    this.now = options?.now ?? Date.now;
    this.isAlive = options?.isProcessAlive ?? processAlive;
    this.beforeScanStat = options?.beforeScanStat;
    this.beforeDelete = options?.beforeDelete;
    this.beforeReclaimRename = options?.beforeReclaimRename;
  }

  async maintain(directory: string, delta: RetentionDelta = {}): Promise<RetentionOutcome> {
    return this.serial(directory, () => this.maintainDirectory(directory, delta));
  }

  private async maintainDirectory(directory: string, delta: RetentionDelta): Promise<RetentionOutcome> {
    await mkdir(directory, { recursive: true });
    const state = this.state(directory);
    state.writes += delta.writes ?? 0;
    state.addedBytes += Math.max(0, delta.addedBytes ?? 0);
    const estimate = (state.exactBytes ?? 0) + state.addedBytes;
    const scan = state.exactBytes === undefined || state.writes >= this.scanWrites || state.addedBytes >= this.scanBytes || estimate > this.maxBytes;
    if (!scan) return { cleanup: "not_needed", bytes: estimate };

    let snapshot = await scanDirectory(directory, this.beforeScanStat); state.scans++;
    state.exactBytes = snapshot.bytes; state.addedBytes = 0; state.writes = 0;
    if (snapshot.bytes <= this.maxBytes) return { cleanup: "not_needed", bytes: snapshot.bytes };

    const lock = await this.acquire(directory);
    if (!lock) {
      state.cleanupDeferred = true;
      return { cleanup: "deferred", bytes: snapshot.bytes };
    }
    try {
      // Reconcile under the cooperative lock so a cleaner acts on the latest
      // multi-process state rather than on its pre-lock estimate.
      snapshot = await scanDirectory(directory, this.beforeScanStat); state.scans++;
      let remaining = snapshot.bytes;
      const protectedPaths = new Set((delta.protectedPaths ?? []).map(normalizePath));
      const reports = snapshot.files.filter(file => /^reports\/[^/]+\.json$/i.test(file.relativePath) && !protectedPaths.has(normalizePath(file.relativePath))).sort(compareFiles);
      for (const file of reports) {
        if (remaining <= this.maxBytes) break;
        await this.deleteFile(file.path); remaining -= file.size;
      }
      if (remaining > this.maxBytes) {
        const groups = await closedCaptureGroups(directory, snapshot.files);
        for (const group of groups) {
          if (remaining <= this.maxBytes) break;
          if (group.files.some(file => protectedPaths.has(normalizePath(file.relativePath)))) continue;
          for (const file of group.files) await this.deleteFile(file.path);
          remaining -= group.files.reduce((sum, file) => sum + file.size, 0);
        }
      }
      state.exactBytes = Math.max(0, remaining); state.cleanupDeferred = false;
      return { cleanup: remaining <= this.maxBytes ? "converged" : "limited", bytes: remaining };
    } finally { await this.release(directory, lock); }
  }

  stats(directory: string): RetentionStats {
    const state = this.state(directory);
    return { scans: state.scans, estimatedBytes: (state.exactBytes ?? 0) + state.addedBytes, cleanupDeferred: state.cleanupDeferred };
  }

  takeNotice(directory: string): "DIAGNOSTIC_CLEANUP_DEFERRED" | undefined {
    const state = this.state(directory);
    if (!state.cleanupDeferred) return undefined;
    state.cleanupDeferred = false;
    return "DIAGNOSTIC_CLEANUP_DEFERRED";
  }

  private state(directory: string): DirectoryState {
    let state = this.states.get(directory);
    if (!state) { state = { addedBytes: 0, writes: 0, scans: 0, cleanupDeferred: false }; this.states.set(directory, state); }
    return state;
  }

  private async acquire(directory: string): Promise<string | undefined> {
    const path = join(directory, LOCK_NAME), token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(path, JSON.stringify({ pid: this.pid, token, createdAt: new Date(this.now()).toISOString() }), { encoding: "utf8", flag: "wx" });
        return token;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        let raw: string;
        try { raw = await readFile(path, "utf8"); }
        catch (readError) { if (isCode(readError, "ENOENT")) continue; return undefined; }
        if (isLiveOwner(parseOwner(raw), this.isAlive)) return undefined;
        await this.beforeReclaimRename?.(path);
        const stalePath = `${path}.stale.${token}.tmp`;
        try {
          await rename(path, stalePath);
          const movedRaw = await readFile(stalePath, "utf8");
          if (isLiveOwner(parseOwner(movedRaw), this.isAlive)) {
            try { await writeFile(path, movedRaw, { encoding: "utf8", flag: "wx" }); }
            catch (restoreError) { if (!isCode(restoreError, "EEXIST")) throw restoreError; }
            await rm(stalePath, { force: true });
            return undefined;
          }
          await rm(stalePath, { force: true });
        }
        catch (renameError) { if (!isCode(renameError, "ENOENT")) return undefined; }
      }
    }
    return undefined;
  }

  private async release(directory: string, token: string): Promise<void> {
    const path = join(directory, LOCK_NAME);
    try {
      const owner = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
      if (owner.token === token) await rm(path, { force: true });
    } catch (error) { if (!isCode(error, "ENOENT")) throw error; }
  }

  private async deleteFile(path: string): Promise<void> {
    await this.beforeDelete?.(path);
    try { await rm(path, { force: true }); }
    catch (error) { if (!isCode(error, "ENOENT")) throw error; }
  }

  private async serial<T>(directory: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(directory) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    const marker = current.then(() => undefined, () => undefined);
    this.queues.set(directory, marker);
    try { return await current; } finally { if (this.queues.get(directory) === marker) this.queues.delete(directory); }
  }
}

async function scanDirectory(directory: string, beforeScanStat?: (path: string) => void | Promise<void>): Promise<DirectorySnapshot> {
  const files: StoredFile[] = [];
  const visit = async (path: string): Promise<void> => {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (isCode(error, "ENOENT")) return; throw error; }
    for (const entry of entries) {
      const absolute = join(path, entry.name);
      if (entry.isDirectory()) { await visit(absolute); continue; }
      const relativePath = relative(directory, absolute).replaceAll("\\", "/");
      if (relativePath === LOCK_NAME || /\.cleanup\.lock\.stale\..+\.tmp$/i.test(relativePath) || /\.[^.]+\.tmp$/i.test(relativePath)) continue;
      try {
        await beforeScanStat?.(absolute);
        const info = await stat(absolute);
        files.push({ path: absolute, relativePath, size: info.size, mtimeMs: info.mtimeMs });
      } catch (error) { if (!isCode(error, "ENOENT")) throw error; }
    }
  };
  await visit(directory);
  return { bytes: files.reduce((sum, file) => sum + file.size, 0), files };
}

async function closedCaptureGroups(directory: string, files: readonly StoredFile[]): Promise<Array<{ key: StoredFile; files: StoredFile[] }>> {
  const groups = new Map<string, StoredFile[]>();
  for (const file of files) {
    const match = /^runs\/(diag-[^.]+)\.(?:meta\.json|events\.jsonl|json|md)$/i.exec(file.relativePath);
    if (match) { const group = groups.get(match[1]!) ?? []; group.push(file); groups.set(match[1]!, group); }
  }
  const closed: Array<{ key: StoredFile; files: StoredFile[] }> = [];
  for (const [ref, group] of groups) {
    const meta = group.find(file => file.relativePath === `runs/${ref}.meta.json`);
    if (!meta) continue;
    try {
      const parsed = JSON.parse(await readFile(join(directory, meta.relativePath), "utf8")) as { status?: unknown };
      if (parsed.status !== "closed") continue;
    } catch { continue; }
    const ordered = [...group].sort(compareFiles);
    closed.push({ key: ordered[0]!, files: ordered });
  }
  return closed.sort((left, right) => compareFiles(left.key, right.key));
}

function normalizePath(path: string): string { return path.replaceAll("\\", "/").normalize("NFC"); }
function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left), rightPoints = Array.from(right);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index++) {
    const difference = leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
function compareFiles(left: StoredFile, right: StoredFile): number {
  return left.mtimeMs - right.mtimeMs || compareCodePoints(normalizePath(left.relativePath), normalizePath(right.relativePath)) || compareCodePoints(left.relativePath, right.relativePath);
}
function parseOwner(raw: string): { pid?: unknown; token?: unknown } | undefined { try { return JSON.parse(raw) as { pid?: unknown; token?: unknown }; } catch { return undefined; } }
function isLiveOwner(owner: { pid?: unknown } | undefined, isAlive: (pid: number) => boolean): boolean { return typeof owner?.pid === "number" && isAlive(owner.pid); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return !isCode(error, "ESRCH"); } }
