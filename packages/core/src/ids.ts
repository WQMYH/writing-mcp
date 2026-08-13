import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

export function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
  return `${prefix}:${digest}`;
}

export async function safeRealpath(path: string): Promise<string> { return normalize(await realpath(resolve(path))); }

export function assertWithin(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw Object.assign(new Error(`Path escapes authorized root: ${target}`), { code: "PATH_NOT_ALLOWED" });
}

export async function assertAuthorizedPath(target:string,authorizedRoots:string[]):Promise<string>{
  if(!authorizedRoots.length)throw Object.assign(new Error("No authorized writing roots configured"),{code:"AUTHORIZED_ROOTS_REQUIRED"});
  const realTarget=await safeRealpath(target);const roots=await Promise.all(authorizedRoots.map(safeRealpath));
  if(roots.some(root=>{try{assertWithin(root,realTarget);return true;}catch{return false;}}))return realTarget;
  throw Object.assign(new Error(`Path is outside authorized writing roots: ${target}`),{code:"PATH_NOT_ALLOWED"});
}
