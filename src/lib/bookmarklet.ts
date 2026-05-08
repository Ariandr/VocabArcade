export function buildBookmarklet(appUrl: string): string {
  const appImportUrl = new URL(appUrl);
  appImportUrl.hash = "/import";
  appImportUrl.search = "";

  const code = `(() => {
  const APP_URL = ${JSON.stringify(appImportUrl.toString())};
  const APP_ORIGIN = new URL(APP_URL).origin;
  try {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const pageControlFragments = [
      "free 7-day trial",
      "still learning",
      "not studied",
      "you've begun learning",
      "you haven't studied",
      "keep up the good work",
      "select these",
      "terms in this set",
      "your stats",
      "don't know?",
      "search for a question"
    ];
    const blockedControlFragments = ["free 7-day trial", "none of that", "why, you"];
    const isControlBlock = (value) => {
      const text = clean(value).toLocaleLowerCase();
      const hits = pageControlFragments.filter((fragment) => text.includes(fragment)).length;
      return text === "search" || blockedControlFragments.some((fragment) => text.includes(fragment)) || hits >= 2 || text.startsWith("upgrade") || text.startsWith("still learning") || text.startsWith("not studied") || text.startsWith("terms in this set");
    };
    const isControlText = (value) => {
      const text = clean(value).toLocaleLowerCase();
      return !text || pageControlFragments.some((fragment) => text === fragment || text.startsWith(fragment));
    };
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
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
      if (isControlBlock(term) || isControlBlock(definition)) return;
      if (term && definition && !pairs.some((item) => item.term === term && item.definition === definition)) {
        pairs.push({ term, definition });
      }
    };
    const exactSideText = (side) => {
      const textNode = side.querySelector(".TermText, [class*='TermText'], .FormattedText, [class*='FormattedText']");
      return clean(textNode?.textContent || side.textContent);
    };
    const addExactLayoutPairs = () => {
      document.querySelectorAll(".SetPageTermsList-term, div[aria-label='Term']").forEach((row) => {
        const sides = Array.from(row.querySelectorAll("[data-testid='set-page-term-card-side']"));
        if (sides.length < 2) return;
        add(exactSideText(sides[0]), exactSideText(sides[1]));
      });
    };
    const textItemsIn = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const items = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        const text = clean(node.textContent);
        if (!parent || !text || text.length > 500 || isControlText(text) || text === "|" || text === "｜" || text === "┊") continue;
        if (parent.closest("button, input, textarea, select, option, svg, script, style, noscript")) continue;
        if (!isVisible(parent)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        range.detach();
        if (rect.width < 1 || rect.height < 1) continue;
        items.push({ text, rect });
      }
      return items;
    };
    const addPairsByIcons = () => {
      const indicatorButtons = Array.from(document.querySelectorAll("button, [role='button'], a")).filter((btn) => {
        const label = (btn.getAttribute("aria-label") || btn.getAttribute("title") || btn.textContent || "").toLowerCase();
        return label === "star" || label === "star this term" || label === "play audio";
      });
      const candidateRows = new Set();
      indicatorButtons.forEach((btn) => {
        let curr = btn.parentElement;
        while (curr && curr !== document.body) {
          if (!isVisible(curr)) break;
          const rect = curr.getBoundingClientRect();
          if (rect.width > 200 && rect.height >= 24 && rect.height < 600) {
            const items = textItemsIn(curr);
            if (items.length >= 2) {
              candidateRows.add(curr);
              break;
            }
          }
          curr = curr.parentElement;
        }
      });

      const rowList = Array.from(candidateRows);
      const finalRows = rowList.filter((row) => {
        return !rowList.some((other) => other !== row && row.contains(other));
      });

      finalRows.forEach((row) => {
        const items = textItemsIn(row);
        if (items.length < 2) return;

        items.sort((a, b) => {
          if (Math.abs(a.rect.top - b.rect.top) < 10) {
            return a.rect.left - b.rect.left;
          }
          return a.rect.top - b.rect.top;
        });

        let maxGap = -Infinity;
        let splitIndex = 1;

        for (let i = 1; i < items.length; i++) {
          const verticalOverlap = !(items[i].rect.bottom < items[i - 1].rect.top || items[i].rect.top > items[i - 1].rect.bottom);
          if (verticalOverlap) {
            const gap = items[i].rect.left - items[i - 1].rect.right;
            if (gap > maxGap) {
              maxGap = gap;
              splitIndex = i;
            }
          }
        }

        if (maxGap < 10) {
          maxGap = -Infinity;
          splitIndex = 1;
          items.sort((a, b) => a.rect.top - b.rect.top);
          for (let i = 1; i < items.length; i++) {
            const gap = items[i].rect.top - items[i - 1].rect.bottom;
            if (gap > maxGap) {
              maxGap = gap;
              splitIndex = i;
            }
          }
        }

        const termItems = items.slice(0, splitIndex);
        const defItems = items.slice(splitIndex);

        const sortReading = (a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left;
        termItems.sort(sortReading);
        defItems.sort(sortReading);

        const term = clean(termItems.map((i) => i.text).join(" "));
        const definition = clean(defItems.map((i) => i.text).join(" "));

        if (term && definition) {
          add(term, definition);
        }
      });
    };
    const addLayoutPairs = () => {
      const candidates = Array.from(document.querySelectorAll("[data-testid*='SetPageTerm'], [class*='SetPageTerm'], article, li, div"));
      const rows = [];
      candidates.forEach((node) => {
        if (!(node instanceof Element) || !isVisible(node)) return;
        const rect = node.getBoundingClientRect();
        if (rect.width < 260 || rect.height < 36 || rect.height > 260) return;
        const items = textItemsIn(node);
        if (items.length < 2 || items.length > 8) return;
        const midpoint = rect.left + rect.width * 0.52;
        const left = items.filter((item) => item.rect.left + item.rect.width / 2 < midpoint);
        const right = items.filter((item) => item.rect.left + item.rect.width / 2 >= midpoint);
        if (!left.length || !right.length) return;
        const leftRightEdge = Math.max(...left.map((item) => item.rect.right));
        const rightLeftEdge = Math.min(...right.map((item) => item.rect.left));
        if (rightLeftEdge - leftRightEdge < 18) return;
        const orderedText = (side) => clean(side
          .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
          .map((item) => item.text)
          .join(" "));
        const term = orderedText(left);
        const definition = orderedText(right);
        if (!term || !definition || term === definition) return;
        rows.push({ top: rect.top, left: rect.left, term, definition });
      });
      rows
        .sort((a, b) => a.top - b.top || a.left - b.left)
        .forEach((row) => add(row.term, row.definition));
    };
    const addCardSides = (cardSides) => {
      if (!Array.isArray(cardSides) || cardSides.length < 2) return;
      const wordSide = cardSides.find((side) => side?.label === "word" || side?.sideId === 0) || cardSides[0];
      const definitionSide = cardSides.find((side) => side?.label === "definition" || side?.sideId === 1) || cardSides[1];
      add(wordSide?.media?.[0]?.plainText, definitionSide?.media?.[0]?.plainText);
    };
    const parseDataString = (value) => {
      const text = String(value || "").trim();
      if (!text || (!text.startsWith("{") && !text.startsWith("["))) return;
      if (!text.includes("cardSides") && !text.includes("studiableItems") && !text.includes("plainText")) return;
      try {
        parseCandidates(JSON.parse(text));
      } catch {}
    };
    const parseCandidates = (value) => {
      if (!value) return;
      if (typeof value === "string") {
        parseDataString(value);
        return;
      }
      if (typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(parseCandidates);
        return;
      }
      const record = value;
      if (record.word && record.definition) add(record.word, record.definition);
      if (record.term && record.definition) add(record.term, record.definition);
      if (record.term && record.meaning) add(record.term, record.meaning);
      if (record.cardSides) addCardSides(record.cardSides);
      for (const key of Object.keys(record)) {
        const child = record[key];
        if (child && (typeof child === "object" || typeof child === "string")) parseCandidates(child);
      }
    };
    if (window.__NEXT_DATA__) parseCandidates(window.__NEXT_DATA__);
    document.querySelectorAll("script[type='application/json'], script#__NEXT_DATA__").forEach((script) => {
      try {
        parseCandidates(JSON.parse(script.textContent || ""));
      } catch {}
    });
    addExactLayoutPairs();
    addPairsByIcons();
    if (pairs.length < 2) addLayoutPairs();
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
  } catch (err) {
    alert("Vocab Arcade Bookmarklet Error: " + err.message + "\\n\\nPlease let the developer know!");
  }
})();`;

  return `javascript:${encodeURIComponent(code)}`;
}
