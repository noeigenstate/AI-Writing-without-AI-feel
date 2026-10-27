/**
 * Deterministic, bounded length normalization for a draft that narrowly misses
 * its length band after the model's own correction passes.
 */
import type { ArticleParagraphRole, GeneratedArticle } from "./article.js";
import { isBoundaryRole } from "./articleFlow.js";
import { countArticleBody, getArticleLengthSpec, type ArticleLengthTier } from "./articleLength.js";
import { splitSentences } from "./splitter.js";
import type { Lang } from "../core/i18n.js";

/** Measure body-only length using the shared language-specific counting rule. */
export function articleBodyLength(article: GeneratedArticle, lang: Lang): number {
  return countArticleBody(article.paragraphs, lang);
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
export function normalizeSmallLengthMiss(
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

function hasCitation(paragraph: string): boolean {
  return /\[\d+\]/u.test(paragraph);
}

function countBoundaryRoles(roles: readonly ArticleParagraphRole[]): number {
  return roles.filter(isBoundaryRole).length;
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
  const boundaryRoleCount = countBoundaryRoles(roles);
  const middle = out
    .map((_, index) => index)
    .filter((index) => index > 0 && index < out.length - 1)
    .filter((index) => roles[index] !== "hook" && roles[index] !== "resolution")
    .filter((index) => !(isBoundaryRole(roles[index]) && boundaryRoleCount <= 1))
    .filter((index) => !hasCitation(out[index]))
    .reverse();

  // Tighten only optional, uncited middle beats. The hook, sole boundary/turn,
  // and closing callback are never used as deterministic length padding.
  for (const index of middle) {
    if (countArticleBody(out, lang) <= max) break;
    const sentences = citationAwareSentences(out[index]);
    while (sentences.length > 1 && countArticleBody(out, lang) > max) {
      sentences.pop();
      const candidate = [...out];
      candidate[index] = sentences.join("").trimEnd();
      if (countArticleBody(candidate, lang) < min) break;
      out[index] = candidate[index];
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
  const boundaryRoleCount = countBoundaryRoles(roles);
  for (let index = compacted.paragraphs.length - 2; index > 0; index -= 1) {
    if (roles[index] === "evidence" || hasCitation(compacted.paragraphs[index])) continue;
    if (isBoundaryRole(roles[index]) && boundaryRoleCount <= 1) continue;
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
  const boundaryRoleCount = countBoundaryRoles(roles);
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
    .filter((index) => !hasCitation(article.paragraphs[index]))
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
