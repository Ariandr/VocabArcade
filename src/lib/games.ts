import type { StudySet, StudyTerm } from "../types";

export function shuffle<T>(items: T[]): T[] {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

export function choicesForTerm(set: StudySet, term: StudyTerm, count = 4): string[] {
  const distractors = shuffle(
    set.terms
      .filter((item) => item.id !== term.id)
      .map((item) => item.definition),
  ).slice(0, Math.max(0, count - 1));
  return shuffle([term.definition, ...distractors]);
}

type AnswerSide = "term" | "definition";

function choicesForAnswerSide(
  set: StudySet,
  term: StudyTerm,
  answerSide: AnswerSide,
  count = 4,
): string[] {
  const answer = answerSide === "definition" ? term.definition : term.term;
  const distractors = shuffle(
    set.terms
      .filter((item) => item.id !== term.id)
      .map((item) => (answerSide === "definition" ? item.definition : item.term)),
  ).slice(0, Math.max(0, count - 1));
  return shuffle([answer, ...distractors]);
}

export type TestQuestion =
  | {
      id: string;
      kind: "multiple-choice";
      prompt: string;
      answer: string;
      choices: string[];
    }
  | {
      id: string;
      kind: "matching";
      prompt: string;
      answer: string;
      choices: string[];
    }
  | {
      id: string;
      kind: "written";
      prompt: string;
      answer: string;
    }
  | {
      id: string;
      kind: "true-false";
      prompt: string;
      answer: string;
      shownAnswer: string;
      isTrue: boolean;
    };

export type TestAnswerWith = "both" | "term" | "definition";

export type TestQuestionKind = "true-false" | "multiple-choice" | "matching" | "written";

export type TestSettings = {
  answerWith: TestAnswerWith;
  enabledKinds: TestQuestionKind[];
  questionCount: number;
};

function answerSideForTerm(answerWith: TestAnswerWith, index: number): AnswerSide {
  if (answerWith === "both") return index % 2 === 0 ? "definition" : "term";
  return answerWith;
}

function promptForSide(term: StudyTerm, answerSide: AnswerSide): string {
  return answerSide === "definition" ? term.term : term.definition;
}

function answerForSide(term: StudyTerm, answerSide: AnswerSide): string {
  return answerSide === "definition" ? term.definition : term.term;
}

export function generateConfiguredTestQuestions(
  set: StudySet,
  settings: TestSettings,
): TestQuestion[] {
  const enabledKinds =
    settings.enabledKinds.length > 0 ? settings.enabledKinds : ["multiple-choice" as const];
  const maxGeneratedQuestions = Math.max(1, set.terms.length * enabledKinds.length);
  const questionCount = Math.max(1, Math.min(settings.questionCount, maxGeneratedQuestions));
  const terms = shuffle(set.terms);
  const questions = terms.flatMap((term, index) => {
    const answerSide = answerSideForTerm(settings.answerWith, index);
    const prompt = promptForSide(term, answerSide);
    const answer = answerForSide(term, answerSide);
    const falseTerm = set.terms[(index + 1) % set.terms.length] ?? term;
    const falseAnswer = answerForSide(falseTerm, answerSide);
    const useTrue = index % 2 === 0;

    return enabledKinds.map((kind) => {
      if (kind === "written") {
        return {
          id: `${term.id}-written-${answerSide}`,
          kind,
          prompt,
          answer,
        };
      }

      if (kind === "true-false") {
        return {
          id: `${term.id}-tf-${answerSide}`,
          kind,
          prompt,
          answer,
          shownAnswer: useTrue ? answer : falseAnswer,
          isTrue: useTrue,
        };
      }

      return {
        id: `${term.id}-${kind}-${answerSide}`,
        kind,
        prompt,
        answer,
        choices: choicesForAnswerSide(set, term, answerSide),
      };
    });
  });

  return shuffle(questions).slice(0, questionCount);
}

export function generateTestQuestions(set: StudySet): TestQuestion[] {
  return generateConfiguredTestQuestions(set, {
    answerWith: "both",
    enabledKinds: ["multiple-choice", "written", "true-false"],
    questionCount: set.terms.length * 3,
  });
}

export function normalizeAnswer(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function isCorrectAnswer(input: string, answer: string): boolean {
  return normalizeAnswer(input) === normalizeAnswer(answer);
}

export type BlastTargetState = "idle" | "hit" | "miss";

export type BlastTarget = {
  id: string;
  termId: string;
  text: string;
  isCorrect: boolean;
  x: number;
  y: number;
  speed: number;
  driftX: number;
  driftY: number;
  size: number;
  state: BlastTargetState;
};

export function truncateBlastText(text: string, maxWords = 70): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(" ")}...`;
}

export function blastTargetSize(text: string): number {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const lengthScore = Math.max(text.length / 30, wordCount * 0.48);
  return Math.min(16, Math.max(8.2, 7.4 + lengthScore));
}

export function generateBlastTargets(
  set: StudySet,
  current: StudyTerm,
  round = 0,
  count = 4,
): BlastTarget[] {
  const definitions = choicesForTerm(set, current, Math.min(count, set.terms.length));
  const positions = shuffle([
    { x: 13, y: 58 },
    { x: 28, y: 24 },
    { x: 47, y: 42 },
    { x: 65, y: 18 },
    { x: 78, y: 55 },
    { x: 86, y: 30 },
  ]);

  return definitions.map((definition, index) => {
    const text = truncateBlastText(definition);
    return {
      id: `blast-${current.id}-${round}-${index}`,
      termId: current.id,
      text,
      isCorrect: definition === current.definition,
      x: positions[index % positions.length].x,
      y: positions[index % positions.length].y,
      speed: 0.08 + (index % 3) * 0.025,
      driftX: index % 2 === 0 ? 1 : -1,
      driftY: index % 3 === 0 ? 0.45 : -0.3,
      size: blastTargetSize(text),
      state: "idle" as const,
    };
  });
}

export function isBlastRoundComplete(round: number, totalTerms: number): boolean {
  return round >= totalTerms;
}
