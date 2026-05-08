import type { ImportPayload, StudySet, StudyTerm } from "../types";

const MIN_TEXT_LENGTH = 1;
const HEADER_TERMS = new Set(["term", "terms", "word", "front"]);
const HEADER_DEFINITIONS = new Set(["definition", "definitions", "meaning", "back"]);
const IGNORED_EXACT_PAIRS = new Set(["get a hint"]);
const PAGE_CONTROL_FRAGMENTS = [
  "still learning",
  "not studied",
  "you've begun learning",
  "you haven't studied",
  "keep up the good work",
  "select these",
  "terms in this set",
  "your stats",
  "don't know?",
  "search for a question",
];

export function makeId(prefix = "id"): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripDuplicatedDefinition(term: string, definition: string): string {
  if (!term || !definition) return term;
  const lowerTerm = term.toLocaleLowerCase();
  const lowerDefinition = definition.toLocaleLowerCase();

  if (lowerTerm === lowerDefinition) return term;
  if (!lowerTerm.endsWith(lowerDefinition)) return term;

  const stripped = term.slice(0, term.length - definition.length).trim();
  return stripped || term;
}

function isHeaderPair(term: string, definition: string): boolean {
  return (
    HEADER_TERMS.has(term.toLocaleLowerCase()) &&
    HEADER_DEFINITIONS.has(definition.toLocaleLowerCase())
  );
}

export function isIgnoredTermPair(term: string, definition: string): boolean {
  const normalizedTerm = cleanText(term).toLocaleLowerCase();
  const normalizedDefinition = cleanText(definition).toLocaleLowerCase();
  return (
    (normalizedTerm === normalizedDefinition && IGNORED_EXACT_PAIRS.has(normalizedTerm)) ||
    isPageControlBlock(normalizedTerm) ||
    isPageControlBlock(normalizedDefinition)
  );
}

function isPageControlBlock(value: string): boolean {
  const hits = PAGE_CONTROL_FRAGMENTS.filter((fragment) => value.includes(fragment)).length;
  return (
    hits >= 2 ||
    value.startsWith("still learning") ||
    value.startsWith("not studied") ||
    value.startsWith("terms in this set")
  );
}

export function normalizeTerms(
  pairs: Array<{ term: unknown; definition: unknown }>,
): StudyTerm[] {
  const seen = new Set<string>();
  return pairs
    .map((pair) => {
      const definition = cleanText(pair.definition);
      return {
        term: stripDuplicatedDefinition(cleanText(pair.term), definition),
        definition,
      };
    })
    .filter(
      (pair) =>
        pair.term.length >= MIN_TEXT_LENGTH &&
        pair.definition.length >= MIN_TEXT_LENGTH &&
        !isHeaderPair(pair.term, pair.definition) &&
        !isIgnoredTermPair(pair.term, pair.definition),
    )
    .filter((pair) => {
      const key = `${pair.term.toLocaleLowerCase()}::${pair.definition.toLocaleLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((pair) => ({ id: makeId("term"), ...pair }));
}

export function payloadToStudySet(payload: ImportPayload): StudySet {
  const terms = normalizeTerms(payload.terms);
  if (terms.length === 0) {
    throw new Error("No valid term-definition pairs were found.");
  }

  const now = new Date().toISOString();
  return {
    id: makeId("set"),
    title: cleanText(payload.title) || "Imported study set",
    sourceUrl: cleanText(payload.sourceUrl) || undefined,
    terms,
    createdAt: now,
    updatedAt: now,
  };
}

export function parseDelimitedText(input: string): ImportPayload {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const terms = lines
    .map((line) => {
      const delimiter = line.includes("\t") ? "\t" : line.includes(",") ? "," : "";
      if (!delimiter) return null;
      const [term, ...rest] = line.split(delimiter);
      return { term, definition: rest.join(delimiter) };
    })
    .filter((pair): pair is { term: string; definition: string } => Boolean(pair));

  return {
    title: "Pasted study set",
    terms,
  };
}

export function parseManualImport(input: string): ImportPayload {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Paste study data before importing.");
  }

  try {
    const parsed = JSON.parse(trimmed) as Partial<ImportPayload> | unknown[];
    if (Array.isArray(parsed)) {
      return {
        title: "Pasted study set",
        terms: parsed.map((item) => {
          const record = item as Record<string, unknown>;
          return {
            term: cleanText(record.term ?? record.word ?? record.front ?? ""),
            definition: cleanText(record.definition ?? record.back ?? record.meaning ?? ""),
          };
        }),
      };
    }

    if (parsed && typeof parsed === "object" && Array.isArray(parsed.terms)) {
      return parsed as ImportPayload;
    }
  } catch {
    return parseDelimitedText(trimmed);
  }

  throw new Error("Unsupported import format.");
}

export function validateImportMessage(value: unknown): ImportPayload | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.source !== "vocab-arcade-bookmarklet") return null;
  const payload = record.payload as Partial<ImportPayload> | undefined;
  if (!payload || !Array.isArray(payload.terms)) return null;
  return {
    title: typeof payload.title === "string" ? payload.title : undefined,
    sourceUrl: typeof payload.sourceUrl === "string" ? payload.sourceUrl : undefined,
    terms: payload.terms.map((term) => ({
      term: (term as Record<string, unknown>).term as string,
      definition: (term as Record<string, unknown>).definition as string,
    })),
  };
}
