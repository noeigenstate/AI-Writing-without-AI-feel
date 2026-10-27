import JSZip from "jszip";
import { validateDecodableRasterImage } from "./research/images.js";

/**
 * docx 解析与导出。
 *
 * 设计要点：导出时**不从零重建** docx，而是加载原始 docx，只替换每个段落里的文字，
 * 其余 XML（段落样式、列表、字体等）原样保留 —— 这样能在「段落级」上最大程度保真。
 */

/** Normalized paragraph type. */
export type ParaKind = "heading1" | "heading2" | "heading3" | "list" | "normal";

/** A unit of generated document content: a paragraph, a table, or a figure. */
export type DocxBlock =
  | { type: "paragraph"; kind: ParaKind; text: string }
  | { type: "table"; title?: string; columns: string[]; rows: string[][]; note?: string }
  | {
      type: "figure";
      title: string;
      caption: string;
      mediaDataUri: string;
      mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
      width: number;
      height: number;
    };

/** One parsed paragraph, aligned by index with the source document. */
export interface ParsedParagraph {
  index: number;      // 在文档中的段落序号（与导出对齐）
  style: string;      // 原始 pStyle val，如 "Heading1" / ""
  kind: ParaKind;     // 归一化后的类型
  text: string;       // 段落纯文本
}

/** The parsed paragraph structure of a docx. */
export interface ParsedDoc {
  paragraphs: ParsedParagraph[];
}

const PSTYLE_RE = /<w:pStyle\b[^>]*w:val="([^"]*)"/;
const WT_RE = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
type FigureBlock = Extract<DocxBlock, { type: "figure" }>;
type TableBlock = Extract<DocxBlock, { type: "table" }>;
type FigureMime = FigureBlock["mimeType"];

interface PreparedFigure {
  bytes: Buffer;
  extension: "png" | "jpg" | "gif" | "webp";
  cx: number;
  cy: number;
}

const INVALID_FIGURE_MEDIA_ERROR = "Invalid DOCX figure media";
const FIGURE_EXTENSIONS: Record<FigureMime, PreparedFigure["extension"]> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function invalidFigureMedia(): never {
  throw new Error(INVALID_FIGURE_MEDIA_ERROR);
}

/** Decode one canonical base64 data URI and reject MIME/header spoofing. */
async function prepareFigure(figure: FigureBlock): Promise<PreparedFigure> {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(
    figure.mediaDataUri
  );
  if (!match || match[1] !== figure.mimeType) invalidFigureMedia();

  const payload = match[2];
  if (payload.length % 4 !== 0) invalidFigureMedia();
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== payload) invalidFigureMedia();
  if (!hasExpectedImageSignature(bytes, figure.mimeType)) invalidFigureMedia();
  if (!Number.isSafeInteger(figure.width) || figure.width <= 0) invalidFigureMedia();
  if (!Number.isSafeInteger(figure.height) || figure.height <= 0) invalidFigureMedia();
  const decoded = await validateDecodableRasterImage(bytes, figure.mimeType);
  if (!decoded || decoded.width !== figure.width || decoded.height !== figure.height) invalidFigureMedia();

  return { bytes, extension: FIGURE_EXTENSIONS[figure.mimeType], ...figureExtent(figure.width, figure.height) };
}

function hasExpectedImageSignature(bytes: Buffer, mimeType: FigureMime): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    const signature = bytes.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

/** Fit the source aspect ratio inside a readable Word page area. */
function figureExtent(width: number, height: number): { cx: number; cy: number } {
  const maxCx = 5_760_000;
  const maxCy = 6_480_000;
  const ratio = width / height;
  let cx = maxCx;
  let cy = Math.round(cx / ratio);
  if (cy > maxCy) {
    cy = maxCy;
    cx = Math.round(cy * ratio);
  }
  return { cx: Math.max(1, cx), cy: Math.max(1, cy) };
}

interface XmlSpan {
  start: number;
  end: number;
  text: string;
}

/** Decode XML entities back to plain text. */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Encode the XML-significant characters for embedding in document XML. */
function encodeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Map a Word pStyle value to a normalized {@link ParaKind}. */
function styleToKind(style: string): ParaKind {
  const s = style.toLowerCase();
  if (/heading\s*1|^1$|title/.test(s)) return "heading1";
  if (/heading\s*2|^2$/.test(s)) return "heading2";
  if (/heading\s*3|^3$/.test(s)) return "heading3";
  if (/list/.test(s)) return "list";
  return "normal";
}

/** Map a normalized {@link ParaKind} back to a Word style id ("" for normal). */
function kindToStyle(kind: ParaKind): string {
  if (kind === "heading1") return "Heading1";
  if (kind === "heading2") return "Heading2";
  if (kind === "heading3") return "Heading3";
  if (kind === "list") return "ListParagraph";
  return "";
}

/** Extract the visible text of a `<w:p>` block, stripping leaked Word tags. */
function paragraphText(block: string): string {
  let text = "";
  for (const m of block.matchAll(WT_RE)) text += decodeXml(m[1]);
  // 防御：某些带修订/复杂 run 的 docx 会把 Word 标签残渣漏进文字，剔除之
  return text.replace(/<\/?w:[^>]*>/g, "");
}

/**
 * Parse a docx buffer into its paragraph structure.
 *
 * @param buf The docx file bytes.
 * @returns The parsed paragraphs.
 * @throws Error if `word/document.xml` is missing (not a valid docx).
 */
export async function parseDocx(buf: Buffer): Promise<ParsedDoc> {
  const { xml } = await loadDocumentXml(buf);
  const paragraphs = paragraphSpans(xml).map(({ text: block }, index): ParsedParagraph => {
    const style = block.match(PSTYLE_RE)?.[1] ?? "";
    return { index, style, kind: styleToKind(style), text: paragraphText(block) };
  });
  return { paragraphs };
}

/**
 * Replace paragraph text in the original docx and return new bytes.
 *
 * Reuses the source docx and only swaps text, so paragraph styles, lists, and
 * fonts are preserved (paragraph-level fidelity).
 *
 * @param buf The original docx.
 * @param newTexts New text aligned by paragraph index; `undefined`/missing keeps the original.
 * @returns The rebuilt docx bytes.
 * @throws Error if `word/document.xml` is missing.
 */
export async function exportDocx(
  buf: Buffer,
  newTexts: (string | undefined)[]
): Promise<Buffer> {
  const { zip, xml } = await loadDocumentXml(buf);
  const updated = replaceParagraphSpans(xml, (block, index) => {
    const newText = newTexts[index];
    return newText === undefined ? block : replaceParagraphText(block, newText);
  });
  zip.file("word/document.xml", updated);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function loadDocumentXml(buf: Buffer): Promise<{ zip: JSZip; xml: string }> {
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("不是有效的 docx：缺少 word/document.xml");
  return { zip, xml: await file.async("string") };
}

/** Top-level `<w:p>` blocks in document order; paragraphs nested in text boxes stay inside their parent. */
function paragraphSpans(xml: string): XmlSpan[] {
  const spans: XmlSpan[] = [];
  const re = /<w:p\b[^>]*\/>|<w:p\b[^>]*>|<\/w:p>/g;
  let start = -1;
  let depth = 0;

  for (const match of xml.matchAll(re)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (token === "</w:p>") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const end = index + token.length;
        spans.push({ start, end, text: xml.slice(start, end) });
        start = -1;
      }
      continue;
    }

    if (!token.endsWith("/>")) {
      if (depth === 0) start = index;
      depth += 1;
    } else if (depth === 0) {
      spans.push({ start: index, end: index + token.length, text: token });
    }
  }

  return spans;
}

function replaceParagraphSpans(xml: string, replacer: (block: string, index: number) => string): string {
  let out = "";
  let cursor = 0;
  paragraphSpans(xml).forEach((span, index) => {
    out += xml.slice(cursor, span.start) + replacer(span.text, index);
    cursor = span.end;
  });
  return out + xml.slice(cursor);
}

/**
 * Build a minimal editable docx from plain paragraphs.
 *
 * @param paragraphs Paragraphs with kind and text.
 * @returns The docx bytes.
 */
export async function createDocxFromParagraphs(
  paragraphs: { kind: ParaKind; text: string }[]
): Promise<Buffer> {
  return createDocxFromBlocks(paragraphs.map((p) => ({ type: "paragraph", ...p })));
}

/**
 * Build a docx from structured blocks: paragraphs, Word tables, and source images.
 *
 * @param blocks The ordered content blocks.
 * @returns The docx bytes.
 */
export async function createDocxFromBlocks(blocks: DocxBlock[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml());
  zip.folder("_rels")?.file(".rels", packageRelsXml());
  const word = zip.folder("word");
  const figureBlocks = blocks.filter((block): block is FigureBlock => block.type === "figure");
  // Decode sequentially so a document with several large figures cannot make
  // every image decoder allocate its full pixel buffer at the same time.
  const preparedFigures: PreparedFigure[] = [];
  for (const figure of figureBlocks) preparedFigures.push(await prepareFigure(figure));
  word?.file("document.xml", documentXml(blocks, preparedFigures));
  word?.file("styles.xml", stylesXml());
  word?.folder("_rels")?.file("document.xml.rels", documentRelsXml(preparedFigures));
  const media = word?.folder("media");
  preparedFigures.forEach((figure, index) => media?.file(`figure${index + 1}.${figure.extension}`, figure.bytes));
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Build the `word/document.xml` body from content blocks. */
function documentXml(blocks: DocxBlock[], figures: PreparedFigure[]): string {
  let figureIndex = 0;
  const body = blocks
    .map((block) => {
      if (block.type === "paragraph") {
        return paragraphXml(block.kind, block.text);
      }
      if (block.type === "table") {
        return tableBlockXml(block);
      }

      const figure = figures[figureIndex];
      figureIndex += 1;
      return figureBlockXml(block, figureIndex, figure);
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${body}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

/** Render a single paragraph as `<w:p>` XML with its style. */
function paragraphXml(kind: ParaKind, text: string): string {
  const style = kindToStyle(kind);
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${encodeXml(text)}</w:t></w:r></w:p>`;
}

/** Render a table block (optional title + bordered table + optional note) as XML. */
function tableBlockXml(table: TableBlock): string {
  const header = tableRowXml(table.columns, true);
  const rows = table.rows.map((row) => tableRowXml(row, false)).join("");
  const note = table.note ? paragraphXml("normal", table.note) : "";
  const title = table.title ? paragraphXml("heading2", table.title) : "";
  return `${title}<w:tbl>
    <w:tblPr>
      <w:tblW w:w="0" w:type="auto"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:space="0" w:color="A7B7A5"/>
        <w:left w:val="single" w:sz="4" w:space="0" w:color="A7B7A5"/>
        <w:bottom w:val="single" w:sz="4" w:space="0" w:color="A7B7A5"/>
        <w:right w:val="single" w:sz="4" w:space="0" w:color="A7B7A5"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="D7E2D4"/>
        <w:insideV w:val="single" w:sz="4" w:space="0" w:color="D7E2D4"/>
      </w:tblBorders>
    </w:tblPr>
    ${header}${rows}
  </w:tbl>${note}`;
}

/** Render one table row; header rows are shaded and bold. */
function tableRowXml(cells: string[], isHeader: boolean): string {
  const fill = isHeader ? `<w:shd w:fill="EEF6EC"/>` : "";
  const bold = isHeader ? "<w:b/>" : "";
  return `<w:tr>${cells
    .map(
      (cell) =>
        `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/>${fill}</w:tcPr><w:p><w:r><w:rPr>${bold}</w:rPr><w:t xml:space="preserve">${encodeXml(
          cell
        )}</w:t></w:r></w:p></w:tc>`
    )
    .join("")}</w:tr>`;
}

/** Render a figure block (original source image + caption) as XML. */
function figureBlockXml(figure: FigureBlock, index: number, prepared: PreparedFigure): string {
  const rid = `rIdFigure${index}`;
  const { cx, cy, extension } = prepared;
  return `<w:p><w:r><w:drawing>
  <wp:inline distT="0" distB="0" distL="0" distR="0">
    <wp:extent cx="${cx}" cy="${cy}"/>
    <wp:docPr id="${index}" name="Figure ${index}"/>
    <a:graphic>
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic>
          <pic:nvPicPr>
            <pic:cNvPr id="${index}" name="figure${index}.${extension}"/>
            <pic:cNvPicPr/>
          </pic:nvPicPr>
          <pic:blipFill>
            <a:blip r:embed="${rid}"/>
            <a:stretch><a:fillRect/></a:stretch>
          </pic:blipFill>
          <pic:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          </pic:spPr>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing></w:r></w:p>
${paragraphXml("normal", figure.caption)}`;
}

/** The `[Content_Types].xml` part declaring supported source image types. */
function contentTypesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="gif" ContentType="image/gif"/>
  <Default Extension="webp" ContentType="image/webp"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
}

/** The package-level `_rels/.rels` pointing at the main document part. */
function packageRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
}

/** The `word/_rels/document.xml.rels` linking styles and each original figure image. */
function documentRelsXml(figures: PreparedFigure[] = []): string {
  const figureRels = figures.map((figure, index) => {
    const id = index + 1;
    return `<Relationship Id="rIdFigure${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/figure${id}.${figure.extension}"/>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  ${figureRels}
</Relationships>`;
}

/** The `word/styles.xml` defining Normal and Heading1–3/List styles. */
function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:spacing w:after="240"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:rPr><w:b/><w:sz w:val="26"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:rPr><w:b/><w:sz w:val="23"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph">
    <w:name w:val="List Paragraph"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
  </w:style>
</w:styles>`;
}

/**
 * Write the full new text into a paragraph's first run and blank the rest.
 *
 * Paragraph style (pPr) and the first run's style (rPr) are preserved.
 *
 * @param block The original `<w:p>` XML.
 * @param newText The replacement text.
 * @returns The rewritten paragraph XML.
 */
function replaceParagraphText(block: string, newText: string): string {
  // 没有 <w:t> 的空段落不会被匹配，原样返回
  const encoded = encodeXml(newText);
  let seen = 0;
  return block.replace(WT_RE, (full) => {
    seen++;
    const openTag = full.slice(0, full.indexOf(">") + 1);
    // 其余 <w:t> 清空（保留标签结构）
    if (seen > 1) return `${openTag}</w:t>`;
    // 首个 <w:t> 写入全部文本，并保证 xml:space="preserve"
    const preserved = /xml:space=/.test(openTag) ? openTag : openTag.replace(/>$/, ' xml:space="preserve">');
    return `${preserved}${encoded}</w:t>`;
  });
}
