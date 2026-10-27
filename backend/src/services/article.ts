import { chat, type ChatOptions } from "./llm.js";
import { splitSentences } from "./splitter.js";
import type { DocxBlock, ParaKind } from "./docx.js";
import type { ResearchItem } from "./research/types.js";
import { fetchSafeImageBinary, type SafeImageBinary } from "./research/images.js";
import type { LicensedMediaItem } from "./research/licensedMedia.js";
import { applyLieflatLessAiTone } from "./lessAiTone.js";
import {
  articleDraftPrompt,
  articleFlowFixPrompt,
  articleLengthFixPrompt,
  articleTopicsPrompt,
} from "../prompts/article.prompts.js";
import { shortDate, slug, stringField, truncate } from "../lib/text.js";
import { parseJson, parseJsonWithRepair } from "../lib/json.js";
import {
  articleLengthDistance,
  countArticleBody,
  getArticleLengthSpec,
  measureArticleLength,
  type ArticleLengthMetadata,
  type ArticleLengthTier,
} from "./articleLength.js";
import {
  ARTICLE_LABELS,
  tr,
  type Lang,
} from "../core/i18n.js";

export interface ArticleDomain {
  id: string;
  name: string;
  desc: string;
}

export interface TopicOption {
  id: string;
  title: string;
  angle: string;
  audience: string;
  keywords: string[];
}

export interface GeneratedArticle {
  title: string;
  paragraphs: string[];
  /** Semantic role for each body paragraph, aligned by array index. */
  paragraphRoles?: ArticleParagraphRole[];
  /** Optional section headings inserted before the referenced paragraph. */
  sectionBreaks?: ArticleSectionBreak[];
  /** Visual intent emitted with the draft; used only to select retrieved media. */
  mediaHints?: ArticleMediaHint[];
  /** Body-only length measurement for the requested language/tier. */
  length?: ArticleLengthMetadata;
  references?: ArticleReference[];
  /** Lead figure shown after the opening paragraph. */
  figure?: ArticleFigure;
  /** Extra source images placed near the body paragraph they match. */
  bodyFigures?: ArticleFigure[];
}

export type ArticleParagraphRole =
  | "hook"
  | "context"
  | "evidence"
  | "mechanism"
  | "turn"
  | "counterpoint"
  | "resolution";

export interface ArticleSectionBreak {
  /** Zero-based body paragraph index. */
  beforeParagraphIndex: number;
  heading: string;
}

export interface ArticleMediaHint {
  /** Zero-based body paragraph index after which the visual should appear. */
  afterParagraphIndex: number;
  kind: "image" | "gif";
  purpose: "scene" | "evidence" | "explanation" | "breather";
  query: string;
  alt: string;
  caption?: string;
  sourceRefs: number[];
}

export interface ArticleReference {
  id: number;
  text: string;
}

export interface ArticleFigure {
  title: string;
  caption: string;
  origin: "web";
  mediaKind: "image" | "gif";
  mimeType: SafeImageBinary["mimeType"];
  /** Only backend-fetched and container-validated bytes are inlined here. */
  mediaDataUri: string;
  width: number;
  height: number;
  alt: string;
  sourceName: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceRef: number;
  afterParagraphIndex?: number;
}

export interface ArticleDomainMatch {
  domain: ArticleDomain;
  score: number;
  reasons: string[];
}

export type ArticleRenderBlock =
  | { type: "paragraph"; kind: ParaKind; text: string; paragraphIndex?: number }
  | {
      type: "figure";
      title: string;
      caption: string;
      origin: "web";
      mediaKind: "image" | "gif";
      mimeType: SafeImageBinary["mimeType"];
      mediaDataUri: string;
      width: number;
      height: number;
      alt: string;
      sourceName: string;
      sourceTitle: string;
      sourceUrl: string;
      sourceRef: number;
    }
  | { type: "table"; title: string; columns: string[]; rows: string[][]; note?: string }
  | { type: "references"; title: string; items: string[] };

export interface GenerateTopicOptionsInput {
  domain: ArticleDomain;
  n?: number;
  researchContext?: string;
  researchCoverage?: ResearchCoverageSummary;
  lang?: Lang;
}

export interface ResearchCoverageSummary {
  domestic: number;
  international: number;
  global: number;
  uniqueSources: number;
}

export interface GenerateArticleInput {
  domainName: string;
  topic: TopicOption | string;
  styleSummary?: string;
  targetLength?: ArticleLengthTier;
  researchContext?: string;
  researchCoverage?: ResearchCoverageSummary;
  /** Bounded evidence-gate feedback from a rejected complete draft. */
  qualityRepairInstruction?: string;
  sceneId?: string;
  styleId?: string;
  lang?: Lang;
}

export interface ArticleMediaDependencies {
  /** Test seam only; HTTP request data is never allowed to supply this function. */
  fetchImage?: typeof fetchSafeImageBinary;
  /** Open-license media discovered after drafting; it never enters the evidence prompt. */
  supplementalMedia?: LicensedMediaItem[];
}

type ChatFn = (prompt: string, opts?: ChatOptions) => Promise<string>;

interface ArticleDomainDef {
  id: string;
  name: { en: string; zh: string };
  desc: { en: string; zh: string };
}

const ARTICLE_DOMAIN_DEFS: ArticleDomainDef[] = [
  {
    id: "ai-tech",
    name: { en: "AI & Tech", zh: "AI 与科技" },
    desc: {
      en: "LLMs, products, tools, startups, and technology trends",
      zh: "大模型、产品、工具、创业与技术趋势",
    },
  },
  {
    id: "business",
    name: { en: "Business & Finance", zh: "商业与财经" },
    desc: {
      en: "Companies, industries, consumption, investing, and business models",
      zh: "公司、行业、消费、投资与商业模式",
    },
  },
  {
    id: "workplace",
    name: { en: "Work & Growth", zh: "职场与成长" },
    desc: {
      en: "Productivity, management, communication, career choices, and self-growth",
      zh: "效率、管理、沟通、职业选择与个人成长",
    },
  },
  {
    id: "education",
    name: { en: "Education & Learning", zh: "教育与学习" },
    desc: {
      en: "Learning methods, parenting, schooling, and knowledge services",
      zh: "学习方法、家庭教育、升学、知识服务",
    },
  },
  {
    id: "health-life",
    name: { en: "Health & Lifestyle", zh: "健康与生活方式" },
    desc: {
      en: "Body and mind, daily habits, city life, and consumer choices",
      zh: "身心健康、日常习惯、城市生活与消费选择",
    },
  },
  {
    id: "culture",
    name: { en: "Culture & Books", zh: "文化与读书" },
    desc: {
      en: "Books and film, history, people, aesthetics, and public expression",
      zh: "书影、历史、人物、审美和公共表达",
    },
  },
  {
    id: "society",
    name: { en: "Society", zh: "社会观察" },
    desc: {
      en: "Trending events, public issues, demographic shifts, and urban topics",
      zh: "热点事件、公共议题、人群变化和城市议题",
    },
  },
  {
    id: "personal-brand",
    name: { en: "Personal Brand & Creators", zh: "个人品牌与自媒体" },
    desc: {
      en: "Content operations, IP, newsletters, communities, and monetization",
      zh: "内容运营、IP、公众号、社群和变现",
    },
  },
];

const CUSTOM_DOMAIN_DESC = { en: "User-defined domain", zh: "用户自定义领域" };

/**
 * List the supported article domains, localized.
 *
 * @param lang Target language.
 * @returns The domains for that language.
 */
export function getArticleDomains(lang: Lang): ArticleDomain[] {
  return ARTICLE_DOMAIN_DEFS.map((d) => ({ id: d.id, name: d.name[lang], desc: d.desc[lang] }));
}

/** Backward-compatible default (English) list. Prefer getArticleDomains(lang). */
export const ARTICLE_DOMAINS: ArticleDomain[] = getArticleDomains("en");

/**
 * Resolve a domain from an id or a custom name, falling back to the first domain.
 *
 * @param domainId A known domain id, if any.
 * @param customDomain A free-text domain name, used when no id matches.
 * @param lang Target language.
 * @returns The resolved domain.
 */
export function resolveArticleDomain(domainId?: string, customDomain?: string, lang: Lang = "en"): ArticleDomain {
  const domains = getArticleDomains(lang);
  const picked = domains.find((d) => d.id === domainId);
  if (picked) return picked;
  const name = customDomain?.trim();
  if (name) return { id: "custom", name, desc: CUSTOM_DOMAIN_DESC[lang] };
  return domains[0];
}

/**
 * Infer the best-fitting domain for a user-supplied title via the model.
 *
 * @param title The article title.
 * @param lang Target language.
 * @param ask Chat function (injectable for testing).
 * @returns The matched domain with a confidence score and reasons.
 * @throws Error if the model returns no usable match.
 */
export async function matchArticleDomainFromTitle(
  title: string,
  lang: Lang = "en",
  ask: ChatFn = chat
): Promise<ArticleDomainMatch> {
  const raw = await ask(domainMatchPrompt(title, lang), {
    temperature: 0,
    disableThinking: true,
  });
  const parsed = await parseJsonWithRepair<unknown>(raw, ask, "domain-match JSON object");
  const match = normalizeDomainMatch(parsed, lang);
  if (match) {
    return match;
  }

  throw new Error("The model did not return a usable domain match.");
}

/**
 * Generate topic options for a domain.
 *
 * Accepts either a {@link GenerateTopicOptionsInput} object or the legacy
 * `(domain, n)` positional form. The chat function is injectable for testing.
 *
 * @returns Up to `n` normalized topic options.
 * @throws Error if the model returns no usable topics.
 */
export async function generateTopicOptions(
  input: GenerateTopicOptionsInput,
  ask?: ChatFn
): Promise<TopicOption[]>;
export async function generateTopicOptions(
  domain: ArticleDomain,
  n?: number,
  ask?: ChatFn
): Promise<TopicOption[]>;
export async function generateTopicOptions(
  inputOrDomain: GenerateTopicOptionsInput | ArticleDomain,
  nOrAsk: number | ChatFn = 6,
  maybeAsk: ChatFn = chat
): Promise<TopicOption[]> {
  const options =
    "domain" in inputOrDomain
      ? inputOrDomain
      : {
          domain: inputOrDomain,
          n: typeof nOrAsk === "number" ? nOrAsk : 6,
        };
  const ask = typeof nOrAsk === "function" ? nOrAsk : maybeAsk;
  const n = options.n ?? 6;
  const lang: Lang = "lang" in options && options.lang ? options.lang : "en";
  const raw = await ask(
    articleTopicsPrompt(
      options.domain.name,
      options.domain.desc,
      n,
      options.researchContext,
      lang,
      options.researchCoverage
    ),
    { temperature: 0.85, disableThinking: true }
  );
  const parsed = await parseJsonWithRepair<unknown>(raw, ask, "topics JSON array");
  const topicItems = topicArray(parsed);
  if (!topicItems) {
    throw new Error("The model did not return usable topics; please retry.");
  }
  const topics = topicItems
    .map((item, index) => normalizeTopic(item, index, lang))
    .filter((item): item is TopicOption => Boolean(item))
    .slice(0, n);
  if (topics.length === 0) {
    throw new Error("The model did not return usable topics; please retry.");
  }
  return topics;
}

/** How many corrective passes to attempt before an off-target draft is rejected. */
const MAX_LENGTH_FIX_PASSES = 5;
/** One optional, non-blocking pass for a seriously broken narrative spine. */
const MIN_ACCEPTABLE_READING_FLOW_SCORE = 66;
/** Measure body-only length using the shared language-specific counting rule. */
export function articleBodyLength(article: GeneratedArticle, lang: Lang): number {
  return countArticleBody(article.paragraphs, lang);
}

/**
 * Generate a full article draft (title + paragraphs) from a topic.
 *
 * The draft is checked against the target-length band; on a clear miss the
 * model is asked to expand/condense its own draft (up to two passes), and a
 * pass is kept only when it moves the length toward the band. A successful
 * return is guaranteed to be inside the requested band; persistent misses are
 * rejected instead of being presented as completed work.
 *
 * @param input Domain, topic, style, length, research context, and language.
 * @param ask Chat function (injectable for testing).
 * @returns The parsed article.
 * @throws Error if the model returns no usable article JSON.
 */
export async function generateArticleDraft(
  input: GenerateArticleInput,
  ask: ChatFn = chat
): Promise<GeneratedArticle> {
  const lang: Lang = input.lang ?? "en";
  const targetLength = input.targetLength ?? "medium";
  const draftPrompt = articleDraftPrompt(input);
  let article = await requestArticleJson(draftPrompt, ask, {
    temperature: 0.72,
    disableThinking: true,
  });

  const spec = getArticleLengthSpec(lang, targetLength);
  const initialFlow = analyzeArticleReadingFlow(article, targetLength, lang);
  if (article.paragraphRoles && initialFlow.score < MIN_ACCEPTABLE_READING_FLOW_SCORE) {
    try {
      const candidate = await requestOptionalArticleJson(
        articleFlowFixPrompt(article, input, initialFlow.issues),
        ask,
        { temperature: 0.46, disableThinking: true }
      );
      if (!candidate) throw new Error("Optional flow repair returned no usable article");
      const repairedFlow = analyzeArticleReadingFlow(candidate, targetLength, lang);
      const originalLengthMiss = articleLengthDistance(articleBodyLength(article, lang), spec);
      const candidateLengthMiss = articleLengthDistance(articleBodyLength(candidate, lang), spec);
      if (
        candidate.paragraphRoles &&
        repairedFlow.score > initialFlow.score &&
        candidateLengthMiss <= originalLengthMiss &&
        preservesSectionStructure(article, candidate, targetLength) &&
        preservesExistingCitations(article, candidate) &&
        preservesMediaIntent(article, candidate, "strict")
      ) {
        article = candidate;
      }
    } catch {
      // Readability repair is deliberately non-blocking. A usable draft still
      // proceeds to deterministic length validation when this optional pass fails.
    }
  }

  for (let pass = 0; pass < MAX_LENGTH_FIX_PASSES; pass += 1) {
    const length = articleBodyLength(article, lang);
    const miss = articleLengthDistance(length, spec);
    if (miss === 0) break;
    const repaired = await requestArticleJson(articleLengthFixPrompt(article, input, length), ask, {
      temperature: 0.72,
      disableThinking: true,
    });
    const fixed = inheritArticleStructure(article, repaired, targetLength);
    if (!fixed) continue;
    if (!preservesSectionStructure(article, fixed, targetLength)) continue;
    if (!preservesExistingCitations(article, fixed)) continue;
    if (!preservesMediaIntent(article, fixed, "length")) continue;
    if (article.paragraphRoles) {
      const beforeFlow = analyzeArticleReadingFlow(article, targetLength, lang);
      const afterFlow = analyzeArticleReadingFlow(fixed, targetLength, lang);
      if (!fixed.paragraphRoles || afterFlow.score < beforeFlow.score) continue;
    }
    // 只在更接近目标区间时采用；否则保留上一版，避免越改越糟
    if (articleLengthDistance(articleBodyLength(fixed, lang), spec) >= miss) continue;
    article = fixed;
  }
  const beforeLocalNormalization = article;
  const normalized = normalizeSmallLengthMiss(article, lang, targetLength);
  const flowStayedSafe = !beforeLocalNormalization.paragraphRoles
    || (Boolean(normalized.paragraphRoles)
      && analyzeArticleReadingFlow(normalized, targetLength, lang).score
        >= analyzeArticleReadingFlow(beforeLocalNormalization, targetLength, lang).score);
  if (
    preservesSectionStructure(beforeLocalNormalization, normalized, targetLength)
    && preservesExistingCitations(beforeLocalNormalization, normalized)
    && preservesMediaIntent(beforeLocalNormalization, normalized, "length")
    && flowStayedSafe
  ) {
    article = normalized;
  }
  let length = measureArticleLength(article.paragraphs, lang, targetLength);
  if (!length.inRange) {
    const message =
      lang === "zh"
        ? `模型在 ${MAX_LENGTH_FIX_PASSES} 轮校准后仍未达到目标字数（实际 ${length.actual}，目标 ${length.min}-${length.max}），请重试。`
        : `The model still missed the requested length after ${MAX_LENGTH_FIX_PASSES} correction passes (actual ${length.actual}, target ${length.min}-${length.max}). Please retry.`;
    throw new ArticleLengthTargetError(message, length);
  }

  // lieflat-less-ai-tone is explicitly a finished-draft cleanup skill. Apply
  // it only to Chinese WeChat articles, after flow and length correction, and
  // keep the pass non-blocking. Its patch validator preserves citations and
  // protected tokens; the boundary below also rejects structural/length drift.
  if (lang === "zh" && input.sceneId === "wechat") {
    try {
      const cleaned = await applyLieflatLessAiTone(article, input.styleSummary, ask);
      const cleanedLength = measureArticleLength(cleaned.paragraphs, lang, targetLength);
      if (
        cleaned.paragraphs.length === article.paragraphs.length
        && cleanedLength.inRange
        && preservesExistingCitations(article, cleaned)
      ) {
        article = cleaned;
        length = cleanedLength;
      }
    } catch {
      // Optional tone cleanup must never discard an otherwise valid article.
    }
  }
  return { ...article, length };
}

function preservesExistingCitations(before: GeneratedArticle, after: GeneratedArticle): boolean {
  const markers = (article: GeneratedArticle) => {
    const counts = new Map<number, number>();
    for (const paragraph of article.paragraphs) {
      for (const match of paragraph.matchAll(/\[(\d+)\]/gu)) {
        const marker = Number(match[1]);
        counts.set(marker, (counts.get(marker) ?? 0) + 1);
      }
    }
    return counts;
  };
  const beforeMarkers = markers(before);
  const afterMarkers = markers(after);
  return [...beforeMarkers].every(([marker, count]) => (afterMarkers.get(marker) ?? 0) >= count);
}

function preservesMediaIntent(
  before: GeneratedArticle,
  after: GeneratedArticle,
  mode: "strict" | "length"
): boolean {
  const beforeHints = before.mediaHints ?? [];
  if (beforeHints.length === 0) return true;
  const signature = (hint: ArticleMediaHint) => JSON.stringify([
    hint.kind,
    hint.purpose,
    ...(mode === "strict"
      ? [hint.query.trim().toLocaleLowerCase(), hint.alt.trim().toLocaleLowerCase()]
      : []),
    [...hint.sourceRefs].sort((left, right) => left - right),
  ]);
  const counts = new Map<string, number>();
  for (const hint of after.mediaHints ?? []) {
    const key = signature(hint);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const hint of beforeHints) {
    const key = signature(hint);
    const remaining = counts.get(key) ?? 0;
    if (remaining > 0) {
      counts.set(key, remaining - 1);
      continue;
    }
    if (mode === "length" && mediaHintBecameOrphaned(hint, before, after)) continue;
    return false;
  }
  return true;
}

function mediaHintBecameOrphaned(
  hint: ArticleMediaHint,
  before: GeneratedArticle,
  after: GeneratedArticle
): boolean {
  if (after.paragraphs.length >= before.paragraphs.length) return false;
  if (hint.sourceRefs.some((sourceRef) =>
    after.paragraphs.some((paragraph) => paragraph.includes(`[${sourceRef}]`))
  )) {
    return false;
  }
  const anchoredText = before.paragraphs[hint.afterParagraphIndex] ?? "";
  const anchorTokens = tokenizeForImageMatch(anchoredText);
  if (anchorTokens.size === 0) return false;
  return !after.paragraphs.some((paragraph) => {
    const paragraphTokens = tokenizeForImageMatch(paragraph);
    const overlap = countOverlap(anchorTokens, paragraphTokens);
    return overlap >= Math.min(3, Math.max(1, Math.ceil(anchorTokens.size * 0.15)));
  });
}

export interface ArticleReadingFlowReport {
  score: number;
  issues: string[];
}

function requiredSectionHeadingCount(tier: ArticleLengthTier): number {
  return tier === "long" ? 4 : tier === "medium" ? 2 : 0;
}

function uniqueSectionHeadingCount(article: GeneratedArticle): number {
  return new Set(
    (article.sectionBreaks ?? [])
      .map((section) => section.heading.trim())
      .filter(Boolean)
  ).size;
}

/**
 * Do not let a rewrite or local normalization discard an already-valid section plan.
 *
 * A draft below the tier's heading floor may still be improved by a corrective
 * pass. Once the original meets that floor, however, every candidate must meet
 * it too; duplicate or blank headings do not count toward the requirement.
 */
export function preservesSectionStructure(
  before: GeneratedArticle,
  after: GeneratedArticle,
  tier: ArticleLengthTier
): boolean {
  const required = requiredSectionHeadingCount(tier);
  return required === 0
    || uniqueSectionHeadingCount(before) < required
    || uniqueSectionHeadingCount(after) >= required;
}

/**
 * Evaluate the observable narrative contract without judging prose style.
 *
 * This is intentionally a light, deterministic check: it catches missing
 * argumentative beats, repeated sections, and an unscannable long draft. It
 * never blocks generation and it does not claim to verify literary quality.
 */
export function analyzeArticleReadingFlow(
  article: GeneratedArticle,
  tier: ArticleLengthTier = "medium",
  lang: Lang = "en"
): ArticleReadingFlowReport {
  const roles = article.paragraphRoles;
  if (!roles || roles.length !== article.paragraphs.length) {
    return {
      score: 0,
      issues: [lang === "zh" ? "正文缺少可检查的段落角色。" : "The body has no observable paragraph-role structure."],
    };
  }

  const zh = lang === "zh";
  const issues: string[] = [];
  let score = 100;
  const addIssue = (penalty: number, chinese: string, english: string) => {
    score -= penalty;
    issues.push(zh ? chinese : english);
  };

  if (roles[0] !== "hook") {
    addIssue(14, "开场没有以具体问题、场景或矛盾建立阅读钩子。", "The opening lacks a concrete problem, scene, or tension as a hook.");
  }
  if (roles.at(-1) !== "resolution") {
    addIssue(14, "结尾没有回应开场问题或意象，缺少清晰落点。", "The ending does not answer or echo the opening and lacks a clear resolution.");
  }
  if (!roles.includes("evidence")) {
    addIssue(14, "正文缺少承载来源材料的证据段。", "The body lacks an evidence paragraph grounded in the source material.");
  }
  if (!roles.includes("mechanism")) {
    addIssue(12, "证据之后缺少“为什么、意味着什么”的机制解释。", "The draft presents material without a mechanism explaining why it matters.");
  }
  if (tier !== "short" && !roles.some((role) => role === "turn" || role === "counterpoint")) {
    addIssue(8, "中长文缺少转折、反方视角或边界条件。", "The medium/long draft lacks a turn, counterpoint, or boundary condition.");
  }

  let repeatedRun = 1;
  for (let index = 1; index < roles.length; index += 1) {
    repeatedRun = roles[index] === roles[index - 1] ? repeatedRun + 1 : 1;
    if (repeatedRun === 3) {
      addIssue(10, "连续三段承担同一功能，阅读节奏停滞。", "Three consecutive paragraphs serve the same role, flattening the reading rhythm.");
      break;
    }
  }

  const normalized = article.paragraphs.map((paragraph) =>
    paragraph
      .toLocaleLowerCase()
      .replace(/\[\d+\]/gu, "")
      .replace(/[^\p{L}\p{N}]+/gu, "")
  );
  if (new Set(normalized.filter(Boolean)).size < normalized.filter(Boolean).length) {
    addIssue(16, "正文存在重复段落，应合并而不是换词复述。", "The body contains a repeated paragraph that should be merged rather than paraphrased.");
  }

  const headingCount = uniqueSectionHeadingCount(article);
  const minimumHeadings = requiredSectionHeadingCount(tier);
  if (headingCount < minimumHeadings) {
    addIssue(
      10,
      `章节层次不足：${tier === "long" ? "长文至少需要四个" : "中篇至少需要两个"}可扫读的小标题。`,
      `The article is hard to scan: a ${tier} draft needs at least ${minimumHeadings} meaningful section headings.`
    );
  }

  const evidenceIndices = roles.flatMap((role, index) => (role === "evidence" ? [index] : []));
  const unexplainedEvidence = evidenceIndices.some((index) =>
    !roles.slice(index + 1, index + 3).some((role) => role === "mechanism" || role === "turn")
  );
  if (unexplainedEvidence) {
    addIssue(8, "至少一处证据后没有紧跟解释或转折，读者难以理解其意义。", "At least one evidence beat is not followed by explanation or a turn, leaving its meaning unclear.");
  }

  return { score: Math.max(0, score), issues: issues.slice(0, 12) };
}

/** Preserve a positional narrative/media plan when a length-only rewrite omits or degrades it. */
function inheritArticleStructure(
  before: GeneratedArticle,
  after: GeneratedArticle,
  tier: ArticleLengthTier
): GeneratedArticle | undefined {
  if (before.paragraphs.length !== after.paragraphs.length) {
    const losesRoles = Boolean(before.paragraphRoles) && !after.paragraphRoles;
    const losesSections = (Boolean(before.sectionBreaks?.length) && !after.sectionBreaks?.length)
      || !preservesSectionStructure(before, after, tier);
    // Positional metadata cannot be safely copied across a changed paragraph
    // count. Give the bounded length-repair loop another chance instead of
    // silently discarding the narrative and media plan.
    return losesRoles || losesSections ? undefined : after;
  }
  return {
    ...after,
    paragraphRoles: after.paragraphRoles ?? before.paragraphRoles,
    sectionBreaks: preservesSectionStructure(before, after, tier)
      ? after.sectionBreaks ?? before.sectionBreaks
      : before.sectionBreaks,
    mediaHints: after.mediaHints ?? before.mediaHints,
  };
}

/** A bounded generation attempt could not satisfy the requested length band. */
export class ArticleLengthTargetError extends Error {
  constructor(
    message: string,
    readonly length: ArticleLengthMetadata
  ) {
    super(message);
    this.name = "ArticleLengthTargetError";
  }
}

/** A provider returned empty or structurally unusable article JSON. */
export class ArticleModelOutputError extends Error {
  constructor() {
    super("The model did not return a usable article JSON after one retry.");
    this.name = "ArticleModelOutputError";
  }
}

/**
 * Request a normalized article, retrying once when visible content is empty or
 * the parsed JSON has the wrong shape. The retry uses the original full prompt
 * so an empty first response is never "repaired" into a meaningless `{}`.
 */
async function requestArticleJson(
  prompt: string,
  ask: ChatFn,
  options: ChatOptions
): Promise<GeneratedArticle> {
  let providerError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw: string;
    try {
      raw = await ask(prompt, {
        ...options,
        temperature: attempt === 0 ? options.temperature : Math.min(options.temperature ?? 0.4, 0.4),
        disableThinking: true,
      });
    } catch (error) {
      providerError = error;
      continue;
    }
    providerError = undefined;
    if (!raw.trim()) continue;

    try {
      const parsed = await parseJsonWithRepair<unknown>(raw, ask, "article JSON object");
      const article = normalizeArticle(parsed);
      if (article) return article;
    } catch {
      // Retry the complete generation prompt once. Do not surface or log raw
      // model output because it may contain source text or provider details.
    }
  }
  if (providerError) throw providerError;
  throw new ArticleModelOutputError();
}

/** One-shot parser for the optional flow pass: no retry and no model JSON repair. */
async function requestOptionalArticleJson(
  prompt: string,
  ask: ChatFn,
  options: ChatOptions
): Promise<GeneratedArticle | undefined> {
  const raw = await ask(prompt, { ...options, disableThinking: true });
  if (!raw.trim()) return undefined;
  try {
    return normalizeArticle(parseJson<unknown>(raw)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a small model counting mismatch deterministically at the boundary.
 *
 * Providers regularly miss an exact character/word target even after the
 * bounded correction passes. A bounded overrun is compacted through optional, uncited
 * middle beats while protecting the hook, evidence, sole turn, and close. A small
 * underrun gets a short, non-factual transition; larger underruns still fail
 * through the existing typed length error.
 */
function normalizeSmallLengthMiss(
  article: GeneratedArticle,
  lang: Lang,
  tier: ArticleLengthTier
): GeneratedArticle {
  const spec = getArticleLengthSpec(lang, tier);
  const actual = articleBodyLength(article, lang);
  if (actual >= spec.min && actual <= spec.max) return article;
  const overrunTolerance = lang === "zh"
    ? Math.min(240, Math.max(80, Math.ceil(spec.max * 0.25)))
    : Math.min(120, Math.max(40, Math.ceil(spec.max * 0.2)));
  if (actual > spec.max && actual - spec.max <= overrunTolerance) {
    return compactArticleToMaximum(article, lang, spec.min, spec.max);
  }
  const underrunTolerance = Math.min(50, Math.max(20, Math.ceil(spec.min * 0.05)));
  if (actual < spec.min && spec.min - actual <= underrunTolerance) {
    const paragraphs = [...article.paragraphs];
    const lastIndex = paragraphs.length - 1;
    const last = paragraphs[lastIndex] ?? "";
    const citation = last.match(/\[(\d+)\]/gu)?.at(-1) ?? "";
    const body = last.replace(/\s*\[\d+\]\s*$/u, "").trimEnd();
    const needed = spec.min - actual;
    const addition = lengthBridge(lang, needed);
    paragraphs[lastIndex] = [body, addition, citation].filter(Boolean).join(lang === "zh" ? "" : " ");
    return articleBodyLength({ ...article, paragraphs }, lang) <= spec.max
      ? { ...article, paragraphs }
      : article;
  }
  return article;
}

/** Condense optional middle sentences while preserving the narrative spine. */
function trimArticleToMaximum(
  paragraphs: readonly string[],
  lang: Lang,
  min: number,
  max: number,
  roles: readonly ArticleParagraphRole[] = []
): string[] {
  const out = [...paragraphs];
  const boundaryRoleCount = roles.filter((role) => role === "turn" || role === "counterpoint").length;
  const middle = out
    .map((_, index) => index)
    .filter((index) => index > 0 && index < out.length - 1)
    .filter((index) => roles[index] !== "hook" && roles[index] !== "resolution")
    .filter((index) => !((roles[index] === "turn" || roles[index] === "counterpoint") && boundaryRoleCount <= 1))
    .filter((index) => !/\[\d+\]/u.test(out[index]))
    .reverse();

  // Tighten only optional, uncited middle beats. The hook, sole boundary/turn,
  // and closing callback are never used as deterministic length padding.
  for (const index of middle) {
    if (countArticleBody(out, lang) <= max) break;
    const paragraph = out[index];
    const sentences = citationAwareSentences(paragraph);
    while (sentences.length > 1 && countArticleBody(out, lang) > max) {
      sentences.pop();
      const withoutLast = sentences.join("").trimEnd();
      const candidate = [...out];
      candidate[index] = withoutLast;
      if (countArticleBody(candidate, lang) >= min) {
        out[index] = candidate[index];
      } else {
        break;
      }
    }
  }
  return out;
}

/** Compact a bounded overrun while preserving the article's narrative spine. */
function compactArticleToMaximum(
  article: GeneratedArticle,
  lang: Lang,
  min: number,
  max: number
): GeneratedArticle {
  let compacted: GeneratedArticle = {
    ...article,
    paragraphs: trimArticleToMaximum(article.paragraphs, lang, min, max, article.paragraphRoles),
  };

  while (articleBodyLength(compacted, lang) > max) {
    const removable = removableParagraphIndex(compacted, lang, min);
    if (removable < 0) break;
    compacted = removeArticleParagraph(compacted, removable);
  }

  if (articleBodyLength(compacted, lang) <= max) return compacted;
  const excess = articleBodyLength(compacted, lang) - max;
  const roles = compacted.paragraphRoles ?? [];
  const boundaryRoleCount = roles.filter((role) => role === "turn" || role === "counterpoint").length;
  for (let index = compacted.paragraphs.length - 2; index > 0; index -= 1) {
    if (roles[index] === "evidence" || /\[\d+\]/u.test(compacted.paragraphs[index])) continue;
    if ((roles[index] === "turn" || roles[index] === "counterpoint") && boundaryRoleCount <= 1) continue;
    const shortened = shortenUncitedParagraph(compacted.paragraphs[index], lang, excess);
    if (!shortened) continue;
    const paragraphs = [...compacted.paragraphs];
    paragraphs[index] = shortened;
    const candidate = { ...compacted, paragraphs };
    const length = articleBodyLength(candidate, lang);
    if (length >= min && length <= max) return candidate;
  }
  return compacted;
}

function removableParagraphIndex(article: GeneratedArticle, lang: Lang, min: number): number {
  const roles = article.paragraphRoles ?? [];
  const roleCount = (role: ArticleParagraphRole) => roles.filter((candidate) => candidate === role).length;
  const boundaryRoleCount = roles.filter((role) => role === "turn" || role === "counterpoint").length;
  const priority = (index: number): number => {
    const role = roles[index];
    if (!role) return 3;
    if (role === "context") return 0;
    if (role === "counterpoint") return boundaryRoleCount > 1 ? 1 : Number.POSITIVE_INFINITY;
    if (role === "turn") return boundaryRoleCount > 1 ? 2 : Number.POSITIVE_INFINITY;
    if (role === "evidence" && roleCount("evidence") > 1) return 4;
    if (role === "mechanism" && roleCount("mechanism") > 1) return 5;
    return Number.POSITIVE_INFINITY;
  };
  return article.paragraphs
    .map((_, index) => index)
    .filter((index) => index > 0 && index < article.paragraphs.length - 1)
    .filter((index) => !/\[\d+\]/u.test(article.paragraphs[index]))
    .filter((index) => priority(index) < Number.POSITIVE_INFINITY)
    .filter((index) => countArticleBody(article.paragraphs.filter((_, candidate) => candidate !== index), lang) >= min)
    .sort((left, right) => priority(left) - priority(right) || right - left)[0] ?? -1;
}

function removeArticleParagraph(article: GeneratedArticle, removedIndex: number): GeneratedArticle {
  const paragraphs = article.paragraphs.filter((_, index) => index !== removedIndex);
  const paragraphRoles = article.paragraphRoles?.filter((_, index) => index !== removedIndex);
  const sectionBreaks = (article.sectionBreaks ?? []).flatMap((section) => {
    const movedIndex = section.beforeParagraphIndex > removedIndex
      ? section.beforeParagraphIndex - 1
      : section.beforeParagraphIndex === removedIndex
        ? Math.min(removedIndex, paragraphs.length - 1)
        : section.beforeParagraphIndex;
    return movedIndex > 0 && movedIndex < paragraphs.length
      ? [{ ...section, beforeParagraphIndex: movedIndex }]
      : [];
  });
  const mediaHints = (article.mediaHints ?? []).map((hint) => ({
    ...hint,
    afterParagraphIndex: hint.afterParagraphIndex > removedIndex
      ? hint.afterParagraphIndex - 1
      : hint.afterParagraphIndex === removedIndex
        ? Math.max(0, removedIndex - 1)
        : hint.afterParagraphIndex,
  }));
  return {
    ...article,
    paragraphs,
    ...(paragraphRoles ? { paragraphRoles } : {}),
    ...(article.sectionBreaks ? { sectionBreaks } : {}),
    ...(article.mediaHints ? { mediaHints } : {}),
  };
}

/** Last-resort normalization for a tiny overrun in an uncited middle beat. */
function shortenUncitedParagraph(paragraph: string, lang: Lang, removeUnits: number): string | undefined {
  if (removeUnits <= 0) return paragraph;
  if (lang === "en") {
    const words = paragraph.trim().split(/\s+/u);
    if (words.length - removeUnits < 8) return undefined;
    const kept = words.slice(0, words.length - removeUnits);
    kept[kept.length - 1] = `${kept[kept.length - 1].replace(/[.,;:!?]+$/u, "")}…`;
    return kept.join(" ");
  }

  const characters = Array.from(paragraph.replace(/\s+/gu, ""));
  const terminal = /[。！？!?]/u.test(characters.at(-1) ?? "") ? characters.pop() ?? "" : "";
  // Replace one additional character with an ellipsis so the local shortening
  // is visible rather than pretending the clipped clause was authored whole.
  if (characters.length - removeUnits - 1 < 12) return undefined;
  return `${characters.slice(0, characters.length - removeUnits - 1).join("")}…${terminal}`;
}

/** Keep leading citation markers attached to the sentence that precedes them. */
function citationAwareSentences(paragraph: string): string[] {
  const raw = splitSentences(paragraph);
  const out: string[] = [];
  for (const piece of raw) {
    const leading = piece.match(/^\s*(?:\[\d+\]\s*)+/u)?.[0] ?? "";
    if (leading && out.length > 0) {
      out[out.length - 1] += leading;
      const rest = piece.slice(leading.length);
      if (rest) out.push(rest);
    } else if (piece) {
      out.push(piece);
    }
  }
  return out;
}

/** Choose a short, non-factual closing bridge long enough to cross the lower bound. */
function lengthBridge(lang: Lang, needed: number): string {
  const candidates = lang === "zh"
    ? [
        "判断标准，仍是它能否解决具体问题。",
        "真正的判断标准，仍是它能否解决具体问题。",
        "真正的判断标准，仍是它能否解决具体问题，以及代价是否可以承受。",
        "说到底，真正的判断标准，仍是它能否解决具体问题，以及由此带来的成本和风险是否可以承受。",
      ]
    : [
        "That is the test.",
        "That remains the practical test.",
        "That is the practical test: does it solve the real problem?",
        "That is the practical test: does it solve the real problem without creating a larger one?",
        "That is the practical test: does it solve the real problem at an acceptable cost without creating a larger one?",
      ];
  const single = candidates.find((candidate) => countArticleBody([candidate], lang) >= needed);
  if (single) return single;

  const selected: string[] = [];
  for (const candidate of [...candidates].reverse()) {
    selected.push(candidate);
    if (countArticleBody(selected, lang) >= needed) break;
  }
  return selected.join(lang === "zh" ? "" : " ");
}

/**
 * Flatten an article to plain `{kind, text}` paragraphs (drops figures/tables).
 *
 * @param article The generated article.
 * @returns Paragraph blocks only.
 */
export function articleToDocParagraphs(article: GeneratedArticle): { kind: ParaKind; text: string }[] {
  return articleToDocBlocks(article)
    .filter((block): block is Extract<DocxBlock, { type: "paragraph" }> => block.type === "paragraph")
    .map(({ kind, text }) => ({ kind, text }));
}

/**
 * Spread body figures roughly evenly through the full body paragraph list.
 *
 * @param figures Figures to place after body paragraphs.
 * @param paragraphCount Number of body paragraphs available.
 * @returns Map from body-paragraph index → figures to insert after it.
 */
function spreadFigures(figures: ArticleFigure[], paragraphCount: number): Map<number, ArticleFigure[]> {
  const placement = new Map<number, ArticleFigure[]>();
  if (figures.length === 0 || paragraphCount === 0) {
    return placement;
  }

  const unanchored: ArticleFigure[] = [];
  for (const figure of figures) {
    if (typeof figure.afterParagraphIndex === "number") {
      const after = Math.min(paragraphCount - 1, Math.max(0, figure.afterParagraphIndex));
      const list = placement.get(after) ?? [];
      list.push(figure);
      placement.set(after, list);
    } else {
      unanchored.push(figure);
    }
  }

  const step = paragraphCount / unanchored.length;
  unanchored.forEach((figure, i) => {
    const after = Math.min(paragraphCount - 1, Math.max(0, Math.floor(step * (i + 1)) - 1));
    const list = placement.get(after) ?? [];
    list.push(figure);
    placement.set(after, list);
  });
  return placement;
}

function sectionHeadingMap(article: GeneratedArticle): Map<number, string[]> {
  const headings = new Map<number, string[]>();
  for (const section of article.sectionBreaks ?? []) {
    if (!section.heading.trim() || section.beforeParagraphIndex <= 0 || section.beforeParagraphIndex >= article.paragraphs.length) {
      continue;
    }
    const list = headings.get(section.beforeParagraphIndex) ?? [];
    list.push(section.heading.trim());
    headings.set(section.beforeParagraphIndex, list);
  }
  return headings;
}

/**
 * Lay out an article as ordered docx blocks: title, lead figure, body (with
 * interspersed figures), and references.
 *
 * @param article The generated (enriched) article.
 * @param lang Target language for section labels.
 * @returns Ordered docx blocks ready for {@link ./docx.ts}.
 */
export function articleToDocBlocks(article: GeneratedArticle, lang: Lang = "en"): DocxBlock[] {
  const blocks: DocxBlock[] = [
    { type: "paragraph", kind: "heading1", text: article.title },
  ];
  const bodyFigures = article.bodyFigures ?? [];
  const figuresAfter = spreadFigures(bodyFigures, article.paragraphs.length);
  const headingsBefore = sectionHeadingMap(article);
  if (article.paragraphs.length === 0) {
    if (article.figure) blocks.push({ type: "figure", ...article.figure });
    for (const figure of bodyFigures) blocks.push({ type: "figure", ...figure });
  } else {
    article.paragraphs.forEach((text, i) => {
      for (const heading of headingsBefore.get(i) ?? []) {
        blocks.push({ type: "paragraph", kind: "heading2", text: heading });
      }
      blocks.push({ type: "paragraph", kind: "normal", text });
      if (i === 0 && article.figure) blocks.push({ type: "figure", ...article.figure });
      for (const figure of figuresAfter.get(i) ?? []) blocks.push({ type: "figure", ...figure });
    });
  }

  if (article.references && article.references.length > 0) {
    blocks.push({ type: "paragraph", kind: "heading2", text: tr(ARTICLE_LABELS.references, lang) });
    blocks.push(
      ...article.references.map((reference) => ({
        type: "paragraph" as const,
        kind: "normal" as const,
        text: reference.text,
      }))
    );
  }

  return blocks;
}

/**
 * Lay out an article as render blocks for the web editor.
 *
 * Mirrors {@link articleToDocBlocks}, but threads each body paragraph's stored
 * index so the editor can map sentences back to the document.
 *
 * @param article The generated (enriched) article.
 * @param paragraphs Parsed paragraphs (to recover indices by text match).
 * @param lang Target language for section labels.
 * @returns Ordered render blocks.
 */
export function articleToRenderBlocks(
  article: GeneratedArticle,
  paragraphs: { index: number; text: string }[] = [],
  lang: Lang = "en"
): ArticleRenderBlock[] {
  let cursor = 0;
  const takeParagraphIndex = (text: string): number | undefined => {
    for (let i = cursor; i < paragraphs.length; i += 1) {
      if (paragraphs[i].text === text) {
        cursor = i + 1;
        return paragraphs[i].index;
      }
    }
    return undefined;
  };

  const blocks: ArticleRenderBlock[] = [
    { type: "paragraph", kind: "heading1", text: article.title, paragraphIndex: takeParagraphIndex(article.title) },
  ];
  const bodyFigures = article.bodyFigures ?? [];
  const figuresAfter = spreadFigures(bodyFigures, article.paragraphs.length);
  const headingsBefore = sectionHeadingMap(article);
  let renderedGifCount = 0;
  const pushFigure = (figure: ArticleFigure) => {
    const rendered = safeRenderFigure(figure, renderedGifCount < MAX_INLINE_GIFS);
    if (!rendered) return;
    if (rendered.mediaKind === "gif") renderedGifCount += 1;
    blocks.push(rendered);
  };
  if (article.paragraphs.length === 0) {
    if (article.figure) pushFigure(article.figure);
    for (const figure of bodyFigures) pushFigure(figure);
  } else {
    article.paragraphs.forEach((paragraph, i) => {
      for (const heading of headingsBefore.get(i) ?? []) {
        blocks.push({
          type: "paragraph",
          kind: "heading2",
          text: heading,
          paragraphIndex: takeParagraphIndex(heading),
        });
      }
      blocks.push({ type: "paragraph", kind: "normal", text: paragraph, paragraphIndex: takeParagraphIndex(paragraph) });
      if (i === 0 && article.figure) pushFigure(article.figure);
      for (const figure of figuresAfter.get(i) ?? []) pushFigure(figure);
    });
  }

  if (article.references && article.references.length > 0) {
    blocks.push({
      type: "references",
      title: tr(ARTICLE_LABELS.references, lang),
      items: article.references.map((reference) => reference.text),
    });
  }

  return blocks;
}

/** Emit only backend-vetted inline raster media; remote image URLs never enter the DTO. */
function safeRenderFigure(
  figure: ArticleFigure,
  allowAnimatedMedia = true
): Extract<ArticleRenderBlock, { type: "figure" }> | undefined {
  if (!isSafeArticleFigure(figure) || (figure.mediaKind === "gif" && !allowAnimatedMedia)) {
    return undefined;
  }
  return {
    type: "figure",
    title: figure.title,
    caption: figure.caption,
    origin: figure.origin,
    mimeType: figure.mimeType,
    mediaDataUri: figure.mediaDataUri,
    width: figure.width,
    height: figure.height,
    alt: figure.alt,
    mediaKind: figure.mediaKind,
    sourceName: figure.sourceName,
    sourceTitle: figure.sourceTitle,
    sourceUrl: figure.sourceUrl,
    sourceRef: figure.sourceRef,
  };
}

function isSafeArticleFigure(figure: ArticleFigure): boolean {
  const allowedMimeTypes: ReadonlySet<SafeImageBinary["mimeType"]> = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ]);
  if (
    figure.origin !== "web"
    || !allowedMimeTypes.has(figure.mimeType)
    || !Number.isSafeInteger(figure.width)
    || !Number.isSafeInteger(figure.height)
    || figure.width <= 0
    || figure.height <= 0
    || !Number.isSafeInteger(figure.sourceRef)
    || figure.sourceRef <= 0
  ) {
    return false;
  }
  if (figure.mediaKind === "gif" ? figure.mimeType !== "image/gif" : figure.mimeType === "image/gif") {
    return false;
  }
  const prefix = `data:${figure.mimeType};base64,`;
  if (!figure.mediaDataUri.startsWith(prefix)) return false;
  const payload = figure.mediaDataUri.slice(prefix.length);
  return payload.length > 0
    && payload.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(payload);
}

/**
 * Attach references, relevant source images, and inline citations to an article.
 *
 * @param article The drafted article.
 * @param items Research items gathered for the topic.
 * @param accessedAt Access timestamp for the reference list.
 * @param lang Target language.
 * @returns A new article enriched with sourcing.
 */
export async function enrichArticleWithResearch(
  article: GeneratedArticle,
  items: ResearchItem[],
  accessedAt = new Date(),
  lang: Lang = "en",
  dependencies: ArticleMediaDependencies = {}
): Promise<GeneratedArticle> {
  const evidenceItems = items.slice(0, 16);
  const evidenceReferences = formatReferences(evidenceItems, accessedAt);
  const supplementalMedia = (dependencies.supplementalMedia ?? []).slice(0, maxFigureCount(article));
  const supplementalItems = supplementalMedia.map(licensedMediaResearchItem);
  const licensedMediaByResearchId = new Map(
    supplementalMedia.map((media) => [`openverse:${media.id}`, media] as const)
  );
  const references = [
    ...evidenceReferences,
    ...formatLicensedMediaReferences(supplementalMedia, evidenceReferences.length, accessedAt),
  ];
  // The draft only saw the evidence window. Supplemental media references are
  // appended for figure attribution and must not validate invented body cites.
  const paragraphs = enforceInlineCitations(article.paragraphs, evidenceReferences.length);
  const { lead, body } = await buildArticleFigures(
    { ...article, paragraphs },
    [...evidenceItems, ...supplementalItems],
    lang,
    dependencies.fetchImage ?? fetchSafeImageBinary,
    licensedMediaByResearchId
  );
  return {
    ...article,
    paragraphs,
    ...(article.length
      ? { length: measureArticleLength(paragraphs, lang, article.length.tier) }
      : {}),
    references,
    figure: lead,
    bodyFigures: body,
  };
}

/**
 * Re-run the deterministic figure/source/body relationship gate after all
 * source and licensed-media figures have been attached.
 */
export function articleMediaMatchesBody(
  article: GeneratedArticle,
  researchItems: ResearchItem[],
  supplementalMedia: LicensedMediaItem[] = []
): boolean {
  const evidenceItems = researchItems.slice(0, 16);
  const allItems = [...evidenceItems, ...supplementalMedia.map(licensedMediaResearchItem)];
  const figures = [...(article.figure ? [article.figure] : []), ...(article.bodyFigures ?? [])];
  return figures.every((figure) => {
    if (!isSafeArticleFigure(figure)) return false;
    const item = allItems[figure.sourceRef - 1];
    if (!item || item.url !== figure.sourceUrl) return false;
    const paragraphIndex = figure.afterParagraphIndex ?? 0;
    if (paragraphIndex < 0 || paragraphIndex >= article.paragraphs.length) return false;
    const paragraph = article.paragraphs[paragraphIndex] ?? "";
    const hints = article.mediaHints?.filter((hint) => hint.afterParagraphIndex === paragraphIndex) ?? [];
    const directCitation = [...paragraph.matchAll(/\[(\d+)\]/gu)]
      .some((match) => Number(match[1]) === figure.sourceRef);
    const sourceHint = hints.some((hint) => hint.sourceRefs.includes(figure.sourceRef));
    const targetText = [
      article.title,
      paragraph,
      ...hints.flatMap((hint) => [hint.query, hint.alt]),
    ].join(" ");
    return directCitation || sourceHint || hasSignificantSourceImageMatch(targetText, item);
  });
}

/** Validate and normalize one raw topic object; returns null if it lacks a title. */
function normalizeTopic(item: unknown, index: number, lang: Lang = "en"): TopicOption | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const title = stringField(obj.title);
  if (!title) return null;
  const angle =
    stringField(obj.angle) || (lang === "zh" ? "从一个具体切口展开" : "develop from a specific angle");
  const audience = stringField(obj.audience) || tr(ARTICLE_LABELS.defaultAudience, lang);
  const keywords = Array.isArray(obj.keywords)
    ? obj.keywords
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim())
    : [];
  return {
    id: `topic-${index + 1}-${slug(title)}`,
    title,
    angle,
    audience,
    keywords,
  };
}

/** Extract a topics array from either a bare array or a `{topics|options|items}` wrapper. */
function topicArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return null;
  }

  const obj = value as Record<string, unknown>;
  for (const key of ["topics", "options", "items"]) {
    if (Array.isArray(obj[key])) {
      return obj[key];
    }
  }

  return null;
}

const ARTICLE_PARAGRAPH_ROLES = new Set<ArticleParagraphRole>([
  "hook",
  "context",
  "evidence",
  "mechanism",
  "turn",
  "counterpoint",
  "resolution",
]);

const ARTICLE_MEDIA_PURPOSES = new Set<ArticleMediaHint["purpose"]>([
  "scene",
  "evidence",
  "explanation",
  "breather",
]);

/** Validate a raw article object; returns null without a title and ≥1 paragraph. */
function normalizeArticle(item: unknown): GeneratedArticle | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const title = stringField(obj.title);
  const rawParagraphs = Array.isArray(obj.paragraphs) ? obj.paragraphs : [];
  const isLegacyParagraphArray = rawParagraphs.length > 0
    && rawParagraphs.every((value) => typeof value === "string");
  const isStructuredParagraphArray = rawParagraphs.length > 0
    && rawParagraphs.every((value) => Boolean(value) && typeof value === "object" && !Array.isArray(value));
  if (!isLegacyParagraphArray && !isStructuredParagraphArray) return null;

  const normalizedParagraphs: Array<{
    text: string;
    role?: ArticleParagraphRole;
    heading?: string;
  }> = [];
  if (isLegacyParagraphArray) {
    for (const value of rawParagraphs as string[]) {
      if (value.trim()) normalizedParagraphs.push({ text: value.trim() });
    }
  } else {
    for (const value of rawParagraphs) {
      const paragraph = value as Record<string, unknown>;
      const text = stringField(paragraph.text);
      const rawRole = stringField(paragraph.role) as ArticleParagraphRole;
      if (!text || !ARTICLE_PARAGRAPH_ROLES.has(rawRole)) return null;
      normalizedParagraphs.push({
        text,
        role: rawRole,
        heading: truncate(stringField(paragraph.heading), 90).trim(),
      });
    }
  }
  const paragraphs = normalizedParagraphs.map((paragraph) => paragraph.text);
  if (!title || paragraphs.length === 0) return null;

  const paragraphRoles = isStructuredParagraphArray
    ? normalizedParagraphs.map((paragraph) => paragraph.role as ArticleParagraphRole)
    : undefined;
  const sectionBreaks = normalizedParagraphs
    .map((paragraph, index) => ({
      beforeParagraphIndex: index,
      heading: paragraph.heading ?? "",
    }))
    .filter((section) => section.beforeParagraphIndex > 0 && section.heading);
  const mediaHints = normalizeArticleMediaHints(obj.mediaHints, paragraphs.length);

  return {
    title,
    paragraphs,
    ...(paragraphRoles ? { paragraphRoles } : {}),
    ...(sectionBreaks.length > 0 ? { sectionBreaks } : {}),
    ...(mediaHints.length > 0 ? { mediaHints } : {}),
  };
}

function inferParagraphRole(index: number, paragraphCount: number): ArticleParagraphRole {
  if (index === 0) return "hook";
  if (index === paragraphCount - 1) return "resolution";
  if (index === 1) return "context";
  return index % 3 === 0 ? "mechanism" : "evidence";
}

function normalizeArticleMediaHints(value: unknown, paragraphCount: number): ArticleMediaHint[] {
  if (!Array.isArray(value) || paragraphCount <= 0) return [];
  const hints: ArticleMediaHint[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const afterParagraph = Number(item.afterParagraph);
    const kind = item.kind === "gif" ? "gif" : item.kind === "image" ? "image" : undefined;
    const purpose = stringField(item.purpose) as ArticleMediaHint["purpose"];
    const query = truncate(stringField(item.query), 120).trim();
    const alt = truncate(stringField(item.alt), 180).trim();
    if (!Number.isInteger(afterParagraph) || !kind || !ARTICLE_MEDIA_PURPOSES.has(purpose) || !query) {
      continue;
    }
    const caption = truncate(stringField(item.caption), 220).trim();
    const sourceRefs = Array.isArray(item.sourceRefs)
      ? [...new Set(item.sourceRefs
          .map((source) => Number(source))
          .filter((source) => Number.isInteger(source) && source > 0))]
      : [];
    hints.push({
      afterParagraphIndex: Math.min(paragraphCount - 1, Math.max(0, afterParagraph - 1)),
      kind,
      purpose,
      query,
      alt: alt || query,
      ...(caption ? { caption } : {}),
      sourceRefs,
    });
  }
  return hints.slice(0, 8);
}

/** Validate a raw domain-match object; returns null if the domainId is unknown. */
function normalizeDomainMatch(item: unknown, lang: Lang = "en"): ArticleDomainMatch | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const domainId = stringField(obj.domainId);
  const domain = getArticleDomains(lang).find((entry) => entry.id === domainId);
  if (!domain) return null;
  const confidence = typeof obj.confidence === "number" ? obj.confidence : Number(obj.confidence);
  const score = Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : 70;
  const reasons = Array.isArray(obj.reasons)
    ? obj.reasons.filter((reason): reason is string => typeof reason === "string" && reason.trim().length > 0)
    : [];
  return {
    domain,
    score,
    reasons: reasons.slice(0, 5),
  };
}

/** Build the prompt asking the model to classify a title into one domain. */
function domainMatchPrompt(title: string, lang: Lang = "en"): string {
  const domains = getArticleDomains(lang).map((domain) => ({
    id: domain.id,
    name: domain.name,
    desc: domain.desc,
  }));

  if (lang === "zh") {
    return `你要根据用户输入的文章标题，判断最适合的文章领域。

可选领域：
${JSON.stringify(domains, null, 2)}

用户标题：
${title}

判断要求：
1. 必须只从可选领域中选择一个 domainId。
2. 根据标题语义判断，不要只看单个关键词。
3. 如果标题跨领域，选择最能决定文章论证材料来源的领域。
4. 输出 2-4 条简短 reasons，说明为什么匹配这个领域。

严格只输出 JSON 对象：
{"domainId":"ai-tech","confidence":88,"reasons":["原因1","原因2"]}`;
  }

  return `Pick the best-fitting article domain for the user's title.

Available domains:
${JSON.stringify(domains, null, 2)}

User title:
${title}

Rules:
1. Choose exactly one domainId from the available domains.
2. Judge by the meaning of the title, not a single keyword.
3. If the title spans domains, pick the one that most determines where the article's evidence comes from.
4. Output 2-4 short reasons explaining the match.

Output strictly a JSON object:
{"domainId":"ai-tech","confidence":88,"reasons":["reason 1","reason 2"]}`;
}

/**
 * Keep only inline citations that point at a real reference.
 *
 * 不再给没有引用的段落补造编号（那会伪造出处）；只把指向不存在参考文献的
 * `[n]` 标记清掉，段落有没有引用完全由模型是否真的引用了资料决定。
 */
function enforceInlineCitations(paragraphs: string[], referenceCount: number): string[] {
  return paragraphs.map((paragraph) =>
    paragraph
      .replace(/\[(\d+)\]/g, (marker, n: string) => {
        const id = Number(n);
        return id >= 1 && id <= referenceCount ? marker : "";
      })
      .replace(/ {2,}/g, " ")
      .trimEnd()
  );
}

/** Keep rich media proportional to reading length without turning the article into a gallery. */
const MAX_TOTAL_FIGURES = 6;
const MAX_RANKED_MEDIA = 16;
const MIN_IMAGE_RELEVANCE_SCORE = 3;
const MAX_INLINE_GIFS = 1;
const MAX_TOTAL_INLINE_MEDIA_BYTES = 8 * 1024 * 1024;

interface RankedSourceImage {
  item: ResearchItem;
  score: number;
  paragraphIndex: number;
  sourceRef: number;
  /** Strict matches may fill the length-tier allowance; fallback matches may only yield one figure. */
  selectionMode: "strict" | "fallback";
}

interface RankedSourceImageGroups {
  strict: RankedSourceImage[];
  fallback: RankedSourceImage[];
}

interface BuiltSourceFigure extends ArticleFigure {
  inlineBytes: number;
}

/**
 * Build the lead figure plus any in-body figures.
 *
 * Only source images with enough text-signal overlap are used. The image is
 * placed after the paragraph it best matches; unrelated images are omitted.
 */
async function buildArticleFigures(
  article: GeneratedArticle,
  items: ResearchItem[],
  lang: Lang = "en",
  fetchImage: typeof fetchSafeImageBinary = fetchSafeImageBinary,
  licensedMediaByResearchId: ReadonlyMap<string, LicensedMediaItem> = new Map()
): Promise<{ lead?: ArticleFigure; body: ArticleFigure[] }> {
  const ranked = rankSourceImages(article, items);
  const maxFigures = maxFigureCount(article);
  if (maxFigures <= 0) return { body: [] };
  const preferredStrict = selectSourceImageMatches(article, ranked.strict, maxFigures);
  const preferredStrictUrls = new Set(preferredStrict.map((match) => match.item.imageUrl));
  const strictAttempts = [
    ...preferredStrict,
    ...ranked.strict.filter((match) => !preferredStrictUrls.has(match.item.imageUrl)),
  ];
  // Each static candidate is fully decoded at the trust boundary. Keep this
  // sequential and distinguish the successful-image quota from the attempt
  // list: a failed top-ranked download must not hide the next safe source.
  const fetched: Array<BuiltSourceFigure | undefined> = [];
  for (const match of strictAttempts) {
    const figure = await buildSourceImageFigure(match, lang, fetchImage, licensedMediaByResearchId);
    fetched.push(figure);
    if (applyInlineMediaBudget(fetched).length >= maxFigures) break;
  }

  // Conservative matches never fill a gallery: after strict candidates have
  // been tried, add at most one distinct, safely decoded fallback. Failed or
  // over-budget fallback candidates may be skipped in favour of the next
  // related source, with at most the original (<=16) unique candidates tried.
  if (applyInlineMediaBudget(fetched).length < maxFigures) {
    const strictUrls = new Set(ranked.strict.map((match) => match.item.imageUrl));
    for (const match of ranked.fallback) {
      if (strictUrls.has(match.item.imageUrl)) continue;
      const figure = await buildSourceImageFigure(match, lang, fetchImage, licensedMediaByResearchId);
      if (!figure) continue;
      const beforeCount = applyInlineMediaBudget(fetched).length;
      const withFallback = applyInlineMediaBudget([...fetched, figure]);
      if (withFallback.length <= beforeCount) continue;
      fetched.push(figure);
      break;
    }
  }
  const sourceFigures = applyInlineMediaBudget(fetched);

  // Only a real source image that matches the opening may be the lead. When no
  // such image exists, the article simply has no lead figure.
  const openingSourceIndex = sourceFigures.findIndex((figure) => figure.afterParagraphIndex === 0);
  let lead: ArticleFigure | undefined;
  if (openingSourceIndex >= 0) {
    lead = sourceFigures.splice(openingSourceIndex, 1)[0];
  }
  if (lead) lead.afterParagraphIndex = 0;

  const body = sourceFigures
    .map((figure, editorialOrder) => ({ figure, editorialOrder }))
    .sort((left, right) =>
      (left.figure.afterParagraphIndex ?? 0) - (right.figure.afterParagraphIndex ?? 0)
      || left.editorialOrder - right.editorialOrder
    )
    .map(({ figure }) => figure);
  const numbered = renumberFigures([...(lead ? [lead] : []), ...body], lang);
  return {
    lead: lead ? numbered[0] : undefined,
    body: numbered.slice(lead ? 1 : 0),
  };
}

function renumberFigures(figures: ArticleFigure[], lang: Lang): ArticleFigure[] {
  return figures.map((figure, index) => {
    const prefix = figureLabel(index + 1, lang);
    const stripPrefix = (value: string) => value.replace(/^(?:Figure\s+\d+\.|图\d+)\s*/u, "");
    const captionHadPrefix = /^(?:Figure\s+\d+\.|图\d+)\s*/u.test(figure.caption);
    return {
      ...figure,
      title: `${prefix} ${stripPrefix(figure.title)}`,
      caption: captionHadPrefix ? `${prefix} ${stripPrefix(figure.caption)}` : figure.caption,
    };
  });
}

function maxFigureCount(article: GeneratedArticle): number {
  if (article.length?.tier === "short") return 2;
  if (article.length?.tier === "medium") return 4;
  if (article.length?.tier === "long") return 6;
  return Math.min(MAX_TOTAL_FIGURES, Math.ceil(article.paragraphs.length / 3));
}

function selectSourceImageMatches(
  article: GeneratedArticle,
  ranked: RankedSourceImage[],
  desired: number
): RankedSourceImage[] {
  const selected = ranked.slice(0, desired);
  const wantsGif = article.mediaHints?.some((hint) => hint.kind === "gif");
  if (!wantsGif || selected.some((entry) => isLikelyGifUrl(entry.item.imageUrl))) return selected;
  const gif = ranked.find((entry) => isLikelyGifUrl(entry.item.imageUrl));
  if (!gif) return selected;
  if (selected.length < desired) selected.push(gif);
  else if (selected.length >= 1) selected[selected.length - 1] = gif;
  return [...new Map(selected.map((entry) => [entry.item.imageUrl, entry])).values()];
}

function isLikelyGifUrl(url: string | undefined): boolean {
  return Boolean(url && /\.gif(?:$|[?#])/iu.test(url));
}

/** Localized figure number prefix, e.g. "图2" / "Figure 2.". */
function figureLabel(n: number, lang: Lang): string {
  return lang === "zh" ? `图${n}` : `Figure ${n}.`;
}

/** Build one figure from a safely fetched source image; failure means no figure. */
async function buildSourceImageFigure(
  match: RankedSourceImage,
  lang: Lang,
  fetchImage: typeof fetchSafeImageBinary,
  licensedMediaByResearchId: ReadonlyMap<string, LicensedMediaItem> = new Map()
): Promise<BuiltSourceFigure | undefined> {
  const { item, paragraphIndex, sourceRef } = match;
  if (!item.imageUrl) return undefined;
  const licensedMedia = licensedMediaByResearchId.get(item.id);
  const candidateUrls = licensedMedia
    ? [licensedMedia.downloadUrl, licensedMedia.thumbnailUrl]
    : [item.imageUrl];
  let image: SafeImageBinary | undefined;
  for (const candidateUrl of [...new Set(candidateUrls)]) {
    image = await fetchImage(candidateUrl, 8_000, IMAGE_INLINE_MAX_BYTES).catch(() => undefined);
    if (image) break;
  }
  if (!image) return undefined;
  const isGif = image.mimeType === "image/gif";
  const caption = licensedMedia
    ? licensedMediaFigureCaption(licensedMedia, sourceRef, isGif, lang)
    : lang === "zh"
      ? `${isGif ? "动图" : "图片"}来源 [${sourceRef}]：${item.sourceName}，《${item.title}》，${item.url}`
      : `${isGif ? "GIF" : "Image"} source [${sourceRef}]: ${item.sourceName}, "${item.title}", ${item.url}`;
  return {
    title: isGif ? (lang === "zh" ? "来源动图" : "Source GIF") : tr(ARTICLE_LABELS.figureSourceWord, lang),
    caption,
    origin: "web",
    mimeType: image.mimeType,
    mediaDataUri: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
    width: image.width,
    height: image.height,
    alt: item.title,
    mediaKind: isGif ? "gif" : "image",
    sourceName: item.sourceName,
    sourceTitle: item.title,
    sourceUrl: item.url,
    sourceRef,
    afterParagraphIndex: paragraphIndex,
    inlineBytes: image.bytes.length,
  };
}

/** Keep response payloads bounded; over-budget media is omitted, never replaced. */
function applyInlineMediaBudget(
  figures: (BuiltSourceFigure | undefined)[]
): ArticleFigure[] {
  let inlineBytes = 0;
  let gifCount = 0;
  const accepted: ArticleFigure[] = [];

  for (const built of figures) {
    if (!built) continue;
    const { inlineBytes: figureBytes, ...figure } = built;
    const isGif = figure.mediaKind === "gif";
    const exceedsGifLimit = isGif && gifCount >= MAX_INLINE_GIFS;
    const exceedsByteLimit = inlineBytes + figureBytes > MAX_TOTAL_INLINE_MEDIA_BYTES;
    if (exceedsGifLimit || exceedsByteLimit || figureBytes <= 0) continue;

    inlineBytes += figureBytes;
    if (isGif) gifCount += 1;
    accepted.push(figure);
  }
  return accepted;
}

/**
 * Rank source images best-match-first for the article; empty when none are relevant.
 *
 * Only strong matches (score ≥ {@link MIN_IMAGE_RELEVANCE_SCORE}) are eligible.
 * Weak or zero-overlap images are never used merely to fill a quota.
 */
function rankSourceImages(article: GeneratedArticle, items: ResearchItem[]): RankedSourceImageGroups {
  const candidates = [...new Map(
    items
      .map((item, sourceIndex) => ({ item, sourceIndex }))
      .filter(({ item }) => item.imageUrl)
      .map((entry) => [entry.item.imageUrl!.trim().toLocaleLowerCase(), entry])
  ).values()];
  if (candidates.length === 0) {
    return { strict: [], fallback: [] };
  }

  const paragraphs = article.paragraphs.length > 0 ? article.paragraphs : [article.title];

  const scored = candidates
    .map(({ item, sourceIndex }) => {
      let best = { score: 0, paragraphIndex: 0 };
      paragraphs.forEach((paragraph, paragraphIndex) => {
        const hints = article.mediaHints?.filter((hint) => hint.afterParagraphIndex === paragraphIndex) ?? [];
        const hintText = hints.map((hint) => `${hint.query} ${hint.alt}`).join(" ");
        // Supplemental media is discovered only after the draft is complete,
        // so the model could never have cited or intentionally selected its
        // appended reference number. Do not let a formerly out-of-range model
        // marker become an explicit +8/+10 anchor when media refs are added.
        const isSupplementalMedia = item.sourceId === "openverse";
        const directCitation = !isSupplementalMedia
          && [...paragraph.matchAll(/\[(\d+)\]/gu)]
            .some((match) => Number(match[1]) === sourceIndex + 1);
        const sourceHint = !isSupplementalMedia
          && hints.some((hint) => hint.sourceRefs.includes(sourceIndex + 1));
        const gifHint = hints.some((hint) => hint.kind === "gif") && isLikelyGifUrl(item.imageUrl);
        const targetText = [article.title, paragraph, hintText].join(" ");
        const hasExplicitAnchor = directCitation || sourceHint;
        const hasSignificantTextMatch = hasSignificantSourceImageMatch(targetText, item);
        const score = (hasExplicitAnchor || hasSignificantTextMatch
          ? imageRelevanceScore([paragraph, hintText].join(" "), item)
          + imageRelevanceScore(article.title, item) * 0.3
          + (directCitation ? 10 : 0)
          + (sourceHint ? 8 : 0)
          + (gifHint ? 4 : 0)
          : 0);
        if (score > best.score) {
          best = { score, paragraphIndex };
        }
      });
      return { item, sourceRef: sourceIndex + 1, selectionMode: "strict" as const, ...best };
    })
    .sort((a, b) => b.score - a.score);

  const strict = scored
    .filter((entry) => entry.score >= MIN_IMAGE_RELEVANCE_SCORE)
    .slice(0, MAX_RANKED_MEDIA);

  // A model may omit every mediaHint and [n] marker even though research has a
  // genuinely relevant source image. In that narrow case, use the original
  // research query only as a bridge: the source title/summary itself must match
  // both the article's subject and that detailed query. This never fills a
  // quota; buildArticleFigures accepts only the first safely decoded result.
  return {
    strict,
    fallback: rankConservativeSourceImageFallback(article, candidates).slice(0, MAX_RANKED_MEDIA),
  };
}

function imageRelevanceScore(targetText: string, item: ResearchItem): number {
  const targetTokens = tokenizeForImageMatch(targetText);
  if (targetTokens.size === 0) return 0;

  // Publisher names and the search query are not evidence that this particular
  // page's image depicts the article subject. Only actual source-page content
  // participates in the strict textual score; hints/citations add their own
  // explicit bonuses above.
  const sourceTokens = tokenizeForImageMatch([item.title, item.summary, item.excerpt ?? ""].join(" "));
  const titleTokens = tokenizeForImageMatch(item.title);
  if (sourceTokens.size === 0 && titleTokens.size === 0) return 0;

  const overlap = countOverlap(sourceTokens, targetTokens);
  const titleOverlap = countOverlap(titleTokens, targetTokens);
  const coverage = sourceTokens.size > 0 ? overlap / Math.min(sourceTokens.size, targetTokens.size) : 0;
  return overlap + titleOverlap * 1.5 + coverage * 2;
}

/** Require more than one broad domain word before an unanchored source can rank. */
function hasSignificantSourceImageMatch(targetText: string, item: ResearchItem): boolean {
  const targetTokens = tokenizeForImageMatch(targetText);
  const sourceTokens = tokenizeForImageMatch([item.title, item.summary, item.excerpt ?? ""].join(" "));
  const overlapping = [...sourceTokens].filter((token) => targetTokens.has(token));
  if (overlapping.length >= 2) return true;

  // One clear scene/entity in the source title is meaningful; one incidental
  // word buried in a summary is not. Broad AI/technology/education/business
  // tokens have already been removed by tokenizeForImageMatch.
  const titleTokens = tokenizeForImageMatch(item.title);
  return [...titleTokens].some((token) =>
    targetTokens.has(token)
    && (/^[a-z0-9-]{5,}$/u.test(token) || /^[\u4e00-\u9fff]{3}$/u.test(token))
  );
}

interface MediaConcept {
  id: string;
  /** A broad domain term cannot, on its own, justify a fallback image. */
  broad?: boolean;
  aliases: readonly string[];
}

/**
 * Small bilingual concept bridge for conservative cross-language media matching.
 *
 * This is not a topic classifier. It only verifies that a retrieved source's
 * own title/summary expresses the same concrete concept as both the article and
 * the detailed research query. Same-language subjects continue to use lexical
 * overlap, while this bridge covers common Chinese-article/international-source
 * pairs without treating a generic word such as "AI" as sufficient.
 */
const MEDIA_CONCEPTS: readonly MediaConcept[] = [
  {
    id: "artificial-intelligence",
    broad: true,
    aliases: ["ai", "artificial intelligence", "machine intelligence", "人工智能", "大模型"],
  },
  {
    id: "education",
    broad: true,
    aliases: [
      "education", "educational", "learning", "student", "students", "school", "schools",
      "higher education", "higher ed", "classroom", "course", "courses",
      "教育", "学习", "研学", "学生", "学校", "课堂", "课程",
    ],
  },
  {
    id: "children",
    broad: true,
    aliases: ["child", "children", "kid", "kids", "youth", "young people", "孩子", "儿童", "青少年", "年轻人"],
  },
  {
    id: "museum-exhibition",
    aliases: [
      "museum", "museums", "science center", "science centre", "exhibit", "exhibits", "exhibition",
      "科技馆", "科学馆", "博物馆", "展馆", "展览",
    ],
  },
  {
    id: "work-employment",
    broad: true,
    aliases: ["employment", "jobs", "job", "workplace", "workforce", "career", "就业", "工作岗位", "职场", "职业"],
  },
  {
    id: "remote-work",
    aliases: ["remote work", "remote working", "work from home", "远程工作", "远程办公", "居家办公"],
  },
  {
    id: "business-investment",
    broad: true,
    aliases: ["business", "investment", "investing", "company", "companies", "商业", "投资", "公司", "企业"],
  },
  {
    id: "healthcare",
    broad: true,
    aliases: ["healthcare", "health care", "medical", "medicine", "hospital", "健康", "医疗", "医院"],
  },
  {
    id: "climate",
    aliases: ["climate change", "global warming", "climate", "气候变化", "全球变暖", "气候"],
  },
  {
    id: "renewable-energy",
    aliases: ["renewable energy", "clean energy", "solar energy", "wind power", "可再生能源", "清洁能源", "新能源"],
  },
  {
    id: "privacy",
    aliases: ["data protection", "data privacy", "privacy", "数据保护", "隐私"],
  },
  {
    id: "regulation",
    broad: true,
    aliases: ["regulation", "regulations", "regulatory", "policy", "policies", "监管", "法规", "政策", "制度"],
  },
  {
    id: "housing",
    aliases: ["housing", "real estate", "home prices", "住房", "房地产", "房价"],
  },
  {
    id: "aging-elder-care",
    aliases: ["elder care", "eldercare", "aging population", "older adults", "养老", "老龄化", "老年人"],
  },
  {
    id: "marriage",
    aliases: ["marriage", "marry", "wedding", "婚姻", "结婚", "晚婚"],
  },
  {
    id: "supply-chain",
    aliases: ["supply chain", "supply chains", "logistics", "供应链", "物流"],
  },
  {
    id: "electric-vehicles",
    aliases: ["electric vehicle", "electric vehicles", "evs", "新能源汽车", "电动汽车"],
  },
  {
    id: "quantum-computing",
    aliases: ["quantum computing", "quantum computer", "quantum computers", "量子计算", "量子电脑"],
  },
  {
    id: "cybersecurity-cryptography",
    aliases: ["cybersecurity", "cyber security", "cryptography", "encryption", "网络安全", "密码学", "加密技术"],
  },
  {
    id: "software-development",
    aliases: ["software development", "programming", "coding", "developer", "developers", "软件开发", "编程", "代码"],
  },
];

function rankConservativeSourceImageFallback(
  article: GeneratedArticle,
  candidates: Array<{ item: ResearchItem; sourceIndex: number }>
): RankedSourceImage[] {
  const articleText = [article.title, ...article.paragraphs].join(" ");
  const articleTokens = tokenizeForImageMatch(articleText);
  const articleConcepts = mediaConceptsForText(articleText);

  return candidates
    .flatMap(({ item, sourceIndex }): RankedSourceImage[] => {
      const sourceText = [item.title, item.summary, item.excerpt ?? ""].join(" ");
      const sourceTokens = tokenizeForImageMatch(sourceText);
      const queryTokens = tokenizeForImageMatch(item.query);
      const sourceConcepts = mediaConceptsForText(sourceText);
      const queryConcepts = mediaConceptsForText(item.query);
      const articleSourceOverlap = countOverlap(articleTokens, sourceTokens);
      const sourceQueryOverlap = countOverlap(sourceTokens, queryTokens);
      const sharedSpecificConcepts = countSharedSpecificMediaConcepts(
        articleConcepts,
        sourceConcepts,
        queryConcepts
      );
      const sharedBroadConcepts = countSharedBroadMediaConcepts(
        articleConcepts,
        sourceConcepts,
        queryConcepts
      );

      // Same-language matching needs multiple meaningful terms plus evidence
      // that the source page also matches the query which admitted it. For
      // bilingual matching, one concrete three-way canonical concept suffices;
      // otherwise two independent broad concepts are required. The generic AI
      // concept never counts toward either threshold.
      const directMatch = articleSourceOverlap >= 2 && sourceQueryOverlap >= 1;
      const bilingualConceptMatch = sharedSpecificConcepts >= 1 || sharedBroadConcepts >= 2;
      if (!directMatch && !bilingualConceptMatch) return [];

      const titleTokens = tokenizeForImageMatch(item.title);
      const articleTitleTokens = tokenizeForImageMatch(article.title);
      const titleOverlap = countOverlap(titleTokens, articleTitleTokens);
      const queryTitleOverlap = countOverlap(titleTokens, queryTokens);
      const paragraphIndex = bestFallbackParagraphIndex(article.paragraphs, sourceTokens, sourceConcepts);
      const score = sharedSpecificConcepts * 12
        + sharedBroadConcepts * 4
        + articleSourceOverlap * 3
        + sourceQueryOverlap * 2
        + titleOverlap * 2
        + queryTitleOverlap;
      return [{
        item,
        sourceRef: sourceIndex + 1,
        score,
        paragraphIndex,
        selectionMode: "fallback",
      }];
    })
    .sort((left, right) => right.score - left.score || left.sourceRef - right.sourceRef);
}

function bestFallbackParagraphIndex(
  paragraphs: string[],
  sourceTokens: Set<string>,
  sourceConcepts: Set<string>
): number {
  let best = { score: -1, paragraphIndex: 0 };
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const lexical = countOverlap(tokenizeForImageMatch(paragraph), sourceTokens);
    const concepts = countSharedSpecificMediaConcepts(
      mediaConceptsForText(paragraph),
      sourceConcepts
    );
    const broadConcepts = countSharedBroadMediaConcepts(
      mediaConceptsForText(paragraph),
      sourceConcepts
    );
    const score = lexical * 2 + concepts * 6 + broadConcepts * 2;
    if (score > best.score) best = { score, paragraphIndex };
  });
  return best.paragraphIndex;
}

function countSharedSpecificMediaConcepts(...sets: Set<string>[]): number {
  return countSharedMediaConcepts(sets, (definition) => !definition.broad);
}

function countSharedBroadMediaConcepts(...sets: Set<string>[]): number {
  return countSharedMediaConcepts(
    sets,
    (definition) => Boolean(definition.broad) && definition.id !== "artificial-intelligence"
  );
}

function countSharedMediaConcepts(
  sets: Set<string>[],
  include: (definition: MediaConcept) => boolean
): number {
  const [first, ...rest] = sets;
  if (!first) return 0;
  let count = 0;
  for (const concept of first) {
    const definition = MEDIA_CONCEPTS.find((candidate) => candidate.id === concept);
    if (!definition || !include(definition)) continue;
    if (rest.every((set) => set.has(concept))) count += 1;
  }
  return count;
}

function mediaConceptsForText(text: string): Set<string> {
  const normalized = text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ");
  const concepts = new Set<string>();
  for (const concept of MEDIA_CONCEPTS) {
    if (concept.aliases.some((alias) => containsMediaConceptAlias(normalized, alias))) {
      concepts.add(concept.id);
    }
  }
  return concepts;
}

function containsMediaConceptAlias(normalizedText: string, rawAlias: string): boolean {
  const alias = rawAlias.normalize("NFKC").toLocaleLowerCase();
  if (!/^[a-z0-9 ]+$/u.test(alias)) return normalizedText.includes(alias);
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ +/gu, "\\s+");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "u").test(normalizedText);
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const token of a) {
    if (b.has(token)) n += 1;
  }
  return n;
}

function tokenizeForImageMatch(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const words: string[] = normalized.match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [];
  for (const segment of normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i < segment.length - 1; i += 1) {
      words.push(segment.slice(i, i + 2));
    }
    for (let i = 0; i < segment.length - 2; i += 1) {
      words.push(segment.slice(i, i + 3));
    }
  }
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "are",
    "was",
    "were",
    "will",
    "about",
    "into",
    "after",
    "before",
    // These describe an entire product domain and cannot establish that a
    // particular source image is about the article's concrete subject.
    "artificial",
    "intelligence",
    "technology",
    "technologies",
    "tech",
    "education",
    "educational",
    "learning",
    "student",
    "students",
    "school",
    "schools",
    "business",
    "commercial",
    "company",
    "companies",
    "investment",
    "investing",
    "finance",
    "financing",
    "market",
    "health",
    "healthcare",
    "medical",
    "work",
    "workplace",
    "workforce",
    "employment",
    "job",
    "jobs",
    "policy",
    "policies",
    "regulation",
    "regulations",
    "regulatory",
    "child",
    "children",
    "kid",
    "kids",
    "youth",
    "\u4eba\u5de5",
    "\u5de5\u667a",
    "\u667a\u80fd",
    "\u4eba\u5de5\u667a",
    "\u5de5\u667a\u80fd",
    "\u5927\u6a21",
    "\u6a21\u578b",
    "\u5927\u6a21\u578b",
    "\u79d1\u6280",
    "\u6280\u672f",
    "\u6559\u80b2",
    "\u5b66\u4e60",
    "\u7814\u5b66",
    "\u5b66\u751f",
    "\u5b69\u5b50",
    "\u513f\u7ae5",
    "\u5546\u4e1a",
    "\u4f01\u4e1a",
    "\u516c\u53f8",
    "\u6295\u8d44",
    "\u878d\u8d44",
    "\u5e02\u573a",
    "\u5065\u5eb7",
    "\u533b\u7597",
    "\u5de5\u4f5c",
    "\u804c\u573a",
    "\u5c31\u4e1a",
    "\u653f\u7b56",
    "\u76d1\u7ba1",
    "\u5982\u4f55",
    "\u4e00\u4e2a",
    "\u6211\u4eec",
    "\u4ed6\u4eec",
    "\u8fd9\u4e9b",
    "\u90a3\u4e9b",
    "\u53ef\u4ee5",
    "\u6b63\u5728",
    "\u5df2\u7ecf",
    "\u56e0\u4e3a",
    "\u4f46\u662f",
  ]);
  return new Set(words.filter((word) => !stop.has(word)));
}

/** Per-source byte cap before a real network image is eligible for inclusion. */
const IMAGE_INLINE_MAX_BYTES = 3 * 1024 * 1024;

/** Convert post-draft Openverse metadata into a figure-only research shape. */
function licensedMediaResearchItem(media: LicensedMediaItem): ResearchItem {
  return {
    id: `openverse:${media.id}`,
    sourceKind: "article",
    sourceName: `Openverse / ${media.creator}`,
    sourceId: "openverse",
    region: "global",
    title: media.title,
    summary: [media.title, ...media.tags].join(" "),
    url: media.landingUrl,
    imageUrl: media.downloadUrl,
    publishedAt: "",
    authors: [media.creator],
    query: media.query,
  };
}

function licensedMediaFigureCaption(
  media: LicensedMediaItem,
  sourceRef: number,
  isGif: boolean,
  lang: Lang
): string {
  if (lang === "zh") {
    return `${isGif ? "动图" : "图片"}来源 [${sourceRef}]：${media.title}，创作者 ${media.creator}；`
      + `${media.licenseName}（${media.licenseUrl}）；原始页面 ${media.landingUrl}。`
      + "许可元数据由 Openverse 汇集，请在使用前于原始页面核验。";
  }
  return `${isGif ? "GIF" : "Image"} source [${sourceRef}]: "${media.title}" by ${media.creator}; `
    + `${media.licenseName} (${media.licenseUrl}); original page ${media.landingUrl}. `
    + "License metadata is indexed by Openverse; verify the terms on the original page before reuse.";
}

/** Format research items into numbered, APA-ish reference strings. */
function formatReferences(items: ResearchItem[], accessedAt: Date): ArticleReference[] {
  const accessed = accessedAt.toISOString().slice(0, 10);
  return items.map((item, index) => {
    const authors = item.authors.length > 0 ? item.authors.join(", ") : item.sourceName;
    const date = shortDate(item.publishedAt) || "n.d.";
    const source = item.sourceKind === "paper" ? "arXiv" : item.sourceName;
    return {
      id: index + 1,
      text: `[${index + 1}] ${authors}. (${date}). ${item.title}. ${source}. ${item.url}. Accessed ${accessed}.`,
    };
  });
}

/** Append complete attribution references without changing evidence numbering. */
function formatLicensedMediaReferences(
  items: LicensedMediaItem[],
  evidenceReferenceCount: number,
  accessedAt: Date
): ArticleReference[] {
  const accessed = accessedAt.toISOString().slice(0, 10);
  return items.map((item, index) => {
    const id = evidenceReferenceCount + index + 1;
    const creatorPage = item.creatorUrl ? ` Creator: ${item.creatorUrl}.` : "";
    return {
      id,
      text: `[${id}] Image: "${item.title}" by ${item.creator}. ${item.licenseName}: ${item.licenseUrl}.`
        + `${creatorPage} Original page: ${item.landingUrl}. `
        + `License metadata indexed by Openverse; verify terms at the original page. Accessed ${accessed}.`,
    };
  });
}
