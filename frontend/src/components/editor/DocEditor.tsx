import { useEffect, useId, useMemo, useState } from "react";
import { useStore } from "../../lib/store.js";
import GzhExportPanel from "./GzhExportPanel.js";
import RewritePopover from "./SentencePopover.js";
import {
  fetchAlternatives,
  fetchTitles,
  type ArticleRenderBlockDTO,
  type ArticleSourceMediaMime,
  type ParagraphDTO,
} from "../../lib/api.js";
import { messages } from "../../lib/i18n.js";
import { safePublicSourcePageUrl } from "../../lib/sourceUrl.js";

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
  const lengthState = bodyLength === null || !length
    ? null
    : bodyLength < length.min
      ? "short"
      : bodyLength > length.max
        ? "long"
        : "in-range";

  function restoreTriggerFocus(selection: Selected) {
    setSel(null);
    requestAnimationFrame(() => {
      if (selection.trigger.isConnected) selection.trigger.focus();
    });
  }

  function activateOnKeyboard(event: React.KeyboardEvent<HTMLElement>, activate: () => void) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activate();
  }

  function renderParagraph(p: ParagraphDTO, isTitle: boolean, interactive: boolean) {
    if (isTitle) {
      const text = p.sentences.join("");
      return (
        <h1 key={p.index} className="para doc-title">
          <span
            className={interactive ? "sentence title-pick" : "sentence readonly-sentence"}
            title={interactive ? t.clickRetitle : undefined}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-haspopup={interactive ? "dialog" : undefined}
            aria-expanded={interactive ? sel?.kind === "title" && sel.paraIndex === p.index : undefined}
            onClick={
              interactive
                ? (event) =>
                    setSel({
                      kind: "title",
                      paraIndex: p.index,
                      text,
                      anchor: event.currentTarget.getBoundingClientRect(),
                      trigger: event.currentTarget,
                    })
                : undefined
            }
            onKeyDown={
              interactive
                ? (event) =>
                    activateOnKeyboard(event, () =>
                      setSel({
                        kind: "title",
                        paraIndex: p.index,
                        text,
                        anchor: event.currentTarget.getBoundingClientRect(),
                        trigger: event.currentTarget,
                      })
                    )
                : undefined
            }
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
              title={interactive ? t.clickRephrase : undefined}
              role={interactive ? "button" : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-haspopup={interactive ? "dialog" : undefined}
              aria-expanded={
                interactive
                  ? sel?.kind === "sentence" && sel.paraIndex === p.index && sel.sentenceIdx === i
                  : undefined
              }
              onClick={
                interactive
                  ? (event) =>
                      setSel({
                        kind: "sentence",
                        paraIndex: p.index,
                        sentenceIdx: i,
                        sentence: s,
                        context,
                        anchor: event.currentTarget.getBoundingClientRect(),
                        trigger: event.currentTarget,
                      })
                  : undefined
              }
              onKeyDown={
                interactive
                  ? (event) =>
                      activateOnKeyboard(event, () =>
                        setSel({
                          kind: "sentence",
                          paraIndex: p.index,
                          sentenceIdx: i,
                          sentence: s,
                          context,
                          anchor: event.currentTarget.getBoundingClientRect(),
                          trigger: event.currentTarget,
                        })
                      )
                  : undefined
              }
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
      if (block.type === "figure") {
        const sourceMedia = resolveSourceFigureMedia(block);
        if (!sourceMedia) return null;
        const sourceTitle = lang === "zh" ? `《${sourceMedia.sourceTitle}》` : `“${sourceMedia.sourceTitle}”`;
        const sourceRef = Number.isSafeInteger(block.sourceRef) && Number(block.sourceRef) > 0
          ? `[${block.sourceRef}]`
          : "";
        return (
          <figure className="doc-figure" key={`figure-${docId}-${index}`}>
            {block.mediaKind === "gif" ? (
              <ControlledGifMedia
                animatedSrc={sourceMedia.src}
                alt={sourceMedia.alt}
                width={sourceMedia.width}
                height={sourceMedia.height}
                lang={lang}
              />
            ) : (
              <div className="doc-figure-media-image">
                <img
                  className="doc-figure-source-image"
                  src={sourceMedia.src}
                  alt={sourceMedia.alt}
                  width={sourceMedia.width}
                  height={sourceMedia.height}
                  loading="lazy"
                  decoding="async"
                />
              </div>
            )}
            <figcaption>
              {block.caption && <span className="doc-figure-caption">{block.caption}</span>}
              <span className="doc-figure-source">
                <span>{lang === "zh" ? "来源：" : "Source: "}</span>
                <a href={sourceMedia.sourceUrl} target="_blank" rel="noopener noreferrer">
                  {sourceMedia.sourceName} · {sourceTitle} · {t.viewSource}
                </a>
                {sourceRef && <span className="doc-source-ref">{sourceRef}</span>}
              </span>
            </figcaption>
          </figure>
        );
      }

      if (block.type === "table") {
        return (
          <section className="doc-table-wrap" key={`table-${index}`}>
            <h2>{block.title}</h2>
            <table className="doc-table">
              <thead>
                <tr>{block.columns.map((column) => <th key={column}>{column}</th>)}</tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            {block.note && <p className="table-note">{block.note}</p>}
          </section>
        );
      }

      if (block.type === "references") {
        return (
          <section className="doc-references" key={`references-${index}`}>
            <h2>{block.title}</h2>
            {block.items.map((item) => <p key={item}>{item}</p>)}
          </section>
        );
      }

      const fallback = block.paragraphIndex !== undefined ? paragraphByIndex.get(block.paragraphIndex) : undefined;
      const paragraph = fallback ?? paragraphFromBlock(block, index);
      return renderParagraph(paragraph, paragraph.index === titleIndex, interactive && Boolean(fallback));
    });
  }

  function DocumentActions() {
    const isBusy = Boolean(busy);
    return (
      <div className="doc-actions" aria-label={lang === "zh" ? "文档操作" : "Document actions"}>
        {length && bodyLength !== null && lengthState && (
          <div
            className={`body-length body-length-${lengthState}`}
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
            <span className="body-length-state">
              {lengthState === "in-range" ? t.lengthInRange : lengthState === "short" ? t.lengthTooShort : t.lengthTooLong}
            </span>
          </div>
        )}
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

export type GifPlaybackState = "idle" | "playing" | "error";
export type GifPlaybackEvent = "toggle" | "error";
export const INITIAL_GIF_PLAYBACK_STATE: GifPlaybackState = "idle";

/** Keep GIF playback deterministic and never mount motion in reduced-motion mode. */
export function transitionGifPlayback(
  state: GifPlaybackState,
  event: GifPlaybackEvent,
  reducedMotion = false
): GifPlaybackState {
  if (event === "error") return "error";
  if (reducedMotion) return "idle";
  return state === "playing" ? "idle" : "playing";
}

export function shouldMountGifMedia(state: GifPlaybackState, reducedMotion = false): boolean {
  return state === "playing" && !reducedMotion;
}

interface ControlledGifMediaProps {
  animatedSrc: string;
  alt: string;
  width: number;
  height: number;
  lang: "en" | "zh";
}

/** Consent-first GIF player: no image bytes are mounted until the reader chooses Play. */
function ControlledGifMedia({ animatedSrc, alt, width, height, lang }: ControlledGifMediaProps) {
  const [playback, setPlayback] = useState<GifPlaybackState>(INITIAL_GIF_PLAYBACK_STATE);
  const reducedMotion = usePrefersReducedMotion();
  const mediaId = useId();
  const descriptionId = useId();
  const statusId = useId();
  const isPlaying = shouldMountGifMedia(playback, reducedMotion);

  useEffect(() => {
    if (reducedMotion) setPlayback(INITIAL_GIF_PLAYBACK_STATE);
  }, [reducedMotion]);

  const playLabel = lang === "zh" ? "播放 GIF" : "Play GIF";
  const pauseLabel = lang === "zh" ? "暂停 GIF" : "Pause GIF";
  const retryLabel = lang === "zh" ? "重试 GIF" : "Retry GIF";
  const actionLabel = playback === "error" ? retryLabel : isPlaying ? pauseLabel : playLabel;
  const stateLabel = playback === "error"
    ? (lang === "zh" ? "GIF，加载失败" : "GIF, load failed")
    : isPlaying
      ? (lang === "zh" ? "GIF，播放中" : "GIF, playing")
      : (lang === "zh" ? "GIF，尚未加载" : "GIF, not loaded");
  const idleTitle = lang === "zh" ? "原始 GIF 尚未加载" : "The original GIF has not been loaded";
  const idleMessage = lang === "zh"
    ? "为避免自动播放，点击后才会加载真实来源动图。"
    : "To prevent autoplay, the genuine source GIF loads only after you choose Play.";
  const reducedMotionMessage = lang === "zh"
    ? "已按系统的减少动态效果设置不加载 GIF。"
    : "The GIF is not loaded because reduced motion is enabled.";
  const errorMessage = lang === "zh"
    ? "GIF 加载失败，真实动图已卸载。你可以稍后重试。"
    : "The GIF could not load and has been unloaded. You can try again.";

  return (
    <>
      <div
        id={mediaId}
        className="doc-figure-media-gif"
        data-gif-state={reducedMotion ? "reduced" : playback}
      >
        <span className="doc-media-kind" aria-label={stateLabel} title={stateLabel}>
          {playback === "error"
            ? (lang === "zh" ? "GIF · 失败" : "GIF · ERROR")
            : isPlaying
              ? (lang === "zh" ? "GIF · 播放中" : "GIF · PLAYING")
              : (lang === "zh" ? "GIF · 待播放" : "GIF · READY")}
        </span>
        {isPlaying ? (
          <img
            className="doc-figure-source-image doc-figure-gif-animated"
            src={animatedSrc}
            alt={alt}
            width={width}
            height={height}
            decoding="async"
            onError={() => setPlayback((state) => transitionGifPlayback(state, "error"))}
          />
        ) : (
          <div id={descriptionId} className="doc-gif-idle">
            <strong>{idleTitle}</strong>
            <span>{idleMessage}</span>
            {reducedMotion && <span className="doc-gif-motion-note">{reducedMotionMessage}</span>}
          </div>
        )}
        {!reducedMotion && (
          <button
            type="button"
            className="doc-gif-control"
            aria-controls={mediaId}
            aria-describedby={playback === "error"
              ? `${descriptionId} ${statusId}`
              : isPlaying
                ? undefined
                : descriptionId}
            aria-pressed={isPlaying}
            onClick={() => setPlayback((state) => transitionGifPlayback(state, "toggle"))}
          >
            <GifControlIcon playing={isPlaying} />
            <span>{actionLabel}</span>
          </button>
        )}
      </div>
      {playback === "error" && !reducedMotion && (
        <p id={statusId} className="doc-gif-status" role="status" aria-live="polite">
          {errorMessage}
        </p>
      )}
    </>
  );
}

function GifControlIcon({ playing }: { playing: boolean }) {
  return (
    <svg className="doc-gif-control-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {playing ? (
        <path d="M3.5 2.5h3v11h-3zm6 0h3v11h-3z" />
      ) : (
        <path d="M4 2.4 13 8l-9 5.6z" />
      )}
    </svg>
  );
}

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reducedMotion;
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

function formatLength(value: number, lang: "en" | "zh"): string {
  return new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en-US").format(value);
}

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

/** Restrict clickable attribution to an absolute HTTP(S) source page. */
export function safeSourcePageUrl(value: string | undefined): string | undefined {
  return safePublicSourcePageUrl(value);
}

type SourceFigureBlock = Extract<ArticleRenderBlockDTO, { type: "figure" }>;

interface ResolvedSourceFigureMedia {
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
  const sourceUrl = safeSourcePageUrl(block.sourceUrl);
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
