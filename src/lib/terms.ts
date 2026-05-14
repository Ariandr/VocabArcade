import type { StudySet, StudyTerm } from "../types";

export function isTermActive(term: StudyTerm): boolean {
  return term.active !== false;
}

export function activeTerms(terms: StudyTerm[]): StudyTerm[] {
  return terms.filter(isTermActive);
}

export function activeStudySet(set: StudySet): StudySet {
  return {
    ...set,
    terms: activeTerms(set.terms),
  };
}
