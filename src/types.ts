export type StudyTerm = {
  id: string;
  term: string;
  definition: string;
};

export type StudySet = {
  id: string;
  sourceUrl?: string;
  title: string;
  terms: StudyTerm[];
  createdAt: string;
  updatedAt: string;
};

export type ImportPayload = {
  title?: string;
  sourceUrl?: string;
  terms: Array<{
    term: string;
    definition: string;
  }>;
};

export type ProgressState = {
  correct: string[];
  needsPractice: string[];
};
