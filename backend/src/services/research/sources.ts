import type { NewsSource, NewsSourceType, ResearchRegion } from "./types.js";

/**
 * Verified public feeds used by the built-in research desk.
 *
 * The catalog deliberately carries both mainland-Chinese and international
 * publications. A dead or HTML-only endpoint is kept out of the enabled set;
 * broad web search can still discover articles from those publishers.
 */
export const NEWS_SOURCES: NewsSource[] = [
  // Domestic perspectives: technology, science, business, and general news.
  source("sspai", "少数派", "technology", "domestic", "zh", "https://sspai.com/feed"),
  source("ithome", "IT之家", "technology", "domestic", "zh", "https://www.ithome.com/rss/"),
  source("cnbeta", "cnBeta", "technology", "domestic", "zh", "https://www.cnbeta.com.tw/backend.php"),
  source("geekpark", "极客公园", "technology", "domestic", "zh", "https://www.geekpark.net/rss"),
  source("sciencenet", "科学网", "technology", "domestic", "zh", "http://www.sciencenet.cn/xml/news-0.aspx?news=0"),
  source("sciencenet-opinion", "科学网评论", "chinese", "domestic", "zh", "http://www.sciencenet.cn/xml/news-0.aspx?di=6"),
  source("tmtpost", "钛媒体", "finance", "domestic", "zh", "https://www.tmtpost.com/rss.xml"),
  source("china-daily-business", "China Daily Business", "finance", "domestic", "en", "http://www.chinadaily.com.cn/rss/bizchina_rss.xml"),
  source("china-daily-china", "China Daily China", "international", "domestic", "en", "http://www.chinadaily.com.cn/rss/china_rss.xml"),
  source("china-daily-opinion", "China Daily Opinion", "chinese", "domestic", "en", "http://www.chinadaily.com.cn/rss/opinion_rss.xml"),

  // International perspectives: public-interest, world, science, technology, and markets.
  source("npr-world", "NPR World", "international", "international", "en", "https://feeds.npr.org/1004/rss.xml"),
  source("france24", "France 24", "international", "international", "en", "https://www.france24.com/en/rss"),
  source("bbc-world", "BBC World", "international", "international", "en", "https://feeds.bbci.co.uk/news/world/rss.xml"),
  source("al-jazeera", "Al Jazeera", "international", "international", "en", "https://www.aljazeera.com/xml/rss/all.xml"),
  source("un-news", "UN News", "international", "international", "en", "https://news.un.org/feed/subscribe/en/news/all/rss.xml"),
  source("who-news", "WHO News", "international", "international", "en", "https://www.who.int/rss-feeds/news-english.xml"),
  source("nature", "Nature", "technology", "international", "en", "https://www.nature.com/nature.rss"),
  source("techcrunch", "TechCrunch", "technology", "international", "en", "https://techcrunch.com/feed/"),
  source("ars-technica", "Ars Technica", "technology", "international", "en", "https://feeds.arstechnica.com/arstechnica/index"),
  source("wired", "Wired", "technology", "international", "en", "https://www.wired.com/feed/rss"),
  source("mit-technology-review", "MIT Technology Review", "technology", "international", "en", "https://www.technologyreview.com/feed/"),
  source("engadget", "Engadget", "technology", "international", "en", "https://www.engadget.com/rss.xml"),
  source("hacker-news", "Hacker News", "technology", "international", "en", "https://hnrss.org/frontpage"),
  source("cnbc-world", "CNBC World", "international", "international", "en", "https://www.cnbc.com/id/100727362/device/rss/rss.html"),
  source("cnbc-top-news", "CNBC Top News", "finance", "international", "en", "https://www.cnbc.com/id/100003114/device/rss/rss.html"),
  source("marketwatch-top-stories", "MarketWatch Top Stories", "finance", "international", "en", "https://feeds.content.dowjones.io/public/rss/mw_topstories"),
];

function source(
  id: string,
  name: string,
  type: NewsSourceType,
  region: Exclude<ResearchRegion, "global">,
  language: "zh" | "en",
  url: string
): NewsSource {
  return { id, name, type, region, language, url, enabled: true };
}

/** Return the enabled sources that have a URL. */
export function enabledNewsSources(): NewsSource[] {
  return NEWS_SOURCES.filter((item) => item.enabled && item.url);
}

/**
 * Pick a balanced set of feeds for a domain.
 *
 * Each plan reserves an equal number of domestic and international feeds. The
 * topic category only changes which feeds lead within each region; it can no
 * longer collapse a Chinese technology query into six overseas feeds (or vice
 * versa). Results are interleaved so later limits preserve the balance.
 */
export function newsSourcesForDomain(domainName: string, perRegion = 4): NewsSource[] {
  const preferredTypes = sourceTypesForDomain(domainName.trim().toLowerCase());
  const enabled = enabledNewsSources();
  const forRegion = (region: ResearchRegion) =>
    rankedForTypes(enabled.filter((item) => item.region === region), preferredTypes).slice(0, perRegion);

  return interleave(forRegion("domestic"), forRegion("international"));
}

function rankedForTypes(sources: NewsSource[], preferredTypes: NewsSourceType[]): NewsSource[] {
  const rank = new Map(preferredTypes.map((type, index) => [type, index]));
  return sources
    .map((item, index) => ({ item, index, score: rank.get(item.type) ?? preferredTypes.length }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ item }) => item);
}

function interleave<T>(left: T[], right: T[]): T[] {
  const output: T[] = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index]) output.push(left[index]);
    if (right[index]) output.push(right[index]);
  }
  return output;
}

function sourceTypesForDomain(domainName: string): NewsSourceType[] {
  if (isFinanceDomain(domainName)) return ["finance", "international", "chinese", "technology"];
  if (isTechnologyDomain(domainName)) return ["technology", "international", "chinese", "finance"];
  if (isChineseDomain(domainName)) return ["chinese", "international", "technology", "finance"];
  return ["international", "chinese", "technology", "finance"];
}

function isFinanceDomain(domainName: string): boolean {
  return [
    "bloomberg", "cnbc", "finance", "ft.com", "market", "marketwatch", "reuters", "stock", "wsj",
    "yahoo", "商业", "投资", "消费", "财经",
  ].some((keyword) => domainName.includes(keyword));
}

function isTechnologyDomain(domainName: string): boolean {
  if (/(^|[^a-z0-9])ai([^a-z0-9]|$)/i.test(domainName)) return true;
  return [
    "anthropic", "arstechnica", "github", "google", "hacker", "microsoft", "openai", "science",
    "tech", "technology", "techcrunch", "theverge", "verge", "wired", "大模型", "技术", "科技", "科学",
  ].some((keyword) => domainName.includes(keyword));
}

function isChineseDomain(domainName: string): boolean {
  return [
    ".cn", "36kr", "baidu", "caixin", "china", "chinese", "cctv", "huxiu", "jiemian", "qq.com",
    "sina", "thepaper", "weibo", "zhihu", "中国", "中文", "国内",
  ].some((keyword) => domainName.includes(keyword));
}
