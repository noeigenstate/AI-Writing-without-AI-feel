import type { Lang } from "../core/i18n.js";
import { isOneOf } from "../lib/text.js";

/** Supported article-length tiers accepted by the API. */
export const ARTICLE_LENGTH_TIERS = ["short", "medium", "long"] as const;

export type ArticleLengthTier = (typeof ARTICLE_LENGTH_TIERS)[number];
export type ArticleLengthUnit = "characters" | "words";

export interface ArticleLengthSpec {
  unit: ArticleLengthUnit;
  min: number;
  max: number;
}

export interface ArticleLengthMetadata extends ArticleLengthSpec {
  tier: ArticleLengthTier;
  actual: number;
  inRange: boolean;
}

/**
 * Single source of truth for both prompt guidance and runtime acceptance.
 * Chinese counts non-whitespace Unicode code points; English counts
 * whitespace-delimited words. Titles and other non-body content are excluded.
 */
export const ARTICLE_LENGTH_SPECS: Record<Lang, Record<ArticleLengthTier, ArticleLengthSpec>> = {
  zh: {
    short: { unit: "characters", min: 450, max: 650 },
    medium: { unit: "characters", min: 1000, max: 1300 },
    long: { unit: "characters", min: 3000, max: 3800 },
  },
  en: {
    short: { unit: "words", min: 350, max: 500 },
    medium: { unit: "words", min: 850, max: 1100 },
    long: { unit: "words", min: 2200, max: 2800 },
  },
};

/** Return whether a request value is a supported target-length tier. */
export function isArticleLengthTier(value: unknown): value is ArticleLengthTier {
  return isOneOf(ARTICLE_LENGTH_TIERS, value);
}

/** Resolve the exact length specification for a language and tier. */
export function getArticleLengthSpec(lang: Lang, tier: ArticleLengthTier): ArticleLengthSpec {
  return ARTICLE_LENGTH_SPECS[lang][tier];
}

/**
 * Count body text only. Paragraph separators are whitespace, so they do not
 * affect either counting mode.
 */
export function countArticleBody(paragraphs: readonly string[], lang: Lang): number {
  // Inline reference markers are apparatus rather than authored prose. Removing
  // them before every measurement also means later citation cleanup cannot move
  // an otherwise on-target draft outside its requested band.
  const body = paragraphs.join("\n").replace(/\[\d+\]/gu, "");
  if (lang === "zh") {
    return Array.from(body.replace(/\s/gu, "")).length;
  }
  return body.trim().match(/\S+/gu)?.length ?? 0;
}

/** Measure body text against its exact language/tier specification. */
export function measureArticleLength(
  paragraphs: readonly string[],
  lang: Lang,
  tier: ArticleLengthTier
): ArticleLengthMetadata {
  const spec = getArticleLengthSpec(lang, tier);
  const actual = countArticleBody(paragraphs, lang);
  return {
    tier,
    unit: spec.unit,
    actual,
    min: spec.min,
    max: spec.max,
    inRange: actual >= spec.min && actual <= spec.max,
  };
}

/** Distance from an actual length to the accepted band; zero when in range. */
export function articleLengthDistance(actual: number, spec: ArticleLengthSpec): number {
  if (actual < spec.min) return spec.min - actual;
  if (actual > spec.max) return actual - spec.max;
  return 0;
}
