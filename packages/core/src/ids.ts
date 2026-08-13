import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { normalize, relative, resolve, sep } from "node:path";

export function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
  return `${prefix}:${digest}`;
}

export async function safeRealpath(path: string): Promise<string> { return normalize(await realpath(resolve(path))); }

export function assertWithin(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !resolve(rel).startsWith(sep))) return;
  throw Object.assign(new Error(`Path escapes authorized root: ${target}`), { code: "PATH_NOT_ALLOWED" });
}
