/**
 * Lay out a generated article as ordered docx blocks or web render blocks:
 * title, section headings, body paragraphs with interspersed figures, references.
 */
import type { DocxBlock, ParaKind } from "./docx.js";
import type { ArticleFigure, ArticleRenderBlock, GeneratedArticle } from "./article.js";
import { isSafeArticleFigure, MAX_INLINE_GIFS } from "./articleSourcing.js";
import { ARTICLE_LABELS, tr, type Lang } from "../core/i18n.js";

interface ArticleBodyVisitor {
  heading(text: string): void;
  paragraph(text: string): void;
  figure(figure: ArticleFigure): void;
}

/**
 * Flatten an article to plain `{kind, text}` paragraphs (drops figures/tables).
 *
 * @param article The generated article.
 * @returns Paragraph blocks only.
 */
export function articleToDocParagraphs(article: GeneratedArticle): { kind: ParaKind; text: string }[] {
  return articleToDocBlocks(article)
    .filter((block): block is Extract<DocxBlock, { type: "paragraph" }> => block.type === "paragraph")
    .map(({ kind, text }) => ({ kind, text }));
}

/**
 * Lay out an article as ordered docx blocks: title, lead figure, body (with
 * interspersed figures), and references.
 *
 * @param article The generated (enriched) article.
 * @param lang Target language for section labels.
 * @returns Ordered docx blocks ready for {@link ./docx.ts}.
 */
export function articleToDocBlocks(article: GeneratedArticle, lang: Lang = "en"): DocxBlock[] {
  const blocks: DocxBlock[] = [
    { type: "paragraph", kind: "heading1", text: article.title },
  ];
  visitArticleBody(article, {
    heading: (text) => blocks.push({ type: "paragraph", kind: "heading2", text }),
    paragraph: (text) => blocks.push({ type: "paragraph", kind: "normal", text }),
    figure: (figure) => blocks.push({ type: "figure", ...figure }),
  });

  if (article.references && article.references.length > 0) {
    blocks.push({ type: "paragraph", kind: "heading2", text: tr(ARTICLE_LABELS.references, lang) });
    blocks.push(
      ...article.references.map((reference) => ({
        type: "paragraph" as const,
        kind: "normal" as const,
        text: reference.text,
      }))
    );
  }

  return blocks;
}

/**
 * Lay out an article as render blocks for the web editor.
 *
 * Mirrors {@link articleToDocBlocks}, but threads each body paragraph's stored
 * index so the editor can map sentences back to the document.
 *
 * @param article The generated (enriched) article.
 * @param paragraphs Parsed paragraphs (to recover indices by text match).
 * @param lang Target language for section labels.
 * @returns Ordered render blocks.
 */
export function articleToRenderBlocks(
  article: GeneratedArticle,
  paragraphs: { index: number; text: string }[] = [],
  lang: Lang = "en"
): ArticleRenderBlock[] {
  let cursor = 0;
  const takeParagraphIndex = (text: string): number | undefined => {
    for (let i = cursor; i < paragraphs.length; i += 1) {
      if (paragraphs[i].text === text) {
        cursor = i + 1;
        return paragraphs[i].index;
      }
    }
    return undefined;
  };

  const blocks: ArticleRenderBlock[] = [
    { type: "paragraph", kind: "heading1", text: article.title, paragraphIndex: takeParagraphIndex(article.title) },
  ];
  let renderedGifCount = 0;
  visitArticleBody(article, {
    heading: (text) =>
      blocks.push({ type: "paragraph", kind: "heading2", text, paragraphIndex: takeParagraphIndex(text) }),
    paragraph: (text) =>
      blocks.push({ type: "paragraph", kind: "normal", text, paragraphIndex: takeParagraphIndex(text) }),
    figure: (figure) => {
      const rendered = safeRenderFigure(figure, renderedGifCount < MAX_INLINE_GIFS);
      if (!rendered) return;
      if (rendered.mediaKind === "gif") renderedGifCount += 1;
      blocks.push(rendered);
    },
  });

  if (article.references && article.references.length > 0) {
    blocks.push({
      type: "references",
      title: tr(ARTICLE_LABELS.references, lang),
      items: article.references.map((reference) => reference.text),
    });
  }

  return blocks;
}

/**
 * Walk the body in reading order: section headings, each paragraph, the lead
 * figure after the opening paragraph, then the figures anchored after it.
 * Without body paragraphs, the figures are emitted on their own.
 */
function visitArticleBody(article: GeneratedArticle, visit: ArticleBodyVisitor): void {
  const bodyFigures = article.bodyFigures ?? [];
  if (article.paragraphs.length === 0) {
    if (article.figure) visit.figure(article.figure);
    for (const figure of bodyFigures) visit.figure(figure);
    return;
  }

  const figuresAfter = spreadFigures(bodyFigures, article.paragraphs.length);
  const headingsBefore = sectionHeadingMap(article);
  article.paragraphs.forEach((text, i) => {
    for (const heading of headingsBefore.get(i) ?? []) visit.heading(heading);
    visit.paragraph(text);
    if (i === 0 && article.figure) visit.figure(article.figure);
    for (const figure of figuresAfter.get(i) ?? []) visit.figure(figure);
  });
}

function addToGroup<K, V>(groups: Map<K, V[]>, key: K, value: V): void {
  const list = groups.get(key) ?? [];
  list.push(value);
  groups.set(key, list);
}

/**
 * Spread body figures roughly evenly through the full body paragraph list.
 *
 * @param figures Figures to place after body paragraphs.
 * @param paragraphCount Number of body paragraphs available.
 * @returns Map from body-paragraph index → figures to insert after it.
 */
function spreadFigures(figures: ArticleFigure[], paragraphCount: number): Map<number, ArticleFigure[]> {
  const placement = new Map<number, ArticleFigure[]>();
  if (figures.length === 0 || paragraphCount === 0) {
    return placement;
  }

  const clampIndex = (index: number) => Math.min(paragraphCount - 1, Math.max(0, index));
  const unanchored: ArticleFigure[] = [];
  for (const figure of figures) {
    if (typeof figure.afterParagraphIndex === "number") {
      addToGroup(placement, clampIndex(figure.afterParagraphIndex), figure);
    } else {
      unanchored.push(figure);
    }
  }

  const step = paragraphCount / unanchored.length;
  unanchored.forEach((figure, i) => addToGroup(placement, clampIndex(Math.floor(step * (i + 1)) - 1), figure));
  return placement;
}

function sectionHeadingMap(article: GeneratedArticle): Map<number, string[]> {
  const headings = new Map<number, string[]>();
  for (const section of article.sectionBreaks ?? []) {
    if (!section.heading.trim() || section.beforeParagraphIndex <= 0 || section.beforeParagraphIndex >= article.paragraphs.length) {
      continue;
    }
    addToGroup(headings, section.beforeParagraphIndex, section.heading.trim());
  }
  return headings;
}

/** Emit only backend-vetted inline raster media; remote image URLs never enter the DTO. */
function safeRenderFigure(
  figure: ArticleFigure,
  allowAnimatedMedia = true
): Extract<ArticleRenderBlock, { type: "figure" }> | undefined {
  if (!isSafeArticleFigure(figure) || (figure.mediaKind === "gif" && !allowAnimatedMedia)) {
    return undefined;
  }
  return {
    type: "figure",
    title: figure.title,
    caption: figure.caption,
    origin: figure.origin,
    mimeType: figure.mimeType,
    mediaDataUri: figure.mediaDataUri,
    width: figure.width,
    height: figure.height,
    alt: figure.alt,
    mediaKind: figure.mediaKind,
    sourceName: figure.sourceName,
    sourceTitle: figure.sourceTitle,
    sourceUrl: figure.sourceUrl,
    sourceRef: figure.sourceRef,
  };
}
