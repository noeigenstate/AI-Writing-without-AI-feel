import type { GeneratedArticle } from "../article.js";
import { normalizePublicSourceUrl, fetchTextWithOutboundPolicy } from "./networkSafety.js";
import { isRecord, tryParseJson } from "./parse.js";
import { createConcurrencyGate } from "./rateLimit.js";

const OPENVERSE_IMAGE_SEARCH_URL = "https://api.openverse.org/v1/images/";
const OPENVERSE_PAGE_SIZE = 8;
const OPENVERSE_RESPONSE_MAX_BYTES = 768 * 1024;
const OPENVERSE_CACHE_TTL_MS = 15 * 60 * 1000;
const OPENVERSE_CACHE_MAX_ENTRIES = 32;
const OPENVERSE_REQUEST_CONCURRENCY = 2;
const ALLOWED_LICENSES = new Set(["cc0", "pdm", "by", "by-sa"]);
const ALLOWED_LICENSE_VERSIONS: Readonly<Record<OpenLicenseId, ReadonlySet<string>>> = {
  cc0: new Set(["1.0"]),
  pdm: new Set(["1.0"]),
  by: new Set(["1.0", "2.0", "2.5", "3.0", "4.0"]),
  "by-sa": new Set(["1.0", "2.0", "2.5", "3.0", "4.0"]),
};
const BLOCKED_TITLE_TERMS = /(?:\b(?:logo|icon|avatar|placeholder|banner|wallpaper|clipart|template|mockup|emoji|untitled)\b)/iu;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LICENSE_VERSION_PATTERN = /^\d{1,2}(?:\.\d{1,2})?$/u;
const URL_LIKE_TEXT_PATTERN = /(?:https?:\/\/|www\.|data:image\/|(?:^|[\s([{'"`])(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|mil|int|io|ai|co|cn|uk|de|fr|jp|au|ca|info|biz)(?=$|[\s/)\]}'"`,.;:!?]))/iu;
const RASTER_ASSET_PATH_PATTERN = /\.(?:png|jpe?g|webp|gif)(?:$|[?#])/iu;
const ENGLISH_WORD_PATTERN = /[a-z][a-z0-9'-]*/giu;
const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "into",
  "is", "it", "of", "on", "or", "that", "the", "their", "this", "to", "with", "without",
  "article", "image", "images", "news", "photo", "photos", "picture", "pictures", "related",
]);
const OVERLY_BROAD_QUERY_WORDS = new Set([
  "ai", "artificial", "intelligence", "technology", "tech", "digital", "education", "learning",
]);

export type OpenLicenseId = "cc0" | "pdm" | "by" | "by-sa";

/** A real Openverse-indexed raster work and the metadata needed to attribute it. */
export interface LicensedMediaItem {
  id: string;
  title: string;
  creator: string;
  creatorUrl?: string;
  license: OpenLicenseId;
  licenseVersion: string;
  licenseName: string;
  licenseUrl: string;
  landingUrl: string;
  /** Backend-only original asset URL. Never return this field through an API DTO. */
  downloadUrl: string;
  /** Backend-only Openverse proxy fallback. Never return this field through an API DTO. */
  thumbnailUrl: string;
  attribution: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  width: number;
  height: number;
  query: string;
  tags: string[];
}

interface OpenverseSearchDependencies {
  fetchJson?: (url: string) => Promise<unknown>;
}

interface LicensedMediaCacheEntry {
  expiresAt: number;
  items: LicensedMediaItem[];
}

const licensedMediaCache = new Map<string, LicensedMediaCacheEntry>();
const licensedMediaInFlight = new Map<string, Promise<LicensedMediaItem[]>>();
const injectedFetchIds = new WeakMap<NonNullable<OpenverseSearchDependencies["fetchJson"]>, number>();
let nextInjectedFetchId = 1;
/** All Openverse calls share one process-wide, FIFO two-slot gate. */
const withOpenverseRequestLimit = createConcurrencyGate(OPENVERSE_REQUEST_CONCURRENCY);

/**
 * Search up to three English scene queries and return unique, locally relevant
 * openly licensed photographs. Openverse metadata is treated as attribution
 * metadata to be verified at the source, never as a legal determination.
 */
export async function searchLicensedMediaForArticle(
  article: Pick<GeneratedArticle, "title" | "paragraphs" | "mediaHints">,
  evidenceQueries: readonly string[],
  limit: number,
  dependencies: OpenverseSearchDependencies = {}
): Promise<LicensedMediaItem[]> {
  const safeLimit = openverseLimit(limit);
  if (safeLimit === 0) return [];
  const queries = buildLicensedMediaQueries(article, evidenceQueries);
  if (queries.length === 0) return [];

  const unique = new Map<string, LicensedMediaItem>();
  // Anonymous Openverse access is intentionally conservative: query in order
  // and stop as soon as the requested count is satisfied instead of bursting
  // three provider calls at once.
  for (const query of queries) {
    let batch: LicensedMediaItem[];
    try {
      batch = await searchOpenverseImages(query, OPENVERSE_PAGE_SIZE, dependencies);
    } catch {
      continue;
    }
    for (const item of batch) {
      const key = licensedMediaKey(item);
      if (!unique.has(key)) unique.set(key, item);
      if (unique.size >= safeLimit) return [...unique.values()];
    }
  }
  return [...unique.values()].slice(0, safeLimit);
}

/** Build a bounded direct-query plus scene-preserving relaxation sequence. */
export function buildLicensedMediaQueries(
  article: Pick<GeneratedArticle, "title" | "paragraphs" | "mediaHints">,
  evidenceQueries: readonly string[]
): string[] {
  const inputs = [
    ...(article.mediaHints ?? []).map((hint) => hint.query),
    ...evidenceQueries,
    article.title,
  ];
  const compactInputs = inputs
    .map(compactEnglishMediaQuery)
    .filter((query): query is string => Boolean(query));
  if (compactInputs.length === 0) return [];

  const queries: string[] = [];
  const add = (query: string | undefined) => {
    if (!query || queries.some((entry) => entry.toLocaleLowerCase() === query.toLocaleLowerCase())) return;
    queries.push(query);
  };

  // The model-authored visual scene, when usable, remains the first attempt.
  add(compactInputs[0]);
  for (const input of compactInputs) {
    const tokens = normalizedQueryTokens(input);
    const hasChildren = tokens.includes("child");
    const hasMuseumScene = tokens.some((token) => token === "museum" || token === "exhibit");
    const hasLearningScene = tokens.some((token) => token === "education" || token === "science");
    if (hasChildren && (hasMuseumScene || hasLearningScene)) add("children science museum exhibit");
    if (hasMuseumScene) add("interactive museum exhibit");
    if (queries.length >= 3) break;
  }
  for (const input of compactInputs) {
    add(input);
    if (queries.length >= 3) break;
  }
  return queries.slice(0, 3);
}

/** Search one fixed Openverse endpoint; all provider URLs remain untrusted data. */
export async function searchOpenverseImages(
  query: string,
  limit = OPENVERSE_PAGE_SIZE,
  dependencies: OpenverseSearchDependencies = {}
): Promise<LicensedMediaItem[]> {
  const compactQuery = compactEnglishMediaQuery(query);
  const safeLimit = openverseLimit(limit);
  if (!compactQuery || safeLimit === 0) return [];
  const cacheKey = compactQuery.toLocaleLowerCase();
  if (!dependencies.fetchJson) {
    const cached = licensedMediaCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.items.slice(0, safeLimit);
    if (cached) licensedMediaCache.delete(cacheKey);
  }

  const url = new URL(OPENVERSE_IMAGE_SEARCH_URL);
  // Keep the internal relevance token canonical (`child`) while sending the
  // natural plural Openverse indexes much more reliably for group scenes.
  url.searchParams.set("q", compactQuery.replace(/\bchild\b/gu, "children"));
  url.searchParams.set("license", "cc0,pdm,by,by-sa");
  url.searchParams.set("mature", "false");
  url.searchParams.set("filter_dead", "true");
  url.searchParams.set("categories", "photograph");
  url.searchParams.set("page_size", String(OPENVERSE_PAGE_SIZE));

  const inFlightKey = `${openverseTransportIdentity(dependencies)}:${cacheKey}`;
  let pending = licensedMediaInFlight.get(inFlightKey);
  if (!pending) {
    pending = withOpenverseRequestLimit(async () => {
      const payload = dependencies.fetchJson
        ? await dependencies.fetchJson(url.toString())
        : await fetchOpenverseJson(url.toString());
      if (!isOpenverseSearchEnvelope(payload)) {
        throw new Error("Openverse image search returned an invalid response");
      }
      const items = parseOpenverseImageSearch(payload, compactQuery);
      if (!dependencies.fetchJson) writeLicensedMediaCache(cacheKey, items);
      return items;
    });
    licensedMediaInFlight.set(inFlightKey, pending);
    void pending.finally(() => {
      if (licensedMediaInFlight.get(inFlightKey) === pending) {
        licensedMediaInFlight.delete(inFlightKey);
      }
    }).catch(() => undefined);
  }
  return (await pending).slice(0, safeLimit);
}

/** Parse and independently validate the untrusted Openverse search response. */
export function parseOpenverseImageSearch(payload: unknown, query: string): LicensedMediaItem[] {
  const results = isRecord(payload) ? payload.results : undefined;
  if (!Array.isArray(results)) return [];
  const unique = new Map<string, LicensedMediaItem>();
  for (const raw of results.slice(0, OPENVERSE_PAGE_SIZE)) {
    const parsed = parseOpenverseImage(raw, query);
    if (!parsed) continue;
    const key = licensedMediaKey(parsed);
    if (!unique.has(key)) unique.set(key, parsed);
  }
  return [...unique.values()].sort((left, right) =>
    licensedImageRelevanceScore(query, right.title, right.tags)
      - licensedImageRelevanceScore(query, left.title, left.tags)
    || left.title.localeCompare(right.title, "en")
  );
}

function parseOpenverseImage(raw: unknown, query: string): LicensedMediaItem | undefined {
  if (!isRecord(raw)) return undefined;
  const work = openverseWorkIdentity(raw);
  if (!work) return undefined;
  const urls = openverseWorkUrls(raw, work);
  if (!urls || !licenseUrlMatches(work.license, work.licenseVersion, urls.licenseUrl)) return undefined;
  const licenseName = displayLicenseName(work.license, work.licenseVersion);
  // Openverse's provider-supplied attribution commonly contains HTML links and
  // direct asset URLs. Build the display credit only from the independently
  // validated fields instead of returning that untrusted blob to the article.
  const attribution = `"${work.title}" by ${work.creator}, ${licenseName}.`;

  const width = positiveDimension(raw.width);
  const height = positiveDimension(raw.height);
  const mimeType = rasterMimeType(raw.filetype, urls.downloadUrl);
  if (!width || !height || width < 320 || height < 240 || !mimeType) return undefined;

  const tags = openverseTagNames(raw.tags);
  if (!isLocallyRelevantLicensedImage(query, work.title, tags)) return undefined;

  return {
    id: work.id,
    title: work.title,
    creator: work.creator,
    ...(urls.creatorUrl ? { creatorUrl: urls.creatorUrl } : {}),
    license: work.license,
    licenseVersion: work.licenseVersion,
    licenseName,
    licenseUrl: urls.licenseUrl,
    landingUrl: urls.landingUrl,
    downloadUrl: urls.downloadUrl,
    thumbnailUrl: urls.thumbnailUrl,
    attribution,
    mimeType,
    width,
    height,
    query,
    tags,
  };
}

interface OpenverseWorkIdentity {
  id: string;
  title: string;
  creator: string;
  license: OpenLicenseId;
  licenseVersion: string;
}

/** Accept only a non-mature, non-sensitive photograph under an allowed CC license version. */
function openverseWorkIdentity(item: Record<string, unknown>): OpenverseWorkIdentity | undefined {
  const id = cleanString(item.id, 80);
  const title = cleanString(item.title, 240);
  const creator = cleanString(item.creator, 160);
  const license = cleanString(item.license, 20).toLocaleLowerCase();
  const licenseVersion = cleanString(item.license_version, 12);
  const typedLicense = license as OpenLicenseId;
  if (
    !UUID_PATTERN.test(id)
    || !title
    || !creator
    || BLOCKED_TITLE_TERMS.test(title)
    || !ALLOWED_LICENSES.has(license)
    || !LICENSE_VERSION_PATTERN.test(licenseVersion)
    || !ALLOWED_LICENSE_VERSIONS[typedLicense]?.has(licenseVersion)
    || item.mature !== false
    || (typeof item.category === "string" && item.category !== "photograph")
  ) return undefined;
  const sensitivity = item.unstable__sensitivity;
  if (Array.isArray(sensitivity) && sensitivity.length > 0) return undefined;
  return { id, title, creator, license: typedLicense, licenseVersion };
}

interface OpenverseWorkUrls {
  landingUrl: string;
  downloadUrl: string;
  licenseUrl: string;
  creatorUrl?: string;
  thumbnailUrl: string;
}

/**
 * Validate the public URLs. Source and creator pages must be genuine pages,
 * and no display field may expose the backend-only asset URLs.
 */
function openverseWorkUrls(
  item: Record<string, unknown>,
  work: OpenverseWorkIdentity
): OpenverseWorkUrls | undefined {
  const landingUrl = normalizePublicSourceUrl(cleanString(item.foreign_landing_url, 4_096));
  const downloadUrl = normalizePublicSourceUrl(cleanString(item.url, 4_096));
  const licenseUrl = normalizePublicSourceUrl(cleanString(item.license_url, 1_024));
  const rawCreatorUrl = cleanString(item.creator_url, 4_096);
  const creatorUrl = rawCreatorUrl ? normalizePublicSourceUrl(rawCreatorUrl) : undefined;
  if (!landingUrl || !downloadUrl || !licenseUrl || (rawCreatorUrl && !creatorUrl)) return undefined;
  const thumbnailUrl = `${OPENVERSE_IMAGE_SEARCH_URL}${work.id}/thumb/?compressed=true`;
  const privateMediaUrls = [downloadUrl, thumbnailUrl];
  const isAssetLike = (pageUrl: string) =>
    privateMediaUrls.some((mediaUrl) => sameNormalizedUrl(pageUrl, mediaUrl))
    || RASTER_ASSET_PATH_PATTERN.test(new URL(pageUrl).pathname);
  if (
    isAssetLike(landingUrl)
    || Boolean(creatorUrl && isAssetLike(creatorUrl))
    || displayMetadataContainsUrl(work.title, privateMediaUrls)
    || displayMetadataContainsUrl(work.creator, privateMediaUrls)
  ) return undefined;
  return { landingUrl, downloadUrl, licenseUrl, creatorUrl, thumbnailUrl };
}

function openverseTagNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((tag) => isRecord(tag) ? [cleanString(tag.name, 80)] : [])
    .filter(Boolean)
    .slice(0, 40);
}

function compactEnglishMediaQuery(value: string): string | undefined {
  if (!value || /[^\x00-\x7f]/u.test(value)) return undefined;
  const tokens = normalizedQueryTokens(value)
    .filter((token) => !QUERY_STOP_WORDS.has(token))
    .slice(0, 5);
  const concreteCount = tokens.filter((token) => !OVERLY_BROAD_QUERY_WORDS.has(token)).length;
  return tokens.length >= 2 && concreteCount >= 2 ? tokens.join(" ") : undefined;
}

function normalizedQueryTokens(value: string): string[] {
  const raw = value.toLocaleLowerCase().match(ENGLISH_WORD_PATTERN) ?? [];
  const tokens = raw.map(normalizeMediaToken).filter(Boolean);
  return [...new Set(tokens)];
}

function normalizeMediaToken(value: string): string {
  if (/^(?:children|child|kids?|youth)$/u.test(value)) return "child";
  if (/^(?:exhibits?|exhibition|exhibitions)$/u.test(value)) return "exhibit";
  if (/^(?:museums)$/u.test(value)) return "museum";
  if (/^(?:educational|education|learning|students?|classrooms?)$/u.test(value)) return "education";
  if (/^(?:scientific|science|stem)$/u.test(value)) return "science";
  if (/^(?:interactive|interaction|interactions)$/u.test(value)) return "interactive";
  return value.replace(/'(?:s)?$/u, "");
}

function isLocallyRelevantLicensedImage(query: string, title: string, tags: readonly string[]): boolean {
  const score = licensedImageRelevanceScore(query, title, tags);
  const queryTokens = relevanceQueryTokens(query);
  const titleTokens = new Set(normalizedQueryTokens(title));
  const titleOverlap = [...queryTokens].filter((token) => titleTokens.has(token));
  const requiredAnchors = queryTokens.size >= 4 ? 3 : 2;
  return score >= requiredAnchors && titleOverlap.length >= 1;
}

/** Prefer fuller scene coverage instead of trusting the provider's result order. */
function licensedImageRelevanceScore(query: string, title: string, tags: readonly string[]): number {
  const queryTokens = relevanceQueryTokens(query);
  const mediaTokens = new Set(normalizedQueryTokens(`${title} ${tags.join(" ")}`));
  return [...queryTokens].filter((token) => mediaTokens.has(token)).length;
}

function relevanceQueryTokens(query: string): Set<string> {
  return new Set(
    normalizedQueryTokens(query).filter((token) => !QUERY_STOP_WORDS.has(token) && token !== "ai")
  );
}

function licenseUrlMatches(license: OpenLicenseId, version: string, value: string): boolean {
  const url = new URL(value);
  const hostname = url.hostname.toLocaleLowerCase().replace(/^www\./u, "");
  if (hostname !== "creativecommons.org") return false;
  const escapedVersion = version.replace(".", "\\.");
  const path = url.pathname.toLocaleLowerCase();
  if (license === "cc0") return new RegExp(`^/publicdomain/zero/${escapedVersion}(?:/|$)`, "u").test(path);
  if (license === "pdm") return new RegExp(`^/publicdomain/mark/${escapedVersion}(?:/|$)`, "u").test(path);
  return new RegExp(`^/licenses/${license}/${escapedVersion}(?:/|$)`, "u").test(path);
}

function displayLicenseName(license: OpenLicenseId, version: string): string {
  if (license === "cc0") return `CC0 ${version}`;
  if (license === "pdm") return `Public Domain Mark ${version}`;
  return `CC ${license.toLocaleUpperCase()} ${version}`;
}

function rasterMimeType(value: unknown, downloadUrl: string): LicensedMediaItem["mimeType"] | undefined {
  const filetype = cleanString(value, 20).toLocaleLowerCase().replace(/^image\//u, "");
  const extension = new URL(downloadUrl).pathname.match(/\.([a-z0-9]{2,5})$/iu)?.[1]?.toLocaleLowerCase();
  const type = filetype || extension || "";
  if (type === "jpg" || type === "jpeg") return "image/jpeg";
  if (type === "png") return "image/png";
  if (type === "webp") return "image/webp";
  if (type === "gif") return "image/gif";
  return undefined;
}

function positiveDimension(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 100_000 ? parsed : undefined;
}

function openverseLimit(limit: number): number {
  return Math.max(0, Math.min(OPENVERSE_PAGE_SIZE, Math.trunc(limit)));
}

/** Identity used to drop duplicate works: same source page plus same asset. */
function licensedMediaKey(item: LicensedMediaItem): string {
  return `${item.landingUrl}\n${item.downloadUrl}`.toLocaleLowerCase();
}

function cleanString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

async function fetchOpenverseJson(url: string): Promise<unknown> {
  const response = await fetchTextWithOutboundPolicy(url, {
    label: "Openverse image search",
    timeoutMs: 8_000,
    maxBytes: OPENVERSE_RESPONSE_MAX_BYTES,
    maxRedirects: 1,
    headers: {
      Accept: "application/json",
      "User-Agent": "SpeakPlainly/0.1 (+open-licensed-media-search)",
    },
  });
  if (!response.ok) {
    throw new Error(`Openverse image search failed: ${response.status}`);
  }
  const payload = tryParseJson(response.text);
  if (payload === undefined) throw new Error("Openverse image search returned invalid JSON");
  return payload;
}

function isOpenverseSearchEnvelope(value: unknown): value is { results: unknown[] } {
  return isRecord(value) && Array.isArray(value.results);
}

function openverseTransportIdentity(dependencies: OpenverseSearchDependencies): string {
  const injected = dependencies.fetchJson;
  if (!injected) return "production";
  let id = injectedFetchIds.get(injected);
  if (!id) {
    id = nextInjectedFetchId;
    nextInjectedFetchId += 1;
    injectedFetchIds.set(injected, id);
  }
  return `injected-${id}`;
}

function sameNormalizedUrl(left: string, right: string): boolean {
  const leftUrl = new URL(left);
  const rightUrl = new URL(right);
  // Query strings and fragments can vary while addressing the same media
  // resource. Source/creator pages must have a genuinely different public
  // origin/path, not a decorated form of the private asset URL.
  return leftUrl.origin.toLocaleLowerCase() === rightUrl.origin.toLocaleLowerCase()
    && leftUrl.pathname.toLocaleLowerCase() === rightUrl.pathname.toLocaleLowerCase();
}

function displayMetadataContainsUrl(value: string, privateMediaUrls: readonly string[]): boolean {
  const folded = value.toLocaleLowerCase();
  return URL_LIKE_TEXT_PATTERN.test(value)
    || privateMediaUrls.some((url) => folded.includes(url.toLocaleLowerCase()));
}

function writeLicensedMediaCache(key: string, items: LicensedMediaItem[]): void {
  const now = Date.now();
  for (const [cacheKey, entry] of licensedMediaCache) {
    if (entry.expiresAt <= now) licensedMediaCache.delete(cacheKey);
  }
  licensedMediaCache.delete(key);
  while (licensedMediaCache.size >= OPENVERSE_CACHE_MAX_ENTRIES) {
    const oldest = licensedMediaCache.keys().next().value as string | undefined;
    if (!oldest) break;
    licensedMediaCache.delete(oldest);
  }
  licensedMediaCache.set(key, { expiresAt: now + OPENVERSE_CACHE_TTL_MS, items });
}
