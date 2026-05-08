import { describe, expect, it } from "vitest";
import {
  normalizeTerms,
  parseManualImport,
  payloadToStudySet,
  validateImportMessage,
} from "./import";

describe("import helpers", () => {
  it("normalizes and de-duplicates term pairs", () => {
    const terms = normalizeTerms([
      { term: " apple ", definition: " fruit " },
      { term: "apple", definition: "fruit" },
      { term: "", definition: "ignored" },
    ]);

    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({ term: "apple", definition: "fruit" });
  });

  it("removes header rows and duplicated definition suffixes", () => {
    const terms = normalizeTerms([
      { term: "Term", definition: "Definition" },
      { term: "Термин", definition: "Определение" },
      { term: "Термін", definition: "Визначення" },
      { term: "Get a hint", definition: "Get a hint" },
      {
        term: "Still learning (7) You've begun learning these terms. Keep up the good work! Select these 7 hedge knight ought to",
        definition: "зачерпнути, загрібати",
      },
      { term: "Search", definition: "Upgrade: Free 7-day trial" },
      { term: "hedge 1 none of that! 3", definition: "Why, you...! 2 septon 4" },
      { term: "hedgeживопліт; огорожа", definition: "живопліт; огорожа" },
      { term: "knightлицар", definition: "лицар" },
      { term: "Why, you...!", definition: "Ах ти ж...! / Та ти ж...! / От ти...!" },
      { term: "none of that!", definition: "припини це! / не смій! / досить!" },
    ]);

    expect(terms).toHaveLength(4);
    expect(terms[0]).toMatchObject({ term: "hedge", definition: "живопліт; огорожа" });
    expect(terms[1]).toMatchObject({ term: "knight", definition: "лицар" });
    expect(terms[2]).toMatchObject({
      term: "Why, you...!",
      definition: "Ах ти ж...! / Та ти ж...! / От ти...!",
    });
    expect(terms[3]).toMatchObject({
      term: "none of that!",
      definition: "припини це! / не смій! / досить!",
    });
  });

  it("parses CSV and TSV pasted data", () => {
    const payload = parseManualImport("one\tuno\ntwo,dos");

    expect(payload.terms).toEqual([
      { term: "one", definition: "uno" },
      { term: "two", definition: "dos" },
    ]);
  });

  it("parses JSON pasted data", () => {
    const payload = parseManualImport(
      JSON.stringify({
        title: "Numbers",
        terms: [{ term: "one", definition: "uno" }],
      }),
    );

    expect(payload.title).toBe("Numbers");
    expect(payload.terms).toHaveLength(1);
  });

  it("creates a StudySet from a payload", () => {
    const set = payloadToStudySet({
      title: "Numbers",
      sourceUrl: "https://example.com/study-set",
      terms: [{ term: "one", definition: "uno" }],
    });

    expect(set.title).toBe("Numbers");
    expect(set.terms[0].id).toMatch(/^term-/);
    expect(set.sourceUrl).toBe("https://example.com/study-set");
  });

  it("validates bookmarklet messages", () => {
    const payload = validateImportMessage({
      source: "vocab-arcade-bookmarklet",
      payload: {
        title: "Set",
        terms: [{ term: "one", definition: "uno" }],
      },
    });

    expect(payload?.title).toBe("Set");
    expect(payload?.terms).toHaveLength(1);
    expect(validateImportMessage({ source: "other" })).toBeNull();
  });
});
