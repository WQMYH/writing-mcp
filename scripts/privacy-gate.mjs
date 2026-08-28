#!/usr/bin/env node
// Privacy gate for publication: scans every object reachable from local refs (blob
// contents plus commit/tag messages) for banned privacy markers and fails on any hit.
// Design rules:
// - Leak-safe output: reports marker name, path and object id only, never matched text
//   or surrounding content (a gate run must not echo what it is looking for).
// - Markers are stored as UTF-8 hex bytes so this published script never contains the
//   plaintext it searches for. Add a marker by hex-encoding the phrase, never by pasting it.
// Usage: node scripts/privacy-gate.mjs [--scope=history|worktree]
// Scope: history (default) = objects reachable from local refs (heads/tags); worktree = tracked files on disk.
// Remote-tracking refs (refs/remotes/*) are deliberately excluded: they are stale local caches of
// server state, not part of what a push will upload. What the server actually holds is verified by
// re-running this gate in a fresh clone after the push.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const scopeArg = process.argv.find((a) => a.startsWith("--scope="));
const scope = scopeArg ? scopeArg.split("=")[1] : "history";
if (scope !== "history" && scope !== "worktree") { console.error(`[privacy:gate] unknown scope: ${scope}`); process.exit(2); }

// Markers are only the two third-party novel titles used as private evaluation corpora.
// Deliberately NOT including generic tokens like "Materials/" or "标注数据": those are
// non-identifying, appear in legitimate code/docs (and in this very script), so blocking
// them would make the gate self-match and forever fail. Corpus titles are the sole PII.
const MARKERS = [
  { name: "private-corpus-title-a", bytes: Buffer.from("e69eabe99c81", "hex") },
  { name: "private-corpus-title-b", bytes: Buffer.from("e8afa1e7a798e4b98be4b8bb", "hex") },
];
// Test hook: WRITING_MCP_PRIVACY_MARKERS=[{"name":..,"text":..}|{"hex":..}] replaces the list
// so regression fixtures can plant harmless sentinels without touching real markers.
const override = process.env.WRITING_MCP_PRIVACY_MARKERS;
const markers = override
  ? JSON.parse(override).map((m) => ({ name: m.name, bytes: Buffer.from(m.hex ?? Buffer.from(m.text, "utf8").toString("hex"), "hex") }))
  : MARKERS;

const git = (args, input) => {
  const r = spawnSync("git", args, { encoding: "buffer", input, maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) { console.error(`[privacy:gate] git ${args.join(" ")} failed: ${r.stderr?.toString("utf8")}`); process.exit(2); }
  return r.stdout;
};

const findings = [];
let scanned = 0;
const scan = (label, content) => {
  scanned++;
  for (const m of markers) {
    let count = 0, idx = content.indexOf(m.bytes);
    while (idx !== -1) { count++; idx = content.indexOf(m.bytes, idx + m.bytes.length); }
    if (count) findings.push({ marker: m.name, label, count });
  }
};

if (scope === "worktree") {
  for (const f of git(["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean)) scan(f, readFileSync(f));
} else {
  const names = new Map(); const oids = [];
  // enumerate local refs only (heads + tags); skip refs/remotes and refs/notes
  const tips = git(["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/tags"]).toString("utf8").split("\n").filter(Boolean);
  for (const line of git(["rev-list", "--objects", ...tips]).toString("utf8").split("\n")) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    if (sp === -1) { oids.push(line); continue; }
    oids.push(line.slice(0, sp));
    const path = line.slice(sp + 1).trim();
    if (path) names.set(line.slice(0, sp), path);
  }
  const stream = git(["cat-file", "--batch"], Buffer.from(oids.join("\n") + "\n", "utf8"));
  let pos = 0;
  while (pos < stream.length) {
    const nl = stream.indexOf(0x0a, pos); if (nl === -1) break;
    const header = stream.subarray(pos, nl).toString("utf8");
    if (header.endsWith(" missing")) { pos = nl + 1; continue; }
    const [oid, type, sizeText] = header.split(" ");
    const size = Number(sizeText);
    const content = stream.subarray(nl + 1, nl + 1 + size);
    pos = nl + 1 + size + 1;
    if (type === "blob") scan(`${names.get(oid) ?? "<unmapped>"}@${oid.slice(0, 10)}`, content);
    else if (type === "commit" || type === "tag") scan(`message@${oid.slice(0, 10)}`, content);
  }
}

for (const f of findings) console.log(`[privacy:gate] ${f.marker}\t${f.label}\t${f.count} hit(s)`);
console.log(`[privacy:gate] scope=${scope} scanned=${scanned} findings=${findings.length}`);
if (findings.length) { console.error("[privacy:gate] FAIL - privacy markers present; scrub before publishing"); process.exit(1); }
console.log("[privacy:gate] PASS");
