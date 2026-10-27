import { cached } from "./cache.js";
import { fetchTextWithOutboundPolicy, type SafeTextFetchResult } from "./networkSafety.js";
import type { ResearchItem } from "./types.js";
import { resolveGoogleNewsArticleUrls } from "./webSearch.js";

const DEFAULT_PAGE_LIMIT = 6;
const MAX_SOURCE_PAGE_BYTES = 1_500_000;
const MAX_EXTRACTED_CHARACTERS = 8_000;
const CONTENT_CACHE_TTL_MS = 30 * 60 * 1000;
const FETCH_CONCURRENCY = 4;

type FetchPage = (url: string) => Promise<SafeTextFetchResult>;

export interface EnrichResearchContentOptions {
  limit?: number;
  fetchPage?: FetchPage;
}

/**
 * Fetch bounded source-page text for the strongest non-comment results.
 * Existing provider content wins; failed pages remain ordinary research items.
 */
export async function enrichResearchContent(
  items: ResearchItem[],
  options: EnrichResearchContentOptions = {}
): Promise<ResearchItem[]> {
  const limit = clampLimit(options.limit ?? DEFAULT_PAGE_LIMIT, items.length);
  if (limit === 0) return items;
  const fetchPage = options.fetchPage ?? defaultFetchPage;
  const candidates = items
    .filter((item) => !item.content?.trim() && isPageContentCandidate(item))
    .map((item, index) => ({ item, index, priority: sourceContentPriority(item) }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .slice(0, limit);
  if (candidates.length === 0) return items;

  const resolvedUrls = await resolveGoogleNewsArticleUrls(
    candidates.map(({ item }) => item.url),
    {},
    candidates.map(({ item }) => ({ title: item.title, sourceName: item.sourceName }))
  );
  const resolvedById = new Map<string, string>();
  candidates.forEach(({ item }, index) => {
    const resolved = resolvedUrls[index] ?? item.url;
    if (resolved !== item.url) resolvedById.set(item.id, resolved);
  });

  const contentById = new Map<string, string>();
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(FETCH_CONCURRENCY, candidates.length) },
    async () => {
      while (cursor < candidates.length) {
        const candidate = candidates[cursor];
        cursor += 1;
        if (!candidate) continue;
        const resolvedUrl = resolvedById.get(candidate.item.id) ?? candidate.item.url;
        if (isGoogleNewsWrapper(resolvedUrl)) continue;
        const content = await fetchOneSourceContent(
          { ...candidate.item, url: resolvedUrl },
          fetchPage
        );
        if (content) contentById.set(candidate.item.id, content);
      }
    }
  );
  await Promise.all(workers);

  return items.map((item) => {
    const content = contentById.get(item.id);
    const url = resolvedById.get(item.id) ?? item.url;
    return content || url !== item.url ? { ...item, url, ...(content ? { content } : {}) } : item;
  });
}

async function defaultFetchPage(url: string): Promise<SafeTextFetchResult> {
  return fetchTextWithOutboundPolicy(url, {
    label: "research source content",
    timeoutMs: 10_000,
    maxBytes: MAX_SOURCE_PAGE_BYTES,
    headers: {
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
    },
  });
}

async function fetchOneSourceContent(
  item: ResearchItem,
  fetchPage: FetchPage
): Promise<string | undefined> {
  const cacheKey = `research-content:v1:${item.url}`;
  return cached(cacheKey, CONTENT_CACHE_TTL_MS, async () => {
    try {
      const response = await fetchPage(item.url);
      if (!response.ok) return undefined;
      const contentType = response.headers["content-type"]?.toLocaleLowerCase() ?? "";
      let extracted = "";
      if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml") || !contentType) {
        extracted = extractReadablePageText(response.text, MAX_EXTRACTED_CHARACTERS * 2);
      } else if (contentType.includes("text/plain")) {
        extracted = cleanExtractedText(response.text, MAX_EXTRACTED_CHARACTERS * 2);
      } else {
        return undefined;
      }
      const relevant = selectRelevantPageText(
        extracted,
        [item.query, item.title, item.summary].join(" "),
        MAX_EXTRACTED_CHARACTERS
      );
      return relevant.length >= 160 ? relevant : undefined;
    } catch {
      return undefined;
    }
  });
}

/** Extract article-like text while dropping active, navigational, and boilerplate elements. */
export function extractReadablePageText(html: string, maxCharacters = MAX_EXTRACTED_CHARACTERS): string {
  if (!html) return "";
  const bounded = html.slice(0, MAX_SOURCE_PAGE_BYTES);
  const withoutNoise = bounded
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|svg|noscript|template|iframe|nav|footer|header|form)\b[^>]*>[\s\S]*?<\/\1>/giu, " ");
  const semanticSections = [
    ...withoutNoise.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main>/giu),
    ...withoutNoise.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/giu),
    ...withoutNoise.matchAll(/<[^>]+\brole=["']main["'][^>]*>([\s\S]*?)<\/[^>]+>/giu),
  ].map((match) => match[1]);
  const candidate = semanticSections.join("\n").length >= 240
    ? semanticSections.join("\n")
    : withoutNoise;
  const withBreaks = candidate
    .replace(/<(?:br|hr)\b[^>]*\/?\s*>/giu, "\n")
    .replace(/<\/(?:p|div|section|article|main|li|tr|h[1-6]|blockquote|figcaption)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ");
  return cleanExtractedText(decodeHtmlEntities(withBreaks), maxCharacters);
}

/** Keep opening context plus the blocks that overlap the source query/title most strongly. */
export function selectRelevantPageText(
  text: string,
  relevanceText: string,
  maxCharacters = MAX_EXTRACTED_CHARACTERS
): string {
  const blocks = text
    .split(/\n+/gu)
    .map((block) => block.replace(/\s+/gu, " ").trim())
    .filter((block) => block.length >= 30 && !isBoilerplateBlock(block));
  if (blocks.length === 0) return "";
  const terms = relevanceTerms(relevanceText);
  const ranked = blocks.map((block, index) => ({
    block,
    index,
    score: relevanceScore(block, terms),
  }));
  const selectedIndexes = new Set<number>();
  for (let index = 0; index < Math.min(4, blocks.length); index += 1) selectedIndexes.add(index);
  for (const entry of [...ranked].sort((left, right) => right.score - left.score || left.index - right.index)) {
    if (entry.score <= 0 && selectedIndexes.size >= 8) break;
    selectedIndexes.add(entry.index);
    if (selectedIndexes.size >= 24) break;
  }
  const selected = [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => blocks[index]);
  return selected.join("\n").slice(0, Math.max(1, maxCharacters)).trim();
}

function cleanExtractedText(value: string, maxCharacters: number): string {
  const lines = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .split(/\n+/gu)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const unique = lines.filter((line) => {
    const key = line.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.join("\n").slice(0, Math.max(1, maxCharacters)).trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    nbsp: " ",
    ndash: "–",
    quot: "\"",
    rdquo: "”",
    rsquo: "’",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (entity, token: string) => {
    const lowered = token.toLocaleLowerCase();
    if (lowered.startsWith("#x")) {
      const codePoint = Number.parseInt(lowered.slice(2), 16);
      return safeCodePoint(codePoint, entity);
    }
    if (lowered.startsWith("#")) {
      const codePoint = Number.parseInt(lowered.slice(1), 10);
      return safeCodePoint(codePoint, entity);
    }
    return named[lowered] ?? entity;
  });
}

function safeCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isSafeInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function relevanceTerms(value: string): string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const latin = normalized.match(/[a-z0-9][a-z0-9.+-]{2,}/gu) ?? [];
  const hanSequences = normalized.match(/[\u3400-\u9fff]{2,}/gu) ?? [];
  const han = hanSequences.flatMap((sequence) => {
    const terms: string[] = [];
    for (let index = 0; index < sequence.length - 1; index += 1) {
      terms.push(sequence.slice(index, index + Math.min(4, sequence.length - index)));
    }
    return terms;
  });
  const stop = new Set(["about", "after", "and", "are", "for", "from", "into", "the", "this", "with"]);
  return [...new Set([...latin, ...han].filter((term) => !stop.has(term)))].slice(0, 80);
}

function relevanceScore(block: string, terms: string[]): number {
  const lowered = block.normalize("NFKC").toLocaleLowerCase();
  return terms.reduce((score, term) => score + (lowered.includes(term) ? Math.min(6, term.length) : 0), 0);
}

function isBoilerplateBlock(value: string): boolean {
  return /^(?:accept (?:all )?cookies|cookie settings|privacy policy|terms of use|sign in|log in|subscribe|all rights reserved|skip to (?:main )?content)$/iu.test(value)
    || /(?:enable javascript|your browser does not support)/iu.test(value);
}

function isPageContentCandidate(item: ResearchItem): boolean {
  if (item.sourceKind === "comment") return false;
  try {
    const url = new URL(item.url);
    const hostname = url.hostname.toLocaleLowerCase().replace(/\.$/u, "");
    if (/\.(?:pdf|zip|docx?|xlsx?|pptx?)(?:$|[?#])/iu.test(url.pathname)) return false;
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isGoogleNewsWrapper(value: string): boolean {
  try {
    return new URL(value).hostname.toLocaleLowerCase().replace(/\.$/u, "") === "news.google.com";
  } catch {
    return false;
  }
}

function sourceContentPriority(item: ResearchItem): number {
  let score = item.sourceKind === "paper" ? 5 : item.sourceKind === "article" ? 4 : 2;
  try {
    const hostname = new URL(item.url).hostname.toLocaleLowerCase();
    if (/\.(?:gov|int|edu)(?:\.[a-z]{2})?$/u.test(hostname)) score += 8;
    if (/(?:who\.int|un\.org|europa\.eu|gov\.cn|gov\.uk)$/u.test(hostname)) score += 8;
  } catch {
    // URL validity is checked before this ranking helper.
  }
  if (/official|government|ministry|university|研究|报告|公告|公报|指南|全文/iu.test(`${item.title} ${item.sourceName}`)) {
    score += 4;
  }
  return score;
}

function clampLimit(value: number, maximum: number): number {
  if (!Number.isFinite(value) || maximum <= 0) return 0;
  return Math.min(maximum, Math.max(0, Math.trunc(value)));
}
