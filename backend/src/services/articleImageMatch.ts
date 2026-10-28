/**
 * Deterministic text-signal matching between article paragraphs and the
 * images attached to research sources. Pure functions only: nothing here
 * fetches or decodes media.
 */
import type { ArticleMediaHint, GeneratedArticle } from "./article.js";
import type { ResearchItem } from "./research/types.js";

const MAX_RANKED_MEDIA = 16;
const MIN_IMAGE_RELEVANCE_SCORE = 3;

export interface RankedSourceImage {
  item: ResearchItem;
  score: number;
  paragraphIndex: number;
  sourceRef: number;
  /** Strict matches may fill the length-tier allowance; fallback matches may only yield one figure. */
  selectionMode: "strict" | "fallback";
}

export interface RankedSourceImageGroups {
  strict: RankedSourceImage[];
  fallback: RankedSourceImage[];
}

interface ImageCandidate {
  item: ResearchItem;
  sourceIndex: number;
}

/**
 * Rank source images best-match-first for the article; empty when none are relevant.
 *
 * Only strong matches (score ≥ {@link MIN_IMAGE_RELEVANCE_SCORE}) are eligible.
 * Weak or zero-overlap images are never used merely to fill a quota.
 */
export function rankSourceImages(article: GeneratedArticle, items: ResearchItem[]): RankedSourceImageGroups {
  const candidates = uniqueImageCandidates(items);
  if (candidates.length === 0) {
    return { strict: [], fallback: [] };
  }

  const paragraphs = article.paragraphs.length > 0 ? article.paragraphs : [article.title];
  const strict = candidates
    .map(({ item, sourceIndex }) => ({
      item,
      sourceRef: sourceIndex + 1,
      selectionMode: "strict" as const,
      ...bestImageParagraph(article, paragraphs, item, sourceIndex + 1),
    }))
    .sort((a, b) => b.score - a.score)
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

/** One entry per distinct image URL; a later duplicate replaces the earlier source. */
function uniqueImageCandidates(items: ResearchItem[]): ImageCandidate[] {
  return [...new Map(
    items
      .map((item, sourceIndex) => ({ item, sourceIndex }))
      .filter(({ item }) => item.imageUrl)
      .map((entry) => [entry.item.imageUrl!.trim().toLocaleLowerCase(), entry])
  ).values()];
}

function bestImageParagraph(
  article: GeneratedArticle,
  paragraphs: string[],
  item: ResearchItem,
  sourceRef: number
): { score: number; paragraphIndex: number } {
  let best = { score: 0, paragraphIndex: 0 };
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const score = paragraphImageScore(article, paragraph, paragraphIndex, item, sourceRef);
    if (score > best.score) {
      best = { score, paragraphIndex };
    }
  });
  return best;
}

function paragraphImageScore(
  article: GeneratedArticle,
  paragraph: string,
  paragraphIndex: number,
  item: ResearchItem,
  sourceRef: number
): number {
  const hints = mediaHintsAfter(article, paragraphIndex);
  const hintText = hints.map((hint) => `${hint.query} ${hint.alt}`).join(" ");
  // Supplemental media is discovered only after the draft is complete,
  // so the model could never have cited or intentionally selected its
  // appended reference number. Do not let a formerly out-of-range model
  // marker become an explicit +8/+10 anchor when media refs are added.
  const isSupplementalMedia = item.sourceId === "openverse";
  const directCitation = !isSupplementalMedia && citesSource(paragraph, sourceRef);
  const sourceHint = !isSupplementalMedia && hints.some((hint) => hint.sourceRefs.includes(sourceRef));
  const hasExplicitAnchor = directCitation || sourceHint;
  if (!hasExplicitAnchor && !hasSignificantSourceImageMatch([article.title, paragraph, hintText].join(" "), item)) {
    return 0;
  }
  const gifHint = hints.some((hint) => hint.kind === "gif") && isLikelyGifUrl(item.imageUrl);
  return imageRelevanceScore([paragraph, hintText].join(" "), item)
    + imageRelevanceScore(article.title, item) * 0.3
    + (directCitation ? 10 : 0)
    + (sourceHint ? 8 : 0)
    + (gifHint ? 4 : 0);
}

/** Media hints anchored after one body paragraph. */
export function mediaHintsAfter(article: GeneratedArticle, paragraphIndex: number): ArticleMediaHint[] {
  return article.mediaHints?.filter((hint) => hint.afterParagraphIndex === paragraphIndex) ?? [];
}

/** True when the paragraph carries an inline `[sourceRef]` citation. */
export function citesSource(paragraph: string, sourceRef: number): boolean {
  return [...paragraph.matchAll(/\[(\d+)\]/gu)].some((match) => Number(match[1]) === sourceRef);
}

export function isLikelyGifUrl(url: string | undefined): boolean {
  return Boolean(url && /\.gif(?:$|[?#])/iu.test(url));
}

/** The source page's own content; publisher names and search queries are excluded. */
function sourcePageText(item: ResearchItem): string {
  return [item.title, item.summary, item.excerpt ?? ""].join(" ");
}

function imageRelevanceScore(targetText: string, item: ResearchItem): number {
  const targetTokens = tokenizeForImageMatch(targetText);
  if (targetTokens.size === 0) return 0;

  // Publisher names and the search query are not evidence that this particular
  // page's image depicts the article subject. Only actual source-page content
  // participates in the strict textual score; hints/citations add their own
  // explicit bonuses above.
  const sourceTokens = tokenizeForImageMatch(sourcePageText(item));
  const titleTokens = tokenizeForImageMatch(item.title);
  if (sourceTokens.size === 0 && titleTokens.size === 0) return 0;

  const overlap = countOverlap(sourceTokens, targetTokens);
  const titleOverlap = countOverlap(titleTokens, targetTokens);
  const coverage = sourceTokens.size > 0 ? overlap / Math.min(sourceTokens.size, targetTokens.size) : 0;
  return overlap + titleOverlap * 1.5 + coverage * 2;
}

/** Require more than one broad domain word before an unanchored source can rank. */
export function hasSignificantSourceImageMatch(targetText: string, item: ResearchItem): boolean {
  const targetTokens = tokenizeForImageMatch(targetText);
  const sourceTokens = tokenizeForImageMatch(sourcePageText(item));
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
  candidates: ImageCandidate[]
): RankedSourceImage[] {
  const articleText = [article.title, ...article.paragraphs].join(" ");
  const articleTokens = tokenizeForImageMatch(articleText);
  const articleConcepts = mediaConceptsForText(articleText);

  return candidates
    .flatMap(({ item, sourceIndex }): RankedSourceImage[] => {
      const sourceText = sourcePageText(item);
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
    const paragraphConcepts = mediaConceptsForText(paragraph);
    const concepts = countSharedSpecificMediaConcepts(paragraphConcepts, sourceConcepts);
    const broadConcepts = countSharedBroadMediaConcepts(paragraphConcepts, sourceConcepts);
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

export function countOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const token of a) {
    if (b.has(token)) n += 1;
  }
  return n;
}

const IMAGE_MATCH_STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "were", "will",
  "about", "into", "after", "before",
  // These describe an entire product domain and cannot establish that a
  // particular source image is about the article's concrete subject.
  "artificial", "intelligence", "technology", "technologies", "tech",
  "education", "educational", "learning", "student", "students", "school", "schools",
  "business", "commercial", "company", "companies", "investment", "investing",
  "finance", "financing", "market", "health", "healthcare", "medical",
  "work", "workplace", "workforce", "employment", "job", "jobs",
  "policy", "policies", "regulation", "regulations", "regulatory",
  "child", "children", "kid", "kids", "youth",
  "人工", "工智", "智能", "人工智", "工智能", "大模", "模型", "大模型", "科技", "技术",
  "教育", "学习", "研学", "学生", "孩子", "儿童", "商业", "企业", "公司", "投资",
  "融资", "市场", "健康", "医疗", "工作", "职场", "就业", "政策", "监管", "如何",
  "一个", "我们", "他们", "这些", "那些", "可以", "正在", "已经", "因为", "但是",
]);

/** Latin words of 3+ characters plus overlapping CJK bigrams and trigrams, minus stop words. */
export function tokenizeForImageMatch(text: string): Set<string> {
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
  return new Set(words.filter((word) => !IMAGE_MATCH_STOP_WORDS.has(word)));
}
