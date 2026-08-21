import { describe, expect, test } from "vitest";
import { derivePrfTerms, PRODUCTION_PRF_CONFIGURATION, validatePrfConfiguration } from "../packages/core/src/search-prf.js";

describe("deterministic PRF term derivation", () => {
  test("freezes the train-selected production configuration", () => {
    expect(PRODUCTION_PRF_CONFIGURATION).toEqual({ topK: 5, termCount: 6, weight: 0.35 });
  });

  test("filters original terms, aliases, stopwords, singletons, and one-span terms", () => {
    const frequencies = new Map([["archive", 10], ["common", 1]]);
    const terms = derivePrfTerms([
      { heading: "One", excerpt: "lost crown beacon archive common the unique" },
      { heading: "Two", excerpt: "lost crown beacon archive common the" },
    ], ["lost", "crown"], new Set(["beacon"]), { topK: 5, termCount: 4, weight: 0.35 }, 100, (term) => frequencies.get(term) ?? 0);
    expect(terms.map((item) => item.term)).toEqual(["common", "archive"]);
  });

  test("uses ordinal term order as the final deterministic tie-breaker", () => {
    const terms = derivePrfTerms([
      { heading: "One", excerpt: "query beta alpha" },
      { heading: "Two", excerpt: "query beta alpha" },
    ], ["query"], new Set(), { topK: 5, termCount: 4, weight: 0.15 }, 10, () => 2);
    expect(terms.map((item) => item.term)).toEqual(["alpha", "beta"]);
  });

  test("keeps expansion terms compatible with the trigram corpus-frequency index", () => {
    const terms = derivePrfTerms([
      { heading: "One", excerpt: "query 双字 三字词 四字词汇" },
      { heading: "Two", excerpt: "query 双字 三字词 四字词汇" },
    ], ["query"], new Set(), { topK: 5, termCount: 4, weight: 0.15 }, 10, () => 2);
    expect(terms.map((item) => item.term)).toContain("三字词");
    expect(terms.map((item) => item.term)).not.toContain("双字");
    expect(terms.map((item) => item.term)).toContain("四字词汇");
  });

  test("bounds the exact-IDF candidate pool before corpus frequency lookups", () => {
    const vocabulary = Array.from({ length: 40 }, (_, index) => `term${String(index).padStart(3, "0")}`);
    let lookups = 0;
    derivePrfTerms([
      { heading: "One", excerpt: vocabulary.join(" ") },
      { heading: "Two", excerpt: vocabulary.join(" ") },
    ], [], new Set(), { topK: 5, termCount: 4, weight: 0.15 }, 100, () => { lookups++; return 2; });
    expect(lookups).toBe(32);
  });

  test("rejects values outside the frozen configuration grid", () => {
    expect(() => validatePrfConfiguration({ topK: 6, termCount: 4, weight: 0.35 } as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_SEARCH_EXPERIMENT" }),
    );
  });
});
