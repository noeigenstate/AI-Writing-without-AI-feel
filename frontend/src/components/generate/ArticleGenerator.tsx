import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchArticleTopics,
  previewResearch,
  type TargetLength,
  type TopicOptionDTO,
  type WritingSceneId,
} from "../../lib/api.js";
import { useStore } from "../../lib/store.js";
import { Sparkle } from "../common/icons.js";
import { OptionSelect, SegmentedControl, type Option } from "../common/OptionControls.js";
import ProgressBanner from "../common/ProgressBanner.js";
import { messages } from "../../lib/i18n.js";
import { sceneOptions } from "../../lib/sceneOptions.js";
import DomainPicker from "./DomainPicker.js";
import GeneratorResults from "./GeneratorResults.js";

/** Which page of the generator is showing: the setup form or the topic/research results. */
export type GeneratorView = "setup" | "results";

interface ArticleGeneratorProps {
  onViewChange?: (view: GeneratorView) => void;
}

/** "Generate article" view: title-first or domain → topics → research → generate. */
export default function ArticleGenerator({ onViewChange }: ArticleGeneratorProps) {
  const styles = useStore((s) => s.styles);
  const loadStyles = useStore((s) => s.loadStyles);
  const domains = useStore((s) => s.articleDomains);
  const loadArticleDomains = useStore((s) => s.loadArticleDomains);
  const doGenerateArticle = useStore((s) => s.doGenerateArticle);
  const doGenerateArticleFromTitle = useStore((s) => s.doGenerateArticleFromTitle);
  const research = useStore((s) => (s.mode === "generate" ? s.research : s.workspaces.generate.research));
  const setResearch = useStore((s) => s.setResearch);
  const lang = useStore((s) => s.lang);
  const t = messages[lang];
  const lengthOptions: Option<TargetLength>[] = [
    { id: "medium", label: t.lengthRegular },
    { id: "short", label: t.lengthShort },
    { id: "long", label: t.lengthLong },
  ];
  const [domainId, setDomainId] = useState("");
  const [customDomain, setCustomDomain] = useState("");
  const [titleInput, setTitleInput] = useState("");
  const [styleId, setStyleId] = useState("");
  const [sceneId, setSceneId] = useState<WritingSceneId>("wechat");
  const [targetLength, setTargetLength] = useState<TargetLength>("medium");
  const [topics, setTopics] = useState<TopicOptionDTO[]>([]);
  const [topicBusy, setTopicBusy] = useState(false);
  const [topicProgress, setTopicProgress] = useState<{ task: "articleTopics"; startedAt: number } | null>(null);
  const [topicError, setTopicError] = useState<string | null>(null);
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);
  const [generatingTopicId, setGeneratingTopicId] = useState<string | null>(null);

  useEffect(() => {
    loadStyles();
    loadArticleDomains();
  }, [loadArticleDomains, loadStyles]);

  useEffect(() => {
    if (!domainId && domains[0]) setDomainId(domains[0].id);
  }, [domainId, domains]);

  const results = useResultsView(onViewChange);

  const selectedDomain = useMemo(
    () => domains.find((d) => d.id === domainId),
    [domainId, domains]
  );
  const domainArg = domainId === "custom" ? customDomain : "";

  async function loadTopics() {
    setTopicBusy(true);
    setTopicProgress({ task: "articleTopics", startedAt: Date.now() });
    setTopicError(null);
    setResearchError(null);
    try {
      const response = await fetchArticleTopics(domainId, domainArg, 6, lang);
      setTopics(response.topics);
      setResearch(response.research ?? null, "generate");
      if (response.topics.length > 0 || response.research) results.open("topics");
    } catch (e) {
      setTopicError((e as Error).message);
    } finally {
      setTopicBusy(false);
      setTopicProgress(null);
    }
  }

  async function loadResearch() {
    setResearchBusy(true);
    setResearchError(null);
    try {
      const bundle = await previewResearch(domainId, domainArg, "", lang);
      setResearch(bundle, "generate");
      results.open("research");
    } catch (e) {
      setResearchError((e as Error).message);
    } finally {
      setResearchBusy(false);
    }
  }

  /** Topics, research and errors belong to one domain choice; drop them when it changes. */
  function clearResults() {
    setTopics([]);
    setResearch(null, "generate");
    setTopicError(null);
    setResearchError(null);
    setGeneratingTopicId(null);
    setTopicProgress(null);
  }

  function selectDomain(nextDomainId: string) {
    setDomainId(nextDomainId);
    clearResults();
  }

  function changeCustomDomain(value: string) {
    setCustomDomain(value);
    clearResults();
  }

  async function generate(topic: TopicOptionDTO) {
    setGeneratingTopicId(topic.id);
    setTopicError(null);
    setResearchError(null);
    try {
      await doGenerateArticle(domainId, domainArg, topic, styleId, sceneId, targetLength);
    } finally {
      setGeneratingTopicId(null);
    }
  }

  async function generateFromTitle() {
    const title = titleInput.trim();
    if (!title) {
      setTopicError(t.enterTitleErr);
      return;
    }
    setGeneratingTopicId("title-input");
    setTopicError(null);
    setResearchError(null);
    try {
      await doGenerateArticleFromTitle(title, styleId, sceneId, targetLength);
    } finally {
      setGeneratingTopicId(null);
    }
  }

  const customDisabled = domainId === "custom" && !customDomain.trim();
  const isGeneratingArticle = Boolean(generatingTopicId);
  const hasResults = topics.length > 0 || Boolean(research);
  const scenes = sceneOptions(t);

  if (results.view === "results" && hasResults) {
    return (
      <GeneratorResults
        lang={lang}
        topics={topics}
        research={research}
        settings={{
          domain: domainId === "custom" ? customDomain.trim() : selectedDomain?.name,
          style: styles.find((style) => style.id === styleId)?.name ?? t.defaultTone,
          scene: scenes.find((scene) => scene.id === sceneId)?.label ?? t.sceneGeneral,
          length: lengthOptions.find((length) => length.id === targetLength)?.label ?? t.lengthRegular,
        }}
        generatingTopicId={generatingTopicId}
        topicError={topicError}
        researchError={researchError}
        headingRef={results.headingRef}
        onBack={results.backToSetup}
        onGenerate={generate}
      />
    );
  }

  return (
    <div className="generator">
      <section className="step generator-compose">
        <div className="step-head">
          <h2>
            <span className="badge lavender">1</span>
            {t.genStep1}
          </h2>
        </div>

        <div className="title-generate">
          <label className="sr-only" htmlFor="article-title-input">
            {lang === "zh" ? "文章标题" : "Article title"}
          </label>
          <input
            id="article-title-input"
            className="text-input title-input"
            value={titleInput}
            maxLength={120}
            onChange={(e) => {
              setTitleInput(e.target.value);
              setTopicError(null);
            }}
            placeholder={t.titlePlaceholder}
          />
          <button
            type="button"
            className="primary"
            disabled={isGeneratingArticle || !titleInput.trim()}
            onClick={() => {
              void generateFromTitle();
            }}
          >
            <Sparkle />
            {generatingTopicId === "title-input" ? t.generating : t.generateByTitle}
          </button>
        </div>

        <DomainPicker
          lang={lang}
          domains={domains}
          domainId={domainId}
          customDomain={customDomain}
          onSelect={selectDomain}
          onCustomDomainChange={changeCustomDomain}
        />
      </section>

      <section className="step generator-desk">
        <div className="step-head">
          <h2>
            <span className="badge mint">2</span>
            {t.genStep2}
          </h2>
        </div>
        <div className="generator-row">
          <label className="sr-only" htmlFor="article-style-select">
            {lang === "zh" ? "文章口吻" : "Article tone"}
          </label>
          <OptionSelect
            id="article-style-select"
            value={styleId}
            options={styles.map((s) => ({ id: s.id, label: s.name }))}
            emptyLabel={t.defaultTone}
            onChange={setStyleId}
          />
          <label className="sr-only" htmlFor="article-scene-select">
            {t.sceneLabel}
          </label>
          <OptionSelect id="article-scene-select" value={sceneId} options={scenes} onChange={setSceneId} />
          <SegmentedControl
            aria-label={lang === "zh" ? "文章长度" : "Article length"}
            options={lengthOptions}
            value={targetLength}
            onChange={setTargetLength}
          />
          <button
            ref={results.topicsButtonRef}
            type="button"
            className="primary"
            disabled={topicBusy || customDisabled || isGeneratingArticle}
            onClick={loadTopics}
          >
            <Sparkle />
            {topicBusy ? t.generating : t.autoTopics}
          </button>
          <button
            ref={results.researchButtonRef}
            type="button"
            className="primary"
            disabled={researchBusy || customDisabled || isGeneratingArticle}
            onClick={loadResearch}
          >
            <Sparkle />
            {researchBusy ? t.researching : t.researchBtn}
          </button>
          {hasResults && (
            <button
              ref={results.revisitButtonRef}
              type="button"
              className="generator-revisit"
              onClick={() => results.open("revisit")}
            >
              {t.viewGeneratedResults}
            </button>
          )}
        </div>
        <p className="sr-only" role="status" aria-atomic="true">
          {researchBusy ? t.researching : research ? t.sourceCount(research.items.length) : ""}
        </p>
        {topicError && <div className="error topic-error" role="alert">{topicError}</div>}
        {researchError && <div className="error topic-error" role="alert">{researchError}</div>}
        {topicProgress && <ProgressBanner busy={t.generating} progress={topicProgress} lang={lang} />}
        {selectedDomain && !topicBusy && (
          <p className="hint pick-desc">{t.currentDomain(selectedDomain.name)}</p>
        )}
        {generatingTopicId && <p className="hint pick-desc">{t.generatingNote}</p>}
      </section>
    </div>
  );
}

type ResultsOrigin = "topics" | "research" | "revisit";

/**
 * Setup/results navigation: focus the results heading on open and return focus
 * to the button that opened the results when going back.
 */
function useResultsView(onViewChange: ((view: GeneratorView) => void) | undefined) {
  const [view, setView] = useState<GeneratorView>("setup");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const topicsButtonRef = useRef<HTMLButtonElement>(null);
  const researchButtonRef = useRef<HTMLButtonElement>(null);
  const revisitButtonRef = useRef<HTMLButtonElement>(null);
  const originRef = useRef<ResultsOrigin>("topics");

  useEffect(() => {
    if (view !== "results") return;
    const frame = requestAnimationFrame(() => headingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [view]);

  function open(origin: ResultsOrigin) {
    originRef.current = origin;
    setView("results");
    onViewChange?.("results");
  }

  function backToSetup() {
    setView("setup");
    onViewChange?.("setup");
    requestAnimationFrame(() => {
      const target = {
        research: researchButtonRef,
        revisit: revisitButtonRef,
        topics: topicsButtonRef,
      }[originRef.current].current;
      target?.focus();
    });
  }

  return { view, headingRef, topicsButtonRef, researchButtonRef, revisitButtonRef, open, backToSetup };
}
