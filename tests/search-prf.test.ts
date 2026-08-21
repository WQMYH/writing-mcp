import { describe, expect, test } from "vitest";
import { derivePrfTerms, validatePrfConfiguration } from "../packages/core/src/search-prf.js";

describe("deterministic PRF term derivation", () => {
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

  test("rejects values outside the frozen configuration grid", () => {
    expect(() => validatePrfConfiguration({ topK: 6, termCount: 4, weight: 0.35 } as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_SEARCH_EXPERIMENT" }),
    );
  });
});
