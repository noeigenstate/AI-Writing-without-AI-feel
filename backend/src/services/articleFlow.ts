/**
 * Deterministic narrative checks for a draft and the safety gates that decide
 * whether a model rewrite or local normalization may replace an earlier draft.
 */
import type { ArticleMediaHint, ArticleParagraphRole, GeneratedArticle } from "./article.js";
import { countOverlap, tokenizeForImageMatch } from "./articleImageMatch.js";
import type { ArticleLengthTier } from "./articleLength.js";
import type { Lang } from "../core/i18n.js";

export interface ArticleReadingFlowReport {
  score: number;
  issues: string[];
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
  if (tier !== "short" && !roles.some(isBoundaryRole)) {
    addIssue(8, "中长文缺少转折、反方视角或边界条件。", "The medium/long draft lacks a turn, counterpoint, or boundary condition.");
  }
  if (hasThreeRoleRun(roles)) {
    addIssue(10, "连续三段承担同一功能，阅读节奏停滞。", "Three consecutive paragraphs serve the same role, flattening the reading rhythm.");
  }
  if (hasRepeatedParagraph(article.paragraphs)) {
    addIssue(16, "正文存在重复段落，应合并而不是换词复述。", "The body contains a repeated paragraph that should be merged rather than paraphrased.");
  }

  const minimumHeadings = requiredSectionHeadingCount(tier);
  if (uniqueSectionHeadingCount(article) < minimumHeadings) {
    addIssue(
      10,
      `章节层次不足：${tier === "long" ? "长文至少需要四个" : "中篇至少需要两个"}可扫读的小标题。`,
      `The article is hard to scan: a ${tier} draft needs at least ${minimumHeadings} meaningful section headings.`
    );
  }
  if (hasUnexplainedEvidence(roles)) {
    addIssue(8, "至少一处证据后没有紧跟解释或转折，读者难以理解其意义。", "At least one evidence beat is not followed by explanation or a turn, leaving its meaning unclear.");
  }

  return { score: Math.max(0, score), issues: issues.slice(0, 12) };
}

export function isBoundaryRole(role: ArticleParagraphRole | undefined): boolean {
  return role === "turn" || role === "counterpoint";
}

function hasThreeRoleRun(roles: readonly ArticleParagraphRole[]): boolean {
  return roles.some((role, index) => index >= 2 && role === roles[index - 1] && role === roles[index - 2]);
}

/** Same text once citations, case, punctuation and spacing are ignored. */
function hasRepeatedParagraph(paragraphs: readonly string[]): boolean {
  const normalized = paragraphs
    .map((paragraph) =>
      paragraph
        .toLocaleLowerCase()
        .replace(/\[\d+\]/gu, "")
        .replace(/[^\p{L}\p{N}]+/gu, "")
    )
    .filter(Boolean);
  return new Set(normalized).size < normalized.length;
}

/** An evidence beat needs a mechanism or turn within the next two paragraphs. */
function hasUnexplainedEvidence(roles: readonly ArticleParagraphRole[]): boolean {
  return roles.some((role, index) =>
    role === "evidence"
    && !roles.slice(index + 1, index + 3).some((next) => next === "mechanism" || next === "turn")
  );
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
 * Gate shared by model length repairs and local length normalization: keep the
 * section plan, every citation, the media plan, and a role-tagged draft's flow score.
 */
export function preservesLengthRewriteContract(
  before: GeneratedArticle,
  after: GeneratedArticle,
  tier: ArticleLengthTier,
  lang: Lang
): boolean {
  return preservesSectionStructure(before, after, tier)
    && preservesExistingCitations(before, after)
    && preservesMediaIntent(before, after, "length")
    && keepsReadingFlow(before, after, tier, lang);
}

function keepsReadingFlow(
  before: GeneratedArticle,
  after: GeneratedArticle,
  tier: ArticleLengthTier,
  lang: Lang
): boolean {
  if (!before.paragraphRoles) return true;
  return Boolean(after.paragraphRoles)
    && analyzeArticleReadingFlow(after, tier, lang).score >= analyzeArticleReadingFlow(before, tier, lang).score;
}

function citationCounts(article: GeneratedArticle): Map<number, number> {
  const counts = new Map<number, number>();
  for (const paragraph of article.paragraphs) {
    for (const match of paragraph.matchAll(/\[(\d+)\]/gu)) {
      const marker = Number(match[1]);
      counts.set(marker, (counts.get(marker) ?? 0) + 1);
    }
  }
  return counts;
}

export function preservesExistingCitations(before: GeneratedArticle, after: GeneratedArticle): boolean {
  const afterMarkers = citationCounts(after);
  return [...citationCounts(before)].every(([marker, count]) => (afterMarkers.get(marker) ?? 0) >= count);
}

export function preservesMediaIntent(
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

/** Preserve a positional narrative/media plan when a length-only rewrite omits or degrades it. */
export function inheritArticleStructure(
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
