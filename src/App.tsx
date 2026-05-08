import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import type { ImportPayload, StudySet, StudyTerm } from "./types";
import { buildBookmarklet } from "./lib/bookmarklet";
import {
  isCorrectAnswer,
  choicesForTerm,
  generateBlastTargets,
  generateConfiguredTestQuestions,
  isBlastRoundComplete,
  shuffle,
  type BlastTarget,
  type TestAnswerWith,
  type TestQuestion,
  type TestQuestionKind,
  type TestSettings,
} from "./lib/games";
import {
  parseManualImport,
  payloadToStudySet,
  validateImportMessage,
} from "./lib/import";
import { deleteSet, loadSets, saveSets } from "./lib/storage";

type Mode =
  | "review"
  | "edit"
  | "flashcards"
  | "learn"
  | "test"
  | "match"
  | "blocks"
  | "blast";

const modeLabels: Record<Mode, string> = {
  review: "Set Review",
  edit: "Set Edit",
  flashcards: "Flashcards",
  learn: "Learn",
  test: "Test",
  match: "Match",
  blocks: "Blocks",
  blast: "Blast",
};

function currentAppUrl(): string {
  return window.location.href.split("#")[0];
}

function termsSignature(terms: StudyTerm[]): string {
  return terms
    .map((term) => `${term.term.toLocaleLowerCase()}=${term.definition.toLocaleLowerCase()}`)
    .join("|");
}

function setSignature(set: StudySet): string {
  return `${set.sourceUrl ?? ""}|${set.title.toLocaleLowerCase()}|${termsSignature(set.terms)}`;
}

type VoiceLanguage = "auto" | "en-US" | "pl-PL" | "uk-UA";
let activeUtterance: SpeechSynthesisUtterance | null = null;

const voiceLanguageLabels: Record<VoiceLanguage, string> = {
  auto: "Auto",
  "en-US": "English",
  "pl-PL": "Polish",
  "uk-UA": "Ukrainian",
};

function detectVoiceLanguage(text: string): Exclude<VoiceLanguage, "auto"> {
  if (/[ґєіїҐЄІЇ]/.test(text) || /[\u0400-\u04ff]/.test(text)) return "uk-UA";
  if (/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(text)) return "pl-PL";
  return "en-US";
}

function speakText(text: string, language: VoiceLanguage = "auto"): void {
  const Utterance = globalThis.SpeechSynthesisUtterance ?? window.SpeechSynthesisUtterance;
  const synth = window.speechSynthesis;
  if (
    !synth ||
    typeof Utterance === "undefined" ||
    !text.trim()
  ) {
    return;
  }
  const resolvedLanguage = language === "auto" ? detectVoiceLanguage(text) : language;
  const utterance = new Utterance(text);
  const voices =
    typeof synth.getVoices === "function"
      ? synth.getVoices()
      : [];
  const requestedLanguage = resolvedLanguage.toLocaleLowerCase();
  const requestedBaseLanguage = requestedLanguage.split("-")[0];
  const voice = voices.find((item) => {
    const voiceLanguage = item.lang.toLocaleLowerCase().replace("_", "-");
    return (
      voiceLanguage === requestedLanguage ||
      voiceLanguage.startsWith(`${requestedBaseLanguage}-`)
    );
  });
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = resolvedLanguage;
  }

  activeUtterance = utterance;
  utterance.onend = () => {
    if (activeUtterance === utterance) activeUtterance = null;
  };
  utterance.onerror = () => {
    if (activeUtterance === utterance) activeUtterance = null;
  };

  synth.cancel();
  synth.speak(utterance);
  synth.resume?.();
}

function playAnswerFeedback(correct: boolean) {
  const audioWindow = window as Window & {
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextConstructor = window.AudioContext ?? audioWindow.webkitAudioContext;
  if (!AudioContextConstructor) return;

  try {
    const context = new AudioContextConstructor();
    const gain = context.createGain();
    const now = context.currentTime;
    const notes = correct ? [660, 880] : [260, 190];

    gain.connect(context.destination);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(correct ? 0.12 : 0.09, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);

    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      oscillator.type = correct ? "sine" : "triangle";
      oscillator.frequency.setValueAtTime(frequency, now + index * 0.1);
      oscillator.connect(gain);
      oscillator.start(now + index * 0.1);
      oscillator.stop(now + index * 0.1 + 0.14);
    });

    window.setTimeout(() => void context.close(), 420);
  } catch {
    // Browser audio can be unavailable or blocked; visual feedback still works.
  }
}

function App() {
  const [sets, setSets] = useState<StudySet[]>(() => loadSets());
  const [selectedId, setSelectedId] = useState<string | null>(() => loadSets()[0]?.id ?? null);
  const [mode, setMode] = useState<Mode>("review");
  const [notice, setNotice] = useState("");
  const lastImportRef = useRef<{ signature: string; receivedAt: number } | null>(null);
  const selectedSet = sets.find((set) => set.id === selectedId) ?? null;
  const isImportRoute = window.location.hash.startsWith("#/import");

  const addImportedSet = (payload: ImportPayload) => {
    const importedSet = payloadToStudySet(payload);
    const signature = setSignature(importedSet);
    const now = Date.now();

    if (
      lastImportRef.current?.signature === signature &&
      now - lastImportRef.current.receivedAt < 10_000
    ) {
      return;
    }
    lastImportRef.current = { signature, receivedAt: now };

    const currentSets = loadSets();
    const isSameImport = (set: StudySet) =>
      importedSet.sourceUrl
        ? set.sourceUrl === importedSet.sourceUrl
        : setSignature(set) === signature;
    const existingSet = currentSets.find(isSameImport);
    const nextSet = existingSet
      ? {
          ...importedSet,
          id: existingSet.id,
          createdAt: existingSet.createdAt,
          updatedAt: new Date().toISOString(),
        }
      : importedSet;
    const next = existingSet
      ? [nextSet, ...currentSets.filter((set) => !isSameImport(set))]
      : [nextSet, ...currentSets];

    saveSets(next);
    setSets(next);
    setSelectedId(nextSet.id);
    setMode("review");
    setNotice(
      `${existingSet ? "Updated" : "Imported"} ${nextSet.terms.length} terms in "${nextSet.title}".`,
    );
    window.location.hash = "";
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const payload = validateImportMessage(event.data);
      if (!payload) return;
      try {
        addImportedSet(payload);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Import failed.");
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const updateSelectedSet = (nextSet: StudySet) => {
    const next = sets.map((set) => (set.id === nextSet.id ? nextSet : set));
    saveSets(next);
    setSets(next);
  };

  const removeSelectedSet = () => {
    if (!selectedSet) return;
    const next = deleteSet(selectedSet.id);
    setSets(next);
    setSelectedId(next[0]?.id ?? null);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => window.location.assign(currentAppUrl())}>
          Vocab Arcade
        </button>
        <nav className="top-actions" aria-label="Main navigation">
          <button onClick={() => setSelectedId(null)}>Import</button>
          {sets.length > 0 && (
            <select
              aria-label="Saved sets"
              value={selectedId ?? ""}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {sets.map((set) => (
                <option key={set.id} value={set.id}>
                  {set.title}
                </option>
              ))}
            </select>
          )}
        </nav>
      </header>

      {notice && (
        <button className="notice" onClick={() => setNotice("")}>
          {notice}
        </button>
      )}

      {isImportRoute && !selectedSet ? (
        <ImportReceiver />
      ) : selectedSet ? (
        <StudyWorkspace
          mode={mode}
          set={selectedSet}
          onModeChange={setMode}
          onSetChange={updateSelectedSet}
          onDelete={removeSelectedSet}
        />
      ) : (
        <ImportScreen onImport={addImportedSet} sets={sets} onOpenSet={setSelectedId} />
      )}
    </main>
  );
}

function ImportReceiver() {
  return (
    <section className="panel import-receiver">
      <p className="eyebrow">Waiting for import</p>
      <h1>Return to the study page and click the bookmarklet.</h1>
      <p>
        This tab is ready to receive term-definition data from the bookmarklet.
        Keep it open until the import completes.
      </p>
    </section>
  );
}

function ImportScreen({
  onImport,
  sets,
  onOpenSet,
}: {
  onImport: (payload: ImportPayload) => void;
  sets: StudySet[];
  onOpenSet: (id: string) => void;
}) {
  const [sourceUrl, setSourceUrl] = useState("");
  const [manualText, setManualText] = useState("");
  const [error, setError] = useState("");
  const bookmarklet = useMemo(() => buildBookmarklet(currentAppUrl()), []);
  const bookmarkletRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    bookmarkletRef.current?.setAttribute("href", bookmarklet);
  }, [bookmarklet]);

  const importManual = () => {
    setError("");
    try {
      onImport(parseManualImport(manualText));
      setManualText("");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Import failed.");
    }
  };

  return (
    <section className="import-grid">
      <div className="hero-copy">
        <p className="eyebrow">Browser-only vocabulary practice</p>
        <h1>Import a study set and practice it with focused game modes.</h1>
        <p>
          Paste a set link to prepare the bookmarklet workflow, or paste
          term-definition data directly. Everything is saved on this device.
        </p>
      </div>

      <div className="panel">
        <label htmlFor="set-url">Study set link</label>
        <input
          id="set-url"
          value={sourceUrl}
          onChange={(event) => setSourceUrl(event.target.value)}
          placeholder="https://example.com/study-set"
        />
        <div className="steps">
          <span>
            1. Show your bookmarks bar: press <kbd>Cmd</kbd> + <kbd>Shift</kbd> +{" "}
            <kbd>B</kbd> in Chrome or Edge on Mac, or use Safari's View menu.
          </span>
          <span>2. Drag this link to your bookmarks bar:</span>
          <a className="bookmarklet" href="#" ref={bookmarkletRef}>
            Import to Vocab Arcade
          </a>
          <span>
            If dragging fails, right-click it, copy the link address, and paste
            that address into a new bookmark.
          </span>
          <span>3. Open the set page you can access.</span>
          <span>4. Click the bookmarklet while you are on that page.</span>
        </div>
        {sourceUrl && (
          <a className="button-link" href={sourceUrl} target="_blank" rel="noreferrer">
            Open set page
          </a>
        )}
      </div>

      <div className="panel">
        <label htmlFor="manual-import">Paste JSON, CSV, or TSV</label>
        <textarea
          id="manual-import"
          rows={8}
          value={manualText}
          onChange={(event) => setManualText(event.target.value)}
          placeholder={"word\tdefinition\nfront,back"}
        />
        {error && <p className="error">{error}</p>}
        <button onClick={importManual}>Import pasted data</button>
      </div>

      {sets.length > 0 && (
        <div className="panel saved-panel">
          <h2>Saved sets</h2>
          <div className="saved-list">
            {sets.map((set) => (
              <button key={set.id} onClick={() => onOpenSet(set.id)}>
                <strong>{set.title}</strong>
                <span>{set.terms.length} terms</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function StudyWorkspace({
  set,
  mode,
  onModeChange,
  onSetChange,
  onDelete,
}: {
  set: StudySet;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  onSetChange: (set: StudySet) => void;
  onDelete: () => void;
}) {
  return (
    <section className="workspace">
      <div className="set-header">
        <div>
          <p className="eyebrow">{set.terms.length} terms</p>
          <h1>{set.title}</h1>
          {set.sourceUrl && (
            <a href={set.sourceUrl} target="_blank" rel="noreferrer">
              Source page
            </a>
          )}
        </div>
        <button className="danger" onClick={onDelete}>
          Delete set
        </button>
      </div>

      <div className="mode-grid" role="tablist" aria-label="Practice modes">
        {(Object.keys(modeLabels) as Mode[]).map((item) => (
          <button
            key={item}
            className={mode === item ? "active" : ""}
            onClick={() => onModeChange(item)}
            role="tab"
            aria-selected={mode === item}
          >
            {modeLabels[item]}
          </button>
        ))}
      </div>

      {mode === "review" && <ReviewMode set={set} />}
      {mode === "edit" && <EditMode set={set} onSetChange={onSetChange} />}
      {mode === "flashcards" && <FlashcardsMode set={set} />}
      {mode === "learn" && <LearnMode set={set} />}
      {mode === "test" && <TestMode set={set} />}
      {mode === "match" && <MatchMode set={set} />}
      {mode === "blocks" && <BlocksMode set={set} />}
      {mode === "blast" && <BlastMode set={set} onExit={() => onModeChange("review")} />}
    </section>
  );
}

function ReviewMode({ set }: { set: StudySet }) {
  const [query, setQuery] = useState("");
  const [termLanguage, setTermLanguage] = useState<VoiceLanguage>("auto");
  const [definitionLanguage, setDefinitionLanguage] = useState<VoiceLanguage>("auto");
  const visibleTerms = set.terms.filter((term) =>
    `${term.term} ${term.definition}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );

  return (
    <div className="panel">
      <div className="toolbar">
        <input
          aria-label="Search terms"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search terms"
        />
        <div className="voice-controls" aria-label="Voice settings">
          <label>
            Term voice
            <select
              value={termLanguage}
              onChange={(event) => setTermLanguage(event.target.value as VoiceLanguage)}
            >
              {(Object.keys(voiceLanguageLabels) as VoiceLanguage[]).map((language) => (
                <option key={language} value={language}>
                  {voiceLanguageLabels[language]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Definition voice
            <select
              value={definitionLanguage}
              onChange={(event) => setDefinitionLanguage(event.target.value as VoiceLanguage)}
            >
              {(Object.keys(voiceLanguageLabels) as VoiceLanguage[]).map((language) => (
                <option key={language} value={language}>
                  {voiceLanguageLabels[language]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="review-list">
        {visibleTerms.map((term) => (
          <article className="review-row" key={term.id}>
            <div>
              <p>{term.term}</p>
              <button className="icon-button" onClick={() => speakText(term.term, termLanguage)}>
                Speak term
              </button>
            </div>
            <div>
              <p>{term.definition}</p>
              <button
                className="icon-button"
                onClick={() => speakText(term.definition, definitionLanguage)}
              >
                Speak definition
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function EditMode({ set, onSetChange }: { set: StudySet; onSetChange: (set: StudySet) => void }) {
  const [query, setQuery] = useState("");
  const visibleTerms = set.terms.filter((term) =>
    `${term.term} ${term.definition}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );

  const updateTerm = (termId: string, field: "term" | "definition", value: string) => {
    onSetChange({
      ...set,
      terms: set.terms.map((term) => (term.id === termId ? { ...term, [field]: value } : term)),
      updatedAt: new Date().toISOString(),
    });
  };

  const deleteTerm = (termId: string) => {
    onSetChange({
      ...set,
      terms: set.terms.filter((term) => term.id !== termId),
      updatedAt: new Date().toISOString(),
    });
  };

  return (
    <div className="panel">
      <div className="toolbar">
        <input
          aria-label="Search editable terms"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search terms to edit"
        />
        <button
          onClick={() =>
            onSetChange({ ...set, terms: shuffle(set.terms), updatedAt: new Date().toISOString() })
          }
        >
          Shuffle
        </button>
      </div>
      <div className="term-table">
        {visibleTerms.map((term) => (
          <div className="term-row" key={term.id}>
            <textarea
              aria-label={`Edit term ${term.term}`}
              value={term.term}
              onChange={(event) => updateTerm(term.id, "term", event.target.value)}
            />
            <textarea
              aria-label={`Edit definition ${term.definition}`}
              value={term.definition}
              onChange={(event) => updateTerm(term.id, "definition", event.target.value)}
            />
            <button onClick={() => deleteTerm(term.id)}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function FlashcardsMode({ set }: { set: StudySet }) {
  const [cards, setCards] = useState(() => set.terms);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [isFlipping, setIsFlipping] = useState(false);
  const flipTimeoutRef = useRef<number | null>(null);
  const current = cards[index] ?? set.terms[0];

  useEffect(() => {
    if (flipTimeoutRef.current) {
      window.clearTimeout(flipTimeoutRef.current);
      flipTimeoutRef.current = null;
    }
    setCards(set.terms);
    setIndex(0);
    setFlipped(false);
    setIsFlipping(false);
    return () => {
      if (flipTimeoutRef.current) {
        window.clearTimeout(flipTimeoutRef.current);
        flipTimeoutRef.current = null;
      }
    };
  }, [set.id, set.terms.length]);

  const flipCard = () => {
    if (isFlipping) return;
    setIsFlipping(true);
    flipTimeoutRef.current = window.setTimeout(() => {
      setFlipped((value) => !value);
      flipTimeoutRef.current = null;
    }, 120);
  };

  return (
    <div className="panel study-stage">
      <button
        className={`flashcard ${isFlipping ? "flashcard-flipping" : ""}`}
        onAnimationEnd={() => setIsFlipping(false)}
        onClick={flipCard}
      >
        <span>{flipped ? current.definition : current.term}</span>
        <small>Click to flip</small>
      </button>
      <div className="card-controls">
        <button onClick={() => setIndex(Math.max(0, index - 1))}>Previous</button>
        <span>
          {index + 1} / {cards.length}
        </span>
        <button onClick={() => setIndex(Math.min(cards.length - 1, index + 1))}>Next</button>
        <button
          onClick={() => {
            setCards(shuffle(cards));
            setIndex(0);
          }}
        >
          Shuffle
        </button>
        <button onClick={() => current && speakText(flipped ? current.definition : current.term)}>
          Speak
        </button>
      </div>
    </div>
  );
}

function LearnMode({ set }: { set: StudySet }) {
  const learnSectionSize = 7;
  const [queue, setQueue] = useState(() => shuffle(set.terms));
  const [score, setScore] = useState({ correct: 0, total: 0 });
  const [sectionCompleted, setSectionCompleted] = useState<StudyTerm[]>([]);
  const [showSectionSummary, setShowSectionSummary] = useState(false);
  const [feedback, setFeedback] = useState<{
    status: "correct" | "wrong";
    selected: string;
    answer: string;
    prompt: string;
    term: StudyTerm;
  } | null>(null);
  const feedbackTimeoutRef = useRef<number | null>(null);
  const current = queue[0];
  const choices = useMemo(() => (current ? choicesForTerm(set, current) : []), [set, current]);

  useEffect(() => {
    return () => {
      if (feedbackTimeoutRef.current) {
        window.clearTimeout(feedbackTimeoutRef.current);
        feedbackTimeoutRef.current = null;
      }
    };
  }, []);

  const clearFeedbackTimer = () => {
    if (feedbackTimeoutRef.current) {
      window.clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = null;
    }
  };

  const advanceLearn = (term: StudyTerm, wasCorrect: boolean) => {
    const nextSectionCompleted = [...sectionCompleted, term];
    const nextTotal = score.total + 1;
    const shouldShowSummary =
      nextSectionCompleted.length >= learnSectionSize || nextTotal >= set.terms.length;

    setScore((prev) => ({
      correct: prev.correct + (wasCorrect ? 1 : 0),
      total: prev.total + 1,
    }));
    setSectionCompleted(nextSectionCompleted);
    setQueue((prev) => [
      ...prev.slice(1),
      ...(wasCorrect ? [] : [term]),
    ]);
    setFeedback(null);
    if (shouldShowSummary) {
      setShowSectionSummary(true);
    }
  };

  const answer = (value: string) => {
    if (!current || feedback || showSectionSummary) return;
    const correct = isCorrectAnswer(value, current.definition);
    playAnswerFeedback(correct);
    setFeedback({
      status: correct ? "correct" : "wrong",
      selected: value,
      answer: current.definition,
      prompt: current.term,
      term: current,
    });

    if (correct) {
      feedbackTimeoutRef.current = window.setTimeout(() => {
        advanceLearn(current, true);
        feedbackTimeoutRef.current = null;
      }, 700);
    }
  };

  const continueLearn = () => {
    if (!feedback) return;
    clearFeedbackTimer();
    advanceLearn(feedback.term, feedback.status === "correct");
  };

  const restartLearn = () => {
    clearFeedbackTimer();
    setQueue(shuffle(set.terms));
    setScore({ correct: 0, total: 0 });
    setSectionCompleted([]);
    setShowSectionSummary(false);
    setFeedback(null);
  };

  const continueFromSummary = () => {
    setSectionCompleted([]);
    setShowSectionSummary(false);
  };

  const renderProgress = () => {
    const progressTotal = Math.max(1, set.terms.length);
    const completed = Math.min(progressTotal, score.total);
    const segmentCount = Math.min(8, progressTotal);
    const segments = Array.from(
      { length: segmentCount },
      (_, index) => (index + 1) / segmentCount <= completed / progressTotal,
    );
    return (
      <div className="learn-progress" aria-label="Learn progress">
        <div className="learn-progress-track">
          {segments.map((filled, index) => (
            <span
              className={filled ? "filled" : ""}
              key={`${set.id}-learn-progress-${index}`}
            />
          ))}
        </div>
        <strong>
          {completed} / {progressTotal}
        </strong>
      </div>
    );
  };

  const renderSummary = () => {
    const progressTotal = Math.max(1, set.terms.length);
    const progressPercent = Math.round((Math.min(score.total, progressTotal) / progressTotal) * 100);
    return (
      <div className="learn-summary">
        <h2>Going strong. You can do this!</h2>
        <p>
          Total set progress: <strong>{progressPercent}%</strong>
        </p>
        <div
          className="learn-summary-bar"
          style={{ "--summary-correct-position": `${progressPercent}%` } as CSSProperties}
        >
          <span style={{ width: `${progressPercent}%` }} />
          <strong>{score.correct}</strong>
          <em>{progressTotal}</em>
        </div>
        <div className="learn-summary-labels">
          <span>Correct</span>
          <span>Total questions</span>
        </div>
        <h3>Terms studied in this round</h3>
        <div className="learn-summary-list">
          {sectionCompleted.map((term) => (
            <div className="learn-summary-row" key={`${term.id}-summary`}>
              <span>{term.term}</span>
              <span>{term.definition}</span>
              <button
                aria-label={`Speak ${term.term}`}
                className="icon-button"
                onClick={() => speakText(term.term)}
              >
                Speak
              </button>
            </div>
          ))}
        </div>
        <div className="learn-review-actions">
          <span>Press Continue to keep practicing</span>
          <button onClick={continueFromSummary}>Continue</button>
        </div>
      </div>
    );
  };

  useEffect(() => {
    clearFeedbackTimer();
    setQueue(shuffle(set.terms));
    setFeedback(null);
    setScore({ correct: 0, total: 0 });
    setSectionCompleted([]);
    setShowSectionSummary(false);
  }, [set.id, set.terms.length]);

  if (showSectionSummary) {
    return <div className="learn-shell">{renderSummary()}</div>;
  }

  if (!current) {
    return (
      <div className="panel empty-state">
        <h2>Round complete</h2>
        <button onClick={restartLearn}>Practice again</button>
      </div>
    );
  }

  return (
    <div className="learn-shell">
      {renderProgress()}
      <div className="panel quiz-panel learn-panel">
        <div>
          <p className="eyebrow">
            {score.correct} correct of {score.total}
          </p>
          <h2>{feedback?.prompt ?? current.term}</h2>
        </div>
        <div className="choice-grid">
          {choices.map((choice) => {
            const isSelected = feedback?.selected === choice;
            const isCorrectAnswerChoice = feedback?.answer === choice;
            const feedbackClass =
              feedback?.status === "wrong" && isCorrectAnswerChoice
                ? "choice-correct choice-reviewed"
                : feedback?.status === "correct" && isCorrectAnswerChoice
                  ? "choice-correct"
                  : feedback?.status === "wrong" && isSelected
                    ? "choice-wrong choice-reviewed"
                    : "";

            return (
              <button
                key={choice}
                className={feedbackClass}
                disabled={Boolean(feedback)}
                onClick={() => answer(choice)}
              >
                {choice}
              </button>
            );
          })}
        </div>
        {feedback?.status === "correct" && <p className="result">Correct</p>}
        {feedback?.status === "wrong" && (
          <div className="learn-review">
            <p className="learn-review-message">No worries. Learning is a process.</p>
            <div className="learn-review-actions">
              <span>Select the correct answer or press Continue</span>
              <button onClick={continueLearn}>Continue</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TestMode({ set }: { set: StudySet }) {
  const maxQuestions = Math.max(1, set.terms.length);
  const defaultSettings: TestSettings = {
    answerWith: "both",
    enabledKinds: ["multiple-choice"],
    questionCount: Math.min(20, maxQuestions),
  };
  const [setupOpen, setSetupOpen] = useState(true);
  const [settings, setSettings] = useState<TestSettings>(defaultSettings);
  const [questions, setQuestions] = useState<TestQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [graded, setGraded] = useState(false);

  useEffect(() => {
    setSetupOpen(true);
    setSettings(defaultSettings);
    setQuestions([]);
    setAnswers({});
    setGraded(false);
  }, [set.id, set.terms.length]);

  const setKindEnabled = (kind: TestQuestionKind, enabled: boolean) => {
    setSettings((current) => {
      const enabledKinds = enabled
        ? Array.from(new Set([...current.enabledKinds, kind]))
        : current.enabledKinds.filter((item) => item !== kind);
      return { ...current, enabledKinds };
    });
  };

  const startTest = () => {
    setQuestions(generateConfiguredTestQuestions(set, settings));
    setAnswers({});
    setGraded(false);
    setSetupOpen(false);
  };

  const score = questions.filter((question) => {
    const answer = answers[question.id] ?? "";
    if (question.kind === "true-false") return answer === String(question.isTrue);
    return isCorrectAnswer(answer, question.answer);
  }).length;

  if (setupOpen) {
    const canStart = settings.enabledKinds.length > 0;
    return (
      <div className="test-setup">
        <div className="test-setup-header">
          <div>
            <p>{set.title}</p>
            <h2>Set up your test</h2>
          </div>
          <div className="test-doc-icon" aria-hidden="true">
            <span />
          </div>
        </div>

        <div className="test-setting-row">
          <label htmlFor="test-question-count">Questions (max {maxQuestions})</label>
          <input
            id="test-question-count"
            type="number"
            min={1}
            max={maxQuestions}
            value={settings.questionCount}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                questionCount: Math.max(
                  1,
                  Math.min(maxQuestions, Number(event.target.value) || 1),
                ),
              }))
            }
          />
        </div>

        <div className="test-setting-row">
          <label htmlFor="test-answer-with">Answer with</label>
          <select
            id="test-answer-with"
            value={settings.answerWith}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                answerWith: event.target.value as TestAnswerWith,
              }))
            }
          >
            <option value="both">Both</option>
            <option value="definition">Definition</option>
            <option value="term">Term</option>
          </select>
        </div>

        <div className="test-kind-list">
          {[
            ["true-false", "True/False"],
            ["multiple-choice", "Multiple Choice"],
            ["matching", "Matching"],
            ["written", "Written"],
          ].map(([kind, label]) => (
            <label className="switch-row" key={kind}>
              <span>{label}</span>
              <input
                type="checkbox"
                checked={settings.enabledKinds.includes(kind as TestQuestionKind)}
                onChange={(event) =>
                  setKindEnabled(kind as TestQuestionKind, event.target.checked)
                }
              />
              <i aria-hidden="true" />
            </label>
          ))}
        </div>

        <div className="test-setup-actions">
          <button disabled={!canStart} onClick={startTest}>
            Start test
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel test-panel">
      <div className="toolbar">
        <button
          onClick={() => {
            setSetupOpen(true);
            setAnswers({});
            setGraded(false);
          }}
        >
          Set up new test
        </button>
        <button onClick={() => setGraded(true)}>Grade test</button>
        {graded && <strong>{score} / {questions.length}</strong>}
      </div>
      {questions.slice(0, Math.min(18, questions.length)).map((question) => (
        <div className="question" key={question.id}>
          <p>{question.prompt}</p>
          {question.kind === "multiple-choice" && (
            <div className="choice-grid">
              {question.choices.map((choice) => (
                <label key={choice}>
                  <input
                    type="radio"
                    name={question.id}
                    value={choice}
                    checked={answers[question.id] === choice}
                    onChange={(event) =>
                      setAnswers((prev) => ({ ...prev, [question.id]: event.target.value }))
                    }
                  />
                  {choice}
                </label>
              ))}
            </div>
          )}
          {question.kind === "matching" && (
            <div className="choice-grid matching-grid">
              {question.choices.map((choice) => (
                <button
                  key={choice}
                  className={answers[question.id] === choice ? "selected" : ""}
                  onClick={() => setAnswers((prev) => ({ ...prev, [question.id]: choice }))}
                >
                  {choice}
                </button>
              ))}
            </div>
          )}
          {question.kind === "written" && (
            <input
              value={answers[question.id] ?? ""}
              onChange={(event) =>
                setAnswers((prev) => ({ ...prev, [question.id]: event.target.value }))
              }
            />
          )}
          {question.kind === "true-false" && (
            <div className="true-false">
              <span>{question.shownAnswer}</span>
              <button onClick={() => setAnswers((prev) => ({ ...prev, [question.id]: "true" }))}>
                True
              </button>
              <button onClick={() => setAnswers((prev) => ({ ...prev, [question.id]: "false" }))}>
                False
              </button>
            </div>
          )}
          {graded && <small>Answer: {question.answer}</small>}
        </div>
      ))}
    </div>
  );
}

function MatchMode({ set }: { set: StudySet }) {
  const sourceTerms = set.terms.slice(0, 8);
  const [items, setItems] = useState(() => makeMatchItems(sourceTerms));
  const [selected, setSelected] = useState<string[]>([]);
  const [startedAt] = useState(Date.now());

  const pick = (id: string) => {
    const next = [...selected, id].slice(-2);
    setSelected(next);
    if (next.length !== 2) return;
    const [first, second] = next.map((itemId) => items.find((item) => item.id === itemId));
    if (first && second && first.termId === second.termId && first.kind !== second.kind) {
      setTimeout(() => setItems((prev) => prev.filter((item) => !next.includes(item.id))), 200);
    }
    setTimeout(() => setSelected([]), 250);
  };

  return (
    <div className="panel">
      <div className="toolbar">
        <strong>{items.length === 0 ? `Complete in ${Math.round((Date.now() - startedAt) / 1000)}s` : "Match pairs"}</strong>
        <button onClick={() => setItems(makeMatchItems(sourceTerms))}>Reset</button>
      </div>
      <div className="tile-grid">
        {items.map((item) => (
          <button
            key={item.id}
            className={selected.includes(item.id) ? "selected" : ""}
            onClick={() => pick(item.id)}
          >
            {item.text}
          </button>
        ))}
      </div>
    </div>
  );
}

function makeMatchItems(terms: StudyTerm[]) {
  return shuffle(
    terms.flatMap((term) => [
      { id: `${term.id}-term`, termId: term.id, kind: "term", text: term.term },
      { id: `${term.id}-definition`, termId: term.id, kind: "definition", text: term.definition },
    ]),
  );
}

function BlocksMode({ set }: { set: StudySet }) {
  const terms = set.terms.slice(0, 10);
  const [blocks, setBlocks] = useState(() => makeMatchItems(terms));
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState("Clear matching blocks.");

  const pick = (id: string) => {
    const next = [...selected, id].slice(-2);
    setSelected(next);
    if (next.length !== 2) return;
    const [first, second] = next.map((itemId) => blocks.find((block) => block.id === itemId));
    if (first && second && first.termId === second.termId && first.kind !== second.kind) {
      setMessage("Match cleared");
      setBlocks((prev) => prev.filter((block) => !next.includes(block.id)));
    } else {
      setMessage("Try another pair");
    }
    setTimeout(() => setSelected([]), 350);
  };

  return (
    <div className="panel">
      <div className="toolbar">
        <strong>{message}</strong>
        <button
          onClick={() => {
            setBlocks(makeMatchItems(terms));
            setMessage("Clear matching blocks.");
          }}
        >
          Reset
        </button>
      </div>
      <div className="blocks-grid">
        {blocks.map((block) => (
          <button
            key={block.id}
            className={selected.includes(block.id) ? "selected" : ""}
            onClick={() => pick(block.id)}
          >
            {block.text}
          </button>
        ))}
      </div>
      {blocks.length === 0 && <p className="result">Board cleared.</p>}
    </div>
  );
}

function BlastMode({ set, onExit }: { set: StudySet; onExit: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const shipRef = useRef<HTMLDivElement>(null);
  const cannonRef = useRef<HTMLElement>(null);
  const [deck, setDeck] = useState(() => shuffle(set.terms));
  const [round, setRound] = useState(0);
  const [targets, setTargets] = useState<BlastTarget[]>([]);
  const [shot, setShot] = useState<{
    id: string;
    angle: number;
    originX: number;
    originY: number;
    width: number;
  } | null>(null);
  const [aimDegrees, setAimDegrees] = useState(-90);
  const [score, setScore] = useState(0);
  const [misses, setMisses] = useState(0);
  const [streak, setStreak] = useState(0);
  const [progress, setProgress] = useState(100);
  const [muted, setMuted] = useState(false);
  const [message, setMessage] = useState("Pick the matching definition.");
  const [locked, setLocked] = useState(false);
  const current = deck[round];
  const complete = isBlastRoundComplete(round, deck.length);
  const level = Math.max(1, Math.floor(score / 10) + 1);

  const restart = () => {
    setDeck(shuffle(set.terms));
    setRound(0);
    setScore(0);
    setMisses(0);
    setStreak(0);
    setProgress(100);
    setShot(null);
    setMessage("Pick the matching definition.");
    setLocked(false);
  };

  const advanceRound = (wasCorrect: boolean) => {
    if (wasCorrect) {
      setScore((value) => value + 1);
      setStreak((value) => value + 1);
      setMessage("Direct hit.");
    } else {
      setMisses((value) => value + 1);
      setStreak(0);
      setMessage("Target missed.");
    }
    setProgress(100);
    setLocked(false);
    setRound((value) => value + 1);
  };

  useEffect(() => {
    restart();
  }, [set.id, set.terms.length]);

  useEffect(() => {
    if (!current || complete) return;
    setTargets(generateBlastTargets(set, current, round));
    setProgress(100);
    setShot(null);
    setLocked(false);
    setMessage("Pick the matching definition.");
    if (!muted) speakText(current.term);
  }, [complete, current?.id, muted, round, set]);

  useEffect(() => {
    if (!current || complete || locked) return;
    const timer = window.setInterval(() => {
      setTargets((items) =>
        items.map((target) =>
          target.state === "idle"
            ? {
                ...target,
                x: Math.min(91, Math.max(9, target.x + target.driftX * target.speed)),
                y: Math.min(78, Math.max(15, target.y + target.driftY * target.speed)),
                driftX:
                  target.x <= 9 || target.x >= 91 ? target.driftX * -1 : target.driftX,
                driftY:
                  target.y <= 15 || target.y >= 78 ? target.driftY * -1 : target.driftY,
              }
            : target,
        ),
      );
      setProgress((value) => Math.max(0, value - 0.7 - level * 0.05));
    }, 80);

    return () => window.clearInterval(timer);
  }, [complete, current, level, locked]);

  useEffect(() => {
    if (!current || complete || locked || progress > 0) return;
    setLocked(true);
    window.setTimeout(() => advanceRound(false), 220);
  }, [complete, current, locked, progress]);

  const pointFromStageEvent = (event: MouseEvent<HTMLElement>) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const cannonBase = () => {
    const stageRect = stageRef.current?.getBoundingClientRect();
    const shipRect = shipRef.current?.getBoundingClientRect();
    const cannon = cannonRef.current;
    if (!stageRect || !shipRect || !cannon) return { x: 0, y: 0 };

    return {
      x: shipRect.left + shipRect.width / 2 - stageRect.left,
      y: shipRect.top + cannon.offsetTop + cannon.offsetHeight - stageRect.top,
    };
  };

  const shotGeometry = (target: { x: number; y: number }) => {
    const base = cannonBase();
    const baseDeltaX = target.x - base.x;
    const baseDeltaY = target.y - base.y;
    const angleRadians = Math.atan2(baseDeltaY, baseDeltaX);
    const cannonLength = cannonRef.current?.offsetHeight ?? 0;
    const origin = {
      x: base.x + Math.cos(angleRadians) * cannonLength,
      y: base.y + Math.sin(angleRadians) * cannonLength,
    };
    const shotDeltaX = target.x - origin.x;
    const shotDeltaY = target.y - origin.y;

    return {
      angle: (Math.atan2(shotDeltaY, shotDeltaX) * 180) / Math.PI,
      originX: origin.x,
      originY: origin.y,
      width: Math.hypot(shotDeltaX, shotDeltaY),
    };
  };

  const updateAim = (event: MouseEvent<HTMLDivElement>) => {
    const point = pointFromStageEvent(event);
    setAimDegrees(shotGeometry(point).angle + 90);
  };

  const chooseTarget = (target: BlastTarget, event: MouseEvent<HTMLButtonElement>) => {
    if (locked || complete || target.state !== "idle") return;
    setShot({ id: target.id, ...shotGeometry(pointFromStageEvent(event)) });
    if (target.isCorrect) {
      setLocked(true);
      setTargets((items) =>
        items.map((item) => (item.id === target.id ? { ...item, state: "hit" } : item)),
      );
      window.setTimeout(() => advanceRound(true), 260);
      return;
    }

    setMisses((value) => value + 1);
    setStreak(0);
    setMessage("Not that one.");
    setTargets((items) =>
      items.map((item) => (item.id === target.id ? { ...item, state: "miss" } : item)),
    );
    window.setTimeout(() => {
      setTargets((items) => items.filter((item) => item.id !== target.id));
      setShot(null);
    }, 360);
  };

  if (complete) {
    return (
      <div className="blast-shell">
        <div className="blast-topbar">
          <strong>Blast</strong>
          <span>{set.title}</span>
          <button onClick={onExit}>Exit</button>
        </div>
        <div className="blast-finish">
          <p className="eyebrow">Mission complete</p>
          <h2>{score} direct hits</h2>
          <p>
            Level {level} with {misses} misses.
          </p>
          <div className="card-controls">
            <button onClick={restart}>Play again</button>
            <button onClick={onExit}>Back to set</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="blast-shell">
      <div className="blast-topbar">
        <strong>Blast</strong>
        <span>{set.title}</span>
        <div className="blast-actions">
          <button onClick={() => setMuted((value) => !value)}>{muted ? "Sound off" : "Sound on"}</button>
          <button onClick={restart}>Restart</button>
          <button onClick={onExit}>Exit</button>
        </div>
      </div>
      <div className="blast-prompt">
        <div className="blast-progress" style={{ width: `${progress}%` }} />
        <span>{current?.term}</span>
      </div>
      <div
        className="blast-stage"
        aria-label="Blast answer field"
        ref={stageRef}
        onMouseMove={updateAim}
      >
        <span className="blast-status">{message}</span>
        {shot && (
          <span
            className="blast-shot"
            style={{
              left: `${shot.originX}px`,
              top: `${shot.originY}px`,
              width: `${shot.width}px`,
              transform: `rotate(${shot.angle}deg)`,
            }}
          />
        )}
        {targets.map((target) => (
          <button
            key={target.id}
            className={`asteroid asteroid-${target.state}`}
            style={{
              left: `${target.x}%`,
              top: `${target.y}%`,
              width: `${target.size}rem`,
              height: `${target.size}rem`,
            }}
            onClick={(event) => chooseTarget(target, event)}
          >
            {target.text}
          </button>
        ))}
        <div className="ship" aria-hidden="true" ref={shipRef}>
          <i
            className="ship-cannon"
            ref={cannonRef}
            style={{ transform: `translateX(-50%) rotate(${aimDegrees}deg)` }}
          />
          <span />
        </div>
        <div className="blast-hud blast-hud-left">
          <strong>Lvl {level}</strong>
          <span>
            {score}/{deck.length}
          </span>
          <small>Misses {misses}</small>
        </div>
        <div className="blast-hud blast-hud-right">
          <span>Streak</span>
          <strong>{streak}</strong>
        </div>
      </div>
    </div>
  );
}

export default App;
