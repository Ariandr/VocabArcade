import type { ProgressState, StudySet } from "../types";
import { isIgnoredTermPair } from "./import";

const SETS_KEY = "vocab-arcade:sets";
const PROGRESS_KEY = "vocab-arcade:progress";

export function loadSets(): StudySet[] {
  const raw = localStorage.getItem(SETS_KEY);
  if (!raw) return [];
  try {
    const sets = JSON.parse(raw) as StudySet[];
    if (!Array.isArray(sets)) return [];
    const sanitizedSets = sanitizeSets(sets);
    if (sanitizedSets.changed) {
      saveSets(sanitizedSets.sets);
    }
    return sanitizedSets.sets;
  } catch {
    return [];
  }
}

export function saveSets(sets: StudySet[]): void {
  localStorage.setItem(SETS_KEY, JSON.stringify(sets));
}

function sanitizeSets(sets: StudySet[]): { sets: StudySet[]; changed: boolean } {
  let changed = false;
  const nextSets = sets.map((set) => {
    const terms = set.terms.filter((term) => !isIgnoredTermPair(term.term, term.definition));
    if (terms.length === set.terms.length) return set;
    changed = true;
    return {
      ...set,
      terms,
      updatedAt: new Date().toISOString(),
    };
  });
  return { sets: nextSets, changed };
}

export function upsertSet(set: StudySet): StudySet[] {
  const sets = loadSets();
  const index = sets.findIndex((item) => item.id === set.id);
  const next =
    index >= 0
      ? sets.map((item, itemIndex) => (itemIndex === index ? set : item))
      : [set, ...sets];
  saveSets(next);
  return next;
}

export function deleteSet(setId: string): StudySet[] {
  const next = loadSets().filter((set) => set.id !== setId);
  saveSets(next);
  return next;
}

export function loadProgress(setId: string): ProgressState {
  const raw = localStorage.getItem(`${PROGRESS_KEY}:${setId}`);
  if (!raw) return { correct: [], needsPractice: [] };
  try {
    const parsed = JSON.parse(raw) as ProgressState;
    return {
      correct: Array.isArray(parsed.correct) ? parsed.correct : [],
      needsPractice: Array.isArray(parsed.needsPractice) ? parsed.needsPractice : [],
    };
  } catch {
    return { correct: [], needsPractice: [] };
  }
}

export function saveProgress(setId: string, progress: ProgressState): void {
  localStorage.setItem(`${PROGRESS_KEY}:${setId}`, JSON.stringify(progress));
}
