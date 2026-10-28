import { useMemo, useState } from "react";
import { useStore } from "../../lib/store.js";
import GzhExportPanel from "./GzhExportPanel.js";
import RewritePopover from "./SentencePopover.js";
import { DocReferences, DocTable, SourceFigure } from "./DocBlocks.js";
import {
  fetchAlternatives,
  fetchTitles,
  type ArticleLengthDTO,
  type ArticleRenderBlockDTO,
  type ParagraphDTO,
} from "../../lib/api.js";
import { messages, type Lang } from "../../lib/i18n.js";

// Re-exported so the editor module stays the public entry point for its media helpers.
export {
  INITIAL_GIF_PLAYBACK_STATE,
  shouldMountGifMedia,
  transitionGifPlayback,
  type GifPlaybackEvent,
  type GifPlaybackState,
} from "./ControlledGifMedia.js";
export { resolveSourceFigureMedia, safeSourceMediaDataUri } from "../../lib/sourceMedia.js";
/** Restrict clickable attribution to an absolute HTTP(S) source page. */
export { safePublicSourcePageUrl as safeSourcePageUrl } from "../../lib/sourceUrl.js";

type Selected =
  | {
      kind: "sentence";
      paraIndex: number;
      sentenceIdx: number;
      sentence: string;
      context: string;
      anchor: FloatingAnchor;
      trigger: HTMLElement;
    }
  | { kind: "title"; paraIndex: number; text: string; anchor: FloatingAnchor; trigger: HTMLElement };

type FloatingAnchor = Pick<DOMRect, "left" | "top" | "bottom">;

/** Renders the document/article and wires per-sentence and title rephrasing. */
export default function DocEditor() {
  const paragraphs = useStore((s) => s.paragraphs);
  const storedRenderBlocks = useStore((s) => s.renderBlocks);
  const length = useStore((s) => s.length);
  const titleIndex = useStore((s) => s.titleIndex);
  const mode = useStore((s) => s.mode);
  const aiScore = useStore((s) => s.aiScore);
  const docId = useStore((s) => s.docId)!;
  const lang = useStore((s) => s.lang);
  const t = messages[lang];
  const setSentence = useStore((s) => s.setSentence);
  const setParagraph = useStore((s) => s.setParagraph);
  const doRewrite = useStore((s) => s.doRewrite);
  const doExport = useStore((s) => s.doExport);
  const busy = useStore((s) => s.busy);
  const [sel, setSel] = useState<Selected | null>(null);

  const currentByIndex = new Map(paragraphs.map((p) => [p.index, p]));
  const originalByIndex = new Map(
    paragraphs.map((p) => [
      p.index,
      {
        ...p,
        sentences: [p.original],
      },
    ])
  );
  const blocks = useMemo(
    () => storedRenderBlocks ?? paragraphs.map((p) => paragraphBlockFromParagraph(p)),
    [storedRenderBlocks, paragraphs]
  );
  const compare = Boolean(aiScore);
  const bodyLength = length && (mode === "generate" || mode === "novel")
    ? measureArticleBody(paragraphs, blocks, titleIndex, length.unit)
    : null;

  function restoreTriggerFocus(selection: Selected) {
    setSel(null);
    requestAnimationFrame(() => {
      if (selection.trigger.isConnected) selection.trigger.focus();
    });
  }

  function renderParagraph(p: ParagraphDTO, isTitle: boolean, interactive: boolean) {
    if (isTitle) {
      const text = p.sentences.join("");
      return (
        <h1 key={p.index} className="para doc-title">
          <span
            className={interactive ? "sentence title-pick" : "sentence readonly-sentence"}
            {...selectionTriggerProps(
              interactive,
              t.clickRetitle,
              sel?.kind === "title" && sel.paraIndex === p.index,
              (trigger) => setSel({
                kind: "title",
                paraIndex: p.index,
                text,
                anchor: trigger.getBoundingClientRect(),
                trigger,
              })
            )}
          >
            {text}
          </span>
        </h1>
      );
    }

    const Tag =
      p.kind === "heading1" ? "h1" : p.kind === "heading2" ? "h2" : p.kind === "heading3" ? "h3" : "p";
    const context = p.sentences.join("");
    return (
      <Tag key={p.index} className={`para ${p.kind}`}>
        {p.sentences.map((s, i) =>
          s.trim() ? (
            <span
              key={i}
              className={interactive ? "sentence" : "sentence readonly-sentence"}
              {...selectionTriggerProps(
                interactive,
                t.clickRephrase,
                sel?.kind === "sentence" && sel.paraIndex === p.index && sel.sentenceIdx === i,
                (trigger) => setSel({
                  kind: "sentence",
                  paraIndex: p.index,
                  sentenceIdx: i,
                  sentence: s,
                  context,
                  anchor: trigger.getBoundingClientRect(),
                  trigger,
                })
              )}
            >
              {s}
            </span>
          ) : (
            <span key={i}>{s}</span>
          )
        )}
      </Tag>
    );
  }

  function renderBlockList(paragraphByIndex: Map<number, ParagraphDTO>, interactive: boolean) {
    return blocks.map((block, index) => {
      if (block.type === "figure") return <SourceFigure key={`figure-${docId}-${index}`} block={block} lang={lang} />;
      if (block.type === "table") return <DocTable key={`table-${index}`} block={block} />;
      if (block.type === "references") return <DocReferences key={`references-${index}`} block={block} />;

      const stored = block.paragraphIndex !== undefined ? paragraphByIndex.get(block.paragraphIndex) : undefined;
      const paragraph = stored ?? paragraphFromBlock(block, index);
      return renderParagraph(paragraph, paragraph.index === titleIndex, interactive && Boolean(stored));
    });
  }

  // Declared inside the editor on purpose: it remounts on every editor render, as it always has.
  function DocumentActions() {
    const isBusy = Boolean(busy);
    return (
      <div className="doc-actions" aria-label={lang === "zh" ? "文档操作" : "Document actions"}>
        {length && bodyLength !== null && <BodyLengthStatus bodyLength={bodyLength} length={length} lang={lang} />}
        <button className="primary doc-action-primary" disabled={isBusy} onClick={doRewrite}>
          {t.polishAll}
        </button>
        <button className="doc-action-secondary" disabled={isBusy} onClick={doExport}>
          {t.exportWord}
        </button>
      </div>
    );
  }

  return (
    <>
      <GzhExportPanel />
      {compare ? (
        <div className="doc-compare">
          <section className="doc compare-doc">
            <div className="compare-label">{lang === "zh" ? "原篇" : "Original"}</div>
            {renderBlockList(originalByIndex, false)}
          </section>
          <section className="doc compare-doc">
            <DocumentActions />
            <div className="compare-label">{lang === "zh" ? "润色后" : "Rewritten"}</div>
            {renderBlockList(currentByIndex, true)}
          </section>
        </div>
      ) : (
        <div className="doc">
          <DocumentActions />
          {renderBlockList(currentByIndex, true)}
        </div>
      )}

      {sel?.kind === "sentence" && (
        <RewritePopover
          heading={t.rephraseHeading}
          original={sel.sentence}
          anchor={sel.anchor}
          loadCandidates={() => fetchAlternatives(docId, sel.context, sel.sentence, 3, lang)}
          onAdopt={(text) => {
            setSentence(sel.paraIndex, sel.sentenceIdx, text);
            restoreTriggerFocus(sel);
          }}
          onClose={() => restoreTriggerFocus(sel)}
        />
      )}

      {sel?.kind === "title" && (
        <RewritePopover
          heading={t.retitleHeading}
          original={sel.text}
          anchor={sel.anchor}
          loadCandidates={() => fetchTitles(docId, 3, lang)}
          progressTask="titleCandidates"
          onAdopt={(text) => {
            setParagraph(sel.paraIndex, text);
            restoreTriggerFocus(sel);
          }}
          onClose={() => restoreTriggerFocus(sel)}
        />
      )}
    </>
  );
}

/** Button semantics for an editable sentence or title; read-only spans get none of them. */
function selectionTriggerProps(
  interactive: boolean,
  hint: string,
  expanded: boolean,
  select: (trigger: HTMLElement) => void
) {
  if (!interactive) return {};
  return {
    title: hint,
    role: "button",
    tabIndex: 0,
    "aria-haspopup": "dialog" as const,
    "aria-expanded": expanded,
    onClick: (event: React.MouseEvent<HTMLElement>) => select(event.currentTarget),
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => activateOnKeyboard(event, () => select(event.currentTarget)),
  };
}

function activateOnKeyboard(event: React.KeyboardEvent<HTMLElement>, activate: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  activate();
}

function BodyLengthStatus({ bodyLength, length, lang }: { bodyLength: number; length: ArticleLengthDTO; lang: Lang }) {
  const t = messages[lang];
  const state = bodyLength < length.min ? "short" : bodyLength > length.max ? "long" : "in-range";
  const stateLabel = { short: t.lengthTooShort, long: t.lengthTooLong, "in-range": t.lengthInRange }[state];
  return (
    <div
      className={`body-length body-length-${state}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span>{t.bodyLengthLabel}</span>
      <strong>
        {formatLength(bodyLength, lang)} {length.unit === "characters" ? t.lengthUnitCharacters : t.lengthUnitWords}
      </strong>
      <span className="body-length-target">
        {t.bodyLengthTarget} {formatLength(length.min, lang)}–{formatLength(length.max, lang)}
      </span>
      <span className="body-length-state">{stateLabel}</span>
    </div>
  );
}

/** Wrap a plain paragraph as a render block (used when there are no figures/tables). */
function paragraphBlockFromParagraph(p: ParagraphDTO): ArticleRenderBlockDTO {
  return {
    type: "paragraph",
    kind: p.kind,
    text: p.sentences.join(""),
    paragraphIndex: p.index,
  };
}

/** Build an editable paragraph from a render block when no stored paragraph matches. */
function paragraphFromBlock(block: Extract<ArticleRenderBlockDTO, { type: "paragraph" }>, index: number): ParagraphDTO {
  return {
    index: block.paragraphIndex ?? -1 - index,
    kind: block.kind,
    original: block.text,
    sentences: [block.text],
  };
}

/** Count only authored body paragraphs represented by paragraph render blocks. */
export function measureArticleBody(
  paragraphs: ParagraphDTO[],
  blocks: ArticleRenderBlockDTO[],
  titleIndex: number,
  unit: "characters" | "words"
): number {
  const currentByIndex = new Map(paragraphs.map((paragraph) => [paragraph.index, paragraph]));
  const body = blocks
    .filter((block): block is Extract<ArticleRenderBlockDTO, { type: "paragraph" }> => block.type === "paragraph")
    .filter((block) => block.paragraphIndex !== titleIndex && block.kind !== "heading1")
    .map((block) => {
      const paragraph = block.paragraphIndex === undefined ? undefined : currentByIndex.get(block.paragraphIndex);
      return paragraph ? paragraph.sentences.join("") : block.text;
    })
    .join("\n")
    .replace(/\[\d+\]/gu, "");

  if (unit === "characters") return Array.from(body.replace(/\s/gu, "")).length;
  return body.trim().match(/\S+/gu)?.length ?? 0;
}

function formatLength(value: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en-US").format(value);
}
