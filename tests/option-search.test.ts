import { describe, expect, it } from "vitest";
import { compareLabels, matchesSearch, normalizeForSearch, searchTokens } from "../src/lib/option-search";

/**
 * The customer and vehicle pickers on the invoice and appointment builders sit
 * on these rules. The components themselves are not covered — this suite has no
 * DOM — so the matching and ordering staff depend on lives here.
 */

describe("normalizeForSearch", () => {
  it("lowercases, strips accents, and collapses punctuation", () => {
    expect(normalizeForSearch("José  O'Brien-Smith")).toBe("jose o brien smith");
    expect(normalizeForSearch("(905) 555-1234")).toBe("905 555 1234");
    expect(normalizeForSearch("   ")).toBe("");
  });
});

describe("searchTokens", () => {
  it("splits on anything that is not a letter or digit", () => {
    expect(searchTokens("smith, 905-555")).toEqual(["smith", "905", "555"]);
    expect(searchTokens("  ")).toEqual([]);
  });
});

describe("matchesSearch", () => {
  const customer = "Jane Smith jane.smith@example.com (905) 555-1234";

  it("matches an empty query so the full list shows", () => {
    expect(matchesSearch(customer, "")).toBe(true);
    expect(matchesSearch(customer, "   ")).toBe(true);
  });

  it("matches mid-word, which the browser's own type-ahead never did", () => {
    expect(matchesSearch(customer, "smith")).toBe(true);
    expect(matchesSearch(customer, "example.com")).toBe(true);
  });

  it("matches every token in any order", () => {
    expect(matchesSearch(customer, "smith 905")).toBe(true);
    expect(matchesSearch(customer, "905 smith")).toBe(true);
    expect(matchesSearch(customer, "smith brown")).toBe(false);
  });

  it("finds a phone number however it was typed", () => {
    expect(matchesSearch(customer, "9055551234")).toBe(true);
    expect(matchesSearch(customer, "905-555-1234")).toBe(true);
    expect(matchesSearch("Fleet Co +1 905 555 1234", "9055551234")).toBe(true);
  });

  it("finds a plate whether or not the space was typed", () => {
    expect(matchesSearch("2021 Honda CR-V (ABCD 123)", "abcd123")).toBe(true);
    expect(matchesSearch("2021 Honda CR-V (ABCD123)", "abcd 123")).toBe(true);
  });

  it("ignores accents in either direction", () => {
    expect(matchesSearch("Renée Côté", "renee cote")).toBe(true);
    expect(matchesSearch("Renee Cote", "renée")).toBe(true);
  });
});

describe("compareLabels", () => {
  it("orders case- and accent-insensitively", () => {
    const sorted = ["dave brown", "Álvarez Ltd", "Carol Smith", "bob jones"].sort(compareLabels);
    expect(sorted).toEqual(["Álvarez Ltd", "bob jones", "Carol Smith", "dave brown"]);
  });

  it("orders embedded numbers by value, not by digit", () => {
    const sorted = ["Bay 12 Autos", "Bay 100 Autos", "Bay 2 Autos"].sort(compareLabels);
    expect(sorted).toEqual(["Bay 2 Autos", "Bay 12 Autos", "Bay 100 Autos"]);
  });
});
