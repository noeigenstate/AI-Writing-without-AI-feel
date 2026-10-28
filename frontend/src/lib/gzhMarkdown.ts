/** Build Markdown from editor state for the 公众号 formatting endpoint. */
import type { ArticleRenderBlockDTO, ParagraphDTO } from "./api.js";
import { safePublicSourcePageUrl } from "./sourceUrl.js";

const GZH_SOURCE_MEDIA_TOKEN_PREFIX = "SP_SOURCE_MEDIA_";

/** Trusted inline source media kept out of the formatting-model prompt. */
export interface GzhSourceMedia {
  token: string;
  mediaKind: "image" | "gif";
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  mediaDataUri: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
  sourceName: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceRef: number;
}

export interface GzhPreparedArticle {
  markdown: string;
  sourceMedia: GzhSourceMedia[];
}

/** Convert plain editor paragraphs back to Markdown. */
export function paragraphsToMarkdown(paragraphs: ParagraphDTO[], titleIndex: number): string {
  const lines: string[] = [];
  for (const p of paragraphs) {
    const text = p.sentences.join("").trim();
    if (text) lines.push(markdownParagraph(p.index === titleIndex ? "heading1" : p.kind, text));
  }
  return lines.join("\n\n");
}

/** Convert generated-article render blocks (with any manual edits) to Markdown. */
export function renderBlocksToMarkdown(blocks: ArticleRenderBlockDTO[], paragraphs: ParagraphDTO[]): string {
  return renderBlocksForGzh(blocks, paragraphs).markdown;
}

/**
 * Prepare model-safe Markdown plus a sidecar of already-vetted source bytes.
 *
 * The model sees only stable placement tokens and attribution text. The
 * browser restores the corresponding data URI after the backend has finished
 * formatting, so no remote hotlink or untrusted model-authored image URL is
 * needed.
 */
export function renderBlocksForGzh(
  blocks: ArticleRenderBlockDTO[],
  paragraphs: ParagraphDTO[]
): GzhPreparedArticle {
  const edited = new Map(paragraphs.map((p) => [p.index, p.sentences.join("").trim()]));
  const lines: string[] = [];
  const sourceMedia: GzhSourceMedia[] = [];
  for (const b of blocks) {
    if (b.type === "paragraph") {
      const text = (b.paragraphIndex !== undefined ? edited.get(b.paragraphIndex) : undefined) ?? b.text.trim();
      if (text) lines.push(markdownParagraph(b.kind, text));
    } else if (b.type === "figure") {
      // Only the source page is preserved for attribution. The downloaded
      // media bytes stay out of Markdown, and no remote image hotlink is made.
      const sourceFigure = resolveSourceFigureForExport(b);
      if (!sourceFigure) continue;
      const token = `${GZH_SOURCE_MEDIA_TOKEN_PREFIX}${String(sourceMedia.length + 1).padStart(4, "0")}`;
      sourceMedia.push({ token, ...sourceFigure });
      const placeholder = sourceFigure.mediaKind === "gif" ? "插入来源 GIF" : "插入来源图片";
      const description = [
        compactInlineText(b.title),
        compactInlineText(b.caption),
        `来源：${sourceFigure.sourceName}《${sourceFigure.sourceTitle}》 ${sourceFigure.sourceUrl}`,
      ].filter(Boolean).join("｜");
      lines.push(`【${placeholder}｜素材 ${token}｜来源 ${sourceFigure.sourceRef}】${description ? ` ${description}` : ""}`);
    } else if (b.type === "table") {
      const header = `| ${b.columns.join(" | ")} |`;
      const divider = `| ${b.columns.map(() => "---").join(" | ")} |`;
      const rows = b.rows.map((r) => `| ${r.join(" | ")} |`);
      lines.push(`### ${b.title}`, [header, divider, ...rows].join("\n"));
      if (b.note) lines.push(`> ${b.note}`);
    } else if (b.type === "references") {
      lines.push(`## ${b.title}`, b.items.map((item) => `- ${item}`).join("\n"));
    }
  }
  return { markdown: lines.join("\n\n"), sourceMedia };
}

function markdownParagraph(kind: string, text: string): string {
  switch (kind) {
    case "heading1":
      return `# ${text}`;
    case "heading2":
      return `## ${text}`;
    case "heading3":
      return `### ${text}`;
    case "list":
      return `- ${text}`;
    default:
      return text;
  }
}

function compactInlineText(value: string | undefined): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

type SourceFigureBlock = Extract<ArticleRenderBlockDTO, { type: "figure" }>;

function resolveSourceFigureForExport(block: SourceFigureBlock): {
  mediaKind: "image" | "gif";
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  mediaDataUri: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
  sourceName: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceRef: number;
} | undefined {
  const sourceName = compactInlineText(block.sourceName);
  const sourceTitle = compactInlineText(block.sourceTitle);
  const sourceUrl = safePublicSourcePageUrl(block.sourceUrl);
  const mimeMatchesKind = block.mediaKind === "gif"
    ? block.mimeType === "image/gif"
    : block.mediaKind === "image" && ["image/png", "image/jpeg", "image/webp"].includes(block.mimeType);
  const dataPrefix = `data:${block.mimeType};base64,`;
  const hasVettedMediaShape = typeof block.mediaDataUri === "string"
    && block.mediaDataUri.startsWith(dataPrefix)
    && block.mediaDataUri.length > dataPrefix.length;
  const validDimensions = Number.isSafeInteger(block.width)
    && block.width > 0
    && Number.isSafeInteger(block.height)
    && block.height > 0;
  const validSourceRef = Number.isSafeInteger(block.sourceRef) && block.sourceRef > 0;
  if (
    block.origin !== "web"
    || !mimeMatchesKind
    || !hasVettedMediaShape
    || !validDimensions
    || !validSourceRef
    || !compactInlineText(block.alt)
    || !sourceName
    || !sourceTitle
    || !sourceUrl
  ) {
    return undefined;
  }
  return {
    mediaKind: block.mediaKind,
    mimeType: block.mimeType,
    mediaDataUri: block.mediaDataUri,
    width: block.width,
    height: block.height,
    alt: compactInlineText(block.alt),
    caption: compactInlineText(block.caption),
    sourceName,
    sourceTitle,
    sourceUrl,
    sourceRef: block.sourceRef,
  };
}
