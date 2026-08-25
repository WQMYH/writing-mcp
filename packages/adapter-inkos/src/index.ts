import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import {
  assertWithin,
  safeRealpath,
  stableId,
  type DocumentKind,
  type ParsedWork,
  type SourceSnapshot,
  type SourceSnapshotEntry,
  type SourceDocument,
  type WorkAdapter,
  type WorkCandidate,
} from "@writing-mcp/core";

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function markdownFiles(dir: string, root?: string, visited = new Set<string>()): Promise<string[]> {
  if (!await exists(dir)) return [];
  const real = await safeRealpath(dir);
  const safeRoot = root ?? real;
  assertWithin(safeRoot, real);
  if (visited.has(real)) return [];
  visited.add(real);
  const out: string[] = [];
  for (const entry of await readdir(real, { withFileTypes: true })) {
    const path = await safeRealpath(join(real, entry.name));
    assertWithin(safeRoot, path);
    if (entry.isDirectory()) out.push(...await markdownFiles(path, safeRoot, visited));
    else if (/\.md$/i.test(entry.name)) out.push(path);
  }
  return out.sort();
}

const chapterNumber = (name: string): number | undefined => Number(name.match(/(\d+)/)?.[1]) || undefined;

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
const normalizedRelative=(root:string,path:string)=>relative(root,path).replaceAll("\\", "/");
const fingerprint=(entries:readonly SourceSnapshotEntry[])=>createHash("sha256").update(JSON.stringify(entries.map(entry=>[entry.relativePath,entry.absolutePath,entry.size,entry.mtimeNs]))).digest("hex");
const snapshotMismatch=(message:string)=>Object.assign(new Error(message),{code:"SOURCE_SNAPSHOT_CHANGED"});
const fixedKinds=new Map<string,DocumentKind>([
  ["story/outline/story_frame.md","outline"],["story/story_bible.md","outline"],["story/outline/volume_map.md","outline"],["story/volume_outline.md","outline"],
  ["story/current_state.md","state"],["story/pending_hooks.md","foreshadow"],["story/book_rules.md","document"],["story/character_matrix.md","character"],
]);

function roleResource(relativePath: string): { key: string; canonical: boolean } | null {
  const match = /^story\/roles\/(主要角色|次要角色|major|minor)\/([^/]+\.md)$/iu.exec(relativePath);
  if (!match) return null;
  const directory = match[1]!;
  const tier = directory === "主要角色" || directory.toLowerCase() === "major" ? "major" : "minor";
  const name = match[2]!.normalize("NFC").toLocaleLowerCase("en-US");
  return { key: `role:${tier}:${name}`, canonical: directory === "主要角色" || directory === "次要角色" };
}

async function deduplicateRolePaths(root: string, paths: readonly string[]): Promise<string[]> {
  const plain: string[] = [];
  const groups = new Map<string, Array<{ path: string; canonical: boolean }>>();
  for (const path of paths) {
    const rel = relative(root, path).replaceAll("\\", "/");
    const role = roleResource(rel);
    if (!role) {
      plain.push(path);
      continue;
    }
    const group = groups.get(role.key) ?? [];
    group.push({ path, canonical: role.canonical });
    groups.set(role.key, group);
  }
  for (const [key, aliases] of groups) {
    if (aliases.length === 1) {
      plain.push(aliases[0]!.path);
      continue;
    }
    const contents = await Promise.all(aliases.map((entry) => readFile(entry.path, "utf8")));
    if (!contents.every((content) => content === contents[0])) {
      throw codedError("INKOS_ROLE_ALIAS_CONFLICT", `Conflicting InkOS role aliases exist for ${key}.`);
    }
    plain.push((aliases.find((entry) => entry.canonical) ?? aliases[0]!).path);
  }
  return plain.sort();
}

async function candidateForBook(projectRoot: string, bookRoot: string): Promise<WorkCandidate | null> {
  const config = join(bookRoot, "book.json");
  if (!await exists(config)) return null;
  const id = basename(bookRoot);
  let title = id;
  try { title = JSON.parse(await readFile(config, "utf8")).title ?? id; } catch {}
  return {
    workRef: stableId("work", "inkos", projectRoot, id),
    title,
    rootPath: bookRoot,
    adapter: "inkos",
    capabilities: ["chapters", "characters", "outline", "state", "foreshadow"],
  };
}

export class InkosAdapter implements WorkAdapter {
  readonly kind = "inkos" as const;

  async discover(sourcePath: string): Promise<WorkCandidate[]> {
    try {
      const real = await safeRealpath(sourcePath);
      const sourceStat = await stat(real);
      const directory = sourceStat.isDirectory() ? real : dirname(real);

      if (await exists(join(directory, "book.json"))) {
        const projectRoot = dirname(dirname(directory));
        if (!await exists(join(projectRoot, "inkos.json"))) return [];
        const candidate = await candidateForBook(projectRoot, directory);
        return candidate ? [candidate] : [];
      }

      const projectRoot = basename(real).toLowerCase() === "inkos.json" ? dirname(real) : real;
      if (!await exists(join(projectRoot, "inkos.json"))) return [];
      const books = join(projectRoot, "books");
      if (!await exists(books)) return [];
      const candidates: WorkCandidate[] = [];
      for (const id of await readdir(books)) {
        const candidate = await candidateForBook(projectRoot, join(books, id));
        if (candidate) candidates.push(candidate);
      }
      return candidates;
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "PATH_NOT_ALLOWED") throw error;
      return [];
    }
  }

  private async sourcePaths(candidate:WorkCandidate):Promise<Array<{path:string;kind:DocumentKind}>>{
    const paths: Array<{ path: string; kind: DocumentKind }> = [];
    const root = candidate.rootPath;
    for (const [rel, kind] of [
      ["story/outline/story_frame.md", "outline"],
      ["story/story_bible.md", "outline"],
      ["story/outline/volume_map.md", "outline"],
      ["story/volume_outline.md", "outline"],
      ["story/current_state.md", "state"],
      ["story/pending_hooks.md", "foreshadow"],
      ["story/book_rules.md", "document"],
    ] as const) {
      const path = join(root, rel);
      if (await exists(path)) paths.push({ path, kind });
    }

    const rolePaths = await deduplicateRolePaths(root, await markdownFiles(join(root, "story", "roles")));
    for (const path of rolePaths) paths.push({ path, kind: "character" });
    if (!paths.some((entry) => entry.kind === "character")) {
      const legacy = join(root, "story", "character_matrix.md");
      if (await exists(legacy)) paths.push({ path: legacy, kind: "character" });
    }
    for (const path of await markdownFiles(join(root, "chapters"))) paths.push({ path, kind: "chapter" });

    return paths;
  }

  async snapshot(candidate:WorkCandidate):Promise<SourceSnapshot>{
    const root=await safeRealpath(candidate.rootPath),paths=await this.sourcePaths(candidate);
    const entries=await Promise.all(paths.map(async entry=>{const absolutePath=await safeRealpath(entry.path);assertWithin(root,absolutePath);const info=await stat(absolutePath,{bigint:true});if(!info.isFile())throw snapshotMismatch(`Snapshot entry is no longer a regular file: ${absolutePath}`);return{relativePath:normalizedRelative(root,absolutePath),absolutePath,size:Number(info.size),mtimeNs:info.mtimeNs.toString()};}));
    entries.sort((left,right)=>left.relativePath.localeCompare(right.relativePath));return{rootPath:root,entries,fingerprint:fingerprint(entries)};
  }

  async load(candidate: WorkCandidate,snapshot?:SourceSnapshot): Promise<ParsedWork> {
    const manifest=snapshot??await this.snapshot(candidate),root=await safeRealpath(manifest.rootPath);
    const documents:SourceDocument[]=[];
    for(const entry of manifest.entries){
      const real=await safeRealpath(entry.absolutePath);assertWithin(root,real);const rel=normalizedRelative(root,real),kind=kindForRelativePath(rel);if(rel!==entry.relativePath||!kind)throw snapshotMismatch(`Snapshot path changed: ${entry.relativePath}`);const info=await stat(real,{bigint:true});if(!info.isFile()||Number(info.size)!==entry.size||info.mtimeNs.toString()!==entry.mtimeNs)throw snapshotMismatch(`Snapshot metadata changed: ${entry.relativePath}`);const content=await readFile(real,"utf8"),mtimeMs=Number(info.mtimeNs/1_000_000n),title=content.match(/^#\s+(.+)$/m)?.[1]?.trim()??basename(real,".md");
      documents.push({documentRef:stableId("doc",candidate.workRef,rel),relativePath:rel,absolutePath:real,title,kind,content,chapterNumber:kind==="chapter"?chapterNumber(basename(real)):undefined,sourceMtimeMs:mtimeMs,sourceSize:Number(info.size)});
    }
    return { ...candidate, documents };
  }
}
function kindForRelativePath(relativePath:string):DocumentKind|undefined{return fixedKinds.get(relativePath)??(/^story\/roles\/.+\.md$/i.test(relativePath)?"character":/^chapters\/.+\.md$/i.test(relativePath)?"chapter":undefined);}
