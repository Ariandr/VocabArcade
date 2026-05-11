import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
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
  makeId,
} from "./lib/import";
import {
  loadLearnSettings,
  deleteSet,
  loadSets,
  normalizeLearnSettings,
  saveLearnSettings,
  saveSets,
  type LearnSettings,
} from "./lib/storage";
import {
  appLocaleLabels,
  appLocaleShortLabels,
  appLocales,
  loadAppLocale,
  saveAppLocale,
  translate,
  type AppLocale,
  type TranslationKey,
  type TranslationParams,
} from "./lib/i18n";

type Mode =
  | "review"
  | "edit"
  | "flashcards"
  | "learn"
  | "test"
  | "match"
  | "blocks"
  | "blast";

const modeLabelKeys: Record<Mode, TranslationKey> = {
  review: "mode.review",
  edit: "mode.edit",
  flashcards: "mode.flashcards",
  learn: "mode.learn",
  test: "mode.test",
  match: "mode.match",
  blocks: "mode.blocks",
  blast: "mode.blast",
};

type I18nContextValue = {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  t: (key: TranslationKey, params?: TranslationParams) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("I18nContext is not available.");
  }
  return context;
}

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

const voiceLanguageLabels: Record<VoiceLanguage, TranslationKey> = {
  auto: "voice.auto",
  "en-US": "voice.english",
  "pl-PL": "voice.polish",
  "uk-UA": "voice.ukrainian",
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

function importErrorMessage(
  t: I18nContextValue["t"],
  error: unknown,
  fallbackKey: TranslationKey,
): string {
  if (!(error instanceof Error)) return t(fallbackKey);
  if (error.message === "No valid term-definition pairs were found.") {
    return t("error.noValidPairs");
  }
  if (error.message === "Paste study data before importing.") {
    return t("error.emptyPaste");
  }
  if (error.message === "Unsupported import format.") {
    return t("error.unsupportedImport");
  }
  return error.message || t(fallbackKey);
}

function pluralTermKey(locale: AppLocale, count: number): TranslationKey {
  if (locale === "uk" || locale === "pl") {
    const lastTwo = count % 100;
    const last = count % 10;
    if (lastTwo >= 11 && lastTwo <= 14) return "common.termMany";
    if (last === 1) return "common.termOne";
    if (last >= 2 && last <= 4) return "common.termFew";
    return "common.termMany";
  }

  return count === 1 ? "common.termOne" : "common.termMany";
}

function formatTermCount(t: I18nContextValue["t"], locale: AppLocale, count: number): string {
  return `${count} ${t(pluralTermKey(locale, count))}`;
}

function speakLanguageForMatch(
  kind: "term" | "definition",
  termLanguage: VoiceLanguage,
  definitionLanguage: VoiceLanguage,
): VoiceLanguage {
  return kind === "term" ? termLanguage : definitionLanguage;
}

function languageForText(
  set: StudySet,
  text: string,
  termLanguage: VoiceLanguage,
  definitionLanguage: VoiceLanguage,
): VoiceLanguage {
  const normalized = text.trim().toLocaleLowerCase();
  const matchesDefinition = set.terms.some(
    (term) => term.definition.trim().toLocaleLowerCase() === normalized,
  );
  if (matchesDefinition) return definitionLanguage;
  const matchesTerm = set.terms.some((term) => term.term.trim().toLocaleLowerCase() === normalized);
  if (matchesTerm) return termLanguage;
  return "auto";
}

function SpeakButton({
  text,
  language,
  label,
  className = "pronounce-button",
}: {
  text: string;
  language: VoiceLanguage;
  label: string;
  className?: string;
}) {
  return (
    <button
      aria-label={label}
      className={className}
      title={label}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        speakText(text, language);
      }}
    >
      🔊
    </button>
  );
}

function PronouncedChoice({
  text,
  language,
  label,
  selected,
  disabled,
  className = "",
  onChoose,
}: {
  text: string;
  language: VoiceLanguage;
  label: string;
  selected?: boolean;
  disabled?: boolean;
  className?: string;
  onChoose: () => void;
}) {
  return (
    <div className={`choice-with-speak ${selected ? "selected" : ""}`}>
      <button className={className} disabled={disabled} type="button" onClick={onChoose}>
        {text}
      </button>
      <SpeakButton text={text} language={language} label={label} />
    </div>
  );
}

function App() {
  const [locale, setLocaleState] = useState<AppLocale>(() => loadAppLocale());
  const [sets, setSets] = useState<StudySet[]>(() => loadSets());
  const [selectedId, setSelectedId] = useState<string | null>(() => loadSets()[0]?.id ?? null);
  const [isManaging, setIsManaging] = useState(() => !loadSets().length);
  const [mode, setMode] = useState<Mode>("review");
  const [notice, setNotice] = useState("");
  const lastImportRef = useRef<{ signature: string; receivedAt: number } | null>(null);
  const selectedSet = sets.find((set) => set.id === selectedId) ?? null;
  const isImportRoute = window.location.hash.startsWith("#/import");
  const t = useMemo(() => {
    return (key: TranslationKey, params?: TranslationParams) => translate(locale, key, params);
  }, [locale]);
  const setLocale = (nextLocale: AppLocale) => {
    setLocaleState(nextLocale);
    saveAppLocale(nextLocale);
  };

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
    setIsManaging(false);
    setMode("review");
    setNotice(
      t(existingSet ? "notice.updated" : "notice.imported", {
        termCount: formatTermCount(t, locale, nextSet.terms.length),
        title: nextSet.title,
      }),
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
        setNotice(importErrorMessage(t, error, "error.importFailed"));
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [t]);

  const updateSelectedSet = (nextSet: StudySet) => {
    const next = sets.map((set) => (set.id === nextSet.id ? nextSet : set));
    saveSets(next);
    setSets(next);
  };

  const handleRemoveSet = (id: string) => {
    const next = deleteSet(id);
    setSets(next);
    if (selectedId === id) setSelectedId(next[0]?.id ?? null);
    if (next.length === 0) setIsManaging(true);
  };

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <button className="brand" onClick={() => window.location.assign(currentAppUrl())}>
            {t("app.brand")}
          </button>
          <select
            className="locale-select"
            aria-label={t("nav.language")}
            title={appLocaleLabels[locale]}
            value={locale}
            onChange={(event) => setLocale(event.target.value as AppLocale)}
          >
            {appLocales.map((appLocale) => (
              <option key={appLocale} value={appLocale}>
                {appLocaleShortLabels[appLocale]}
              </option>
            ))}
          </select>
        </div>
        <nav className="top-actions" aria-label={t("nav.main")}>
          {!isManaging && selectedSet ? (
            <button onClick={() => setIsManaging(true)}>{t("nav.manage")}</button>
          ) : (
            sets.length > 0 && <button onClick={() => setIsManaging(false)}>{t("nav.practice")}</button>
          )}
          {sets.length > 0 && (
            <select
              aria-label={t("nav.savedSets")}
              value={selectedId ?? ""}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setIsManaging(false);
              }}
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
      ) : !isManaging && selectedSet ? (
        <StudyWorkspace
          mode={mode}
          set={selectedSet}
          onModeChange={setMode}
          onSetChange={updateSelectedSet}
        />
      ) : (
        <ImportScreen 
          onImport={addImportedSet} 
          sets={sets} 
          onOpenSet={(id) => { setSelectedId(id); setIsManaging(false); }} 
          onDeleteSet={handleRemoveSet} 
        />
      )}
    </main>
    </I18nContext.Provider>
  );
}

function ImportReceiver() {
  const { t } = useI18n();

  return (
    <section className="panel import-receiver">
      <p className="eyebrow">{t("import.waiting")}</p>
      <h1>{t("import.receiverTitle")}</h1>
      <p>{t("import.receiverBody")}</p>
    </section>
  );
}

function ImportScreen({
  onImport,
  sets,
  onOpenSet,
  onDeleteSet,
}: {
  onImport: (payload: ImportPayload) => void;
  sets: StudySet[];
  onOpenSet: (id: string) => void;
  onDeleteSet: (id: string) => void;
}) {
  const { locale, t } = useI18n();
  const [manualText, setManualText] = useState("");
  const [error, setError] = useState("");
  const bookmarklet = useMemo(
    () =>
      buildBookmarklet(currentAppUrl(), {
        noPairs: t("bookmarklet.noPairs"),
        errorPrefix: t("bookmarklet.errorPrefix"),
        errorSuffix: t("bookmarklet.errorSuffix"),
      }),
    [t],
  );
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
      setError(importErrorMessage(t, importError, "error.importFailed"));
    }
  };

  const confirmDelete = (set: StudySet) => {
    if (window.confirm(t("import.confirmDelete", { title: set.title }))) {
      onDeleteSet(set.id);
    }
  };

  const exportSet = (set: StudySet) => {
    const data = JSON.stringify(set, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${set.title}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const importFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        onImport(parseManualImport(text));
        setError("");
      } catch (importError) {
        setError(importErrorMessage(t, importError, "error.fileImportFailed"));
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  return (
    <>
      <section className="import-grid">
        <div className="hero-copy">
          <p className="eyebrow">{t("import.eyebrow")}</p>
          <h1>{t("import.title")}</h1>
          <p>{t("import.description")}</p>
        </div>

        <div className="panel">
          <h2>{t("import.bookmarkletTitle")}</h2>
          <div className="steps">
            <span>
              {t("import.stepBookmarks", {
                cmd: "Cmd",
                shift: "Shift",
                b: "B",
              })}
            </span>
            <span>{t("import.stepDrag")}</span>
            <a className="bookmarklet" href="#" ref={bookmarkletRef}>
              {t("import.bookmarkletLabel")}
            </a>
            <span>{t("import.dragFallback")}</span>
            <span>{t("import.stepOpen")}</span>
            <span>{t("import.stepClick")}</span>
          </div>
        </div>

        <div className="panel">
          <label htmlFor="manual-import">{t("import.manualLabel")}</label>
          <textarea
            id="manual-import"
            rows={8}
            value={manualText}
            onChange={(event) => setManualText(event.target.value)}
            placeholder={t("import.manualPlaceholder")}
          />
          {error && <p className="error">{error}</p>}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button onClick={importManual} style={{ flex: 1 }}>{t("import.pasteButton")}</button>
            <label className="button-link" style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', background: '#303956', margin: 0, minHeight: '2.75rem', padding: '0 1rem', borderRadius: '8px', color: '#fff', fontSize: '1rem' }}>
              {t("import.fileButton")}
              <input type="file" accept=".json" onChange={importFile} style={{ display: 'none' }} />
            </label>
          </div>
        </div>
      </section>

      {sets.length > 0 && (
        <div className="panel saved-panel" style={{ marginTop: '1rem' }}>
          <h2>{t("import.savedTitle")}</h2>
          <div className="saved-list">
            {sets.map((set) => (
              <div key={set.id} style={{ display: 'flex', gap: '0.5rem' }}>
                <button style={{ flex: 1 }} onClick={() => onOpenSet(set.id)}>
                  <strong>{set.title}</strong>
                  <span>{t("import.termCount", { termCount: formatTermCount(t, locale, set.terms.length) })}</span>
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); exportSet(set); }} 
                  style={{ width: 'auto', background: '#303956', padding: '0 1.25rem' }}
                  aria-label={t("import.exportJson")}
                >
                  {t("import.export")}
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); confirmDelete(set); }} 
                  className="danger"
                  style={{ width: 'auto', padding: '0 1.25rem' }}
                  aria-label={t("import.deleteSet")}
                >
                  {t("import.delete")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function StudyWorkspace({
  set,
  mode,
  onModeChange,
  onSetChange,
}: {
  set: StudySet;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  onSetChange: (set: StudySet) => void;
}) {
  const { locale, t } = useI18n();
  const [termLanguage, setTermLanguage] = useState<VoiceLanguage>(() => 
    (localStorage.getItem("vocab-arcade:voice-term") as VoiceLanguage) || "auto"
  );
  const [definitionLanguage, setDefinitionLanguage] = useState<VoiceLanguage>(() => 
    (localStorage.getItem("vocab-arcade:voice-def") as VoiceLanguage) || "auto"
  );

  const updateTermLang = (l: VoiceLanguage) => { setTermLanguage(l); localStorage.setItem("vocab-arcade:voice-term", l); };
  const updateDefLang = (l: VoiceLanguage) => { setDefinitionLanguage(l); localStorage.setItem("vocab-arcade:voice-def", l); };

  return (
    <section className="workspace">
      <div className="set-header">
        <div>
          <p className="eyebrow">{t("workspace.termCount", { termCount: formatTermCount(t, locale, set.terms.length) })}</p>
          <h1>{set.title}</h1>
          {set.sourceUrl && (
            <a href={set.sourceUrl} target="_blank" rel="noreferrer">
              {t("workspace.sourcePage")}
            </a>
          )}
        </div>
        <div style={{ display: "flex", gap: "1rem", alignItems: "flex-end", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <div className="voice-controls" aria-label={t("voice.settings")}>
            <label>
              {t("voice.term")}
              <select
                value={termLanguage}
                onChange={(event) => updateTermLang(event.target.value as VoiceLanguage)}
              >
                {(Object.keys(voiceLanguageLabels) as VoiceLanguage[]).map((language) => (
                  <option key={language} value={language}>
                    {t(voiceLanguageLabels[language])}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("voice.definition")}
              <select
                value={definitionLanguage}
                onChange={(event) => updateDefLang(event.target.value as VoiceLanguage)}
              >
                {(Object.keys(voiceLanguageLabels) as VoiceLanguage[]).map((language) => (
                  <option key={language} value={language}>
                    {t(voiceLanguageLabels[language])}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>

      <div className="mode-grid" role="tablist" aria-label={t("mode.practiceModes")}>
        {(Object.keys(modeLabelKeys) as Mode[]).map((item) => (
          <button
            key={item}
            className={mode === item ? "active" : ""}
            onClick={() => onModeChange(item)}
            role="tab"
            aria-selected={mode === item}
          >
            {t(modeLabelKeys[item])}
          </button>
        ))}
      </div>

      {mode === "review" && <ReviewMode set={set} termLanguage={termLanguage} definitionLanguage={definitionLanguage} />}
      {mode === "edit" && <EditMode set={set} onSetChange={onSetChange} />}
      {mode === "flashcards" && <FlashcardsMode set={set} termLanguage={termLanguage} definitionLanguage={definitionLanguage} />}
      {mode === "learn" && <LearnMode set={set} termLanguage={termLanguage} definitionLanguage={definitionLanguage} />}
      {mode === "test" && <TestMode set={set} termLanguage={termLanguage} definitionLanguage={definitionLanguage} />}
      {mode === "match" && <MatchMode set={set} termLanguage={termLanguage} definitionLanguage={definitionLanguage} />}
      {mode === "blocks" && <BlocksMode set={set} termLanguage={termLanguage} definitionLanguage={definitionLanguage} />}
      {mode === "blast" && <BlastMode set={set} termLanguage={termLanguage} definitionLanguage={definitionLanguage} onExit={() => onModeChange("review")} />}
    </section>
  );
}

function ReviewMode({ set, termLanguage, definitionLanguage }: { set: StudySet; termLanguage: VoiceLanguage; definitionLanguage: VoiceLanguage }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const visibleTerms = set.terms.filter((term) =>
    `${term.term} ${term.definition}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );

  return (
    <div className="panel">
      <div className="toolbar">
        <input
          aria-label={t("review.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("review.search")}
        />
      </div>
      <div className="review-list">
        {visibleTerms.map((term) => (
          <article className="review-row" key={term.id}>
            <div className="review-cell">
              <p>{term.term}</p>
              <button
                aria-label={t("voice.speakTerm")}
                className="review-speak-button pronounce-button"
                title={t("voice.speakTerm")}
                type="button"
                onClick={() => speakText(term.term, termLanguage)}
              >
                🔊
              </button>
            </div>
            <span className="review-divider" aria-hidden="true">
              |
            </span>
            <div className="review-cell">
              <p>{term.definition}</p>
              <button
                aria-label={t("voice.speakDefinition")}
                className="review-speak-button pronounce-button"
                title={t("voice.speakDefinition")}
                type="button"
                onClick={() => speakText(term.definition, definitionLanguage)}
              >
                🔊
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function EditMode({ set, onSetChange }: { set: StudySet; onSetChange: (set: StudySet) => void }) {
  const { t } = useI18n();
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

  const addTerm = () => {
    const newTerm: StudyTerm = {
      id: makeId("term"),
      term: "",
      definition: ""
    };
    onSetChange({
      ...set,
      terms: [newTerm, ...set.terms],
      updatedAt: new Date().toISOString(),
    });
    setQuery("");
  };

  return (
    <div className="panel">
      <div className="toolbar">
        <input
          aria-label={t("edit.searchLabel")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("edit.searchPlaceholder")}
        />
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button onClick={addTerm}>{t("edit.addPair")}</button>
          <button
            onClick={() =>
              onSetChange({ ...set, terms: shuffle(set.terms), updatedAt: new Date().toISOString() })
            }
          >
            {t("edit.shuffle")}
          </button>
        </div>
      </div>
      <div className="term-table">
        {visibleTerms.map((term) => (
          <div className="term-row" key={term.id}>
            <textarea
              aria-label={t("edit.editTerm", { term: term.term })}
              value={term.term}
              onChange={(event) => updateTerm(term.id, "term", event.target.value)}
            />
            <textarea
              aria-label={t("edit.editDefinition", { definition: term.definition })}
              value={term.definition}
              onChange={(event) => updateTerm(term.id, "definition", event.target.value)}
            />
            <button onClick={() => deleteTerm(term.id)}>{t("edit.remove")}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function FlashcardsMode({ set, termLanguage, definitionLanguage }: { set: StudySet; termLanguage: VoiceLanguage; definitionLanguage: VoiceLanguage }) {
  const { t } = useI18n();
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
  const visibleText = flipped ? current.definition : current.term;
  const visibleLanguage = flipped ? definitionLanguage : termLanguage;

  return (
    <div className="panel study-stage">
      <div
        className={`flashcard ${isFlipping ? "flashcard-flipping" : ""}`}
        role="button"
        tabIndex={0}
        onAnimationEnd={() => setIsFlipping(false)}
        onClick={flipCard}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            flipCard();
          }
        }}
      >
        <SpeakButton
          text={visibleText}
          language={visibleLanguage}
          label={flipped ? t("voice.speakDefinition") : t("voice.speakTerm")}
          className="pronounce-button flashcard-speak"
        />
        <span>{visibleText}</span>
        <small>{t("flashcards.flip")}</small>
      </div>
      <div className="card-controls">
        <button onClick={() => setIndex(Math.max(0, index - 1))}>{t("flashcards.previous")}</button>
        <span>
          {index + 1} / {cards.length}
        </span>
        <button onClick={() => setIndex(Math.min(cards.length - 1, index + 1))}>{t("flashcards.next")}</button>
        <button
          onClick={() => {
            setCards(shuffle(cards));
            setIndex(0);
          }}
        >
          {t("flashcards.shuffle")}
        </button>
        <button onClick={() => current && speakText(visibleText, visibleLanguage)}>
          {t("flashcards.speak")}
        </button>
      </div>
    </div>
  );
}

type LearnPhase = "multiple-choice" | "written";

function firstLearnPhase(settings: LearnSettings): LearnPhase {
  return settings.multipleChoice ? "multiple-choice" : "written";
}

function nextLearnPhase(phase: LearnPhase, settings: LearnSettings): LearnPhase | null {
  if (phase === "multiple-choice" && settings.written) return "written";
  return null;
}

function buildLearnQueue(terms: StudyTerm[], shouldShuffle: boolean): StudyTerm[] {
  return shouldShuffle ? shuffle(terms) : [...terms];
}

function learnProgressTotal(settings: LearnSettings, termCount: number): number {
  return Math.max(
    1,
    (settings.multipleChoice ? termCount : 0) + (settings.written ? termCount : 0),
  );
}

function LearnMode({
  set,
  termLanguage,
  definitionLanguage,
}: {
  set: StudySet;
  termLanguage: VoiceLanguage;
  definitionLanguage: VoiceLanguage;
}) {
  const { t } = useI18n();
  const learnSectionSize = 7;
  const [settings, setSettings] = useState<LearnSettings>(() => loadLearnSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [phase, setPhase] = useState<LearnPhase>(() => firstLearnPhase(settings));
  const [queue, setQueue] = useState(() => buildLearnQueue(set.terms, settings.shuffle));
  const [score, setScore] = useState({ correct: 0, total: 0 });
  const [sectionCompleted, setSectionCompleted] = useState<StudyTerm[]>([]);
  const [showSectionSummary, setShowSectionSummary] = useState(false);
  const [writtenInput, setWrittenInput] = useState("");
  const [feedback, setFeedback] = useState<{
    status: "correct" | "wrong";
    selected: string;
    answer: string;
    prompt: string;
    term: StudyTerm;
    phase: LearnPhase;
  } | null>(null);
  const feedbackTimeoutRef = useRef<number | null>(null);
  const current = queue[0];
  const choices = useMemo(
    () => (phase === "multiple-choice" && current ? choicesForTerm(set, current) : []),
    [set, current, phase],
  );
  const progressTotal = learnProgressTotal(settings, set.terms.length);

  const clearFeedbackTimer = () => {
    if (feedbackTimeoutRef.current) {
      window.clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = null;
    }
  };

  const resetLearn = (nextSettings = settings) => {
    const nextPhase = firstLearnPhase(nextSettings);
    clearFeedbackTimer();
    setPhase(nextPhase);
    setQueue(buildLearnQueue(set.terms, nextSettings.shuffle));
    setScore({ correct: 0, total: 0 });
    setSectionCompleted([]);
    setShowSectionSummary(false);
    setFeedback(null);
    setWrittenInput("");
  };

  useEffect(() => {
    return () => clearFeedbackTimer();
  }, []);

  useEffect(() => {
    resetLearn(settings);
  }, [set.id, set.terms.length]);

  const updateLearnSettings = (key: keyof LearnSettings, value: boolean) => {
    const next = { ...settings, [key]: value };
    if (key === "multipleChoice" && !value && !next.written) {
      next.written = true;
    }
    if (key === "written" && !value && !next.multipleChoice) {
      next.multipleChoice = true;
    }
    const normalized = normalizeLearnSettings(next);
    setSettings(normalized);
    saveLearnSettings(normalized);
    resetLearn(normalized);
  };

  const advanceLearn = (term: StudyTerm, wasCorrect: boolean) => {
    const nextSectionCompleted = [...sectionCompleted, term];
    const nextScore = {
      correct: score.correct + (wasCorrect ? 1 : 0),
      total: score.total + 1,
    };
    let nextPhaseValue = phase;
    let nextQueue = [...queue.slice(1), ...(wasCorrect ? [] : [term])];

    if (nextQueue.length === 0) {
      const followingPhase = nextLearnPhase(phase, settings);
      if (followingPhase) {
        nextPhaseValue = followingPhase;
        nextQueue = buildLearnQueue(set.terms, settings.shuffle);
      }
    }

    const flowComplete = nextQueue.length === 0 && nextLearnPhase(nextPhaseValue, settings) === null;
    const shouldShowSummary =
      nextSectionCompleted.length >= learnSectionSize || flowComplete;

    setScore(nextScore);
    setSectionCompleted(nextSectionCompleted);
    setPhase(nextPhaseValue);
    setQueue(nextQueue);
    setFeedback(null);
    setWrittenInput("");
    if (shouldShowSummary) {
      setShowSectionSummary(true);
    }
  };

  const answerMultipleChoice = (value: string) => {
    if (!current || feedback || showSectionSummary || phase !== "multiple-choice") return;
    const correct = isCorrectAnswer(value, current.definition);
    playAnswerFeedback(correct);
    setFeedback({
      status: correct ? "correct" : "wrong",
      selected: value,
      answer: current.definition,
      prompt: current.term,
      term: current,
      phase,
    });

    if (correct) {
      feedbackTimeoutRef.current = window.setTimeout(() => {
        advanceLearn(current, true);
        feedbackTimeoutRef.current = null;
      }, 700);
    }
  };

  const answerWritten = () => {
    if (!current || feedback || showSectionSummary || phase !== "written") return;
    const selected = writtenInput.trim();
    if (!selected) return;
    const correct = isCorrectAnswer(selected, current.term);
    playAnswerFeedback(correct);
    setFeedback({
      status: correct ? "correct" : "wrong",
      selected,
      answer: current.term,
      prompt: current.definition,
      term: current,
      phase,
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

  const restartLearn = () => resetLearn(settings);

  const continueFromSummary = () => {
    setSectionCompleted([]);
    setShowSectionSummary(false);
  };

  const renderSettings = () => (
    <div className="learn-settings-wrap">
      <button
        className="learn-settings-button"
        aria-expanded={settingsOpen}
        aria-label={t("learn.settingsAria")}
        onClick={() => setSettingsOpen((value) => !value)}
      >
        {t("learn.settings")}
      </button>
      {settingsOpen && (
        <div className="learn-settings-panel" role="dialog" aria-label={t("learn.settingsPanel")}>
          <h3>{t("learn.questionTypes")}</h3>
          <label className="switch-row">
            <span>{t("learn.shuffle")}</span>
            <input
              type="checkbox"
              checked={settings.shuffle}
              onChange={(event) => updateLearnSettings("shuffle", event.target.checked)}
            />
            <i />
          </label>
          <label className="switch-row">
            <span>{t("learn.multipleChoice")}</span>
            <input
              type="checkbox"
              checked={settings.multipleChoice}
              onChange={(event) => updateLearnSettings("multipleChoice", event.target.checked)}
            />
            <i />
          </label>
          <label className="switch-row">
            <span>{t("learn.writtenAnswers")}</span>
            <input
              type="checkbox"
              checked={settings.written}
              onChange={(event) => updateLearnSettings("written", event.target.checked)}
            />
            <i />
          </label>
        </div>
      )}
    </div>
  );

  const renderHeader = () => (
    <div className="learn-header">
      <span>{phase === "multiple-choice" ? t("learn.multipleChoicePhase") : t("learn.writtenPhase")}</span>
      {renderSettings()}
    </div>
  );

  const renderProgress = () => {
    const completed = Math.min(progressTotal, score.total);
    const segmentCount = Math.max(1, Math.ceil(progressTotal / learnSectionSize));
    const segments = Array.from({ length: segmentCount }, (_, index) => {
      const segmentStart = index * learnSectionSize;
      const segmentSize = Math.min(learnSectionSize, progressTotal - segmentStart);
      return Math.max(0, Math.min(1, (completed - segmentStart) / segmentSize));
    });
    return (
      <div className="learn-progress" aria-label={t("learn.progress")}>
        <div className="learn-progress-track">
          {segments.map((fillAmount, index) => (
            <span
              style={{ "--learn-segment-fill": `${fillAmount * 100}%` } as CSSProperties}
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
    const progressPercent = Math.round((Math.min(score.total, progressTotal) / progressTotal) * 100);
    return (
      <div className="learn-summary">
        <h2>{t("learn.summaryTitle")}</h2>
        <p>
          {t("learn.totalProgress")} <strong>{progressPercent}%</strong>
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
          <span>{t("learn.correct")}</span>
          <span>{t("learn.totalQuestions")}</span>
        </div>
        <h3>{t("learn.studiedRound")}</h3>
        <div className="learn-summary-list">
          {sectionCompleted.map((term, index) => (
            <div className="learn-summary-row" key={`${term.id}-summary-${index}`}>
              <span>{term.term}</span>
              <span>{term.definition}</span>
              <div className="summary-speak-actions">
                <SpeakButton
                  text={term.term}
                  language={termLanguage}
                  label={t("voice.speakTermValue", { term: term.term })}
                />
                <SpeakButton
                  text={term.definition}
                  language={definitionLanguage}
                  label={t("voice.speakDefinition")}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="learn-review-actions">
          <span>{t("learn.keepPracticing")}</span>
          <button onClick={continueFromSummary}>{t("learn.continue")}</button>
        </div>
      </div>
    );
  };

  if (showSectionSummary) {
    return (
      <div className="learn-shell">
        {renderHeader()}
        {renderSummary()}
      </div>
    );
  }

  if (!current) {
    return (
      <div className="learn-shell">
        {renderHeader()}
        <div className="panel empty-state">
          <h2>{t("learn.roundComplete")}</h2>
          <button onClick={restartLearn}>{t("learn.practiceAgain")}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="learn-shell">
      {renderHeader()}
      {renderProgress()}
      <div className="panel quiz-panel learn-panel">
        <div>
          <p className="eyebrow">
            {t("learn.correctOf", { correct: score.correct, total: score.total })}
          </p>
          <div className="prompt-with-speak">
            <h2>{feedback?.prompt ?? (phase === "multiple-choice" ? current.term : current.definition)}</h2>
            <SpeakButton
              text={feedback?.prompt ?? (phase === "multiple-choice" ? current.term : current.definition)}
              language={phase === "multiple-choice" ? termLanguage : definitionLanguage}
              label={phase === "multiple-choice" ? t("voice.speakTerm") : t("voice.speakDefinition")}
            />
          </div>
        </div>
        {phase === "multiple-choice" ? (
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
                <PronouncedChoice
                  key={choice}
                  text={choice}
                  language={definitionLanguage}
                  label={t("voice.speakDefinition")}
                  className={feedbackClass}
                  disabled={Boolean(feedback)}
                  onChoose={() => answerMultipleChoice(choice)}
                />
              );
            })}
          </div>
        ) : (
          <form
            className="learn-written-form"
            onSubmit={(event) => {
              event.preventDefault();
              answerWritten();
            }}
          >
            <label htmlFor="learn-written-answer">{t("learn.writeMatchingTerm")}</label>
            <input
              id="learn-written-answer"
              value={writtenInput}
              disabled={Boolean(feedback)}
              onChange={(event) => setWrittenInput(event.target.value)}
              autoComplete="off"
            />
            <button disabled={Boolean(feedback) || !writtenInput.trim()}>{t("learn.check")}</button>
          </form>
        )}
        {feedback?.status === "correct" && <p className="result">{t("learn.correctResult")}</p>}
        {feedback?.status === "wrong" && (
          <div className="learn-review">
            <p className="learn-review-message">{t("learn.wrongMessage")}</p>
            {feedback.phase === "written" && (
              <div className="learn-review-grid">
                <div className="learn-answer-card wrong-answer">
                  <span>{t("learn.yourAnswer")}</span>
                  <strong>{feedback.selected}</strong>
                </div>
                <div className="learn-answer-card correct-answer">
                  <span>{t("learn.correctAnswer")}</span>
                  <strong>{feedback.answer}</strong>
                </div>
              </div>
            )}
            <div className="learn-review-actions">
              <span>
                {feedback.phase === "written"
                  ? t("learn.reviewWritten")
                  : t("learn.reviewChoice")}
              </span>
              <button onClick={continueLearn}>{t("learn.continue")}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TestMode({
  set,
  termLanguage,
  definitionLanguage,
}: {
  set: StudySet;
  termLanguage: VoiceLanguage;
  definitionLanguage: VoiceLanguage;
}) {
  const { t } = useI18n();
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
            <h2>{t("test.setupTitle")}</h2>
          </div>
          <div className="test-doc-icon" aria-hidden="true">
            <span />
          </div>
        </div>

        <div className="test-setting-row">
          <label htmlFor="test-question-count">{t("test.questionsMax", { max: maxQuestions })}</label>
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
          <label htmlFor="test-answer-with">{t("test.answerWith")}</label>
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
            <option value="both">{t("test.answerBoth")}</option>
            <option value="definition">{t("test.answerDefinition")}</option>
            <option value="term">{t("test.answerTerm")}</option>
          </select>
        </div>

        <div className="test-kind-list">
          {[
            ["true-false", t("test.trueFalse")],
            ["multiple-choice", t("test.multipleChoice")],
            ["matching", t("test.matching")],
            ["written", t("test.written")],
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
            {t("test.start")}
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
          {t("test.setupNew")}
        </button>
        <button onClick={() => setGraded(true)}>{t("test.grade")}</button>
        {graded && <strong>{score} / {questions.length}</strong>}
      </div>
      {questions.slice(0, Math.min(18, questions.length)).map((question) => (
        <div className="question" key={question.id}>
          <div className="question-prompt">
            <p>{question.prompt}</p>
            <SpeakButton
              text={question.prompt}
              language={languageForText(set, question.prompt, termLanguage, definitionLanguage)}
              label={t("voice.speak")}
            />
          </div>
          {question.kind === "multiple-choice" && (
            <div className="choice-grid">
              {question.choices.map((choice) => (
                <div className="choice-with-speak" key={choice}>
                  <label>
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
                  <SpeakButton
                    text={choice}
                    language={languageForText(set, choice, termLanguage, definitionLanguage)}
                    label={t("voice.speak")}
                  />
                </div>
              ))}
            </div>
          )}
          {question.kind === "matching" && (
            <div className="choice-grid matching-grid">
              {question.choices.map((choice) => (
                <PronouncedChoice
                  key={choice}
                  text={choice}
                  language={languageForText(set, choice, termLanguage, definitionLanguage)}
                  label={t("voice.speak")}
                  selected={answers[question.id] === choice}
                  onChoose={() => setAnswers((prev) => ({ ...prev, [question.id]: choice }))}
                />
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
              <SpeakButton
                text={question.shownAnswer}
                language={languageForText(set, question.shownAnswer, termLanguage, definitionLanguage)}
                label={t("voice.speak")}
              />
              <button onClick={() => setAnswers((prev) => ({ ...prev, [question.id]: "true" }))}>
                {t("test.true")}
              </button>
              <button onClick={() => setAnswers((prev) => ({ ...prev, [question.id]: "false" }))}>
                {t("test.false")}
              </button>
            </div>
          )}
          {graded && <small>{t("test.answer", { answer: question.answer })}</small>}
        </div>
      ))}
    </div>
  );
}

function MatchMode({
  set,
  termLanguage,
  definitionLanguage,
}: {
  set: StudySet;
  termLanguage: VoiceLanguage;
  definitionLanguage: VoiceLanguage;
}) {
  const { t } = useI18n();
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
        <strong>
          {items.length === 0
            ? t("match.completeIn", { seconds: Math.round((Date.now() - startedAt) / 1000) })
            : t("match.pairs")}
        </strong>
        <button onClick={() => setItems(makeMatchItems(sourceTerms))}>{t("match.reset")}</button>
      </div>
      <div className="tile-grid">
        {items.map((item) => (
          <PronouncedChoice
            key={item.id}
            text={item.text}
            language={speakLanguageForMatch(item.kind, termLanguage, definitionLanguage)}
            label={item.kind === "term" ? t("voice.speakTerm") : t("voice.speakDefinition")}
            selected={selected.includes(item.id)}
            onChoose={() => pick(item.id)}
          />
        ))}
      </div>
    </div>
  );
}

type MatchItem = {
  id: string;
  termId: string;
  kind: "term" | "definition";
  text: string;
};

function makeMatchItems(terms: StudyTerm[]): MatchItem[] {
  return shuffle(
    terms.flatMap((term) => [
      { id: `${term.id}-term`, termId: term.id, kind: "term", text: term.term },
      { id: `${term.id}-definition`, termId: term.id, kind: "definition", text: term.definition },
    ]),
  );
}

function BlocksMode({
  set,
  termLanguage,
  definitionLanguage,
}: {
  set: StudySet;
  termLanguage: VoiceLanguage;
  definitionLanguage: VoiceLanguage;
}) {
  const { t } = useI18n();
  const terms = set.terms.slice(0, 10);
  const [blocks, setBlocks] = useState(() => makeMatchItems(terms));
  const [selected, setSelected] = useState<string[]>([]);
  const [messageKey, setMessageKey] = useState<TranslationKey>("blocks.initial");

  const pick = (id: string) => {
    const next = [...selected, id].slice(-2);
    setSelected(next);
    if (next.length !== 2) return;
    const [first, second] = next.map((itemId) => blocks.find((block) => block.id === itemId));
    if (first && second && first.termId === second.termId && first.kind !== second.kind) {
      setMessageKey("blocks.cleared");
      setBlocks((prev) => prev.filter((block) => !next.includes(block.id)));
    } else {
      setMessageKey("blocks.tryAnother");
    }
    setTimeout(() => setSelected([]), 350);
  };

  return (
    <div className="panel">
      <div className="toolbar">
        <strong>{t(messageKey)}</strong>
        <button
          onClick={() => {
            setBlocks(makeMatchItems(terms));
            setMessageKey("blocks.initial");
          }}
        >
          {t("blocks.reset")}
        </button>
      </div>
      <div className="blocks-grid">
        {blocks.map((block) => (
          <PronouncedChoice
            key={block.id}
            text={block.text}
            language={speakLanguageForMatch(block.kind, termLanguage, definitionLanguage)}
            label={block.kind === "term" ? t("voice.speakTerm") : t("voice.speakDefinition")}
            selected={selected.includes(block.id)}
            onChoose={() => pick(block.id)}
          />
        ))}
      </div>
      {blocks.length === 0 && <p className="result">{t("blocks.boardCleared")}</p>}
    </div>
  );
}

function BlastMode({
  set,
  termLanguage,
  definitionLanguage,
  onExit,
}: {
  set: StudySet;
  termLanguage: VoiceLanguage;
  definitionLanguage: VoiceLanguage;
  onExit: () => void;
}) {
  const { t } = useI18n();
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
  const [messageKey, setMessageKey] = useState<TranslationKey>("blast.initial");
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
    setMessageKey("blast.initial");
    setLocked(false);
  };

  const advanceRound = (wasCorrect: boolean) => {
    if (wasCorrect) {
      setScore((value) => value + 1);
      setStreak((value) => value + 1);
      setMessageKey("blast.hit");
    } else {
      setMisses((value) => value + 1);
      setStreak(0);
      setMessageKey("blast.missed");
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
    setMessageKey("blast.initial");
    if (!muted) speakText(current.term, termLanguage);
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
    setMessageKey("blast.notThatOne");
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
          <strong>{t("mode.blast")}</strong>
          <span>{set.title}</span>
          <button onClick={onExit}>{t("blast.exit")}</button>
        </div>
        <div className="blast-finish">
          <p className="eyebrow">{t("blast.missionComplete")}</p>
          <h2>{t("blast.directHits", { count: score })}</h2>
          <p>
            {t("blast.finishStats", { level, misses })}
          </p>
          <div className="card-controls">
            <button onClick={restart}>{t("blast.playAgain")}</button>
            <button onClick={onExit}>{t("blast.backToSet")}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="blast-shell">
      <div className="blast-topbar">
        <strong>{t("mode.blast")}</strong>
        <span>{set.title}</span>
        <div className="blast-actions">
          <button onClick={() => setMuted((value) => !value)}>{muted ? t("blast.soundOff") : t("blast.soundOn")}</button>
          <button onClick={restart}>{t("blast.restart")}</button>
          <button onClick={onExit}>{t("blast.exit")}</button>
        </div>
      </div>
      <div className="blast-prompt">
        <div className="blast-progress" style={{ width: `${progress}%` }} />
        <span>{current?.term}</span>
        {current && (
          <SpeakButton
            text={current.term}
            language={termLanguage}
            label={t("voice.speakTerm")}
            className="pronounce-button blast-prompt-speak"
          />
        )}
      </div>
      <div
        className="blast-stage"
        aria-label={t("blast.answerField")}
        ref={stageRef}
        onMouseMove={updateAim}
      >
        <span className="blast-status">{t(messageKey)}</span>
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
          <div
            key={target.id}
            className="asteroid-wrap"
            style={{
              left: `${target.x}%`,
              top: `${target.y}%`,
              width: `${target.size}rem`,
              height: `${target.size}rem`,
            }}
          >
            <button
              className={`asteroid asteroid-${target.state}`}
              onClick={(event) => chooseTarget(target, event)}
            >
              {target.text}
            </button>
            <SpeakButton
              text={target.text}
              language={definitionLanguage}
              label={t("voice.speakDefinition")}
              className="pronounce-button asteroid-speak"
            />
          </div>
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
          <strong>{t("blast.level", { level })}</strong>
          <span>
            {score}/{deck.length}
          </span>
          <small>{t("blast.misses", { misses })}</small>
        </div>
        <div className="blast-hud blast-hud-right">
          <span>{t("blast.streak")}</span>
          <strong>{streak}</strong>
        </div>
      </div>
    </div>
  );
}

export default App;
