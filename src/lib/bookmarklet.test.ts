import { describe, expect, it } from "vitest";
import { buildBookmarklet } from "./bookmarklet";

describe("bookmarklet", () => {
  it("creates an encoded javascript URL that targets the import route", () => {
    const bookmarklet = buildBookmarklet("https://example.github.io/VocabArcade/");
    const decoded = decodeURIComponent(bookmarklet.replace(/^javascript:/, ""));

    expect(bookmarklet.startsWith("javascript:")).toBe(true);
    expect(decoded).toContain("vocab-arcade-bookmarklet");
    expect(decoded).toContain("https://example.github.io/VocabArcade/#/import");
    expect(decoded).toContain("postMessage");
  });
});
