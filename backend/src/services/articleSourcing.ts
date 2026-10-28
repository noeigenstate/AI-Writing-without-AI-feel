/**
 * Research enrichment for a finished draft: numbered references, inline-citation
 * cleanup, and source/licensed figures fetched and validated at the trust boundary.
 */
import type {
  ArticleFigure,
  ArticleMediaDependencies,
  ArticleReference,
  GeneratedArticle,
} from "./article.js";
import {
  citesSource,
  hasSignificantSourceImageMatch,
  isLikelyGifUrl,
  mediaHintsAfter,
  rankSourceImages,
  type RankedSourceImage,
  type RankedSourceImageGroups,
} from "./articleImageMatch.js";
import { measureArticleLength } from "./articleLength.js";
import { fetchSafeImageBinary, type SafeImageBinary } from "./research/images.js";
import type { LicensedMediaItem } from "./research/licensedMedia.js";
import type { ResearchItem } from "./research/types.js";
import { shortDate } from "../lib/text.js";
import { ARTICLE_LABELS, tr, type Lang } from "../core/i18n.js";

/** The draft prompt only sees this many research items, so only they are citable evidence. */
const EVIDENCE_SOURCE_WINDOW = 16;
/** Keep rich media proportional to reading length without turning the article into a gallery. */
const MAX_TOTAL_FIGURES = 6;
export const MAX_INLINE_GIFS = 1;
const MAX_TOTAL_INLINE_MEDIA_BYTES = 8 * 1024 * 1024;
/** Per-source byte cap before a real network image is eligible for inclusion. */
const IMAGE_INLINE_MAX_BYTES = 3 * 1024 * 1024;
const FIGURE_PREFIX = /^(?:Figure\s+\d+\.|图\d+)\s*/u;

interface BuiltSourceFigure extends ArticleFigure {
  inlineBytes: number;
}

type BuildSourceFigure = (match: RankedSourceImage) => Promise<BuiltSourceFigure | undefined>;

/**
 * Attach references, relevant source images, and inline citations to an article.
 *
 * @param article The drafted article.
 * @param items Research items gathered for the topic.
 * @param accessedAt Access timestamp for the reference list.
 * @param lang Target language.
 * @returns A new article enriched with sourcing.
 */
export async function enrichArticleWithResearch(
  article: GeneratedArticle,
  items: ResearchItem[],
  accessedAt = new Date(),
  lang: Lang = "en",
  dependencies: ArticleMediaDependencies = {}
): Promise<GeneratedArticle> {
  const evidenceItems = items.slice(0, EVIDENCE_SOURCE_WINDOW);
  const evidenceReferences = formatReferences(evidenceItems, accessedAt);
  const supplementalMedia = (dependencies.supplementalMedia ?? []).slice(0, maxFigureCount(article));
  const supplementalItems = supplementalMedia.map(licensedMediaResearchItem);
  const licensedMediaByResearchId = new Map(
    supplementalMedia.map((media) => [`openverse:${media.id}`, media] as const)
  );
  const references = [
    ...evidenceReferences,
    ...formatLicensedMediaReferences(supplementalMedia, evidenceReferences.length, accessedAt),
  ];
  // The draft only saw the evidence window. Supplemental media references are
  // appended for figure attribution and must not validate invented body cites.
  const paragraphs = enforceInlineCitations(article.paragraphs, evidenceReferences.length);
  const { lead, body } = await buildArticleFigures(
    { ...article, paragraphs },
    [...evidenceItems, ...supplementalItems],
    lang,
    dependencies.fetchImage ?? fetchSafeImageBinary,
    licensedMediaByResearchId
  );
  return {
    ...article,
    paragraphs,
    ...(article.length
      ? { length: measureArticleLength(paragraphs, lang, article.length.tier) }
      : {}),
    references,
    figure: lead,
    bodyFigures: body,
  };
}

/**
 * Re-run the deterministic figure/source/body relationship gate after all
 * source and licensed-media figures have been attached.
 */
export function articleMediaMatchesBody(
  article: GeneratedArticle,
  researchItems: ResearchItem[],
  supplementalMedia: LicensedMediaItem[] = []
): boolean {
  const evidenceItems = researchItems.slice(0, EVIDENCE_SOURCE_WINDOW);
  const allItems = [...evidenceItems, ...supplementalMedia.map(licensedMediaResearchItem)];
  const figures = [...(article.figure ? [article.figure] : []), ...(article.bodyFigures ?? [])];
  return figures.every((figure) => {
    if (!isSafeArticleFigure(figure)) return false;
    const item = allItems[figure.sourceRef - 1];
    if (!item || item.url !== figure.sourceUrl) return false;
    const paragraphIndex = figure.afterParagraphIndex ?? 0;
    if (paragraphIndex < 0 || paragraphIndex >= article.paragraphs.length) return false;
    const paragraph = article.paragraphs[paragraphIndex] ?? "";
    const hints = mediaHintsAfter(article, paragraphIndex);
    const targetText = [
      article.title,
      paragraph,
      ...hints.flatMap((hint) => [hint.query, hint.alt]),
    ].join(" ");
    return citesSource(paragraph, figure.sourceRef)
      || hints.some((hint) => hint.sourceRefs.includes(figure.sourceRef))
      || hasSignificantSourceImageMatch(targetText, item);
  });
}

/** Only backend-fetched, container-validated raster data URIs may be rendered inline. */
export function isSafeArticleFigure(figure: ArticleFigure): boolean {
  const allowedMimeTypes: ReadonlySet<SafeImageBinary["mimeType"]> = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ]);
  if (
    figure.origin !== "web"
    || !allowedMimeTypes.has(figure.mimeType)
    || !Number.isSafeInteger(figure.width)
    || !Number.isSafeInteger(figure.height)
    || figure.width <= 0
    || figure.height <= 0
    || !Number.isSafeInteger(figure.sourceRef)
    || figure.sourceRef <= 0
  ) {
    return false;
  }
  if (figure.mediaKind === "gif" ? figure.mimeType !== "image/gif" : figure.mimeType === "image/gif") {
    return false;
  }
  const prefix = `data:${figure.mimeType};base64,`;
  if (!figure.mediaDataUri.startsWith(prefix)) return false;
  const payload = figure.mediaDataUri.slice(prefix.length);
  return payload.length > 0
    && payload.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(payload);
}

/**
 * Keep only inline citations that point at a real reference.
 *
 * 不再给没有引用的段落补造编号（那会伪造出处）；只把指向不存在参考文献的
 * `[n]` 标记清掉，段落有没有引用完全由模型是否真的引用了资料决定。
 */
function enforceInlineCitations(paragraphs: string[], referenceCount: number): string[] {
  return paragraphs.map((paragraph) =>
    paragraph
      .replace(/\[(\d+)\]/g, (marker, n: string) => {
        const id = Number(n);
        return id >= 1 && id <= referenceCount ? marker : "";
      })
      .replace(/ {2,}/g, " ")
      .trimEnd()
  );
}

/**
 * Build the lead figure plus any in-body figures.
 *
 * Only source images with enough text-signal overlap are used. The image is
 * placed after the paragraph it best matches; unrelated images are omitted.
 */
async function buildArticleFigures(
  article: GeneratedArticle,
  items: ResearchItem[],
  lang: Lang = "en",
  fetchImage: typeof fetchSafeImageBinary = fetchSafeImageBinary,
  licensedMediaByResearchId: ReadonlyMap<string, LicensedMediaItem> = new Map()
): Promise<{ lead?: ArticleFigure; body: ArticleFigure[] }> {
  const ranked = rankSourceImages(article, items);
  const maxFigures = maxFigureCount(article);
  if (maxFigures <= 0) return { body: [] };
  const build: BuildSourceFigure = (match) =>
    buildSourceImageFigure(match, lang, fetchImage, licensedMediaByResearchId);
  const strictFigures = await fetchStrictFigures(article, ranked.strict, maxFigures, build);
  const fetched = applyInlineMediaBudget(strictFigures).length < maxFigures
    ? await appendFallbackFigure(strictFigures, ranked, build)
    : strictFigures;
  return leadAndBodyFigures(applyInlineMediaBudget(fetched), lang);
}

/**
 * Try strict matches, preferred picks first, until the figure quota is met.
 *
 * Each static candidate is fully decoded at the trust boundary. Keep this
 * sequential and distinguish the successful-image quota from the attempt
 * list: a failed top-ranked download must not hide the next safe source.
 */
async function fetchStrictFigures(
  article: GeneratedArticle,
  strict: RankedSourceImage[],
  maxFigures: number,
  build: BuildSourceFigure
): Promise<Array<BuiltSourceFigure | undefined>> {
  const preferred = selectSourceImageMatches(article, strict, maxFigures);
  const preferredUrls = new Set(preferred.map((match) => match.item.imageUrl));
  const attempts = [
    ...preferred,
    ...strict.filter((match) => !preferredUrls.has(match.item.imageUrl)),
  ];
  const fetched: Array<BuiltSourceFigure | undefined> = [];
  for (const match of attempts) {
    fetched.push(await build(match));
    if (applyInlineMediaBudget(fetched).length >= maxFigures) break;
  }
  return fetched;
}

/**
 * Conservative matches never fill a gallery: after strict candidates have
 * been tried, add at most one distinct, safely decoded fallback. Failed or
 * over-budget fallback candidates may be skipped in favour of the next
 * related source, with at most the original (<=16) unique candidates tried.
 */
async function appendFallbackFigure(
  fetched: Array<BuiltSourceFigure | undefined>,
  ranked: RankedSourceImageGroups,
  build: BuildSourceFigure
): Promise<Array<BuiltSourceFigure | undefined>> {
  const strictUrls = new Set(ranked.strict.map((match) => match.item.imageUrl));
  const acceptedCount = applyInlineMediaBudget(fetched).length;
  for (const match of ranked.fallback) {
    if (strictUrls.has(match.item.imageUrl)) continue;
    const figure = await build(match);
    if (!figure) continue;
    const withFallback = [...fetched, figure];
    if (applyInlineMediaBudget(withFallback).length > acceptedCount) return withFallback;
  }
  return fetched;
}

/** Split off the opening figure as the lead, order the rest by anchor, and number them all. */
function leadAndBodyFigures(
  sourceFigures: ArticleFigure[],
  lang: Lang
): { lead?: ArticleFigure; body: ArticleFigure[] } {
  // Only a real source image that matches the opening may be the lead. When no
  // such image exists, the article simply has no lead figure.
  const openingSourceIndex = sourceFigures.findIndex((figure) => figure.afterParagraphIndex === 0);
  const lead = openingSourceIndex >= 0 ? sourceFigures[openingSourceIndex] : undefined;
  // Array#sort is stable, so figures anchored to the same paragraph keep editorial order.
  const body = sourceFigures
    .filter((_, index) => index !== openingSourceIndex)
    .sort((left, right) => (left.afterParagraphIndex ?? 0) - (right.afterParagraphIndex ?? 0));
  const numbered = renumberFigures([...(lead ? [lead] : []), ...body], lang);
  return {
    lead: lead ? numbered[0] : undefined,
    body: numbered.slice(lead ? 1 : 0),
  };
}

function renumberFigures(figures: ArticleFigure[], lang: Lang): ArticleFigure[] {
  return figures.map((figure, index) => {
    const prefix = figureLabel(index + 1, lang);
    const stripPrefix = (value: string) => value.replace(FIGURE_PREFIX, "");
    return {
      ...figure,
      title: `${prefix} ${stripPrefix(figure.title)}`,
      caption: FIGURE_PREFIX.test(figure.caption) ? `${prefix} ${stripPrefix(figure.caption)}` : figure.caption,
    };
  });
}

function maxFigureCount(article: GeneratedArticle): number {
  if (article.length?.tier === "short") return 2;
  if (article.length?.tier === "medium") return 4;
  if (article.length?.tier === "long") return 6;
  return Math.min(MAX_TOTAL_FIGURES, Math.ceil(article.paragraphs.length / 3));
}

function selectSourceImageMatches(
  article: GeneratedArticle,
  ranked: RankedSourceImage[],
  desired: number
): RankedSourceImage[] {
  const selected = ranked.slice(0, desired);
  const wantsGif = article.mediaHints?.some((hint) => hint.kind === "gif");
  if (!wantsGif || selected.some((entry) => isLikelyGifUrl(entry.item.imageUrl))) return selected;
  const gif = ranked.find((entry) => isLikelyGifUrl(entry.item.imageUrl));
  if (!gif) return selected;
  if (selected.length < desired) selected.push(gif);
  else if (selected.length >= 1) selected[selected.length - 1] = gif;
  return [...new Map(selected.map((entry) => [entry.item.imageUrl, entry])).values()];
}

/** Localized figure number prefix, e.g. "图2" / "Figure 2.". */
function figureLabel(n: number, lang: Lang): string {
  return lang === "zh" ? `图${n}` : `Figure ${n}.`;
}

/** Build one figure from a safely fetched source image; failure means no figure. */
async function buildSourceImageFigure(
  match: RankedSourceImage,
  lang: Lang,
  fetchImage: typeof fetchSafeImageBinary,
  licensedMediaByResearchId: ReadonlyMap<string, LicensedMediaItem> = new Map()
): Promise<BuiltSourceFigure | undefined> {
  const { item, paragraphIndex, sourceRef } = match;
  if (!item.imageUrl) return undefined;
  const licensedMedia = licensedMediaByResearchId.get(item.id);
  const candidateUrls = licensedMedia
    ? [licensedMedia.downloadUrl, licensedMedia.thumbnailUrl]
    : [item.imageUrl];
  let image: SafeImageBinary | undefined;
  for (const candidateUrl of [...new Set(candidateUrls)]) {
    image = await fetchImage(candidateUrl, 8_000, IMAGE_INLINE_MAX_BYTES).catch(() => undefined);
    if (image) break;
  }
  if (!image) return undefined;
  const isGif = image.mimeType === "image/gif";
  const caption = licensedMedia
    ? licensedMediaFigureCaption(licensedMedia, sourceRef, isGif, lang)
    : lang === "zh"
      ? `${isGif ? "动图" : "图片"}来源 [${sourceRef}]：${item.sourceName}，《${item.title}》，${item.url}`
      : `${isGif ? "GIF" : "Image"} source [${sourceRef}]: ${item.sourceName}, "${item.title}", ${item.url}`;
  return {
    title: isGif ? (lang === "zh" ? "来源动图" : "Source GIF") : tr(ARTICLE_LABELS.figureSourceWord, lang),
    caption,
    origin: "web",
    mimeType: image.mimeType,
    mediaDataUri: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
    width: image.width,
    height: image.height,
    alt: item.title,
    mediaKind: isGif ? "gif" : "image",
    sourceName: item.sourceName,
    sourceTitle: item.title,
    sourceUrl: item.url,
    sourceRef,
    afterParagraphIndex: paragraphIndex,
    inlineBytes: image.bytes.length,
  };
}

/** Keep response payloads bounded; over-budget media is omitted, never replaced. */
function applyInlineMediaBudget(
  figures: (BuiltSourceFigure | undefined)[]
): ArticleFigure[] {
  let inlineBytes = 0;
  let gifCount = 0;
  const accepted: ArticleFigure[] = [];

  for (const built of figures) {
    if (!built) continue;
    const { inlineBytes: figureBytes, ...figure } = built;
    const isGif = figure.mediaKind === "gif";
    const exceedsGifLimit = isGif && gifCount >= MAX_INLINE_GIFS;
    const exceedsByteLimit = inlineBytes + figureBytes > MAX_TOTAL_INLINE_MEDIA_BYTES;
    if (exceedsGifLimit || exceedsByteLimit || figureBytes <= 0) continue;

    inlineBytes += figureBytes;
    if (isGif) gifCount += 1;
    accepted.push(figure);
  }
  return accepted;
}

/** Convert post-draft Openverse metadata into a figure-only research shape. */
function licensedMediaResearchItem(media: LicensedMediaItem): ResearchItem {
  return {
    id: `openverse:${media.id}`,
    sourceKind: "article",
    sourceName: `Openverse / ${media.creator}`,
    sourceId: "openverse",
    region: "global",
    title: media.title,
    summary: [media.title, ...media.tags].join(" "),
    url: media.landingUrl,
    imageUrl: media.downloadUrl,
    publishedAt: "",
    authors: [media.creator],
    query: media.query,
  };
}

function licensedMediaFigureCaption(
  media: LicensedMediaItem,
  sourceRef: number,
  isGif: boolean,
  lang: Lang
): string {
  if (lang === "zh") {
    return `${isGif ? "动图" : "图片"}来源 [${sourceRef}]：${media.title}，创作者 ${media.creator}；`
      + `${media.licenseName}（${media.licenseUrl}）；原始页面 ${media.landingUrl}。`
      + "许可元数据由 Openverse 汇集，请在使用前于原始页面核验。";
  }
  return `${isGif ? "GIF" : "Image"} source [${sourceRef}]: "${media.title}" by ${media.creator}; `
    + `${media.licenseName} (${media.licenseUrl}); original page ${media.landingUrl}. `
    + "License metadata is indexed by Openverse; verify the terms on the original page before reuse.";
}

/** Format research items into numbered, APA-ish reference strings. */
function formatReferences(items: ResearchItem[], accessedAt: Date): ArticleReference[] {
  const accessed = accessedAt.toISOString().slice(0, 10);
  return items.map((item, index) => {
    const authors = item.authors.length > 0 ? item.authors.join(", ") : item.sourceName;
    const date = shortDate(item.publishedAt) || "n.d.";
    const source = item.sourceKind === "paper" ? "arXiv" : item.sourceName;
    return {
      id: index + 1,
      text: `[${index + 1}] ${authors}. (${date}). ${item.title}. ${source}. ${item.url}. Accessed ${accessed}.`,
    };
  });
}

/** Append complete attribution references without changing evidence numbering. */
function formatLicensedMediaReferences(
  items: LicensedMediaItem[],
  evidenceReferenceCount: number,
  accessedAt: Date
): ArticleReference[] {
  const accessed = accessedAt.toISOString().slice(0, 10);
  return items.map((item, index) => {
    const id = evidenceReferenceCount + index + 1;
    const creatorPage = item.creatorUrl ? ` Creator: ${item.creatorUrl}.` : "";
    return {
      id,
      text: `[${id}] Image: "${item.title}" by ${item.creator}. ${item.licenseName}: ${item.licenseUrl}.`
        + `${creatorPage} Original page: ${item.landingUrl}. `
        + `License metadata indexed by Openverse; verify terms at the original page. Accessed ${accessed}.`,
    };
  });
}
