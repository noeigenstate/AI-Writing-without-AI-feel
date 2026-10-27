import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";
import { fetchAgentReachSearch } from "./agentReach.js";
import { cached } from "./cache.js";
import { fetchTextWithTimeout } from "./http.js";
import {
  fetchTextWithOutboundPolicy,
  normalizePublicSourceUrl,
} from "./networkSafety.js";
import {
  inferPublisherName,
  inferPublisherRegion,
  parseFeedXml,
} from "./rss.js";
import type { NewsSource, ResearchItem, ResearchSourceKind } from "./types.js";

const execFileAsync = promisify(execFile);
const GOOGLE_NEWS_NAME = "Google News";
const GOOGLE_NEWS_HOSTNAME = "news.google.com";
const GOOGLE_NEWS_RPC_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";
const GOOGLE_NEWS_RESOLVER_CACHE_MS = 24 * 60 * 60 * 1000;
const GOOGLE_NEWS_RESOLVER_CONCURRENCY = 2;
const GOOGLE_NEWS_MAX_ARTICLE_ID_LENGTH = 2_048;
const GOOGLE_NEWS_MAX_PAGE_BYTES = 1_600_000;
const GOOGLE_NEWS_MAX_PAGE_CHARACTERS = 1_600_000;
const GOOGLE_NEWS_MAX_RPC_BYTES = 128_000;
const GOOGLE_NEWS_MAX_RPC_CHARACTERS = 128_000;
const GOOGLE_NEWS_MAX_SIGNATURE_LENGTH = 256;
const GOOGLE_NEWS_PUBLISHER_SEARCH_URL = "https://html.duckduckgo.com/html/";
const GOOGLE_NEWS_SECONDARY_PUBLISHER_SEARCH_URL = "https://search.yahoo.com/search";
const GOOGLE_NEWS_MAX_SEARCH_BYTES = 800_000;
const GOOGLE_NEWS_MAX_SEARCH_CHARACTERS = 800_000;
const GOOGLE_NEWS_MAX_SEARCH_RESULTS = 12;
const GOOGLE_NEWS_RPC_COOLDOWN_MS = 60_000;
const GOOGLE_NEWS_RESOLVER_START_INTERVAL_MS = 400;
const HACKER_NEWS_NAME = "Hacker News";
const EXA_API_URL = "https://api.exa.ai/search";
let mcporterAvailablePromise: Promise<boolean> | undefined;
let googleNewsResolverActive = 0;
let googleNewsResolverNextStartAt = 0;
let googleNewsRpcCooldownUntil = 0;
const googleNewsResolverWaiters: (() => void)[] = [];
export type GoogleNewsMarket = "cn" | "international";

export interface BroadWebSearchResult {
  items: ResearchItem[];
  unavailableSources: string[];
}
type ProviderFailureCategory = "timed out" | "rate limited" | "authentication unavailable" | "unavailable";

const BROAD_WEB_PROVIDER_LABELS = [
  "Exa article search",
  "Exa comment search",
  "Agent-Reach article search",
  "Agent-Reach comment search",
] as const;
const DISCUSSION_DOMAINS = [
  "reddit.com",
  "news.ycombinator.com",
  "zhihu.com",
  "quora.com",
  "stackoverflow.com",
  "stackexchange.com",
];

const RELEVANCE_ALIASES: { canonical: string; aliases: string[] }[] = [
  { canonical: "artificial_intelligence", aliases: ["artificial intelligence", "人工智能", "大模型"] },
  { canonical: "ai_agent", aliases: ["ai agents", "ai agent", "智能体"] },
  { canonical: "software_development", aliases: ["software development", "software engineering", "软件开发", "编程开发"] },
  { canonical: "small_team", aliases: ["small teams", "small team", "小团队", "小型团队"] },
  { canonical: "remote_work", aliases: ["remote working", "working remotely", "remote work", "远程工作", "远程办公"] },
  { canonical: "policy", aliases: ["policies", "policy", "制度", "政策"] },
  {
    canonical: "small_company",
    aliases: ["small businesses", "small business", "small companies", "small company", "小微企业", "中小企业", "小型公司", "小企业", "小公司"],
  },
  { canonical: "climate_change", aliases: ["climate change", "气候变化"] },
  { canonical: "renewable_energy", aliases: ["renewable energy", "可再生能源", "新能源"] },
  { canonical: "electric_vehicle", aliases: ["electric vehicles", "electric vehicle", "新能源汽车", "电动汽车"] },
  { canonical: "supply_chain", aliases: ["supply chains", "supply chain", "供应链"] },
  { canonical: "data_protection", aliases: ["data protection", "数据保护"] },
  { canonical: "elder_care", aliases: ["elder care", "养老"] },
  { canonical: "quantum_computing", aliases: ["quantum computing", "quantum computer", "量子计算", "量子电脑"] },
  { canonical: "cryptography", aliases: ["cryptography", "cryptographic", "encryption", "密码学", "密码体系", "密码技术", "加密技术"] },
  { canonical: "information_security", aliases: ["information security", "cybersecurity", "cyber security", "信息安全", "网络安全"] },
  { canonical: "impact", aliases: ["impact on", "impacts on", "effect on", "影响", "改变", "冲击", "作用"] },
];

interface ExaRawResult {
  title?: unknown;
  url?: unknown;
  publishedDate?: unknown;
  publishedAt?: unknown;
  author?: unknown;
  authors?: unknown;
  text?: unknown;
  summary?: unknown;
  highlights?: unknown;
  image?: unknown;
}

interface HackerNewsHit {
  objectID?: unknown;
  title?: unknown;
  url?: unknown;
  story_text?: unknown;
  story_title?: unknown;
  comment_text?: unknown;
  author?: unknown;
  created_at?: unknown;
}

export interface GoogleNewsResolverFetchResult {
  ok: boolean;
  status: number;
  text: string;
  /** Final URL after redirects, when supplied by the SSRF-safe page fetcher. */
  url?: string;
}

export interface GoogleNewsResolverRpcRequest {
  articleId: string;
  signature: string;
  timestamp: string;
  body: string;
}

export interface GoogleNewsResolverDependencies {
  fetchPage?: (url: string) => Promise<GoogleNewsResolverFetchResult>;
  postRpc?: (request: GoogleNewsResolverRpcRequest) => Promise<GoogleNewsResolverFetchResult>;
  searchPublisher?: (
    query: string
  ) => Promise<readonly GoogleNewsPublisherSearchCandidate[]>;
}

export interface GoogleNewsResolverMetadata {
  signature: string;
  timestamp: string;
}

export interface GoogleNewsPublisherContext {
  title: string;
  sourceName: string;
}

export interface GoogleNewsPublisherSearchCandidate {
  title: string;
  url: string;
  sourceName?: string;
}

/** Build a Google News RSS query URL for a search market (not a publisher region). */
export function googleNewsSearchUrl(
  query: string,
  market: GoogleNewsMarket = containsCjk(query) ? "cn" : "international"
): string {
  const domesticMarket = market === "cn";
  const params = new URLSearchParams({
    q: query,
    hl: domesticMarket ? "zh-CN" : "en-US",
    gl: domesticMarket ? "CN" : "US",
    ceid: domesticMarket ? "CN:zh-Hans" : "US:en",
  });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

/** Describe the aggregator feed without claiming its publishers share the search market. */
export function googleNewsFeedSource(query: string, market: GoogleNewsMarket): NewsSource {
  return {
    id: `google-news-${market}`,
    name: market === "cn" ? `${GOOGLE_NEWS_NAME} CN` : `${GOOGLE_NEWS_NAME} International`,
    type: market === "cn" ? "chinese" : "international",
    region: "global",
    language: market === "cn" ? "zh" : "en",
    url: googleNewsSearchUrl(query, market),
    enabled: true,
  };
}

/** Parse Google News while inferring each publisher independently from the market. */
export function parseGoogleNewsFeed(
  xml: string,
  query: string,
  market: GoogleNewsMarket
): ResearchItem[] {
  const cleanQuery = cleanText(query, 240);
  if (!cleanQuery) return [];

  return parseFeedXml(xml, googleNewsFeedSource(cleanQuery, market)).map((item) => ({
    ...item,
    sourceKind: "article" as const,
    excerpt: cleanText(item.summary, 280) || undefined,
    query: cleanQuery,
  }));
}

/** Extract one bounded Google News article token from an RSS/article wrapper URL. */
export function googleNewsArticleId(value: string): string | undefined {
  const normalized = normalizePublicSourceUrl(value);
  if (!normalized) return undefined;

  const url = new URL(normalized);
  if (normalizeHostname(url.hostname) !== GOOGLE_NEWS_HOSTNAME) return undefined;
  const match = url.pathname.match(/^\/(?:rss\/)?articles\/([A-Za-z0-9_-]+)\/?$/u);
  if (!match) return undefined;

  const articleId = match[1];
  return isBoundedGoogleNewsArticleId(articleId) ? articleId : undefined;
}

/**
 * Decode the legacy protobuf-like Google News token format without network I/O.
 * New opaque AU_yq-style tokens deliberately return undefined and use the
 * signed resolver path below.
 */
export function decodeLegacyGoogleNewsArticleUrl(value: string): string | undefined {
  const articleId = googleNewsArticleId(value);
  if (!articleId) return undefined;

  let decoded: Buffer;
  try {
    decoded = Buffer.from(articleId, "base64url");
  } catch {
    return undefined;
  }
  if (
    decoded.length < 5
    || decoded[0] !== 0x08
    || decoded[1] !== 0x13
    || decoded[2] !== 0x22
  ) {
    return undefined;
  }

  const length = readBoundedVarint(decoded, 3);
  if (!length || length.value <= 0 || length.value > 4_096) return undefined;
  const end = length.nextOffset + length.value;
  if (end > decoded.length) return undefined;

  let candidate: string;
  try {
    candidate = new TextDecoder("utf-8", { fatal: true }).decode(
      decoded.subarray(length.nextOffset, end)
    );
  } catch {
    return undefined;
  }
  return normalizeGoogleNewsPublisherUrl(candidate);
}

/** Parse the signed resolver attributes from one bounded Google News page. */
export function parseGoogleNewsResolverPage(
  html: string,
  expectedArticleId?: string
): GoogleNewsResolverMetadata | undefined {
  if (!html || html.length > GOOGLE_NEWS_MAX_PAGE_CHARACTERS) return undefined;
  if (expectedArticleId !== undefined && !isBoundedGoogleNewsArticleId(expectedArticleId)) {
    return undefined;
  }

  const tagPattern = /<[^>]{0,8192}\bdata-n-a-(?:sg|ts)\s*=\s*(?:"[^"]*"|'[^']*')[^>]{0,8192}>/giu;
  let inspected = 0;
  for (const match of html.matchAll(tagPattern)) {
    inspected += 1;
    if (inspected > 16) break;
    const attributes = googleNewsResolverAttributes(match[0]);
    if (!attributes) continue;
    if (
      expectedArticleId
      && attributes.articleId
      && attributes.articleId !== expectedArticleId
    ) {
      continue;
    }
    return { signature: attributes.signature, timestamp: attributes.timestamp };
  }
  return undefined;
}

/** Build the fixed Fbv4je form body used by Google's signed article resolver. */
export function buildGoogleNewsResolverRpcBody(
  articleId: string,
  metadata: GoogleNewsResolverMetadata
): string | undefined {
  if (!isBoundedGoogleNewsArticleId(articleId)) return undefined;
  if (!isGoogleNewsSignature(metadata.signature)) return undefined;
  if (!isGoogleNewsTimestamp(metadata.timestamp)) return undefined;

  const timestamp = Number(metadata.timestamp);
  const request = [
    "garturlreq",
    [
      [
        "en-US",
        "US",
        ["FINANCE_TOP_INDICES", "WEB_TEST_1_0_0"],
        null,
        null,
        1,
        1,
        "US:en",
        null,
        180,
        null,
        null,
        null,
        null,
        null,
        0,
        null,
        null,
        [1608992183, 723341000],
      ],
      "en-US",
      "US",
      1,
      [2, 3, 4, 8],
      1,
      0,
      "655000234",
      0,
      0,
      null,
      0,
    ],
    articleId,
    timestamp,
    metadata.signature,
  ];
  const batch = [[["Fbv4je", JSON.stringify(request), null, "generic"]]];
  return new URLSearchParams({ "f.req": JSON.stringify(batch) }).toString();
}

/** Parse and validate the publisher URL from Google's batched RPC envelope. */
export function parseGoogleNewsResolverRpcResponse(value: string): string | undefined {
  if (!value || value.length > GOOGLE_NEWS_MAX_RPC_CHARACTERS) return undefined;

  const lines = value.split(/\r?\n/u);
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate.startsWith("[")) continue;
    const parsed = parseJson(candidate);
    const embedded = googleNewsResolverEmbeddedPayload(parsed);
    if (!embedded) continue;
    const decoded = parseJson(embedded);
    if (!Array.isArray(decoded) || decoded[0] !== "garturlres") continue;
    const normalized = normalizeGoogleNewsPublisherUrl(asString(decoded[1]));
    if (normalized) return normalized;
  }
  return undefined;
}

/**
 * Resolve one Google News wrapper non-destructively. All parser, transport, and
 * destination failures retain the original public wrapper URL.
 */
export async function resolveGoogleNewsArticleUrl(
  value: string,
  dependencies: GoogleNewsResolverDependencies = {},
  publisherContext?: GoogleNewsPublisherContext
): Promise<string> {
  const normalized = normalizePublicSourceUrl(value);
  const articleId = normalized ? googleNewsArticleId(normalized) : undefined;
  if (!normalized || !articleId) return value;

  const legacy = decodeLegacyGoogleNewsArticleUrl(normalized);
  if (legacy) return legacy;

  const load = () => withGoogleNewsResolverLimit(
    () => resolveOpaqueGoogleNewsArticleUrl(
      normalized,
      articleId,
      dependencies,
      publisherContext
    ),
    !hasInjectedGoogleNewsResolverDependency(dependencies)
  );
  // Dependency-injected calls stay isolated and deterministic. Production only
  // caches a verified publisher URL; a transient fallback is immediately
  // retryable instead of poisoning the cache for the feed TTL.
  if (hasInjectedGoogleNewsResolverDependency(dependencies)) return load();
  try {
    return await cached(
      `google-news-resolver:v1:${articleId}`,
      GOOGLE_NEWS_RESOLVER_CACHE_MS,
      async () => {
        const resolved = await load();
        if (resolved === normalized) throw new Error("Google News publisher URL unavailable");
        return resolved;
      }
    );
  } catch {
    return normalized;
  }
}

/** Resolve a list using at most two page/RPC chains at once, preserving order. */
export async function resolveGoogleNewsArticleUrls(
  values: readonly string[],
  dependencies: GoogleNewsResolverDependencies = {},
  publisherContexts: readonly (GoogleNewsPublisherContext | undefined)[] = []
): Promise<string[]> {
  const output = new Array<string>(values.length);
  const inFlight = new Map<string, Promise<string>>();
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      const value = values[index];
      const publisherContext = publisherContexts[index];
      const inFlightKey = publisherContext
        ? `${value}\u0000${publisherContext.title}\u0000${publisherContext.sourceName}`
        : value;
      let pending = inFlight.get(inFlightKey);
      if (!pending) {
        pending = resolveGoogleNewsArticleUrl(value, dependencies, publisherContext);
        inFlight.set(inFlightKey, pending);
      }
      output[index] = await pending;
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(GOOGLE_NEWS_RESOLVER_CONCURRENCY, values.length) },
      () => worker()
    )
  );
  return output;
}

async function resolveOpaqueGoogleNewsArticleUrl(
  wrapperUrl: string,
  articleId: string,
  dependencies: GoogleNewsResolverDependencies,
  publisherContext?: GoogleNewsPublisherContext
): Promise<string> {
  let rpcResolvedUrl: string | undefined;
  try {
    const usesDefaultPageTransport = !dependencies.fetchPage;
    const usesDefaultRpcTransport = !dependencies.postRpc;
    if (usesDefaultPageTransport && googleNewsRpcCooldownUntil > Date.now()) {
      return resolveGoogleNewsPublisherSearchFallback(
        wrapperUrl,
        publisherContext,
        dependencies
      );
    }
    const fetchPage = dependencies.fetchPage ?? defaultGoogleNewsPageFetch;
    // The RSS wrapper serves a smaller intermediary document without the
    // signed resolver attributes. Fetch Google's fixed canonical article page.
    const page = await fetchPage(`https://${GOOGLE_NEWS_HOSTNAME}/articles/${articleId}`);
    if (usesDefaultPageTransport && page.status === 429) {
      googleNewsRpcCooldownUntil = Date.now() + GOOGLE_NEWS_RPC_COOLDOWN_MS;
    }
    if (!page.ok) return resolveGoogleNewsPublisherSearchFallback(
      wrapperUrl,
      publisherContext,
      dependencies
    );

    const redirectedPublisher = normalizeGoogleNewsPublisherUrl(page.url ?? "");
    if (redirectedPublisher) return redirectedPublisher;

    const metadata = parseGoogleNewsResolverPage(page.text, articleId);
    if (!metadata) return resolveGoogleNewsPublisherSearchFallback(
      wrapperUrl,
      publisherContext,
      dependencies
    );
    const body = buildGoogleNewsResolverRpcBody(articleId, metadata);
    if (!body) return resolveGoogleNewsPublisherSearchFallback(
      wrapperUrl,
      publisherContext,
      dependencies
    );

    if (usesDefaultRpcTransport && googleNewsRpcCooldownUntil > Date.now()) {
      return resolveGoogleNewsPublisherSearchFallback(
        wrapperUrl,
        publisherContext,
        dependencies
      );
    }
    const postRpc = dependencies.postRpc ?? defaultGoogleNewsRpcFetch;
    const response = await postRpc({ articleId, ...metadata, body });
    if (usesDefaultRpcTransport && response.status === 429) {
      googleNewsRpcCooldownUntil = Date.now() + GOOGLE_NEWS_RPC_COOLDOWN_MS;
    }
    if (response.ok) rpcResolvedUrl = parseGoogleNewsResolverRpcResponse(response.text);
  } catch {
    // A bounded publisher search below can still recover an exact source URL.
  }
  return rpcResolvedUrl ?? resolveGoogleNewsPublisherSearchFallback(
    wrapperUrl,
    publisherContext,
    dependencies
  );
}

function hasInjectedGoogleNewsResolverDependency(
  dependencies: GoogleNewsResolverDependencies
): boolean {
  return Boolean(
    dependencies.fetchPage
    || dependencies.postRpc
    || dependencies.searchPublisher
  );
}

/** Share two resolver slots across all simultaneous CN/international searches. */
async function withGoogleNewsResolverLimit<T>(
  task: () => Promise<T>,
  throttleStarts: boolean
): Promise<T> {
  await acquireGoogleNewsResolverSlot();
  try {
    if (throttleStarts) {
      const now = Date.now();
      const startAt = Math.max(now, googleNewsResolverNextStartAt);
      googleNewsResolverNextStartAt = startAt + GOOGLE_NEWS_RESOLVER_START_INTERVAL_MS;
      const waitMs = startAt - now;
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
    }
    return await task();
  } finally {
    releaseGoogleNewsResolverSlot();
  }
}

function acquireGoogleNewsResolverSlot(): Promise<void> {
  if (googleNewsResolverActive < GOOGLE_NEWS_RESOLVER_CONCURRENCY) {
    googleNewsResolverActive += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    googleNewsResolverWaiters.push(() => {
      googleNewsResolverActive += 1;
      resolve();
    });
  });
}

function releaseGoogleNewsResolverSlot(): void {
  googleNewsResolverActive = Math.max(0, googleNewsResolverActive - 1);
  googleNewsResolverWaiters.shift()?.();
}

/** Build an exact, bounded lookup query from the Google News title and outlet. */
export function googleNewsPublisherSearchQuery(
  context: GoogleNewsPublisherContext
): string | undefined {
  const sourceName = searchLiteral(context.sourceName, 72);
  const rawTitle = stripPublisherSuffix(cleanText(context.title, 220), sourceName);
  const maxTitleLength = Math.max(80, 232 - sourceName.length);
  const title = searchLiteral(rawTitle, maxTitleLength);
  if (title.length < 8 || sourceName.length < 2 || isGenericPublisherName(sourceName)) {
    return undefined;
  }
  return `"${title}" ${sourceName}`;
}

/** Parse only bounded DuckDuckGo result anchors and their explicit `uddg` target. */
export function parseDuckDuckGoPublisherSearchResults(
  html: string
): GoogleNewsPublisherSearchCandidate[] {
  if (!html || html.length > GOOGLE_NEWS_MAX_SEARCH_CHARACTERS) return [];

  const results: GoogleNewsPublisherSearchCandidate[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b([^>]{0,4096})>([\s\S]{0,1200}?)<\/a>/giu;
  let inspected = 0;
  for (const match of html.matchAll(anchorPattern)) {
    inspected += 1;
    if (inspected > 80 || results.length >= GOOGLE_NEWS_MAX_SEARCH_RESULTS) break;
    const attributes = match[1] ?? "";
    const className = htmlAttribute(attributes, "class");
    if (!/(?:^|\s)result__a(?:\s|$)/u.test(className)) continue;
    const href = htmlAttribute(attributes, "href");
    const url = duckDuckGoResultTarget(href);
    const title = cleanText(match[2] ?? "", 240);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, sourceName: inferPublisherName(url) });
  }
  return results;
}

/** Parse Yahoo result-title anchors and only their explicit encoded `RU` target. */
export function parseYahooPublisherSearchResults(
  html: string
): GoogleNewsPublisherSearchCandidate[] {
  if (!html || html.length > GOOGLE_NEWS_MAX_SEARCH_CHARACTERS) return [];

  const results: GoogleNewsPublisherSearchCandidate[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b([^>]{0,8192})>([\s\S]{0,6000}?)<\/a>/giu;
  let inspected = 0;
  for (const match of html.matchAll(anchorPattern)) {
    inspected += 1;
    if (inspected > 160 || results.length >= GOOGLE_NEWS_MAX_SEARCH_RESULTS) break;
    const body = match[2] ?? "";
    const titleMatch = body.match(/<h3\b[^>]{0,2048}>([\s\S]{0,1600}?)<\/h3>/iu);
    if (!titleMatch) continue;
    const url = yahooResultTarget(htmlAttribute(match[1] ?? "", "href"));
    const title = cleanText(titleMatch[1] ?? "", 240);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, sourceName: inferPublisherName(url) });
  }
  return results;
}

/** Select only a title- and publisher-matched public article URL. */
export function selectGoogleNewsPublisherSearchResult(
  candidates: readonly GoogleNewsPublisherSearchCandidate[],
  context: GoogleNewsPublisherContext
): string | undefined {
  const expectedSourceName = cleanText(context.sourceName, 120);
  const expectedTitle = stripPublisherSuffix(cleanText(context.title, 240), expectedSourceName);
  if (!expectedTitle || !expectedSourceName || isGenericPublisherName(expectedSourceName)) {
    return undefined;
  }

  for (const candidate of candidates.slice(0, GOOGLE_NEWS_MAX_SEARCH_RESULTS)) {
    const url = normalizeGoogleNewsPublisherUrl(candidate.url);
    if (!url || isSearchResultPage(url)) continue;
    const candidateTitle = stripPublisherSuffix(
      cleanText(candidate.title, 240),
      expectedSourceName
    );
    if (!publisherSearchTitleMatches(expectedTitle, candidateTitle, url)) continue;
    if (!publisherStronglyMatches(expectedSourceName, url, candidate.sourceName ?? "")) continue;
    return url;
  }
  return undefined;
}

async function resolveGoogleNewsPublisherSearchFallback(
  wrapperUrl: string,
  context: GoogleNewsPublisherContext | undefined,
  dependencies: GoogleNewsResolverDependencies
): Promise<string> {
  if (!context) return wrapperUrl;
  const query = googleNewsPublisherSearchQuery(context);
  if (!query) return wrapperUrl;

  if (dependencies.searchPublisher) {
    try {
      const candidates = await dependencies.searchPublisher(query);
      return selectGoogleNewsPublisherSearchResult(candidates, context) ?? wrapperUrl;
    } catch {
      return wrapperUrl;
    }
  }

  try {
    return await cached(
      `google-news-publisher-search:v1:${query.toLocaleLowerCase()}`,
      GOOGLE_NEWS_RESOLVER_CACHE_MS,
      async () => {
        const resolved = await resolveGoogleNewsPublisherWithDefaultSearch(query, context);
        if (!resolved) throw new Error("Google News publisher search unavailable");
        return resolved;
      }
    );
  } catch {
    // Rejected/empty searches are evicted by `cached`, so a transient 429 or
    // challenge never becomes a long-lived wrapper result.
    return wrapperUrl;
  }
}

async function resolveGoogleNewsPublisherWithDefaultSearch(
  query: string,
  context: GoogleNewsPublisherContext
): Promise<string | undefined> {
  const apiKey = process.env.EXA_API_KEY?.trim();
  if (apiKey) {
    try {
      const exaCandidates = await fetchDirectExaSearch(query, "article", 6, apiKey);
      const selected = selectGoogleNewsPublisherSearchResult(exaCandidates, context);
      if (selected) return selected;
    } catch {
      // The public, keyless exact-title search remains available below.
    }
  }

  try {
    const duckDuckGoCandidates = await fetchDuckDuckGoPublisherSearch(query);
    const selected = selectGoogleNewsPublisherSearchResult(duckDuckGoCandidates, context);
    if (selected) return selected;
  } catch {
    // A second fixed public index remains available below.
  }

  try {
    const yahooCandidates = await fetchYahooPublisherSearch(query);
    const selected = selectGoogleNewsPublisherSearchResult(yahooCandidates, context);
    if (selected) return selected;
  } catch {
    // Optional Agent-Reach is the last bounded fallback when installed.
  }

  if (await isMcporterAvailable()) {
    try {
      const agentReachCandidates = await fetchAgentReachSearch(query, 6, "article");
      return selectGoogleNewsPublisherSearchResult(agentReachCandidates, context);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function fetchDuckDuckGoPublisherSearch(
  query: string
): Promise<GoogleNewsPublisherSearchCandidate[]> {
  const params = new URLSearchParams({
    q: query,
    kl: containsCjk(query) ? "cn-zh" : "us-en",
  });
  const response = await fetchTextWithTimeout(
    `${GOOGLE_NEWS_PUBLISHER_SEARCH_URL}?${params.toString()}`,
    {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": containsCjk(query) ? "zh-CN,zh;q=0.9,en;q=0.6" : "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (compatible; SpeakPlainlyResearch/0.1; +local development)",
      },
    },
    {
      label: "Publisher exact-title search",
      timeoutMs: 7_000,
      maxBytes: GOOGLE_NEWS_MAX_SEARCH_BYTES,
    }
  );
  if (!response.ok) return [];
  return parseDuckDuckGoPublisherSearchResults(response.text);
}

async function fetchYahooPublisherSearch(
  query: string
): Promise<GoogleNewsPublisherSearchCandidate[]> {
  const params = new URLSearchParams({ p: query });
  const response = await fetchTextWithTimeout(
    `${GOOGLE_NEWS_SECONDARY_PUBLISHER_SEARCH_URL}?${params.toString()}`,
    {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": containsCjk(query) ? "zh-CN,zh;q=0.9,en;q=0.6" : "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (compatible; SpeakPlainlyResearch/0.1; +local development)",
      },
    },
    {
      label: "Secondary publisher exact-title search",
      timeoutMs: 7_000,
      maxBytes: GOOGLE_NEWS_MAX_SEARCH_BYTES,
    }
  );
  if (!response.ok) return [];
  return parseYahooPublisherSearchResults(response.text);
}

function duckDuckGoResultTarget(value: string): string | undefined {
  const href = decodeHtmlAttribute(value.trim());
  if (!href) return undefined;
  try {
    const parsed = new URL(href, GOOGLE_NEWS_PUBLISHER_SEARCH_URL);
    const hostname = normalizeHostname(parsed.hostname);
    if (hostname === "duckduckgo.com" || hostname.endsWith(".duckduckgo.com")) {
      if (parsed.pathname !== "/l/" && parsed.pathname !== "/l") return undefined;
      return normalizeGoogleNewsPublisherUrl(parsed.searchParams.get("uddg") ?? "");
    }
    return normalizeGoogleNewsPublisherUrl(parsed.toString());
  } catch {
    return undefined;
  }
}

function yahooResultTarget(value: string): string | undefined {
  const href = decodeHtmlAttribute(value.trim());
  if (!href) return undefined;
  try {
    const parsed = new URL(href);
    if (normalizeHostname(parsed.hostname) !== "r.search.yahoo.com") return undefined;
    const match = parsed.pathname.match(/\/RU=([^/]{1,4096})\/RK=/iu);
    if (!match) return undefined;
    return normalizeGoogleNewsPublisherUrl(decodeURIComponent(match[1]));
  } catch {
    return undefined;
  }
}

function htmlAttribute(value: string, name: string): string {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "iu");
  const match = value.match(pattern);
  return decodeHtmlAttribute(match?.[1] ?? match?.[2] ?? "");
}

function searchLiteral(value: string, maxLength: number): string {
  return cleanText(value, maxLength)
    .replace(/["“”„‟＂\\]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function stripPublisherSuffix(value: string, sourceName: string): string {
  const title = value.trim();
  const source = sourceName.trim();
  if (!title || !source) return title;
  const lowerTitle = title.toLocaleLowerCase();
  const lowerSource = source.toLocaleLowerCase();
  if (!lowerTitle.endsWith(lowerSource)) return title;
  return title
    .slice(0, title.length - source.length)
    .replace(/\s*[-|:：]\s*(?:news\s*)?[-|:：\s]*$/iu, "")
    .trim() || title;
}

function titlesStronglyMatch(expected: string, candidate: string): boolean {
  const left = normalizeTitleForMatch(expected);
  const right = normalizeTitleForMatch(candidate);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (shorter.length >= 18 && longer.includes(shorter) && shorter.length / longer.length >= 0.72) {
    return true;
  }

  const leftTokens = titleMatchTokens(left);
  const rightTokens = titleMatchTokens(right);
  if (leftTokens.length < 4 || rightTokens.length < 4) return false;
  const rightSet = new Set(rightTokens);
  const matched = leftTokens.filter((token) => rightSet.has(token)).length;
  return matched >= 4
    && matched / leftTokens.length >= 0.72
    && matched / rightTokens.length >= 0.8;
}

function publisherSearchTitleMatches(
  expected: string,
  candidate: string,
  candidateUrl: string
): boolean {
  if (titlesStronglyMatch(expected, candidate)) return true;
  if (!/(?:\.\.\.|…)/u.test(candidate)) return false;

  const expectedTokens = titleMatchTokens(normalizeTitleForMatch(expected));
  const candidateTokens = titleMatchTokens(normalizeTitleForMatch(candidate));
  if (expectedTokens.length < 5 || candidateTokens.length < 4) return false;
  const expectedSet = new Set(expectedTokens);
  const candidateMatches = candidateTokens.filter((token) => expectedSet.has(token)).length;
  if (
    candidateMatches < 5
    || candidateMatches / candidateTokens.length < 0.8
    || candidateMatches / expectedTokens.length < 0.5
  ) {
    return false;
  }

  let pathTokens: string[];
  try {
    pathTokens = titleMatchTokens(normalizeTitleForMatch(
      decodeURIComponent(new URL(candidateUrl).pathname.replace(/[\/_-]+/gu, " "))
    ));
  } catch {
    return false;
  }
  const pathSet = new Set(pathTokens);
  const pathMatches = expectedTokens.filter((token) => pathSet.has(token)).length;
  return pathMatches >= 5 && pathMatches / expectedTokens.length >= 0.82;
}

function normalizeTitleForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function titleMatchTokens(value: string): string[] {
  const chunks = value.match(/[a-z0-9]+|[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? [];
  const output: string[] = [];
  const stop = new Set(["a", "an", "and", "at", "for", "from", "in", "of", "on", "the", "to", "with"]);
  for (const chunk of chunks) {
    if (/^[\p{Script=Han}]+$/u.test(chunk) && chunk.length > 2) {
      for (let index = 0; index < chunk.length - 1; index += 1) {
        output.push(chunk.slice(index, index + 2));
      }
    } else if (chunk.length >= 2 && !stop.has(chunk)) {
      output.push(stemEnglishToken(chunk));
    }
  }
  return [...new Set(output)];
}

function publisherStronglyMatches(
  expectedSourceName: string,
  candidateUrl: string,
  _candidateSourceName: string
): boolean {
  const sourceTokens = publisherIdentityTokens(expectedSourceName, false);
  const allTokens = publisherIdentityTokens(expectedSourceName, true);
  if (sourceTokens.length === 0 && allTokens.length === 0) return false;

  const hostname = normalizeHostname(new URL(candidateUrl).hostname).replace(/^www\./u, "");
  // Search-result labels are untrusted metadata; the publisher identity must be
  // supported by the registrable brand label, not merely appear anywhere in a
  // hostile subdomain such as `cmu.edu.attacker.example`.
  const candidateSignal = normalizePublisherIdentity(publisherBrandLabel(hostname));
  if (!candidateSignal) return false;

  // Every accepted identity is an exact candidate-brand variant. Substring
  // matching would let `notcmu.example` or `cmu-attacker.example` impersonate
  // Carnegie Mellon University. Mixed initial/full-token variants cover common
  // real brands such as `nytimes` without reopening that boundary.
  const expectedSignals = new Set<string>();
  const addSignal = (value: string) => {
    const normalized = normalizePublisherIdentity(value);
    if (normalized.length >= 2 && normalized.length <= 64) expectedSignals.add(normalized);
  };
  const addTokenVariants = (tokens: string[]) => {
    if (tokens.length === 0) return;
    addSignal(tokens.join(""));
    if (tokens.length === 1) return;
    const initials = tokens.map((token) => token[0]).join("");
    addSignal(initials);
    for (let fullFrom = 1; fullFrom < tokens.length; fullFrom += 1) {
      addSignal(
        tokens.slice(0, fullFrom).map((token) => token[0]).join("")
          + tokens.slice(fullFrom).join("")
      );
    }
  };
  addSignal(expectedSourceName);
  if (sourceTokens.length === 1) addSignal(sourceTokens[0]);
  addTokenVariants(sourceTokens);
  addTokenVariants(allTokens);
  // Numeric station brands commonly append `news` in their registered label
  // (for example ABC7 Bay Area -> abc7news.com). Keep that narrow exception
  // exact and unavailable to alphabetic lookalikes such as `cmu-news`.
  for (const token of sourceTokens) {
    if (/\d/u.test(token)) addSignal(`${token}news`);
  }
  const fullAcronym = allTokens.map((token) => token[0]).join("");
  if (fullAcronym.length === 2) addSignal(`${fullAcronym}news`);
  if (
    /\b(?:university|college)\b/iu.test(expectedSourceName)
    && candidateSignal === fullAcronym
    && !/(?:\.edu(?:\.[a-z]{2})?|\.ac\.[a-z]{2})$/u.test(hostname)
  ) {
    return false;
  }
  return expectedSignals.has(candidateSignal);
}

/** Extract the hostname label that owns the public suffix for common domains. */
function publisherBrandLabel(hostname: string): string {
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length < 2) return labels[0] ?? "";
  const finalLabel = labels.at(-1) ?? "";
  const secondLevel = labels.at(-2) ?? "";
  const commonCountrySecondLevels = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);
  if (
    finalLabel.length === 2
    && commonCountrySecondLevels.has(secondLevel)
    && labels.length >= 3
  ) {
    return labels.at(-3) ?? "";
  }
  return secondLevel;
}

function publisherIdentityTokens(value: string, includeGeneric: boolean): string[] {
  const generic = new Set([
    "the", "and", "news", "daily", "online", "media", "press", "network", "group",
    "company", "inc", "ltd", "llc", "com", "org", "net", "edu", "bay", "area",
  ]);
  return (value.normalize("NFKC").toLocaleLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? [])
    .filter((token) => token.length >= 2 && (includeGeneric || !generic.has(token)));
}

function normalizePublisherIdentity(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function isGenericPublisherName(value: string): boolean {
  const identity = normalizePublisherIdentity(value);
  return !identity || [
    "web", "news", "publisher", "unknown", "unknownpublisher", "googlenews",
    "googlenewscn", "googlenewsinternational",
  ].includes(identity);
}

function isSearchResultPage(value: string): boolean {
  const parsed = new URL(value);
  const hostname = normalizeHostname(parsed.hostname);
  const searchDomains = [
    "google.com", "duckduckgo.com", "bing.com", "search.yahoo.com", "search.brave.com",
    "baidu.com", "yandex.com", "yandex.ru",
  ];
  if (searchDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    return true;
  }
  return /^\/(?:search|websearch)(?:\/|$)/iu.test(parsed.pathname);
}

async function defaultGoogleNewsPageFetch(url: string): Promise<GoogleNewsResolverFetchResult> {
  return fetchTextWithOutboundPolicy(url, {
    label: "Google News article resolver",
    timeoutMs: 7_000,
    maxBytes: GOOGLE_NEWS_MAX_PAGE_BYTES,
    maxRedirects: 3,
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.8",
    },
  });
}

async function defaultGoogleNewsRpcFetch(
  request: GoogleNewsResolverRpcRequest
): Promise<GoogleNewsResolverFetchResult> {
  return fetchTextWithTimeout(
    GOOGLE_NEWS_RPC_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "*/*",
        "User-Agent": "SpeakPlainlyResearch/0.1",
      },
      body: request.body,
    },
    {
      label: "Google News publisher resolver",
      timeoutMs: 7_000,
      maxBytes: GOOGLE_NEWS_MAX_RPC_BYTES,
    }
  );
}

function googleNewsResolverAttributes(value: string): (
  GoogleNewsResolverMetadata & { articleId?: string }
) | undefined {
  const attributes = new Map<string, string>();
  const pattern = /\b(data-n-a-(?:sg|ts|id))\s*=\s*("([^"]*)"|'([^']*)')/giu;
  for (const match of value.matchAll(pattern)) {
    const name = match[1].toLocaleLowerCase();
    if (attributes.has(name)) return undefined;
    attributes.set(name, decodeHtmlAttribute(match[3] ?? match[4] ?? ""));
  }

  const signature = attributes.get("data-n-a-sg") ?? "";
  const timestamp = attributes.get("data-n-a-ts") ?? "";
  const articleId = attributes.get("data-n-a-id");
  if (!isGoogleNewsSignature(signature) || !isGoogleNewsTimestamp(timestamp)) return undefined;
  if (articleId !== undefined && !isBoundedGoogleNewsArticleId(articleId)) return undefined;
  return { signature, timestamp, articleId };
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&amp;/giu, "&")
    .replace(/&#(x?[0-9a-f]+);/giu, (entity, code: string) => decodeNumericEntity(entity, code));
}

function isBoundedGoogleNewsArticleId(value: string): boolean {
  return value.length >= 8
    && value.length <= GOOGLE_NEWS_MAX_ARTICLE_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/u.test(value);
}

function isGoogleNewsSignature(value: string): boolean {
  return value.length >= 8
    && value.length <= GOOGLE_NEWS_MAX_SIGNATURE_LENGTH
    && /^[A-Za-z0-9_-]+$/u.test(value);
}

function isGoogleNewsTimestamp(value: string): boolean {
  if (!/^\d{9,13}$/u.test(value)) return false;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0;
}

function readBoundedVarint(
  bytes: Uint8Array,
  offset: number
): { value: number; nextOffset: number } | undefined {
  let value = 0;
  let shift = 0;
  for (let index = offset; index < bytes.length && index < offset + 5; index += 1) {
    const byte = bytes[index];
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) {
      return Number.isSafeInteger(value) ? { value, nextOffset: index + 1 } : undefined;
    }
    shift += 7;
  }
  return undefined;
}

function googleNewsResolverEmbeddedPayload(value: unknown): string | undefined {
  let inspected = 0;
  const visit = (current: unknown, depth: number): string | undefined => {
    inspected += 1;
    if (inspected > 256 || depth > 8 || !Array.isArray(current)) return undefined;
    if (
      current[0] === "wrb.fr"
      && current[1] === "Fbv4je"
      && typeof current[2] === "string"
      && current[2].length <= 16_384
    ) {
      return current[2];
    }
    for (const entry of current) {
      const found = visit(entry, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return visit(value, 0);
}

function normalizeGoogleNewsPublisherUrl(value: string): string | undefined {
  const normalized = normalizePublicSourceUrl(value);
  if (!normalized) return undefined;
  const hostname = normalizeHostname(new URL(normalized).hostname);
  return hostname === GOOGLE_NEWS_HOSTNAME || hostname.endsWith(`.${GOOGLE_NEWS_HOSTNAME}`)
    ? undefined
    : normalized;
}

function normalizeHostname(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\.$/u, "");
}

/** Search current news articles without a key, using curl for system-proxy compatibility. */
export async function fetchGoogleNewsArticles(
  query: string,
  limit = 8,
  market: GoogleNewsMarket = containsCjk(query) ? "cn" : "international"
): Promise<ResearchItem[]> {
  const cleanQuery = cleanText(query, 240);
  if (!cleanQuery) return [];

  const items = await cached(`google-news-feed:v3:${market}:${cleanQuery}:${limit}`, 20 * 60 * 1000, async () => {
    const source = googleNewsFeedSource(cleanQuery, market);
    const options: ExecFileOptionsWithStringEncoding = {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 2_000_000,
      windowsHide: true,
    };
    const command = process.platform === "win32" ? "curl.exe" : "curl";
    const { stdout } = await execFileAsync(
      command,
      [
        "--location",
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "12",
        "--user-agent",
        "SpeakPlainlyResearch/0.1",
        source.url,
      ],
      options
    );
    return parseGoogleNewsFeed(stdout, cleanQuery, market)
      .filter((item) => isRelevantResearchItem(item, cleanQuery))
      .slice(0, limit);
  });
  const resolvedUrls = await resolveGoogleNewsArticleUrls(
    items.map((item) => item.url),
    {},
    items.map((item) => ({ title: item.title, sourceName: item.sourceName }))
  );
  return items.map((item, index) => {
    const resolvedUrl = normalizePublicSourceUrl(resolvedUrls[index]);
    if (!resolvedUrl || resolvedUrl === item.url) return item;
    return {
      ...item,
      id: `${item.sourceId}:${resolvedUrl.toLocaleLowerCase()}`,
      url: resolvedUrl,
    };
  });
}

/** Parse Hacker News story search results as links to relevant web articles. */
export function parseHackerNewsArticles(payload: string | unknown, query: string): ResearchItem[] {
  const parsed = typeof payload === "string" ? parseJson(payload) : payload;
  if (!isRecord(parsed) || !Array.isArray(parsed.hits)) return [];

  return parsed.hits
    .map((raw): ResearchItem | undefined => {
      if (!isRecord(raw)) return undefined;
      const hit = raw as HackerNewsHit;
      const objectId = cleanText(asString(hit.objectID), 80);
      const title = cleanText(asString(hit.title), 180);
      const url = validExternalArticleUrl(asString(hit.url));
      if (!objectId || !title || !url) return undefined;

      const summary = selectRelevantStorySummary(asString(hit.story_text), title, query);
      if (!isRelevantText(`${title} ${summary}`, query)) return undefined;

      const excerpt = cleanText(summary, 280);
      const author = cleanText(asString(hit.author), 120);
      const sourceName = inferPublisherName(url);
      return {
        id: `hacker-news-story:${objectId}`,
        sourceKind: "article",
        sourceName,
        sourceId: "hacker-news-stories",
        region: inferPublisherRegion(url, sourceName),
        title,
        summary,
        excerpt: excerpt || undefined,
        url,
        publishedAt: normalizeDate(asString(hit.created_at)),
        authors: author ? [author] : [],
        query,
      };
    })
    .filter((item): item is ResearchItem => Boolean(item));
}

/** Search Hacker News' public story index for relevant linked web articles. */
export function fetchBuiltInWebArticles(query: string, limit = 8): Promise<ResearchItem[]> {
  const cleanQuery = cleanText(query, 240);
  if (!cleanQuery) return Promise.resolve([]);

  return cached(`hacker-news-stories:${cleanQuery}:${limit}`, 20 * 60 * 1000, async () => {
    const params = new URLSearchParams({
      query: cleanQuery,
      tags: "story",
      hitsPerPage: String(Math.max(limit * 2, limit)),
    });
    const res = await fetchTextWithTimeout(
      `https://hn.algolia.com/api/v1/search?${params.toString()}`,
      { headers: { "User-Agent": "SpeakPlainlyResearch/0.1", Accept: "application/json" } },
      { label: `${HACKER_NEWS_NAME} article search`, timeoutMs: 10_000, maxBytes: 1_000_000 }
    );
    if (!res.ok) throw new Error(`${HACKER_NEWS_NAME} article search failed: ${res.status}`);
    return parseHackerNewsArticles(res.text, cleanQuery).slice(0, limit);
  });
}

/** Parse public Hacker News comment search output into short attributed excerpts. */
export function parseHackerNewsComments(payload: string | unknown, query: string): ResearchItem[] {
  const parsed = typeof payload === "string" ? parseJson(payload) : payload;
  if (!isRecord(parsed) || !Array.isArray(parsed.hits)) return [];

  return parsed.hits
    .map((raw): ResearchItem | undefined => {
      if (!isRecord(raw)) return undefined;
      const hit = raw as HackerNewsHit;
      const objectId = cleanText(asString(hit.objectID), 80);
      const fullComment = cleanText(asString(hit.comment_text), 4_000);
      const excerpt = cleanText(fullComment, 280);
      if (!objectId || !excerpt) return undefined;

      const storyTitle = cleanText(asString(hit.story_title), 180);
      if (!isRelevantText(`${storyTitle} ${fullComment}`, query)) return undefined;
      const author = cleanText(asString(hit.author), 120);
      return {
        id: `hacker-news-comment:${objectId}`,
        sourceKind: "comment",
        sourceName: HACKER_NEWS_NAME,
        sourceId: "hacker-news-comments",
        region: "international",
        title: storyTitle ? `Comment on: ${storyTitle}` : `Public comment about ${cleanText(query, 120)}`,
        summary: excerpt,
        excerpt,
        url: `https://news.ycombinator.com/item?id=${encodeURIComponent(objectId)}`,
        publishedAt: normalizeDate(asString(hit.created_at)),
        authors: author ? [author] : [],
        query,
      };
    })
    .filter((item): item is ResearchItem => Boolean(item));
}

/** Search public comments without credentials through Hacker News' Algolia endpoint. */
export function fetchPublicComments(query: string, limit = 5): Promise<ResearchItem[]> {
  const cleanQuery = cleanText(query, 240);
  if (!cleanQuery) return Promise.resolve([]);

  return cached(`hacker-news-comments:${cleanQuery}:${limit}`, 20 * 60 * 1000, async () => {
    const params = new URLSearchParams({
      query: cleanQuery,
      tags: "comment",
      hitsPerPage: String(Math.max(limit, 1)),
    });
    const res = await fetchTextWithTimeout(
      `https://hn.algolia.com/api/v1/search?${params.toString()}`,
      { headers: { "User-Agent": "SpeakPlainlyResearch/0.1", Accept: "application/json" } },
      { label: HACKER_NEWS_NAME, timeoutMs: 10_000, maxBytes: 1_000_000 }
    );
    if (!res.ok) throw new Error(`${HACKER_NEWS_NAME} comment search failed: ${res.status}`);
    return parseHackerNewsComments(res.text, cleanQuery).slice(0, limit);
  });
}

/** Parse direct Exa search output for either web articles or public discussions. */
export function parseExaSearchResults(
  payload: string | unknown,
  query: string,
  sourceKind: Extract<ResearchSourceKind, "article" | "comment">
): ResearchItem[] {
  const parsed = typeof payload === "string" ? parseJson(payload) : payload;
  if (!isRecord(parsed) || !Array.isArray(parsed.results)) return [];

  return parsed.results
    .map((raw): ResearchItem | undefined => {
      if (!isRecord(raw)) return undefined;
      const result = raw as ExaRawResult;
      const title = cleanText(asString(result.title), 180);
      const url = normalizePublicSourceUrl(asString(result.url));
      if (!title || !url) return undefined;

      const highlightText = cleanText(asStringArray(result.highlights).join(" "), 4_000);
      const fullText = cleanText(asString(result.text), 8_000);
      const excerpt = cleanText(highlightText || fullText, 600);
      const summary = cleanText(asString(result.summary), 700) || excerpt;
      const imageUrl = cleanText(asString(result.image), 500);
      const sourceName = inferPublisherName(url);
      return {
        id: `exa-${sourceKind}:${url.toLowerCase()}`,
        sourceKind,
        sourceName,
        sourceId: `exa-${sourceKind}`,
        region: inferPublisherRegion(url, sourceName),
        title,
        summary,
        excerpt: excerpt || undefined,
        content: fullText || highlightText || undefined,
        url,
        imageUrl: /^https?:\/\//i.test(imageUrl) ? imageUrl : undefined,
        publishedAt: normalizeDate(asString(result.publishedDate) || asString(result.publishedAt)),
        authors: normalizeAuthors(result.author ?? result.authors),
        query,
      };
    })
    .filter((item): item is ResearchItem => Boolean(item));
}

/**
 * Search the broad web for articles and discussions.
 *
 * A configured `EXA_API_KEY` uses the built-in HTTP integration. Otherwise the
 * existing Agent-Reach/mcporter path remains a compatible fallback.
 */
export async function fetchBroadWebSources(query: string): Promise<ResearchItem[]> {
  const result = await fetchBroadWebSourcesWithDiagnostics(query);
  if (result.items.length === 0 && result.unavailableSources.length > 0) {
    throw new Error(result.unavailableSources.join("; "));
  }
  return result.items;
}

/** Search the broad web while retaining warnings from partially failed providers. */
export async function fetchBroadWebSourcesWithDiagnostics(query: string): Promise<BroadWebSearchResult> {
  const cleanQuery = cleanText(query, 240);
  if (!cleanQuery) return { items: [], unavailableSources: [] };

  const apiKey = process.env.EXA_API_KEY?.trim();
  if (apiKey) {
    const direct = await Promise.allSettled([
      fetchDirectExaSearch(cleanQuery, "article", 6, apiKey),
      fetchDirectExaSearch(cleanQuery, "comment", 4, apiKey),
    ]);
    const directItems = direct.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    const warnings = providerDiagnosticsFromSettled(direct, ["Exa article search", "Exa comment search"]);
    if (warnings.length === 0) return { items: directItems, unavailableSources: [] };

    // Preserve whichever direct query succeeded, then fill the failed side via
    // Agent-Reach when it is installed. If no fallback exists, partial success
    // is still more useful than discarding the whole provider.
    if (await isMcporterAvailable()) {
      const fallback = await fetchAgentReachPairWithDiagnostics(cleanQuery);
      return {
        items: [...directItems, ...fallback.items],
        unavailableSources: [...warnings, ...fallback.unavailableSources],
      };
    }
    return { items: directItems, unavailableSources: warnings };
  }

  if (!(await isMcporterAvailable())) return { items: [], unavailableSources: [] };
  return fetchAgentReachPairWithDiagnostics(cleanQuery);
}

async function fetchAgentReachPairWithDiagnostics(query: string): Promise<BroadWebSearchResult> {
  const settled = await Promise.allSettled([
    fetchAgentReachSearch(query, 6, "article"),
    fetchAgentReachSearch(discussionQuery(query), 4, "comment"),
  ]);
  return {
    items: settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
    unavailableSources: providerDiagnosticsFromSettled(settled, ["Agent-Reach article search", "Agent-Reach comment search"]),
  };
}

/** Convert rejected provider calls to stable diagnostics without exposing upstream text. */
export function providerDiagnosticsFromSettled<T>(
  settled: PromiseSettledResult<T>[],
  labels: string[]
): string[] {
  return settled.flatMap((result, index) =>
    result.status === "rejected"
      ? [providerFailureDiagnostic(labels[index] ?? "Broad web provider", result.reason)]
      : []
  );
}

/** Build a public diagnostic containing only a controlled label and broad category. */
export function providerFailureDiagnostic(label: string, error: unknown): string {
  return `${safeProviderLabel(label)}: ${providerFailureCategory(error)}`;
}

/** Re-sanitize nested broad-web warnings at the aggregate boundary. */
export function normalizeProviderDiagnostic(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const label = BROAD_WEB_PROVIDER_LABELS.find(
    (candidate) => raw === candidate || raw.startsWith(`${candidate}:`)
  );
  return providerFailureDiagnostic(label ?? "Broad web provider", raw);
}

function providerFailureCategory(error: unknown): ProviderFailureCategory {
  const record = isRecord(error) ? error : undefined;
  const name = error instanceof Error ? error.name : asString(record?.name);
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : asString(record?.message);
  const code = asString(record?.code);
  const status = typeof record?.status === "number" || typeof record?.status === "string"
    ? String(record.status)
    : "";
  const signal = `${name} ${code} ${status} ${message}`.toLocaleLowerCase();

  if (/aborterror|time(?:d)?[ -]?out|etimedout/.test(signal)) return "timed out";
  if (/\b429\b|rate[ -]?limit|too many requests/.test(signal)) return "rate limited";
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid (?:api )?key|authentication/.test(signal)) {
    return "authentication unavailable";
  }
  return "unavailable";
}

function safeProviderLabel(value: string): string {
  const compact = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (
    !compact ||
    /https?:\/\/|www\.|authorization|cookie|api[-_ ]?key|(?:^|[^a-z0-9])(?:token|secret)(?:[^a-z0-9]|$)/i.test(compact)
  ) {
    return "Research source";
  }
  const safe = compact.replace(/[^\p{L}\p{N} .()&/+_-]/gu, "").trim().slice(0, 80);
  return safe || "Research source";
}

async function isMcporterAvailable(): Promise<boolean> {
  if (!mcporterAvailablePromise) {
    const command = process.platform === "win32" ? "where.exe" : "which";
    const options: ExecFileOptionsWithStringEncoding = {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 64_000,
      windowsHide: true,
    };
    mcporterAvailablePromise = execFileAsync(command, ["mcporter"], options)
      .then(({ stdout }) => Boolean(stdout.trim()))
      .catch(() => false);
  }
  return mcporterAvailablePromise;
}

async function fetchDirectExaSearch(
  query: string,
  sourceKind: Extract<ResearchSourceKind, "article" | "comment">,
  limit: number,
  apiKey: string
): Promise<ResearchItem[]> {
  return cached(`exa-direct:${sourceKind}:${query}:${limit}`, 20 * 60 * 1000, async () => {
    const body: Record<string, unknown> = {
      query,
      type: sourceKind === "article" ? "auto" : "fast",
      numResults: limit,
      moderation: true,
      contents: sourceKind === "article"
        ? {
            highlights: { query, maxCharacters: 4_000 },
            text: { maxCharacters: 8_000 },
          }
        : { highlights: { query, maxCharacters: 2_000 } },
    };
    if (sourceKind === "comment") body.includeDomains = DISCUSSION_DOMAINS;

    const res = await fetchTextWithTimeout(
      EXA_API_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(body),
      },
      { label: `Exa ${sourceKind} search`, timeoutMs: 18_000, maxBytes: 2_000_000 }
    );
    if (!res.ok) throw new Error(`Exa ${sourceKind} search failed: ${res.status}`);
    return parseExaSearchResults(res.text, query, sourceKind).slice(0, limit);
  });
}

function discussionQuery(query: string): string {
  return containsCjk(query) ? `${query} 真实体验 观点 评论 讨论` : `${query} experiences opinions reviews discussion`;
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

/** Accept only genuine external HTTP(S) links; HN self-posts remain discussions. */
function validExternalArticleUrl(value: string): string | undefined {
  const normalized = normalizePublicSourceUrl(value);
  if (!normalized) return undefined;
  return new URL(normalized).hostname.toLocaleLowerCase() === "news.ycombinator.com"
    ? undefined
    : normalized;
}

/** Choose a returned window that contains the relevance evidence used to admit a story. */
function selectRelevantStorySummary(value: string, title: string, query: string): string {
  const fullText = cleanText(value, 4_000);
  const maxLength = 700;
  if (fullText.length <= maxLength) return fullText;

  const finalStart = Math.max(0, fullText.length - maxLength);
  const starts = new Set<number>([0, finalStart]);
  for (let start = Math.floor(maxLength / 2); start < finalStart; start += Math.floor(maxLength / 2)) {
    starts.add(start);
  }
  for (const start of [...starts].sort((a, b) => a - b)) {
    const candidate = cleanText(fullText.slice(start, start + maxLength), maxLength);
    if (isRelevantText(`${title} ${candidate}`, query)) return candidate;
  }
  return cleanText(fullText, maxLength);
}

/** Require retrieved material to share enough meaningful terms with the topic. */
export function isRelevantText(content: string, query: string): boolean {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return true;

  const haystack = normalizeForRelevance(content);
  const latinTokens = new Set(
    (haystack.match(/[a-z0-9]+(?:[_+.-][a-z0-9]+)*/g) ?? []).map(stemEnglishToken)
  );
  const matched = tokens.filter((token) =>
    /^[a-z0-9]/i.test(token) ? latinTokens.has(token) : haystack.includes(token)
  );
  const required = tokens.length <= 3 ? tokens.length : Math.ceil(tokens.length * 0.6);
  return matched.length >= required;
}

/** Check a normalized research item against its requested topic. */
export function isRelevantResearchItem(item: ResearchItem, query: string): boolean {
  return isRelevantText([item.title, item.summary, item.excerpt ?? ""].join(" "), query);
}

function queryTokens(value: string): string[] {
  const stop = new Set([
    "about", "after", "article", "from", "into", "latest", "review", "reviews", "that", "the", "their",
    "this", "what", "when", "where", "which", "with", "如何", "怎么", "为什么", "相关", "文章", "评论", "最新",
  ]);
  const raw = normalizeForRelevance(value).match(/[a-z0-9]+(?:[_+.-][a-z0-9]+)*|[\p{Script=Han}]{2,}/gu) ?? [];
  const tokens: string[] = [];
  for (const token of raw) {
    if (stop.has(token)) continue;
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      tokens.push(...hanRelevanceTokens(token));
    } else if (token.length >= 2) {
      tokens.push(stemEnglishToken(token));
    }
  }
  return [...new Set(tokens)];
}

/** Build overlapping Han bigrams after removing common grammatical glue. */
function hanRelevanceTokens(value: string): string[] {
  const functionWords = ["为什么", "怎么样", "如何", "怎么", "什么", "哪些", "对于", "关于", "以及", "由于", "因此", "是否"];
  let normalized = value;
  for (const word of functionWords) normalized = normalized.replaceAll(word, "");

  const functionChars = new Set(["的", "了", "和", "与", "及", "在", "对", "为", "将", "会", "是", "把", "被", "让", "从", "向", "中"]);
  const chars = [...normalized].filter((char) => !functionChars.has(char));
  if (chars.length < 2) return [];
  if (chars.length === 2) return [chars.join("")];

  const bigrams: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1) {
    bigrams.push(`${chars[index]}${chars[index + 1]}`);
  }
  return bigrams;
}

function normalizeForRelevance(value: string): string {
  let normalized = value.toLocaleLowerCase();
  for (const group of RELEVANCE_ALIASES) {
    for (const alias of [...group.aliases].sort((a, b) => b.length - a.length)) {
      const pattern = /^[a-z0-9 ]+$/i.test(alias)
        ? new RegExp(`\\b${escapeRegExp(alias).replace(/\\ /g, "\\s+")}\\b`, "gi")
        : new RegExp(escapeRegExp(alias), "gu");
      normalized = normalized.replace(pattern, ` ${group.canonical} `);
    }
  }
  return normalized.replace(/\s+/g, " ").trim();
}

function stemEnglishToken(token: string): string {
  if (!/^[a-z]+$/i.test(token) || token.length < 4) return token;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ing") && token.length > 5) {
    const stem = token.slice(0, -3);
    return stem.at(-1) === stem.at(-2) ? stem.slice(0, -1) : stem;
  }
  if (token.endsWith("es") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
  return token;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDate(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function normalizeAuthors(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(asString).map((author) => cleanText(author, 120)).filter(Boolean);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter(Boolean) : [];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cleanText(value: string, maxLength: number): string {
  const cleaned = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(x?[0-9a-f]+);/gi, (entity, code: string) => decodeNumericEntity(entity, code))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= maxLength
    ? cleaned
    : `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function decodeNumericEntity(entity: string, code: string): string {
  const value = code.toLowerCase().startsWith("x")
    ? Number.parseInt(code.slice(1), 16)
    : Number.parseInt(code, 10);
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
}
