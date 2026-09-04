import { useState } from "react";
import {
  type NovelGenerationInput,
  type NovelGenre,
  type NovelTone,
  type NovelViewpoint,
  type TargetLength,
} from "../../lib/api.js";
import { messages } from "../../lib/i18n.js";
import { useStore } from "../../lib/store.js";
import { BookIcon } from "../common/icons.js";

/** Fiction entry view: story brief + narrative controls, then the shared editor. */
export default function NovelGenerator() {
  const lang = useStore((state) => state.lang);
  const busy = useStore((state) => state.mode === "novel" ? state.busy : state.workspaces.novel.busy);
  const doGenerateNovel = useStore((state) => state.doGenerateNovel);
  const t = messages[lang];
  const [title, setTitle] = useState("");
  const [premise, setPremise] = useState("");
  const [genre, setGenre] = useState<NovelGenre>("literary");
  const [viewpoint, setViewpoint] = useState<NovelViewpoint>("third-limited");
  const [tone, setTone] = useState<NovelTone>("restrained");
  const [targetLength, setTargetLength] = useState<TargetLength>("medium");

  const genreOptions: Array<{ id: NovelGenre; label: string }> = [
    { id: "literary", label: t.novelGenreLiterary },
    { id: "romance", label: t.novelGenreRomance },
    { id: "suspense", label: t.novelGenreSuspense },
    { id: "science-fiction", label: t.novelGenreScienceFiction },
    { id: "fantasy", label: t.novelGenreFantasy },
    { id: "historical", label: t.novelGenreHistorical },
    { id: "realism", label: t.novelGenreRealism },
  ];
  const viewpointOptions: Array<{ id: NovelViewpoint; label: string }> = [
    { id: "first-person", label: t.novelViewpointFirst },
    { id: "third-limited", label: t.novelViewpointThirdLimited },
    { id: "omniscient", label: t.novelViewpointOmniscient },
  ];
  const toneOptions: Array<{ id: NovelTone; label: string }> = [
    { id: "restrained", label: t.novelToneRestrained },
    { id: "warm", label: t.novelToneWarm },
    { id: "dark", label: t.novelToneDark },
    { id: "humorous", label: t.novelToneHumorous },
    { id: "tense", label: t.novelToneTense },
  ];
  const lengthOptions: Array<{ id: TargetLength; label: string }> = [
    { id: "short", label: t.novelLengthShort },
    { id: "medium", label: t.novelLengthMedium },
    { id: "long", label: t.novelLengthLong },
  ];

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanPremise = premise.trim();
    if (!cleanPremise || busy) return;
    const input: NovelGenerationInput = {
      title: title.trim(),
      premise: cleanPremise,
      genre,
      viewpoint,
      tone,
      targetLength,
    };
    void doGenerateNovel(input);
  }

  return (
    <form className="generator novel-generator" onSubmit={submit}>
      <section className="step novel-brief">
        <div className="step-head">
          <span className="badge peach">1</span>
          <h2>{t.novelStep1}</h2>
        </div>

        <div className="novel-field">
          <label htmlFor="novel-title">{t.novelTitleLabel}</label>
          <input
            id="novel-title"
            className="text-input"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t.novelTitlePlaceholder}
          />
        </div>

        <div className="novel-field">
          <label htmlFor="novel-premise">{t.novelPremiseLabel}</label>
          <textarea
            id="novel-premise"
            className="novel-premise-input"
            value={premise}
            maxLength={2_000}
            required
            aria-describedby="novel-premise-hint novel-premise-count"
            onChange={(event) => setPremise(event.target.value)}
            placeholder={t.novelPremisePlaceholder}
          />
          <div className="novel-field-meta">
            <span id="novel-premise-hint">{t.novelPremiseHint}</span>
            <span id="novel-premise-count">{t.novelPremiseCount(premise.length)}</span>
          </div>
        </div>
      </section>

      <section className="step generator-desk novel-settings">
        <div className="step-head">
          <span className="badge mint">2</span>
          <h2>{t.novelStep2}</h2>
        </div>

        <div className="novel-options">
          <label htmlFor="novel-genre">{t.novelGenreLabel}</label>
          <select
            id="novel-genre"
            className="styleselect compact"
            value={genre}
            onChange={(event) => setGenre(event.target.value as NovelGenre)}
          >
            {genreOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>

          <label htmlFor="novel-viewpoint">{t.novelViewpointLabel}</label>
          <select
            id="novel-viewpoint"
            className="styleselect compact"
            value={viewpoint}
            onChange={(event) => setViewpoint(event.target.value as NovelViewpoint)}
          >
            {viewpointOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>

          <label htmlFor="novel-tone">{t.novelToneLabel}</label>
          <select
            id="novel-tone"
            className="styleselect compact"
            value={tone}
            onChange={(event) => setTone(event.target.value as NovelTone)}
          >
            {toneOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </div>

        <div className="novel-length">
          <span id="novel-length-label">{t.novelLengthLabel}</span>
          <div className="segment" role="group" aria-labelledby="novel-length-label">
            {lengthOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={targetLength === option.id ? "active" : ""}
                aria-pressed={targetLength === option.id}
                onClick={() => setTargetLength(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <button className="primary novel-submit" type="submit" disabled={Boolean(busy) || !premise.trim()}>
          <BookIcon />
          {busy ?? t.generateNovelBtn}
        </button>
      </section>
    </form>
  );
}
