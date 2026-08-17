import type { EvidenceLocator, SourceDocument } from "./types.js";

export interface Span { spanRef: string; documentRef: string; ordinal: number; startLine: number; endLine: number; heading: string; content: string; locators: EvidenceLocator[] }

export function splitDocument(document: SourceDocument, makeId: (ordinal: number) => string, maxChars = 2400): Span[] {
  const lines = document.content.replace(/\r\n?/g, "\n").split("\n");
  const sourceLineOffset = (document.sourceStartLine ?? 1) - 1;
  const spans: Span[] = [];
  let start = 0, heading = document.title, buffer: string[] = [];
  const mapLocators = (documentStartLine: number, documentEndLine: number) => document.sourceSegments?.flatMap(segment => {
    const overlapStart = Math.max(documentStartLine, segment.documentStartLine);
    const overlapEnd = Math.min(documentEndLine, segment.documentEndLine);
    if (overlapStart > overlapEnd) return [];
    return [{
      relativePath: segment.relativePath,
      startLine: segment.startLine + overlapStart - segment.documentStartLine,
      endLine: segment.startLine + overlapEnd - segment.documentStartLine,
    }];
  }) ?? [{ relativePath: document.relativePath, startLine: sourceLineOffset + documentStartLine, endLine: sourceLineOffset + documentEndLine }];
  const flush = () => {
    // AUD-030 locator exactness: trim blank lines out of the recorded range
    // so locators never cover lines the trimmed content does not contain.
    let first = 0, last = buffer.length - 1;
    while (first <= last && !buffer[first]!.trim()) first++;
    while (last >= first && !buffer[last]!.trim()) last--;
    if (first <= last) {
      const documentStartLine = start + first + 1, documentEndLine = start + last + 1;
      spans.push({ spanRef: makeId(spans.length), documentRef: document.documentRef, ordinal: spans.length, startLine: sourceLineOffset + documentStartLine, endLine: sourceLineOffset + documentEndLine, heading, content: buffer.slice(first, last + 1).join("\n"), locators: mapLocators(documentStartLine, documentEndLine) });
    }
    buffer = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const nextHeading = line.match(/^#{1,6}\s+(.+)/)?.[1]?.trim();
    if (nextHeading && buffer.some((v) => v.trim())) { flush(); start = i; heading = nextHeading; }
    else if (!buffer.length) { start = i; if (nextHeading) heading = nextHeading; }
    // AUD-030 hard cap: a single line longer than maxChars is hard-split into
    // bounded chunk spans sharing that one source line, instead of surviving
    // as one oversized span.
    if (line.length > maxChars) {
      if (buffer.some(v => v.trim())) flush();
      const documentLine = i + 1;
      for (let offset = 0; offset < line.length; offset += maxChars) {
        const chunk = line.slice(offset, offset + maxChars);
        spans.push({ spanRef: makeId(spans.length), documentRef: document.documentRef, ordinal: spans.length, startLine: sourceLineOffset + documentLine, endLine: sourceLineOffset + documentLine, heading, content: chunk, locators: mapLocators(documentLine, documentLine) });
      }
      buffer = [];
      continue;
    }
    buffer.push(line);
    if (buffer.join("\n").length >= maxChars) flush();
  }
  flush();
  return spans;
}

export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const rest = text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ").trim();
  const words = rest ? rest.split(/\s+/).length : 0;
  return Math.max(1, Math.ceil(cjk * 1.15 + words * 1.3));
}
