import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import App from "./App";

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = "";
  });

  const seedSet = () => {
    localStorage.setItem(
      "vocab-arcade:sets",
      JSON.stringify([
        {
          id: "set-1",
          title: "Numbers",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          terms: [
            { id: "term-1", term: "one", definition: "uno" },
            { id: "term-2", term: "two", definition: "dos" },
            { id: "term-3", term: "three", definition: "tres" },
            { id: "term-4", term: "four", definition: "cuatro" },
          ],
        },
      ]),
    );
  };

  const seedLargeSet = () => {
    localStorage.setItem(
      "vocab-arcade:sets",
      JSON.stringify([
        {
          id: "set-large",
          title: "Large Numbers",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          terms: Array.from({ length: 8 }, (_, index) => ({
            id: `term-${index + 1}`,
            term: `term ${index + 1}`,
            definition: `definition ${index + 1}`,
          })),
        },
      ]),
    );
  };

  it("renders the import flow", () => {
    render(<App />);

    expect(screen.getByText("Vocab Arcade")).toBeInTheDocument();

    expect(screen.getByText("Import to Vocab Arcade")).toBeInTheDocument();
  });

  it("ignores repeated bookmarklet messages for the same import", () => {
    render(<App />);
    const message = {
      source: "vocab-arcade-bookmarklet",
      payload: {
        title: "Numbers",
        sourceUrl: "https://example.com/study-set",
        terms: [
          { term: "Term", definition: "Definition" },
          { term: "oneuno", definition: "uno" },
        ],
      },
    };

    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: message }));
      window.dispatchEvent(new MessageEvent("message", { data: message }));
      window.dispatchEvent(new MessageEvent("message", { data: message }));
    });

    const sets = JSON.parse(localStorage.getItem("vocab-arcade:sets") ?? "[]");
    expect(sets).toHaveLength(1);
    expect(sets[0].terms).toHaveLength(1);
    expect(sets[0].terms[0]).toMatchObject({ term: "one", definition: "uno" });
  });

  it("collapses existing duplicate sets when the source is re-imported", () => {
    const duplicateSet = {
      id: "set-old",
      title: "Numbers",
      sourceUrl: "https://example.com/study-set",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      terms: [{ id: "term-old", term: "one", definition: "uno" }],
    };
    localStorage.setItem(
      "vocab-arcade:sets",
      JSON.stringify([
        duplicateSet,
        { ...duplicateSet, id: "set-duplicate" },
        { ...duplicateSet, id: "set-third" },
      ]),
    );
    render(<App />);

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            source: "vocab-arcade-bookmarklet",
            payload: {
              title: "Numbers",
              sourceUrl: "https://example.com/study-set",
              terms: [{ term: "two", definition: "dos" }],
            },
          },
        }),
      );
    });

    const sets = JSON.parse(localStorage.getItem("vocab-arcade:sets") ?? "[]");
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({
      id: "set-old",
      sourceUrl: "https://example.com/study-set",
    });
    expect(sets[0].terms[0]).toMatchObject({ term: "two", definition: "dos" });
  });

  it("shows Set Review and Set Edit as separate modes", () => {
    seedSet();
    render(<App />);

    expect(screen.getByRole("tab", { name: "Set Review" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Set Edit" })).toBeInTheDocument();
  });

  it("removes imported page control rows from saved sets", () => {
    localStorage.setItem(
      "vocab-arcade:sets",
      JSON.stringify([
        {
          id: "set-1",
          title: "Numbers",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          terms: [
            { id: "term-hint", term: "Get a hint", definition: "Get a hint" },
            { id: "term-1", term: "one", definition: "uno" },
          ],
        },
      ]),
    );

    render(<App />);

    expect(screen.queryByText("Get a hint")).not.toBeInTheDocument();
    expect(screen.getByText("one")).toBeInTheDocument();
    const sets = JSON.parse(localStorage.getItem("vocab-arcade:sets") ?? "[]");
    expect(sets[0].terms).toHaveLength(1);
    expect(sets[0].terms[0]).toMatchObject({ term: "one", definition: "uno" });
  });

  it("renders Set Review as readonly rows with pronunciation buttons", () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { speak, cancel, resume: vi.fn(), getVoices: () => [{ lang: "uk-UA" }] },
    });
    Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
      configurable: true,
      value: function MockSpeechSynthesisUtterance(this: { text: string }, text: string) {
        this.text = text;
      },
    });
    seedSet();
    render(<App />);

    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("uno")).toBeInTheDocument();
    expect(screen.getByLabelText("Voice settings")).toBeInTheDocument();
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
    expect(screen.queryByText("Term")).not.toBeInTheDocument();
    expect(screen.queryByText("Definition")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Speak term" })[0]);
    expect(speak).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });

  it("applies selected pronunciation language", () => {
    const speak = vi.fn();
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { speak, cancel: vi.fn(), resume: vi.fn(), getVoices: () => [] },
    });
    Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
      configurable: true,
      value: function MockSpeechSynthesisUtterance(
        this: { text: string; lang?: string },
        text: string,
      ) {
        this.text = text;
      },
    });
    seedSet();
    render(<App />);

    fireEvent.change(screen.getByLabelText("Term voice"), {
      target: { value: "pl-PL" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Speak term" })[0]);

    expect(speak.mock.calls[0][0].lang).toBe("pl-PL");
  });

  it("keeps editing inside Set Edit", () => {
    seedSet();
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: "Set Edit" }));
    expect(screen.getByLabelText("Edit term one")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Edit term one"), {
      target: { value: "first" },
    });

    const sets = JSON.parse(localStorage.getItem("vocab-arcade:sets") ?? "[]");
    expect(sets[0].terms[0].term).toBe("first");
  });

  it("shows Learn feedback for a selected correct answer", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    seedSet();
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: "Learn" }));
    const correctChoice = screen.getByRole("button", { name: "dos" });
    fireEvent.click(correctChoice);

    expect(screen.getByText("Correct")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "dos" })).toHaveClass("choice-correct");
    random.mockRestore();
  });

  it("keeps wrong Learn answers visible until Continue is clicked", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    seedSet();
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: "Learn" }));
    fireEvent.click(screen.getByRole("button", { name: "uno" }));

    expect(screen.getByText("No worries. Learning is a process.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "two" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "uno" })).toHaveClass("choice-wrong");
    expect(screen.getByRole("button", { name: "dos" })).toHaveClass("choice-correct");
    expect(screen.getByText("0 / 4")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.queryByText("No worries. Learning is a process.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "three" })).toBeInTheDocument();
    expect(screen.getByText("1 / 4")).toBeInTheDocument();
    random.mockRestore();
  });

  it("auto-advances correct Learn answers", () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    seedSet();
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: "Learn" }));
    fireEvent.click(screen.getByRole("button", { name: "dos" }));
    expect(screen.getByRole("heading", { name: "two" })).toBeInTheDocument();
    expect(screen.getByText("0 / 4")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(screen.getByRole("heading", { name: "three" })).toBeInTheDocument();
    expect(screen.getByText("1 / 4")).toBeInTheDocument();
    random.mockRestore();
    vi.useRealTimers();
  });

  it("shows persisted Learn settings with requested defaults", () => {
    seedSet();
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: "Learn" }));
    fireEvent.click(screen.getByRole("button", { name: "Learn settings" }));

    expect(screen.getByLabelText("Shuffle")).toBeChecked();
    expect(screen.getByLabelText("Multiple Choice")).toBeChecked();
    expect(screen.getByLabelText("Written answers")).not.toBeChecked();

    fireEvent.click(screen.getByLabelText("Written answers"));

    expect(screen.getByLabelText("Written answers")).toBeChecked();
    expect(JSON.parse(localStorage.getItem("vocab-arcade:learn-settings") ?? "{}")).toMatchObject({
      shuffle: true,
      multipleChoice: true,
      written: true,
    });
  });

  it("runs written Learn answers after the multiple-choice pass when enabled", () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    seedSet();
    render(<App />);
    const answersByTerm = new Map([
      ["one", "uno"],
      ["two", "dos"],
      ["three", "tres"],
      ["four", "cuatro"],
    ]);

    fireEvent.click(screen.getByRole("tab", { name: "Learn" }));
    fireEvent.click(screen.getByRole("button", { name: "Learn settings" }));
    fireEvent.click(screen.getByLabelText("Written answers"));

    for (let index = 0; index < 4; index += 1) {
      expect(screen.queryByLabelText("Write the matching term")).not.toBeInTheDocument();
      const prompt = screen.getByRole("heading", { level: 2 }).textContent ?? "";
      const answer = answersByTerm.get(prompt);
      expect(answer).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: answer }));
      act(() => {
        vi.advanceTimersByTime(700);
      });
    }

    expect(screen.getByText("Written")).toBeInTheDocument();
    expect(screen.getByLabelText("Write the matching term")).toBeInTheDocument();

    random.mockRestore();
    vi.useRealTimers();
  });

  it("can start Learn in written-only mode", () => {
    seedSet();
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: "Learn" }));
    fireEvent.click(screen.getByRole("button", { name: "Learn settings" }));
    fireEvent.click(screen.getByLabelText("Multiple Choice"));

    expect(screen.getByLabelText("Multiple Choice")).not.toBeChecked();
    expect(screen.getByLabelText("Written answers")).toBeChecked();
    expect(screen.getByText("Written")).toBeInTheDocument();
    expect(screen.getByLabelText("Write the matching term")).toBeInTheDocument();
  });

  it("keeps Learn multiple-choice only through the first section", () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    seedLargeSet();
    render(<App />);
    const answersByTerm = new Map(
      Array.from({ length: 8 }, (_, index) => [`term ${index + 1}`, `definition ${index + 1}`]),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Learn" }));

    for (let index = 0; index < 7; index += 1) {
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      const prompt = screen.getByRole("heading", { level: 2 }).textContent ?? "";
      const answer = answersByTerm.get(prompt);
      expect(answer).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: answer }));
      act(() => {
        vi.advanceTimersByTime(700);
      });
    }

    expect(screen.getByText("Going strong. You can do this!")).toBeInTheDocument();
    expect(screen.getByText("Total set progress:")).toBeInTheDocument();
    expect(screen.getByText("88%")).toBeInTheDocument();
    expect(screen.getByText("Terms studied in this round")).toBeInTheDocument();
    expect(screen.getByText("term 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();

    random.mockRestore();
    vi.useRealTimers();
  });

  it("continues Learn after a section summary", () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    seedLargeSet();
    render(<App />);
    const answersByTerm = new Map(
      Array.from({ length: 8 }, (_, index) => [`term ${index + 1}`, `definition ${index + 1}`]),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Learn" }));
    for (let index = 0; index < 7; index += 1) {
      const prompt = screen.getByRole("heading", { level: 2 }).textContent ?? "";
      fireEvent.click(screen.getByRole("button", { name: answersByTerm.get(prompt) }));
      act(() => {
        vi.advanceTimersByTime(700);
      });
    }

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.queryByText("Going strong. You can do this!")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    random.mockRestore();
    vi.useRealTimers();
  });
});
