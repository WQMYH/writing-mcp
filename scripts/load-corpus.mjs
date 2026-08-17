#!/usr/bin/env node
// Corpus loader: scan a directory for TXT/EPUB files and report stats.
// Usage: node scripts/load-corpus.mjs <corpus-directory>
// Output: JSON summary (file count, total chars, total bytes, file list)

import { readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";

const corpusDir = process.argv[2];
if (!corpusDir) {
  console.error("Usage: node scripts/load-corpus.mjs <corpus-directory>");
  process.exit(1);
}

async function scanDirectory(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await scanDirectory(fullPath)));
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (ext === ".txt" || ext === ".epub") {
        const info = await stat(fullPath);
        files.push({
          path: fullPath,
          name: entry.name,
          size: info.size,
          extension: ext,
        });
      }
    }
  }
  return files;
}

async function countChars(filePath) {
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(filePath, "utf-8");
  return content.length;
}

async function main() {
  console.error(`Scanning ${corpusDir}...`);
  const files = await scanDirectory(corpusDir);
  
  let totalChars = 0;
  let totalBytes = 0;
  const fileList = [];
  
  for (const file of files) {
    const chars = await countChars(file.path);
    totalChars += chars;
    totalBytes += file.size;
    fileList.push({
      name: file.name,
      path: file.path,
      size: file.size,
      chars,
      extension: file.extension,
    });
    console.error(`  ${file.name}: ${chars.toLocaleString()} chars, ${(file.size / 1024).toFixed(1)} KB`);
  }
  
  const summary = {
    directory: corpusDir,
    fileCount: files.length,
    totalChars,
    totalBytes,
    totalCharsWan: (totalChars / 10000).toFixed(1),
    totalSizeMB: (totalBytes / (1024 * 1024)).toFixed(2),
    files: fileList,
  };
  
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error("Error:", error.message);
  process.exit(1);
});
