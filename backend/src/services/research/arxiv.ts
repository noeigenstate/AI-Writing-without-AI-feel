import { cached } from "./cache.js";
import { fetchTextWithTimeout } from "./http.js";
import { normalizePublicSourceUrl } from "./networkSafety.js";
import { asArray, isRecord, xmlParser, xmlText, xmlUrlText, type XmlValue } from "./parse.js";
import { waitForProvider } from "./rateLimit.js";
import type { ResearchItem } from "./types.js";

/** Return the first non-empty cleaned text among the candidates. */
function firstText(...values: XmlValue[]): string | undefined {
  for (const value of values) {
    const text = xmlText(value);
    if (text) {
      return text;
    }
  }
  return undefined;
}

/** Resolve an entry's canonical URL (prefer the `alternate` link, else its id). */
function entryUrl(entry: Record<string, unknown>): string | undefined {
  const links = asArray(entry.link as Record<string, unknown> | string | undefined);
  const alternate = links.find((link) => isRecord(link) && link.rel === "alternate");
  const href = isRecord(alternate) ? xmlUrlText(alternate.href as XmlValue) : undefined;
  const id = xmlUrlText(entry.id as XmlValue);
  return normalizePublicSourceUrl(href) || normalizePublicSourceUrl(id);
}

/** Extract author names from an entry, if any. */
function entryAuthors(entry: Record<string, unknown>): string[] | undefined {
  const authors = asArray(entry.author as Record<string, unknown> | string | undefined)
    .map((author) => (isRecord(author) ? xmlText(author.name as XmlValue) : xmlText(author as XmlValue)))
    .filter((author): author is string => Boolean(author));

  return authors.length > 0 ? authors : undefined;
}

/** Build a stable item id from an arXiv URL. */
function itemId(url: string): string {
  return `arxiv:${url.trim().toLowerCase()}`;
}

/**
 * Parse an arXiv Atom feed into research items.
 *
 * @param xml The Atom XML.
 * @param query The originating query (stored on each item).
 * @returns Parsed items (entries lacking a title or URL are dropped).
 */
export function parseArxivAtom(xml: string, query: string): ResearchItem[] {
  const parsed = xmlParser.parse(xml) as { feed?: { entry?: Record<string, unknown> | Record<string, unknown>[] } };
  const entries = asArray(parsed.feed?.entry);

  return entries
    .map((entry): ResearchItem | undefined => {
      const title = xmlText(entry.title as XmlValue);
      const url = entryUrl(entry);

      if (!title || !url) {
        return undefined;
      }

      return {
        id: itemId(url),
        sourceKind: "paper",
        sourceName: "arXiv",
        sourceId: "arxiv",
        region: "international",
        title,
        summary: xmlText(entry.summary as XmlValue) ?? "",
        url,
        publishedAt: firstText(entry.published as XmlValue, entry.updated as XmlValue) ?? "",
        authors: entryAuthors(entry) ?? [],
        query,
      } satisfies ResearchItem;
    })
    .filter((item): item is ResearchItem => Boolean(item));
}

/**
 * Fetch recent arXiv papers for a query (cached 1h, rate-limited per arXiv policy).
 *
 * @param query Free-text search query.
 * @param maxResults Desired result count (clamped to 1–10).
 * @returns Parsed research items.
 * @throws Error if the arXiv request fails.
 */
export function fetchArxivPapers(query: string, maxResults = 8): Promise<ResearchItem[]> {
  const limitedMaxResults = Math.min(10, Math.max(1, Math.trunc(maxResults)));
  const cacheKey = `arxiv:${query.trim().toLowerCase()}:${limitedMaxResults}`;

  return cached(cacheKey, 60 * 60 * 1000, async () => {
    await waitForProvider("arxiv", 3100);

    const params = new URLSearchParams({
      search_query: `all:${query}`,
      start: "0",
      max_results: String(limitedMaxResults),
      sortBy: "submittedDate",
      sortOrder: "descending",
    });

    const res = await fetchTextWithTimeout(
      `https://export.arxiv.org/api/query?${params.toString()}`,
      {},
      { label: "arXiv", timeoutMs: 12_000, maxBytes: 2_000_000 }
    );
    if (!res.ok) {
      throw new Error(`arXiv 请求失败：${res.status}`);
    }

    return parseArxivAtom(res.text, query);
  });
}
