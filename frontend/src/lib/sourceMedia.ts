/** Validation for web-source figures before the editor renders their media. */
import type { ArticleRenderBlockDTO, ArticleSourceMediaMime } from "./api.js";
import { safePublicSourcePageUrl } from "./sourceUrl.js";

const SOURCE_MEDIA_MIME_TYPES: ReadonlySet<string> = new Set<ArticleSourceMediaMime>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Accept only backend-vetted raster data URIs whose MIME agrees with their media kind. */
export function safeSourceMediaDataUri(
  value: string | undefined,
  mimeType: ArticleSourceMediaMime | string | undefined,
  mediaKind: "image" | "gif" | string | undefined
): string | undefined {
  if (!value || !mimeType || !SOURCE_MEDIA_MIME_TYPES.has(mimeType)) return undefined;
  if (mediaKind === "gif" ? mimeType !== "image/gif" : mediaKind !== "image" || mimeType === "image/gif") {
    return undefined;
  }
  const prefix = `data:${mimeType};base64,`;
  return value.startsWith(prefix) && value.length > prefix.length ? value : undefined;
}

export type SourceFigureBlock = Extract<ArticleRenderBlockDTO, { type: "figure" }>;

export interface ResolvedSourceFigureMedia {
  src: string;
  alt: string;
  width: number;
  height: number;
  sourceName: string;
  sourceTitle: string;
  sourceUrl: string;
}

/** Validate the complete web-source contract before any article media is rendered. */
export function resolveSourceFigureMedia(block: SourceFigureBlock): ResolvedSourceFigureMedia | undefined {
  const src = safeSourceMediaDataUri(block.mediaDataUri, block.mimeType, block.mediaKind);
  const sourceUrl = safePublicSourcePageUrl(block.sourceUrl);
  const alt = block.alt?.trim();
  const sourceName = block.sourceName?.trim();
  const sourceTitle = block.sourceTitle?.trim();
  const validDimensions = Number.isSafeInteger(block.width)
    && block.width > 0
    && Number.isSafeInteger(block.height)
    && block.height > 0;
  const validSourceRef = Number.isSafeInteger(block.sourceRef) && block.sourceRef > 0;
  if (
    block.origin !== "web"
    || !src
    || !sourceUrl
    || !alt
    || !sourceName
    || !sourceTitle
    || !validDimensions
    || !validSourceRef
  ) {
    return undefined;
  }
  return {
    src,
    alt,
    width: block.width,
    height: block.height,
    sourceName,
    sourceTitle,
    sourceUrl,
  };
}
