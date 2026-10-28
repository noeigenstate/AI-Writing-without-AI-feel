import { useState } from "react";
import {
  type NovelGenerationInput,
  type NovelGenre,
  type NovelTone,
  type NovelViewpoint,
  type TargetLength,
} from "../../lib/api.js";
import { messages, type Dict } from "../../lib/i18n.js";
import { useStore } from "../../lib/store.js";
import { BookIcon } from "../common/icons.js";
import { OptionSelect, SegmentedControl, type Option } from "../common/OptionControls.js";

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

  const { genreOptions, viewpointOptions, toneOptions, lengthOptions } = novelOptions(t);

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
          <h2>
            <span className="badge peach">1</span>
            {t.novelStep1}
          </h2>
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
          <h2>
            <span className="badge mint">2</span>
            {t.novelStep2}
          </h2>
        </div>

        <div className="novel-options">
          <label htmlFor="novel-genre">{t.novelGenreLabel}</label>
          <OptionSelect id="novel-genre" value={genre} options={genreOptions} onChange={setGenre} />

          <label htmlFor="novel-viewpoint">{t.novelViewpointLabel}</label>
          <OptionSelect id="novel-viewpoint" value={viewpoint} options={viewpointOptions} onChange={setViewpoint} />

          <label htmlFor="novel-tone">{t.novelToneLabel}</label>
          <OptionSelect id="novel-tone" value={tone} options={toneOptions} onChange={setTone} />
        </div>

        <div className="novel-length">
          <span id="novel-length-label">{t.novelLengthLabel}</span>
          <SegmentedControl
            aria-labelledby="novel-length-label"
            options={lengthOptions}
            value={targetLength}
            onChange={setTargetLength}
          />
        </div>

        <button className="primary novel-submit" type="submit" disabled={Boolean(busy) || !premise.trim()}>
          <BookIcon />
          {busy ?? t.generateNovelBtn}
        </button>
      </section>
    </form>
  );
}

function novelOptions(t: Dict): {
  genreOptions: Option<NovelGenre>[];
  viewpointOptions: Option<NovelViewpoint>[];
  toneOptions: Option<NovelTone>[];
  lengthOptions: Option<TargetLength>[];
} {
  return {
    genreOptions: [
      { id: "literary", label: t.novelGenreLiterary },
      { id: "romance", label: t.novelGenreRomance },
      { id: "suspense", label: t.novelGenreSuspense },
      { id: "science-fiction", label: t.novelGenreScienceFiction },
      { id: "fantasy", label: t.novelGenreFantasy },
      { id: "historical", label: t.novelGenreHistorical },
      { id: "realism", label: t.novelGenreRealism },
    ],
    viewpointOptions: [
      { id: "first-person", label: t.novelViewpointFirst },
      { id: "third-limited", label: t.novelViewpointThirdLimited },
      { id: "omniscient", label: t.novelViewpointOmniscient },
    ],
    toneOptions: [
      { id: "restrained", label: t.novelToneRestrained },
      { id: "warm", label: t.novelToneWarm },
      { id: "dark", label: t.novelToneDark },
      { id: "humorous", label: t.novelToneHumorous },
      { id: "tense", label: t.novelToneTense },
    ],
    lengthOptions: [
      { id: "short", label: t.novelLengthShort },
      { id: "medium", label: t.novelLengthMedium },
      { id: "long", label: t.novelLengthLong },
    ],
  };
}
