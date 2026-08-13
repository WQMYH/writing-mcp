import type { SourceDocument } from "./types.js";

export interface Span { spanRef: string; documentRef: string; ordinal: number; startLine: number; endLine: number; heading: string; content: string }

export function splitDocument(document: SourceDocument, makeId: (ordinal: number) => string, maxChars = 2400): Span[] {
  const lines = document.content.replace(/\r\n?/g, "\n").split("\n");
  const spans: Span[] = [];
  let start = 0, heading = document.title, buffer: string[] = [];
  const flush = () => {
    const content = buffer.join("\n").trim();
    if (content) spans.push({ spanRef: makeId(spans.length), documentRef: document.documentRef, ordinal: spans.length, startLine: start + 1, endLine: start + buffer.length, heading, content });
    buffer = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const nextHeading = line.match(/^#{1,6}\s+(.+)/)?.[1]?.trim();
    if (nextHeading && buffer.some((v) => v.trim())) { flush(); start = i; heading = nextHeading; }
    else if (!buffer.length) start = i;
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
