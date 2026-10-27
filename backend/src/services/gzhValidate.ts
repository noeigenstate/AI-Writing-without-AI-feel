/**
 * 微信公众号 HTML 合规校验器（gzh-design-skill `validate_gzh_html.py` 的 TS 移植）。
 *
 * 把"公众号平台限制"从模型自觉变成确定性兜底：检查禁用标签/属性/样式，
 * 并核查中文文本节点是否用 `<span leaf="">` 包裹（粘贴后保持样式的关键）。
 */

export interface GzhValidation {
  /** 会被公众号编辑器过滤或导致粘贴后样式丢失的问题（必须修复）。 */
  errors: string[];
  /** 建议人工确认的问题（半角标点、局部漏包裹等）。 */
  warnings: string[];
  /** 全文 `<span leaf>` 总数。 */
  leafCount: number;
}

const FORBIDDEN: { re: RegExp; msg: string }[] = [
  { re: /<style[\s>]/gi, msg: "<style> 标签会被过滤，样式必须内联" },
  { re: /<script[\s>]/gi, msg: "<script> 标签会被过滤" },
  { re: /<\/?div[\s>]/gi, msg: "<div> 会被改写，请用 <section>" },
  { re: /<link[\s>]/gi, msg: "外部 <link>（CSS/字体）会被过滤" },
  { re: /\sclass\s*=/gi, msg: "class 属性会被剥离，请用内联 style" },
  { re: /\sid\s*=/gi, msg: "id 属性会被剥离" },
  { re: /position\s*:\s*(fixed|absolute|sticky)/gi, msg: "position fixed/absolute/sticky 不被支持" },
  { re: /float\s*:/gi, msg: "float 不被支持" },
  { re: /@media/gi, msg: "@media 媒体查询不被支持" },
  { re: /@keyframes/gi, msg: "@keyframes 动画不被支持" },
  { re: /@import/gi, msg: "@import 不被支持" },
  { re: /display\s*:\s*grid/gi, msg: "display:grid 不被支持，请用 flex" },
  { re: /var\s*\(\s*--/gi, msg: "CSS 变量 var(--x) 不被支持，请写死值" },
  { re: /url\s*\(\s*['"]?https?:\/\/[^)]*\.(woff2?|ttf|otf|eot)/gi, msg: "外部字体不被支持" },
];

const CJK = /[㐀-䶿一-鿿]/;
/** 中文字后紧跟半角逗号/分号/叹号/问号（应改全角）；只查"中文在前"避免中英混排误伤。 */
const HALF_PUNCT = /[㐀-䶿一-鿿][,;!?]/;
const ASCII_QUOTE = /["']/;
/** 代码区特征：等宽字体或 white-space:pre —— 其内半角符号是正常的。 */
const CODE_STYLE = /monospace|white-space\s*:\s*pre|courier|consolas|sf mono/i;
/** 不参与公众号正文粘贴的区域。 */
const SKIP_TAGS = new Set(["head", "title", "style", "script"]);
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** 注释或任意标签；标签属性值里允许出现 `>` 之外的引号内容。 */
const TOKEN_RE = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g;

interface StackEntry {
  tag: string;
  isLeaf: boolean;
  isCode: boolean;
}

/** `<span leaf>` 包裹扫描结果（对应 Python 版 LeafChecker）。 */
interface LeafScan {
  leafCount: number;
  unwrapped: { snippet: string; parent: string }[];
  halfPunct: string[];
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * 校验一段公众号正文 HTML。
 *
 * @param html 待校验的 HTML（正文片段或整页均可）。
 * @returns 错误/警告清单与 `<span leaf>` 计数；`errors` 非空即不可交付。
 */
export function validateGzhHtml(html: string): GzhValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const { re, msg } of FORBIDDEN) {
    const hits = html.match(re)?.length ?? 0;
    if (hits) errors.push(`${msg}（命中 ${hits} 处）`);
  }

  const { leafCount, unwrapped, halfPunct } = scanLeafWrapping(html);
  if (CJK.test(html) && leafCount === 0) {
    errors.push('全文没有任何 <span leaf=""> 包裹——粘贴到公众号后样式会大面积丢失');
  } else if (unwrapped.length) {
    const sample = unwrapped
      .slice(0, 5)
      .map((u) => `「${u.snippet}」(在 <${u.parent}> 内)`)
      .join("；");
    warnings.push(`${unwrapped.length} 处中文文本未被 <span leaf> 包裹，样式可能丢失。例：${sample}`);
  }

  if (halfPunct.length) {
    const sample = halfPunct.slice(0, 5).map((s) => `「${s}」`).join("；");
    warnings.push(
      `${halfPunct.length} 处正文疑似半角标点/英文引号，应改中文全角（代码块内不计）。例：${sample}`
    );
  }

  return { errors, warnings, leafCount };
}

/** 按标签栈逐 token 扫描：统计 `<span leaf>`，收集未包裹的中文与代码区外的半角标点。 */
function scanLeafWrapping(html: string): LeafScan {
  const scan: LeafScan = { leafCount: 0, unwrapped: [], halfPunct: [] };
  const stack: StackEntry[] = [];
  let last = 0;
  for (const m of html.matchAll(TOKEN_RE)) {
    if (m.index > last) recordText(html.slice(last, m.index), stack, scan);
    last = m.index + m[0].length;
    const token = m[0];
    if (token.startsWith("<!--")) continue;
    if (token.startsWith("</")) {
      // 关闭最近的同名标签，并丢弃其内未闭合的子标签
      const open = stack.map((s) => s.tag).lastIndexOf(tagName(token.slice(2)));
      if (open >= 0) stack.splice(open);
      continue;
    }

    const tag = tagName(token.slice(1));
    const isLeaf = tag === "span" && /\sleaf(?:\s*=|[\s/>])/i.test(token);
    const style = token.match(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i);
    const isCode = CODE_STYLE.test(style?.[2] ?? style?.[3] ?? "");
    if (isLeaf) scan.leafCount += 1;
    if (VOID_TAGS.has(tag) || /\/>$/.test(token)) continue;
    stack.push({ tag, isLeaf, isCode });
  }
  if (last < html.length) recordText(html.slice(last), stack, scan);
  return scan;
}

function tagName(rest: string): string {
  return rest.match(/^[a-zA-Z][\w-]*/)?.[0]?.toLowerCase() ?? "";
}

function recordText(raw: string, stack: readonly StackEntry[], scan: LeafScan): void {
  const text = decodeEntities(raw).trim();
  if (!text || !CJK.test(text)) return;
  if (stack.some((s) => SKIP_TAGS.has(s.tag))) return;
  const snippet = text.length > 24 ? `${text.slice(0, 24)}…` : text;
  if (!stack.some((s) => s.isLeaf)) {
    scan.unwrapped.push({ snippet, parent: stack.at(-1)?.tag ?? "(root)" });
  }
  if (!stack.some((s) => s.isCode) && (HALF_PUNCT.test(text) || ASCII_QUOTE.test(text))) {
    scan.halfPunct.push(snippet);
  }
}
