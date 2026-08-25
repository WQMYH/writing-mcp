import type { PrfConfiguration } from "./types.js";

const TOP_K = new Set([5, 8, 12]);
const TERM_COUNTS = new Set([4, 6, 8]);
const WEIGHTS = new Set([0.15, 0.25, 0.35]);
export const PRODUCTION_PRF_CONFIGURATION: PrfConfiguration = { topK: 12, termCount: 8, weight: 0.35 };
const STOPWORDS = new Set([
  "and", "are", "for", "from", "into", "is", "that", "the", "this", "was", "were", "with",
  "一个", "一种", "以及", "但是", "因为", "所以", "他们", "她们", "它们", "没有", "可以",
]);

export interface PrfSource {
  heading: string;
  excerpt: string;
}

export interface WeightedPrfTerm {
  term: string;
  weight: number;
}

export function validatePrfConfiguration(configuration: PrfConfiguration): void {
  if (!TOP_K.has(configuration.topK) || !TERM_COUNTS.has(configuration.termCount) || !WEIGHTS.has(configuration.weight)) {
    throw Object.assign(new Error("PRF settings must belong to the frozen calibration grid"), { code: "INVALID_SEARCH_EXPERIMENT" });
  }
}

function termsFromText(text: string): Set<string> {
  const terms = new Set<string>();
  for (const token of text.normalize("NFKC").toLowerCase().match(/[a-z0-9][a-z0-9_'-]*|[\u3400-\u9fff]+/g) ?? []) {
    if (!/^[\u3400-\u9fff]+$/.test(token)) {
      if ([...token].length > 1 && !STOPWORDS.has(token)) terms.add(token);
      continue;
    }
    if (token.length <= 4) {
      if (token.length > 1 && !STOPWORDS.has(token)) terms.add(token);
      continue;
    }
    for (const size of [3, 2, 4]) for (let index = 0; index + size <= token.length; index++) {
      const term = token.slice(index, index + size);
      if (!STOPWORDS.has(term)) terms.add(term);
    }
  }
  return terms;
}

export function derivePrfTerms(
  sources: readonly PrfSource[],
  originalTerms: readonly string[],
  persistedAliases: ReadonlySet<string>,
  configuration: PrfConfiguration,
  totalSpans: number,
  documentFrequencies: (terms: readonly string[]) => ReadonlyMap<string, number>,
): WeightedPrfTerm[] {
  validatePrfConfiguration(configuration);
  const excluded = new Set([...originalTerms, ...persistedAliases].map((term) => term.normalize("NFKC").toLowerCase()));
  const candidates = new Map<string, { occurrences: number; cooccurrence: number }>();
  for (const [index, source] of sources.slice(0, configuration.topK).entries()) {
    for (const term of termsFromText(`${source.heading}\n${source.excerpt}`)) {
      if (excluded.has(term) || [...term].length <= 1) continue;
      const current = candidates.get(term) ?? { occurrences: 0, cooccurrence: 0 };
      current.occurrences++;
      current.cooccurrence += 1 / (index + 1);
      candidates.set(term, current);
    }
  }
  const rankedCandidates = [...candidates]
    .filter(([term, value]) => [...term].length >= 2 && value.occurrences >= 2)
    .sort((left, right) => right[1].cooccurrence - left[1].cooccurrence || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .slice(0, 128);
  const frequencies = documentFrequencies(rankedCandidates.map(([term]) => term));
  return rankedCandidates
    .map(([term, value]) => {
      const frequency = Math.max(0, frequencies.get(term) ?? 0);
      const idf = Math.log((Math.max(0, totalSpans) + 1) / (frequency + 1)) + 1;
      return { term, weight: value.cooccurrence * idf };
    })
    .sort((left, right) => right.weight - left.weight || (left.term < right.term ? -1 : left.term > right.term ? 1 : 0))
    .slice(0, configuration.termCount);
}
