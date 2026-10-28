import type { RefObject } from "react";
import type { ResearchBundleDTO, ResearchItemDTO, TopicOptionDTO } from "../../lib/api.js";
import { messages, type Dict, type Lang } from "../../lib/i18n.js";
import { ArrowLeft } from "../common/icons.js";

interface GeneratorResultsProps {
  lang: Lang;
  topics: TopicOptionDTO[];
  research: ResearchBundleDTO | null;
  /** Labels of the chosen setup options; an empty `domain` is not listed. */
  settings: { domain?: string; style: string; scene: string; length: string };
  generatingTopicId: string | null;
  topicError: string | null;
  researchError: string | null;
  headingRef: RefObject<HTMLHeadingElement>;
  onBack: () => void;
  onGenerate: (topic: TopicOptionDTO) => Promise<void>;
}

/** Results page of the article generator: title directions and/or the research ledger. */
export default function GeneratorResults({
  lang,
  topics,
  research,
  settings,
  generatingTopicId,
  topicError,
  researchError,
  headingRef,
  onBack,
  onGenerate,
}: GeneratorResultsProps) {
  const t = messages[lang];
  const hasTopics = topics.length > 0;
  return (
    <div className="generator-results">
      <header className="generator-results-head">
        <button type="button" className="generator-back" onClick={onBack}>
          <ArrowLeft />
          {t.backToGeneratorSetup}
        </button>
        <div className="generator-results-copy">
          <h1 ref={headingRef} tabIndex={-1}>
            {hasTopics ? t.topicResultsTitle : t.researchHead}
          </h1>
          <p>{hasTopics ? t.topicResultsSub : t.researchResultsSub}</p>
        </div>
        <ul className="generator-results-meta" aria-label={t.generatorOptionsSummary}>
          {settings.domain && <li>{settings.domain}</li>}
          <li>{settings.style}</li>
          <li>{settings.scene}</li>
          <li>{settings.length}</li>
        </ul>
      </header>

      {generatingTopicId && <p className="generator-results-status" role="status">{t.generatingNote}</p>}
      {topicError && <div className="error topic-error" role="alert">{topicError}</div>}
      {researchError && <div className="error topic-error" role="alert">{researchError}</div>}

      <div className={`generator-results-layout${hasTopics && research ? "" : " single"}`}>
        {hasTopics && (
          <TopicResultsPanel topics={topics} generatingTopicId={generatingTopicId} onGenerate={onGenerate} t={t} />
        )}
        {research && <ResearchResultsPanel research={research} lang={lang} />}
      </div>
    </div>
  );
}

function TopicResultsPanel({
  topics,
  generatingTopicId,
  onGenerate,
  t,
}: Pick<GeneratorResultsProps, "topics" | "generatingTopicId" | "onGenerate"> & { t: Dict }) {
  return (
    <section className="generator-results-panel topic-results-panel" aria-labelledby="topic-results-heading">
      <div className="generator-panel-head">
        <h2 id="topic-results-heading">{t.topicResultsCount(topics.length)}</h2>
      </div>
      <div className="topic-grid">
        {topics.map((topic) => (
          <article className="topic-card" key={topic.id}>
            <div>
              <h3>{topic.title}</h3>
              <p>{topic.angle}</p>
            </div>
            <div className="topic-meta">
              <span>{topic.audience}</span>
              {topic.keywords.slice(0, 3).map((kw) => (
                <span key={kw}>{kw}</span>
              ))}
            </div>
            <button
              type="button"
              className="primary"
              disabled={Boolean(generatingTopicId)}
              onClick={() => {
                void onGenerate(topic);
              }}
            >
              {generatingTopicId === topic.id ? t.generating : t.generateArticleBtn}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function ResearchResultsPanel({ research, lang }: { research: ResearchBundleDTO; lang: Lang }) {
  const t = messages[lang];
  const previewItems = research.items.slice(0, 5);
  return (
    <section className="generator-results-panel research-results-panel" aria-labelledby="research-results-heading">
      <div className="research-head generator-panel-head">
        <h2 id="research-results-heading">{t.researchHead}</h2>
        <span className="research-coverage">
          {t.researchCoverage(
            research.coverage.domestic,
            research.coverage.international,
            research.coverage.global,
            research.coverage.uniqueSources
          )}
        </span>
      </div>
      {previewItems.length > 0 ? (
        <div className="research-list">
          {previewItems.map((item) => (
            <a className="research-item" key={item.id} href={item.url} target="_blank" rel="noreferrer">
              <span>
                {item.sourceName} · {researchRegionLabel(item.region, t)} · {researchKindLabel(item.sourceKind, lang)}
              </span>
              {item.publishedAt && <time>{new Date(item.publishedAt).toLocaleDateString(t.dateLocale)}</time>}
              <strong>{item.title}</strong>
            </a>
          ))}
        </div>
      ) : (
        <p className="generator-empty">{t.noResearchResults}</p>
      )}
      {research.unavailableSources.length > 0 && (
        <p className="research-unavailable">
          {t.unavailableSources(research.unavailableSources.join(lang === "zh" ? "、" : ", "))}
        </p>
      )}
    </section>
  );
}

function researchKindLabel(kind: ResearchItemDTO["sourceKind"], lang: Lang): string {
  const labels = {
    en: { paper: "paper", news: "news", article: "web article", comment: "public comment" },
    zh: { paper: "论文", news: "新闻", article: "网页文章", comment: "公开评论" },
  } as const;
  return labels[lang][kind];
}

function researchRegionLabel(region: ResearchItemDTO["region"], t: Dict): string {
  if (region === "domestic") return t.regionDomestic;
  if (region === "international") return t.regionInternational;
  return t.regionGlobal;
}
