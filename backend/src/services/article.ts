import { chat, type ChatOptions } from "./llm.js";
import type { ParaKind } from "./docx.js";
import type { fetchSafeImageBinary, SafeImageBinary } from "./research/images.js";
import type { LicensedMediaItem } from "./research/licensedMedia.js";
import { applyLieflatLessAiTone } from "./lessAiTone.js";
import {
  articleDraftPrompt,
  articleFlowFixPrompt,
  articleLengthFixPrompt,
  articleTopicsPrompt,
} from "../prompts/article.prompts.js";
import { slug, stringField, truncate } from "../lib/text.js";
import { parseJson, parseJsonWithRepair } from "../lib/json.js";
import {
  articleLengthDistance,
  getArticleLengthSpec,
  measureArticleLength,
  type ArticleLengthMetadata,
  type ArticleLengthSpec,
  type ArticleLengthTier,
} from "./articleLength.js";
import {
  analyzeArticleReadingFlow,
  inheritArticleStructure,
  preservesExistingCitations,
  preservesLengthRewriteContract,
  preservesMediaIntent,
  preservesSectionStructure,
} from "./articleFlow.js";
import { articleBodyLength, normalizeSmallLengthMiss } from "./articleLengthFit.js";
import {
  ARTICLE_LABELS,
  tr,
  type Lang,
} from "../core/i18n.js";

// The article API is split across focused modules; this file re-exports them so
// importers keep a single entry point.
export {
  analyzeArticleReadingFlow,
  preservesSectionStructure,
  type ArticleReadingFlowReport,
} from "./articleFlow.js";
export { articleBodyLength } from "./articleLengthFit.js";
export { articleToDocBlocks, articleToDocParagraphs, articleToRenderBlocks } from "./articleLayout.js";
export { articleMediaMatchesBody, enrichArticleWithResearch } from "./articleSourcing.js";

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

/** Per-draft settings shared by the generation passes. */
interface DraftPassContext {
  input: GenerateArticleInput;
  ask: ChatFn;
  lang: Lang;
  targetLength: ArticleLengthTier;
  spec: ArticleLengthSpec;
}

/**
 * Generate a full article draft (title + paragraphs) from a topic.
 *
 * The draft is checked against the target-length band; on a clear miss the
 * model is asked to expand/condense its own draft (up to
 * {@link MAX_LENGTH_FIX_PASSES} passes), and a pass is kept only when it moves
 * the length toward the band. A successful return is guaranteed to be inside
 * the requested band; persistent misses are rejected instead of being
 * presented as completed work.
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
  const draft = await requestArticleJson(articleDraftPrompt(input), ask, {
    temperature: 0.72,
    disableThinking: true,
  });
  const context: DraftPassContext = {
    input,
    ask,
    lang,
    targetLength,
    spec: getArticleLengthSpec(lang, targetLength),
  };

  const flowRepaired = await repairWeakReadingFlow(draft, context);
  const lengthRepaired = await repairArticleLength(flowRepaired, context);
  const normalized = normalizeSmallLengthMiss(lengthRepaired, lang, targetLength);
  const article = preservesLengthRewriteContract(lengthRepaired, normalized, targetLength, lang)
    ? normalized
    : lengthRepaired;
  const length = measureArticleLength(article.paragraphs, lang, targetLength);
  if (!length.inRange) throw lengthTargetError(length, lang);
  return applyOptionalToneCleanup(article, length, context);
}

/** Ask once for a better narrative spine; keep the rewrite only when it is strictly better and safe. */
async function repairWeakReadingFlow(
  article: GeneratedArticle,
  { input, ask, lang, targetLength, spec }: DraftPassContext
): Promise<GeneratedArticle> {
  const initialFlow = analyzeArticleReadingFlow(article, targetLength, lang);
  if (!article.paragraphRoles || initialFlow.score >= MIN_ACCEPTABLE_READING_FLOW_SCORE) return article;
  try {
    const candidate = await requestOptionalArticleJson(
      articleFlowFixPrompt(article, input, initialFlow.issues),
      ask,
      { temperature: 0.46, disableThinking: true }
    );
    if (!candidate?.paragraphRoles) return article;
    const repairedFlow = analyzeArticleReadingFlow(candidate, targetLength, lang);
    const originalLengthMiss = articleLengthDistance(articleBodyLength(article, lang), spec);
    const candidateLengthMiss = articleLengthDistance(articleBodyLength(candidate, lang), spec);
    const improves = repairedFlow.score > initialFlow.score
      && candidateLengthMiss <= originalLengthMiss
      && preservesSectionStructure(article, candidate, targetLength)
      && preservesExistingCitations(article, candidate)
      && preservesMediaIntent(article, candidate, "strict");
    return improves ? candidate : article;
  } catch {
    // Readability repair is deliberately non-blocking. A usable draft still
    // proceeds to deterministic length validation when this optional pass fails.
    return article;
  }
}

/** Bounded model length-correction loop; a pass is adopted only when it is safe and closer to the band. */
async function repairArticleLength(
  article: GeneratedArticle,
  { input, ask, lang, targetLength, spec }: DraftPassContext
): Promise<GeneratedArticle> {
  let current = article;
  for (let pass = 0; pass < MAX_LENGTH_FIX_PASSES; pass += 1) {
    const length = articleBodyLength(current, lang);
    const miss = articleLengthDistance(length, spec);
    if (miss === 0) break;
    const repaired = await requestArticleJson(articleLengthFixPrompt(current, input, length), ask, {
      temperature: 0.72,
      disableThinking: true,
    });
    const fixed = inheritArticleStructure(current, repaired, targetLength);
    // 只在更接近目标区间时采用；否则保留上一版，避免越改越糟
    if (
      fixed
      && preservesLengthRewriteContract(current, fixed, targetLength, lang)
      && articleLengthDistance(articleBodyLength(fixed, lang), spec) < miss
    ) {
      current = fixed;
    }
  }
  return current;
}

function lengthTargetError(length: ArticleLengthMetadata, lang: Lang): ArticleLengthTargetError {
  const message =
    lang === "zh"
      ? `模型在 ${MAX_LENGTH_FIX_PASSES} 轮校准后仍未达到目标字数（实际 ${length.actual}，目标 ${length.min}-${length.max}），请重试。`
      : `The model still missed the requested length after ${MAX_LENGTH_FIX_PASSES} correction passes (actual ${length.actual}, target ${length.min}-${length.max}). Please retry.`;
  return new ArticleLengthTargetError(message, length);
}

/**
 * lieflat-less-ai-tone is explicitly a finished-draft cleanup skill. Apply
 * it only to Chinese WeChat articles, after flow and length correction, and
 * keep the pass non-blocking. Its patch validator preserves citations and
 * protected tokens; the boundary below also rejects structural/length drift.
 */
async function applyOptionalToneCleanup(
  article: GeneratedArticle,
  length: ArticleLengthMetadata,
  { input, ask, lang, targetLength }: DraftPassContext
): Promise<GeneratedArticle> {
  if (lang !== "zh" || input.sceneId !== "wechat") return { ...article, length };
  try {
    const cleaned = await applyLieflatLessAiTone(article, input.styleSummary, ask);
    const cleanedLength = measureArticleLength(cleaned.paragraphs, lang, targetLength);
    if (
      cleaned.paragraphs.length === article.paragraphs.length
      && cleanedLength.inRange
      && preservesExistingCitations(article, cleaned)
    ) {
      return { ...cleaned, length: cleanedLength };
    }
  } catch {
    // Optional tone cleanup must never discard an otherwise valid article.
  }
  return { ...article, length };
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
