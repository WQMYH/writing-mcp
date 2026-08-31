import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@writing-mcp/host-bridge-protocol";

export class InstanceLockError extends Error {
  readonly code = "BRIDGE_INSTANCE_LOCKED";
  constructor(readonly path: string) {
    super(`instance lock held at ${path}; another bridge instance owns this root`);
  }
}

export interface InstanceLock {
  readonly path: string;
  readonly content: { pid: number; startedAt: number; protocolVersion: number; nonce: string };
  release(): Promise<void>;
}

export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface InstanceLockOptions {
  root: string;
  now?: () => number;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  protocolVersion?: number;
}

/**
 * Exclusive single-instance lock over `<root>/.bridge/instance.lock`. A stale
 * lock is only cleaned up when its recorded pid is provably dead and the file
 * content is byte-identical across the re-read (guards a racing takeover).
 */
export async function acquireInstanceLock(options: InstanceLockOptions): Promise<InstanceLock> {
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  const dir = join(options.root, ".bridge");
  const path = join(dir, "instance.lock");
  await mkdir(dir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = JSON.stringify({ pid, startedAt: now(), protocolVersion, nonce: randomBytes(8).toString("hex") });
    try {
      await writeFile(path, raw, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(path, "utf8").catch(() => null);
      if (existing === null) continue;
      let holderPid: number | null = null;
      try {
        const parsed: unknown = JSON.parse(existing);
        if (parsed !== null && typeof parsed === "object" && typeof (parsed as { pid?: unknown }).pid === "number") holderPid = (parsed as { pid: number }).pid;
      } catch {
        holderPid = null;
      }
      if (holderPid === null || isAlive(holderPid)) throw new InstanceLockError(path);
      const reread = await readFile(path, "utf8").catch(() => null);
      if (reread !== existing) throw new InstanceLockError(path);
      await unlink(path);
      continue;
    }
    return {
      path,
      content: JSON.parse(raw),
      async release(): Promise<void> {
        const present = await readFile(path, "utf8").catch(() => null);
        if (present === raw) await unlink(path).catch(() => undefined);
      },
    };
  }
  throw new InstanceLockError(path);
}
