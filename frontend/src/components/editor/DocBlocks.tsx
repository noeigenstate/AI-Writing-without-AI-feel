import type { ArticleRenderBlockDTO } from "../../lib/api.js";
import { messages, type Lang } from "../../lib/i18n.js";
import { resolveSourceFigureMedia, type SourceFigureBlock } from "../../lib/sourceMedia.js";
import ControlledGifMedia from "./ControlledGifMedia.js";

/** A verified web-source image or GIF with its attribution; invalid media renders nothing. */
export function SourceFigure({ block, lang }: { block: SourceFigureBlock; lang: Lang }) {
  const sourceMedia = resolveSourceFigureMedia(block);
  if (!sourceMedia) return null;
  const t = messages[lang];
  const sourceTitle = lang === "zh" ? `《${sourceMedia.sourceTitle}》` : `“${sourceMedia.sourceTitle}”`;
  return (
    <figure className="doc-figure">
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
          {/* resolveSourceFigureMedia only accepts a positive integer sourceRef. */}
          <span className="doc-source-ref">{`[${block.sourceRef}]`}</span>
        </span>
      </figcaption>
    </figure>
  );
}

export function DocTable({ block }: { block: Extract<ArticleRenderBlockDTO, { type: "table" }> }) {
  return (
    <section className="doc-table-wrap">
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

export function DocReferences({ block }: { block: Extract<ArticleRenderBlockDTO, { type: "references" }> }) {
  return (
    <section className="doc-references">
      <h2>{block.title}</h2>
      {block.items.map((item) => <p key={item}>{item}</p>)}
    </section>
  );
}
