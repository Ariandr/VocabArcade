import { describe, expect, it } from "vitest";
import type { StudySet } from "../types";
import {
  blastTargetSize,
  choicesForTerm,
  generateBlastTargets,
  generateTestQuestions,
  isBlastRoundComplete,
  isCorrectAnswer,
  normalizeAnswer,
  truncateBlastText,
} from "./games";

const set: StudySet = {
  id: "set-1",
  title: "Numbers",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  terms: [
    { id: "1", term: "one", definition: "uno" },
    { id: "2", term: "two", definition: "dos" },
    { id: "3", term: "three", definition: "tres" },
    { id: "4", term: "four", definition: "cuatro" },
  ],
};

describe("game helpers", () => {
  it("builds multiple-choice options with the correct answer", () => {
    const choices = choicesForTerm(set, set.terms[0]);

    expect(choices).toContain("uno");
    expect(choices).toHaveLength(4);
  });

  it("generates mixed test questions", () => {
    const questions = generateTestQuestions(set);

    expect(questions.some((question) => question.kind === "multiple-choice")).toBe(true);
    expect(questions.some((question) => question.kind === "written")).toBe(true);
    expect(questions.some((question) => question.kind === "true-false")).toBe(true);
  });

  it("normalizes written answers", () => {
    expect(normalizeAnswer("  One   Two ")).toBe("one two");
    expect(isCorrectAnswer(" UNO ", "uno")).toBe(true);
  });

  it("generates blast targets with one correct option", () => {
    const targets = generateBlastTargets(set, set.terms[0], 2);

    expect(targets).toHaveLength(4);
    expect(targets.filter((target) => target.isCorrect)).toHaveLength(1);
    expect(targets.find((target) => target.isCorrect)?.text).toBe("uno");
    expect(targets.every((target) => target.y > 0 && target.y < 100)).toBe(true);
    expect(targets.every((target) => target.speed > 0 && target.speed < 0.2)).toBe(true);
  });

  it("sizes blast targets based on text length", () => {
    expect(blastTargetSize("short")).toBeGreaterThanOrEqual(8.2);
    expect(blastTargetSize("short")).toBeLessThan(
      blastTargetSize("a longer definition that needs more room in the target"),
    );
  });

  it("caps very long blast definitions at seventy words", () => {
    const longText = Array.from({ length: 75 }, (_, index) => `word${index}`).join(" ");
    const truncated = truncateBlastText(longText);

    expect(truncated.split(/\s+/)).toHaveLength(70);
    expect(truncated.endsWith("...")).toBe(true);
  });

  it("detects blast completion", () => {
    expect(isBlastRoundComplete(3, 4)).toBe(false);
    expect(isBlastRoundComplete(4, 4)).toBe(true);
  });
});
