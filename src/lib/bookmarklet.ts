export function buildBookmarklet(appUrl: string): string {
  const appImportUrl = new URL(appUrl);
  appImportUrl.hash = "/import";
  appImportUrl.search = "";

  const code = `(() => {
  const APP_URL = ${JSON.stringify(appImportUrl.toString())};
  const APP_ORIGIN = new URL(APP_URL).origin;
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const stripDuplicatedDefinition = (term, definition) => {
    const lowerTerm = term.toLocaleLowerCase();
    const lowerDefinition = definition.toLocaleLowerCase();
    if (lowerTerm !== lowerDefinition && lowerTerm.endsWith(lowerDefinition)) {
      return clean(term.slice(0, term.length - definition.length)) || term;
    }
    return term;
  };
  const pairs = [];
  const add = (term, definition) => {
    term = clean(term);
    definition = clean(definition);
    term = stripDuplicatedDefinition(term, definition);
    if (term.toLocaleLowerCase() === "term" && definition.toLocaleLowerCase() === "definition") return;
    if (term && definition && !pairs.some((item) => item.term === term && item.definition === definition)) {
      pairs.push({ term, definition });
    }
  };
  const parseCandidates = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(parseCandidates);
      return;
    }
    const record = value;
    if (record.word && record.definition) add(record.word, record.definition);
    if (record.term && record.definition) add(record.term, record.definition);
    if (record.term && record.meaning) add(record.term, record.meaning);
    if (record.cardSides && Array.isArray(record.cardSides) && record.cardSides.length >= 2) {
      add(record.cardSides[0]?.media?.[0]?.plainText, record.cardSides[1]?.media?.[0]?.plainText);
    }
    for (const key of Object.keys(record)) {
      const child = record[key];
      if (child && typeof child === "object") parseCandidates(child);
    }
  };
  document.querySelectorAll("script[type='application/json'], script#__NEXT_DATA__").forEach((script) => {
    try {
      parseCandidates(JSON.parse(script.textContent || ""));
    } catch {}
  });
  if (pairs.length < 2) document.querySelectorAll("[data-testid*='Term'], [class*='TermText'], [class*='SetPageTerm']").forEach((node) => {
    const texts = Array.from(node.querySelectorAll("span, a, div"))
      .map((item) => clean(item.textContent))
      .filter((text) => text.length > 0 && text.length < 500);
    if (texts.length >= 2) add(texts[0], texts[texts.length - 1]);
  });
  if (pairs.length === 0) {
    alert("No term-definition pairs were found on this page.");
    return;
  }
  const payload = {
    source: "vocab-arcade-bookmarklet",
    payload: {
      title: clean(document.querySelector("h1")?.textContent || document.title),
      sourceUrl: location.href,
      terms: pairs
    }
  };
  const target = window.open(APP_URL, "_blank");
  const send = () => target?.postMessage(payload, APP_ORIGIN);
  setTimeout(send, 500);
  setTimeout(send, 1500);
  setTimeout(send, 3000);
})();`;

  return `javascript:${encodeURIComponent(code)}`;
}
