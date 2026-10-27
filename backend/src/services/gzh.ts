/**
 * 微信公众号排版引擎（整合自 gzh-design-skill，AGPL-3.0，见 assets/gzh/LICENSE）。
 *
 * 把 Markdown 文章转换为可直接粘贴进公众号编辑器、粘贴后样式不丢失的 HTML：
 * 主题组件库（assets/gzh/theme-*.md）+ 通用增量库作为提示词素材，按章节分块
 * 生成、逐块校验（{@link validateGzhHtml}）并对违规块做一轮自动修复，最后统一
 * 包进该主题的全局容器。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chat } from "./llm.js";
import { validateGzhHtml, type GzhValidation } from "./gzhValidate.js";
import type { Lang } from "../core/i18n.js";

/** 一套已注册的排版主题（对应 assets/gzh/theme-index.md 的一行）。 */
export interface GzhTheme {
  id: string;
  name: { en: string; zh: string };
  /** 主色（前端色卡展示用）。 */
  primary: string;
  /** 点缀色（可选，前端色卡展示用）。 */
  accent?: string;
  scene: { en: string; zh: string };
  /** 组件库文件名（assets/gzh/ 下）。 */
  file: string;
  /** 正文关键词下划线 CSS（theme-index 为单一权威来源）。 */
  underline: string;
}

/** 主题清单，与 assets/gzh/theme-index.md 保持同步；首个为默认推荐。 */
export const GZH_THEMES: GzhTheme[] = [
  {
    id: "moyu-green",
    name: { zh: "翡翠清新", en: "Emerald Fresh" },
    primary: "#059669",
    scene: {
      zh: "教程、测评、清单、工具盘点（信息密度高，默认推荐）",
      en: "Tutorials, reviews, checklists, tool roundups (info-dense; default)",
    },
    file: "theme-moyu-green.md",
    underline: "border-bottom:2px solid #A7F3D0;font-weight:600;",
  },
  {
    id: "red-white",
    name: { zh: "红白杂志", en: "Red Editorial" },
    primary: "#DC2626",
    scene: {
      zh: "深度分析、观点、力量感话题（经典编辑风，红色克制点睛）",
      en: "Deep analysis and opinion pieces (classic editorial, restrained red)",
    },
    file: "theme-red-white.md",
    underline: "border-bottom:2px solid #FECACA;font-weight:600;",
  },
  {
    id: "graphite-minimal",
    name: { zh: "石墨极简", en: "Graphite Minimal" },
    primary: "#52525B",
    scene: {
      zh: "设计、科技评论、专业观点、高端品牌（极简克制、全灰阶）",
      en: "Design and tech commentary, premium brands (minimal, all-gray)",
    },
    file: "theme-graphite-minimal.md",
    underline: "border-bottom:2px solid #52525B;font-weight:600;",
  },
  {
    id: "zen-whitespace",
    name: { zh: "禅意留白", en: "Zen Whitespace" },
    primary: "#4A5D52",
    scene: {
      zh: "禅意冥想、极简生活、深度随笔（呼吸感最强）",
      en: "Mindful essays and minimal living (maximum breathing room)",
    },
    file: "theme-zen-whitespace.md",
    underline: "border-bottom:1.5px solid #B5C8BC;font-weight:500;",
  },
  {
    id: "moyu-ticket",
    name: { zh: "创意票据", en: "Ticket Stub" },
    primary: "#059669",
    scene: {
      zh: "测评、工具对比、创意评测（票据视觉隐喻，星级+硬阴影卡片）",
      en: "Reviews and tool comparisons (ticket-stub metaphor, star ratings)",
    },
    file: "theme-moyu-ticket.md",
    underline: "border-bottom:2px solid #A7F3D0;font-weight:600;",
  },
  {
    id: "olive-journal",
    name: { zh: "橄榄内刊", en: "Olive Journal" },
    primary: "#1e1f23",
    accent: "#ed7b2f",
    scene: {
      zh: "内刊手记、深度评测、案例复盘（编辑部内刊质感，信息密度偏高）",
      en: "Journal-style deep dives and case retrospectives (editorial zine feel)",
    },
    file: "theme-olive-journal.md",
    underline: "border-bottom:2px solid #ed7b2f;font-weight:600;",
  },
];

/** 前端主题卡片 DTO。 */
export interface GzhThemeDTO {
  id: string;
  name: string;
  primary: string;
  accent?: string;
  scene: string;
}

/** 列出可选主题（本地化名称与适用场景）。 */
export function listGzhThemes(lang: Lang): GzhThemeDTO[] {
  return GZH_THEMES.map((t) => ({
    id: t.id,
    name: t.name[lang],
    primary: t.primary,
    accent: t.accent,
    scene: t.scene[lang],
  }));
}

export interface GzhFormatInput {
  markdown: string;
  themeId: string;
  /** 署名；留空则省略文末签名区。 */
  author?: string;
  lang: Lang;
}

export interface GzhFormatResult {
  /** 干净正文片段（`<section>…</section>`，可直接粘贴/包预览壳）。 */
  html: string;
  title: string;
  themeId: string;
  themeName: string;
  validation: GzhValidation;
}

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "gzh");
const assetCache = new Map<string, string>();

function readAsset(file: string): string {
  let text = assetCache.get(file);
  if (text === undefined) {
    text = readFileSync(path.join(ASSET_DIR, file), "utf8");
    assetCache.set(file, text);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Markdown 结构解析
// ---------------------------------------------------------------------------

interface GzhSection {
  /** `##` 章节标题；无标题的开场正文为 undefined。 */
  heading?: string;
  body: string;
}

interface GzhArticleStructure {
  title: string;
  /** 开头引言（首个 `>` 块），无则为 ""。 */
  intro: string;
  sections: GzhSection[];
}

/** 解析 Markdown 为 标题/引言/章节 结构；纯文本时把首行当标题。 */
export function parseGzhStructure(markdown: string): GzhArticleStructure {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let title = "";
  let intro = "";
  const sections: GzhSection[] = [];
  let current: GzhSection = { body: "" };
  let seenContent = false;

  const pushCurrent = () => {
    current.body = current.body.trim();
    if (current.heading !== undefined || current.body) sections.push(current);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!title && /^#\s+/.test(trimmed)) {
      title = trimmed.replace(/^#\s+/, "").trim();
      continue;
    }
    if (!seenContent && !intro && /^>\s?/.test(trimmed) && trimmed.replace(/^>\s?/, "")) {
      // 收集开头连续的引用块作为引言
      const quote: string[] = [];
      let j = i;
      while (j < lines.length && /^>\s?/.test(lines[j].trim())) {
        quote.push(lines[j].trim().replace(/^>\s?/, ""));
        j++;
      }
      intro = quote.join("\n").trim();
      i = j - 1;
      continue;
    }
    if (/^##\s+/.test(trimmed)) {
      pushCurrent();
      current = { heading: trimmed.replace(/^##\s+/, "").trim(), body: "" };
      seenContent = true;
      continue;
    }
    if (trimmed) seenContent = true;
    current.body += `${line}\n`;
  }
  pushCurrent();

  if (!title) {
    // 纯文本输入：首个非空短行当标题，否则留空由调用方兜底
    const first = sections[0]?.body.split("\n").find((l) => l.trim());
    if (first && first.trim().length <= 60 && sections[0]) {
      title = first.trim().replace(/^#+\s*/, "");
      sections[0].body = sections[0].body.replace(first, "").trim();
      if (!sections[0].body && sections[0].heading === undefined) sections.shift();
    }
  }
  return { title: title || "未命名文章", intro, sections };
}

// ---------------------------------------------------------------------------
// 分块计划
// ---------------------------------------------------------------------------

interface GzhChunk {
  /** 交给模型的任务说明。 */
  task: string;
  /** 本块对应的 Markdown 内容（可为空，如纯封面块）。 */
  md: string;
}

const MAX_CHUNK_CHARS = 1800;

/** 把过长章节正文按空行拆成 ≤{@link MAX_CHUNK_CHARS} 的块。 */
function splitBody(body: string): string[] {
  if (body.length <= MAX_CHUNK_CHARS) return [body];
  const blocks = body.split(/\n{2,}/);
  const out: string[] = [];
  let cur = "";
  for (const b of blocks) {
    if (cur && cur.length + b.length + 2 > MAX_CHUNK_CHARS) {
      out.push(cur);
      cur = b;
    } else {
      cur = cur ? `${cur}\n\n${b}` : b;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const CONCLUSION_RE = /总结|结语|最后|写在最后|尾声|小结|结论|展望/;

function buildChunks(doc: GzhArticleStructure, author: string): GzhChunk[] {
  const chunks: GzhChunk[] = [];
  const numbered = doc.sections.filter((s) => s.heading !== undefined);

  chunks.push({
    task:
      "生成文章开篇：按主题库骨架依次生成封面/头图组件（填入文章标题）" +
      (numbered.length >= 2 ? "、目录/导读组件（若主题库有：从全部章节中精选最多 3 个核心看点，不是全量列表）" : "") +
      (doc.intro
        ? "、开头引言卡（填入下方引言内容，识别其中核心词做高亮标记；署名按文章作者，没有明确作者就省略落款）"
        : "") +
      "。只生成这些开篇组件，不要生成章节正文。",
    md: doc.intro,
  });

  let num = 0;
  doc.sections.forEach((section, idx) => {
    const isLast = idx === doc.sections.length - 1;
    if (section.heading === undefined) {
      for (const part of splitBody(section.body)) {
        chunks.push({
          task: "生成一段无章节标题的正文：按映射规则逐段转换，不要生成章节标题组件、封面或签名。",
          md: part,
        });
      }
      return;
    }
    num += 1;
    const label = String(num).padStart(2, "0");
    const conclusion = isLast && CONCLUSION_RE.test(section.heading);
    const parts = splitBody(section.body);
    parts.forEach((part, pi) => {
      const head =
        pi === 0
          ? `生成第 ${num} 章：章节标题「${section.heading}」用主题库章节标题组件，编号 ${
              conclusion ? "用主题库的结语编号变体（如 ∞；主题库未指定变体则用 " + label + "）" : label
            }，有英文标签槽位时配贴切的英文标签。然后按映射规则转换本章正文。`
          : `继续第 ${num} 章「${section.heading}」的正文（章节标题组件已生成过，不要重复），按映射规则逐段转换。`;
      chunks.push({ task: `${head}不要生成封面、目录或签名。`, md: part });
    });
  });

  if (author) {
    chunks.push({
      task:
        `生成文末作者签名区（全文仅此一处）：用主题库的签名/结尾组件，署名「${author}」，` +
        "第一句作者介绍围绕署名展开，第二句保留互动引导（点赞、在看、转发三连）。不要再生成其它内容。",
      md: "",
    });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// 提示词与装配
// ---------------------------------------------------------------------------

function buildSystemPrompt(theme: GzhTheme): string {
  const themeMd = readAsset(theme.file);
  const commonMd = readAsset("common-components.md");
  return [
    "你是微信公众号文章排版引擎。任务：把给定的 Markdown 片段转换为可直接粘贴进公众号编辑器、粘贴后样式不丢失的 HTML 片段。",
    "",
    "【平台红线（违反即失败）】",
    "- 禁止：<style>/<script>/<div>/<link>、class/id 属性、position:fixed/absolute/sticky、float、@media/@keyframes/@import、display:grid、CSS 变量 var(--x)、外部字体。",
    '- 必须：所有样式内联 style；所有文字节点都用 <span leaf="">文字</span> 包裹（漏包裹＝粘贴后样式丢失）。',
    "- 可用：display:flex（有限）、linear-gradient、border-radius、box-shadow、<section>/<p>/<span>/<strong>/<img>/<h3>。",
    "",
    "【排版规则】",
    "1. HTML 一律取用下方组件库并按其映射规则填充，不要凭记忆手写新组件；只用本主题 + 通用增量库，不跨主题混用。",
    `2. 正文关键词下划线（核心特色）：每个正文段落找出 1–3 个最重要短语（4–15 字），用 <span style="${theme.underline}"> 标记；优先核心观点、结论、关键数据、专有名词；整段无要点可不标。`,
    "3. 最强锚点（主色加粗/深底白字）全文 ≤5 处，不要滥用。",
    "4. 中文全角标点：正文一律用，。！？：；“”‘’（）——…，不用半角 , . ! ? ; 和英文直引号；代码块/行内代码/URL/英文专名内部保持原样。",
    "5. 图片 <img> 一律 max-width:100%;height:auto;display:block;margin:0 auto，不要 width:100%；只有真给了说明文字才生成说明组件；不要编造图片 URL；【插入…】等待补素材用通用库 2c 居中占位板块。",
    '6. 代码/命令/Prompt 用通用库代码块组件：每行一个 <p style="margin:0">，禁用 white-space:pre，缩进用全角空格。',
    "7. 强调小标题用小标签/左竖条（通用库 3a–3e），不要用四周虚线框；主题库明确定义的虚线组件除外。",
    "8. 不得增删原文实质内容：每个段落、每张图、每个列表项都要转换，不得遗漏。",
    "9. 组件里的示例文案（作者名如“摸鱼小李/甲木”、示例日期、示例标签等）必须替换成本文实际信息：日期用【文章信息】给的当前日期；没有提供署名就删掉作者栏/署名元素，绝不保留示例人名。",
    "",
    "【输出格式】只输出 HTML 片段本身：不要 Markdown 代码围栏，不要任何解释文字，不要 <!DOCTYPE>/<html>/<head>/<body>，也不要主题的全局容器（外层容器由系统统一包裹）。",
    "",
    `【主题组件库：${theme.name.zh}】`,
    themeMd,
    "",
    "【通用增量组件库（代码块 / 图片·GIF / 小标签，换成本主题主色使用）】",
    commonMd,
  ].join("\n");
}

function buildChunkPrompt(doc: GzhArticleStructure, chunk: GzhChunk, author: string): string {
  const headings = doc.sections
    .filter((s) => s.heading !== undefined)
    .map((s, i) => `${String(i + 1).padStart(2, "0")} ${s.heading}`)
    .join(" / ");
  const now = new Date();
  const date = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}`;
  return [
    "【文章信息】",
    `标题：${doc.title}`,
    headings ? `全部章节：${headings}` : "（本文无章节标题）",
    `当前日期：${date}`,
    author ? `署名：${author}` : "署名：（未提供——删除组件中的作者栏/署名元素，不要用示例人名）",
    "",
    `【本次任务】${chunk.task}`,
    chunk.md ? `\n【本段 Markdown】\n${chunk.md}` : "",
  ].join("\n");
}

/** A deliberately small SVG subset used by the bundled local themes. */
const SVG_GZH_TAGS = new Set([
  "svg",
  "circle",
  "ellipse",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "text",
  "tspan",
]);
const SAFE_GZH_TAGS = new Set([
  "a",
  "br",
  "code",
  "em",
  "figcaption",
  "figure",
  "h3",
  "h4",
  "hr",
  "img",
  "li",
  "p",
  "section",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
  ...SVG_GZH_TAGS,
]);
const VOID_GZH_TAGS = new Set(["br", "hr", "img"]);
const SAFE_GLOBAL_ATTRIBUTES = new Set(["style", "role", "aria-hidden", "aria-label"]);
const SAFE_SVG_ATTRIBUTES = new Set([
  "cx",
  "cy",
  "d",
  "fill",
  "font-family",
  "font-size",
  "font-weight",
  "height",
  "letter-spacing",
  "points",
  "r",
  "rx",
  "ry",
  "stroke",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-width",
  "text-anchor",
  "viewbox",
  "width",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2",
]);
const SAFE_STYLE_PROPERTIES = new Set([
  "align-items",
  "align-self",
  "background",
  "background-color",
  "border",
  "border-bottom",
  "border-bottom-color",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-bottom-style",
  "border-bottom-width",
  "border-collapse",
  "border-color",
  "border-left",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-radius",
  "border-right",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-style",
  "border-top",
  "border-top-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-top-style",
  "border-top-width",
  "border-width",
  "box-shadow",
  "box-sizing",
  "color",
  "cursor",
  "display",
  "flex",
  "flex-basis",
  "flex-direction",
  "flex-grow",
  "flex-shrink",
  "flex-wrap",
  "font-family",
  "font-size",
  "font-style",
  "font-variant-numeric",
  "font-weight",
  "gap",
  "height",
  "justify-content",
  "letter-spacing",
  "line-height",
  "list-style-type",
  "list-style-position",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-height",
  "max-width",
  "min-height",
  "min-width",
  "opacity",
  "overflow",
  "overflow-wrap",
  "overflow-x",
  "overflow-y",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "position",
  "text-align",
  "text-decoration",
  "text-indent",
  "text-overflow",
  "text-shadow",
  "text-transform",
  "transform",
  "transform-origin",
  "vertical-align",
  "-webkit-overflow-scrolling",
  "white-space",
  "width",
  "word-break",
  "word-spacing",
  "writing-mode",
]);

/**
 * Deterministically reduce model-authored HTML to the subset used by the
 * bundled WeChat themes. Unknown elements/attributes are dropped; URLs and
 * CSS are independently checked so prompt injection cannot create executable
 * HTML in the preview or downloaded file.
 */
export function sanitizeGzhHtml(raw: string): string {
  const out: string[] = [];
  let cursor = 0;

  while (cursor < raw.length) {
    const tagStart = raw.indexOf("<", cursor);
    if (tagStart < 0) {
      out.push(raw.slice(cursor).replace(/\0/g, ""));
      break;
    }
    out.push(raw.slice(cursor, tagStart).replace(/\0/g, ""));

    if (raw.startsWith("<!--", tagStart)) {
      const commentEnd = raw.indexOf("-->", tagStart + 4);
      cursor = commentEnd < 0 ? raw.length : commentEnd + 3;
      continue;
    }

    const tagEnd = findHtmlTagEnd(raw, tagStart + 1);
    if (tagEnd < 0) {
      out.push("&lt;");
      cursor = tagStart + 1;
      continue;
    }

    const token = raw.slice(tagStart + 1, tagEnd);
    const closing = token.match(/^\s*\/\s*([a-zA-Z][\w-]*)\s*$/);
    if (closing) {
      const tag = closing[1].toLowerCase();
      if (SAFE_GZH_TAGS.has(tag) && !VOID_GZH_TAGS.has(tag)) out.push(`</${tag}>`);
      cursor = tagEnd + 1;
      continue;
    }

    const opening = token.match(/^\s*([a-zA-Z][\w-]*)([\s\S]*)$/);
    if (!opening) {
      out.push(escapeHtmlToken(raw.slice(tagStart, tagEnd + 1)));
      cursor = tagEnd + 1;
      continue;
    }

    const tag = opening[1].toLowerCase();
    if (SAFE_GZH_TAGS.has(tag)) {
      const selfClosing = /\/\s*$/.test(opening[2]);
      const attributes = sanitizeGzhAttributes(tag, opening[2].replace(/\/\s*$/, ""));
      const suffix = selfClosing && SVG_GZH_TAGS.has(tag) ? " /" : "";
      out.push(`<${tag}${attributes}${suffix}>`);
    }
    cursor = tagEnd + 1;
  }

  return out.join("").trim();
}

function findHtmlTagEnd(raw: string, from: number): number {
  let quote = "";
  for (let i = from; i < raw.length; i += 1) {
    const char = raw[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

function sanitizeGzhAttributes(tag: string, raw: string): string {
  const attributes: string[] = [];
  const seen = new Set<string>();
  let cursor = 0;

  while (cursor < raw.length) {
    cursor = skipSpaces(raw, cursor);
    if (cursor >= raw.length) break;

    const originalName = raw.slice(cursor).match(/^([^\s=/>]+)/)?.[1];
    if (!originalName) {
      cursor += 1;
      continue;
    }
    const name = originalName.toLowerCase();
    cursor = skipSpaces(raw, cursor + originalName.length);

    let value = "";
    if (raw[cursor] === "=") {
      const parsed = readAttributeValue(raw, skipSpaces(raw, cursor + 1));
      // An unterminated quoted value drops it and every attribute after it.
      if (!parsed) break;
      value = parsed.value;
      cursor = parsed.end;
    }

    if (seen.has(name)) continue;
    const safe = sanitizeGzhAttribute(tag, name, value);
    if (safe === undefined) continue;
    seen.add(name);
    const outputName = name === "viewbox" ? "viewBox" : name;
    attributes.push(`${outputName}="${escapeHtmlAttribute(safe)}"`);
  }
  return attributes.length ? ` ${attributes.join(" ")}` : "";
}

function skipSpaces(raw: string, cursor: number): number {
  let next = cursor;
  while (/\s/.test(raw[next] ?? "")) next += 1;
  return next;
}

/** Read a quoted or bare attribute value at `cursor`; undefined when a quote is never closed. */
function readAttributeValue(raw: string, cursor: number): { value: string; end: number } | undefined {
  const quote = raw[cursor];
  if (quote === '"' || quote === "'") {
    const close = raw.indexOf(quote, cursor + 1);
    return close < 0 ? undefined : { value: raw.slice(cursor + 1, close), end: close + 1 };
  }
  const value = raw.slice(cursor).match(/^[^\s>]+/)?.[0] ?? "";
  return { value, end: cursor + (value.length || 1) };
}

function sanitizeGzhAttribute(tag: string, name: string, value: string): string | undefined {
  if (name.startsWith("on") || name === "class" || name === "id") return undefined;
  if (name === "style") return sanitizeInlineStyle(value) || undefined;
  if (tag === "span" && (name === "leaf" || name === "nodeleaf")) return "";
  if (tag === "section" && name === "mp-style-type") return value.slice(0, 80);
  if (SAFE_GLOBAL_ATTRIBUTES.has(name)) return value.slice(0, 500);
  // Model-authored image URLs are never fetched in the formatter. Removing
  // `src` prevents generated previews/downloads from becoming tracking or
  // DNS-rebinding request gadgets; the application supplies no trusted image
  // URL through this model-output channel.
  if (tag === "img" && name === "src") return undefined;
  if (tag === "img" && (name === "alt" || name === "width" || name === "height")) return value.slice(0, 500);
  if (tag === "a" && name === "href") return sanitizeUrl(value, true);
  if (tag === "a" && name === "title") return value.slice(0, 500);
  if (SVG_GZH_TAGS.has(tag) && SAFE_SVG_ATTRIBUTES.has(name)) {
    if ((name === "fill" || name === "stroke") && isDangerousCss(value)) return undefined;
    return value.slice(0, 2_000);
  }
  return undefined;
}

function sanitizeUrl(value: string, allowContactProtocols: boolean): string | undefined {
  const decoded = decodeHtmlForSecurity(value).trim();
  const compact = decoded.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
  if (!compact || compact.startsWith("//")) return undefined;
  if (compact.startsWith("#") || compact.startsWith("/") || compact.startsWith("./") || compact.startsWith("../")) {
    return decoded.slice(0, 2_000);
  }
  const scheme = compact.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (!scheme) return undefined;
  const allowed = allowContactProtocols ? new Set(["http", "https", "mailto", "tel"]) : new Set(["http", "https"]);
  return allowed.has(scheme) ? decoded.slice(0, 2_000) : undefined;
}

function sanitizeInlineStyle(style: string): string {
  const safe: string[] = [];
  // Decode entities before declaration splitting: otherwise `&#x75;rl(...)`
  // would be split at the entity semicolon before the URL check sees it.
  for (const declaration of decodeHtmlForSecurity(style).split(";")) {
    const separator = declaration.indexOf(":");
    if (separator <= 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!SAFE_STYLE_PROPERTIES.has(property) || !value || isDangerousCss(value)) continue;
    if (property === "position" && value.toLowerCase() !== "relative") continue;
    if (property === "display" && !/^(?:block|inline|inline-block|flex|inline-flex|table|table-row|table-cell)$/i.test(value)) {
      continue;
    }
    safe.push(`${property}:${value}`);
  }
  return safe.join(";");
}

function isDangerousCss(value: string): boolean {
  const normalized = decodeCssEscapes(decodeHtmlForSecurity(value))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .toLowerCase();
  return /(?:url\s*\(|image-set\s*\(|expression\s*\(|@import|(?:https?|ftps?|wss?|javascript|vbscript|data|file|behavior)\s*:|-moz-binding)/i.test(
    normalized
  );
}

function decodeCssEscapes(value: string): string {
  return value
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\([^\r\n])/g, "$1");
}

const SECURITY_NAMED_ENTITIES: Record<string, string> = { colon: ":", tab: "\t", newline: "\n", amp: "&" };

function decodeHtmlForSecurity(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded
      .replace(/&#x([0-9a-f]+);?/gi, (_match, hex: string) => safeCodePoint(hex, 16))
      .replace(/&#([0-9]+);?/g, (_match, decimal: string) => safeCodePoint(decimal, 10))
      .replace(/&(colon|tab|newline|amp);/gi, (_match, entity: string) => SECURITY_NAMED_ENTITIES[entity.toLowerCase()]);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function safeCodePoint(value: string, radix: number): string {
  const point = Number.parseInt(value, radix);
  return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlToken(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 剥掉模型可能带上的围栏/文档外壳/解释文字，再执行 HTML 白名单净化。 */
function sanitizeChunkHtml(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/, "").trim();
  s = s.replace(/<\/?(?:!DOCTYPE|html|head|body)[^>]*>/gi, "");
  const first = s.indexOf("<");
  const lastIdx = s.lastIndexOf(">");
  if (first > 0) s = s.slice(first);
  if (lastIdx >= 0 && lastIdx < s.length - 1) s = s.slice(0, lastIdx + 1);
  return sanitizeGzhHtml(s.trim());
}

/** 从主题库"组件 1 全局容器"取容器首尾；取不到则用中性兜底容器。 */
function extractContainer(theme: GzhTheme): { open: string; close: string } {
  const md = readAsset(theme.file);
  const m = md.match(/##[^\n]*全局容器[\s\S]*?```html\s*\n([\s\S]*?)```/);
  if (m) {
    const html = m[1].trim();
    const cm = html.match(/^([\s\S]*?)<!--[\s\S]*?-->([\s\S]*)$/);
    if (cm && cm[1].trim() && cm[2].trim()) {
      return { open: cm[1].trim(), close: cm[2].trim() };
    }
  }
  return {
    open:
      '<section style="max-width:677px;margin:0 auto;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Hiragino Sans GB\',\'Microsoft YaHei\',sans-serif;color:#374151;line-height:1.75;letter-spacing:0.5px;overflow-x:hidden;">',
    close: "</section>",
  };
}

/** 生成一块 HTML；校验有错时请模型修一轮，修复版违规不增加才采用。 */
async function renderChunk(prompt: string, system: string, lang: Lang): Promise<string> {
  const html = sanitizeChunkHtml(await chat(prompt, { system, temperature: 0.4 }));
  if (!html) throw new Error(lang === "zh" ? "模型返回为空，请重试" : "Model returned empty output; try again.");
  const check = validateGzhHtml(html);
  if (!check.errors.length) return html;

  const fixed = sanitizeChunkHtml(
    await chat(
      [
        "下面这段公众号 HTML 违反了平台规则，请修复后重新输出完整 HTML 片段（不要解释、不要围栏）：",
        ...check.errors.map((e) => `- ${e}`),
        "",
        html,
      ].join("\n"),
      { system, temperature: 0.2 }
    )
  );
  return fixed && validateGzhHtml(fixed).errors.length <= check.errors.length ? fixed : html;
}

const MAX_INPUT_CHARS = 30_000;

/**
 * 把一篇 Markdown 文章排版为公众号 HTML。
 *
 * 按章节分块调用模型（主题组件库进 system 提示词，可被服务端前缀缓存命中），
 * 每块先剥壳再校验，违规块做一轮修复；最后包全局容器并整体复检。
 *
 * @throws Error 当输入为空/超长、主题不存在、或模型返回空时。
 */
export async function formatGzhArticle(input: GzhFormatInput): Promise<GzhFormatResult> {
  const markdown = input.markdown.trim();
  if (!markdown) throw new Error(input.lang === "zh" ? "请输入要排版的文章内容" : "Article content is empty.");
  if (markdown.length > MAX_INPUT_CHARS) {
    throw new Error(
      input.lang === "zh"
        ? `文章过长（${markdown.length} 字），请控制在 ${MAX_INPUT_CHARS} 字以内`
        : `Article too long (${markdown.length} chars); keep it under ${MAX_INPUT_CHARS}.`
    );
  }
  const theme = GZH_THEMES.find((t) => t.id === input.themeId) ?? GZH_THEMES[0];
  const doc = parseGzhStructure(markdown);
  const author = input.author?.trim() ?? "";
  const chunks = buildChunks(doc, author);
  const system = buildSystemPrompt(theme);

  const rendered: string[] = [];
  for (const chunk of chunks) {
    rendered.push(await renderChunk(buildChunkPrompt(doc, chunk, author), system, input.lang));
  }

  const container = extractContainer(theme);
  const body = sanitizeGzhHtml(
    `${container.open}\n${rendered.join("\n")}\n${container.close}`
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\n{3,}/g, "\n\n")
  );
  const validation = validateGzhHtml(body);
  return {
    html: body,
    title: doc.title,
    themeId: theme.id,
    themeName: theme.name[input.lang],
    validation,
  };
}
