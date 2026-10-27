/**
 * 「人类感」评分 —— 纯本地、零模型调用的启发式打分。
 * Local, deterministic human-likeness score. No LLM call, no network — your text never leaves the machine.
 *
 * 输出 0–100：越高越像人类文章。附带 AI 痕迹扣分明细，方便前端展示「为什么扣分」。
 * Returns 0–100 (higher = more human-like) plus a deduction breakdown of AI tells.
 *
 * 它衡量「读起来像不像真人文章」，不是「能不能骗过检测器」——我们刻意不做后者。
 */

import type { Lang } from "../core/i18n.js";

export interface ScoreSignal {
  id: string;
  label: string;
  hits: number;
  points: number; // 该类贡献的扣分（已封顶）
  layer?: SignalLayer;
  suggestion?: string;
  examples?: SignalExample[];
}

export interface AiScore {
  score: number; // 0–100，越高越像人类文章
  level: "low" | "medium" | "high";
  signals: ScoreSignal[]; // 仅返回命中的项，按扣分降序
}

export type SignalLayer = "wording" | "sentence" | "structure" | "rhythm" | "evidence" | "format";

export interface SignalExample {
  text: string;
  start: number;
  end: number;
}

export interface DiagnosticIssue {
  id: string;
  layer: SignalLayer;
  label: string;
  hits: number;
  points: number;
  suggestion: string;
  examples: SignalExample[];
}

export interface AiDiagnosticReport extends AiScore {
  summary: string;
  issues: DiagnosticIssue[];
}

interface SignalGroup {
  id: string;
  label: string;
  layer: SignalLayer;
  suggestion: string;
  scale: number; // 密度 → 分数的放大系数
  max: number; // 该类封顶
}

interface PhraseGroup extends SignalGroup {
  phrases: string[]; // 直接子串匹配（中文）或单词匹配（英文）
  atSentenceStart?: boolean; // 仅统计句首命中
}

interface RegexGroup extends SignalGroup {
  patterns: RegExp[];
}

const ZH_PHRASES: PhraseGroup[] = [
  {
    id: "opener",
    label: "套话开头/收尾",
    layer: "structure",
    suggestion: "删掉宏大开场或万能总结，直接写具体事件、对象、判断或下一步。",
    phrases: ["综上所述", "总而言之", "总的来说", "总之", "一言以蔽之", "由此可见", "在当今", "当今社会", "在这个", "归根结底"],
    scale: 60,
    max: 26,
  },
  {
    id: "filler",
    label: "正确的废话/空泛评注",
    layer: "wording",
    suggestion: "把空泛判断换成可验证的信息：谁、何时、做了什么、造成什么结果。",
    phrases: ["值得注意的是", "值得一提的是", "不难发现", "不难看出", "显而易见", "毫无疑问", "众所周知", "不可忽视", "正因如此", "重要的是"],
    scale: 60,
    max: 22,
  },
  {
    id: "buzz",
    label: "营销黑话",
    layer: "wording",
    suggestion: "把黑话换成普通动词和具体动作，说明到底省了什么、增加了什么、谁受影响。",
    phrases: [
      "赋能",
      "新范式",
      "深度融合",
      "未来可期",
      "持续发力",
      "生态闭环",
      "降本增效",
      "底层逻辑",
      "护城河",
      "强强联合",
      "颗粒度",
      "抓手",
      "打法",
      "心智",
      "势能",
      "链路",
      "闭环",
      "方法论",
    ],
    scale: 55,
    max: 18,
  },
  {
    id: "model-catchphrase",
    label: "模型腔口头禅",
    layer: "wording",
    suggestion: "减少网感套话和情绪化万能词，改成符合作者身份的自然表达。",
    phrases: [
      "稳稳拖住",
      "先接住",
      "接住",
      "更狠一点",
      "更猛一点",
      "直接拉满",
      "一把梭",
      "给到",
      "打透",
      "说白了",
      "翻译成人话",
      "这事儿",
      "这波",
      "狠狠",
      "拿捏",
      "破防",
      "杀疯了",
      "封神",
      "天花板",
      "闭眼入",
      "不允许还有人不知道",
    ],
    scale: 70,
    max: 18,
  },
  {
    id: "connective",
    label: "机械连接词起头",
    layer: "sentence",
    suggestion: "少用“首先/其次/此外”排队，改用真实因果、转折或直接承接上一句。",
    phrases: ["此外", "然而", "因此", "首先", "其次", "再者", "最后", "与此同时", "另一方面", "综上"],
    atSentenceStart: true,
    scale: 45,
    max: 18,
  },
  {
    id: "frame",
    label: "泛化套路句式",
    layer: "sentence",
    suggestion: "把“关键在于/我们需要”这类句壳拆开，换成一个明确动作或判断。",
    phrases: ["是一种", "关键在于", "重点在于", "核心在于", "我们可以", "我们需要", "这种现象", "这一", "对于"],
    scale: 30,
    max: 14,
  },
];

const EN_PHRASES: PhraseGroup[] = [
  {
    id: "opener",
    label: "Boilerplate opener/closer",
    layer: "structure",
    suggestion: "Remove broad openings or generic closings; start with the specific claim, actor, or event.",
    phrases: ["in conclusion", "in today's", "in the modern world", "in summary", "to sum up", "all in all", "at the end of the day", "in this day and age"],
    scale: 70,
    max: 26,
  },
  {
    id: "filler",
    label: "Empty filler / hedging",
    layer: "wording",
    suggestion: "Replace filler with concrete evidence, a direct claim, or a measurable consequence.",
    phrases: ["it is worth noting", "it is important to note", "needless to say", "it goes without saying", "it cannot be denied", "undoubtedly", "without a doubt"],
    scale: 70,
    max: 22,
  },
  {
    id: "buzz",
    label: "AI buzzwords",
    layer: "wording",
    suggestion: "Swap buzzwords for plain verbs and specific details about what changed and for whom.",
    phrases: [
      "leverage",
      "empower",
      "seamless",
      "game-changer",
      "cutting-edge",
      "delve into",
      "delve",
      "tapestry",
      "testament to",
      "navigate the",
      "in the realm of",
      "ever-evolving",
      "underscore",
      "pivotal",
      "robust",
      "holistic",
      "nuanced",
      "unlock",
      "transformative",
      "foster",
      "elevate",
    ],
    scale: 55,
    max: 20,
  },
  {
    id: "connective",
    label: "Mechanical sentence-start connective",
    layer: "sentence",
    suggestion: "Vary transitions and let the logic of the previous sentence carry the next one.",
    phrases: ["moreover", "furthermore", "however", "therefore", "additionally", "firstly", "secondly", "finally", "in addition", "consequently"],
    atSentenceStart: true,
    scale: 50,
    max: 18,
  },
  {
    id: "frame",
    label: "Generic frame",
    layer: "sentence",
    suggestion: "Replace generic framing with a precise claim, example, or decision.",
    phrases: ["is a kind of", "the key is", "plays a crucial role", "plays a vital role", "when it comes to", "a wide range of"],
    scale: 35,
    max: 14,
  },
];

const PARALLEL_ZH: RegexGroup = {
  id: "parallel",
  label: "排比/对仗堆砌",
  layer: "structure",
  suggestion: "拆掉整齐排比，保留最有信息量的一组，并补一个真实例子或限制条件。",
  patterns: [
    /不仅[^。！？\n]{0,40}(而且|还|也|更)/g,
    /既[^。！？\n]{0,30}又/g,
    /无论[^。！？\n]{0,30}(还是|都)/g,
    /一方面[^。！？\n]{0,40}另一方面/g,
  ],
  scale: 60,
  max: 16,
};

const PARALLEL_EN: RegexGroup = {
  id: "parallel",
  label: "Piled-up parallelism",
  layer: "structure",
  suggestion: "Break stacked parallel phrasing into one direct claim plus a concrete example or caveat.",
  patterns: [/not only\b[^.!?\n]{0,60}\bbut also/gi, /\bboth\b[^.!?\n]{0,40}\band\b/gi],
  scale: 55,
  max: 14,
};

/** Markdown 残留：这些符号会原样进 Word，是最直接的 AI 痕迹 */
const MARKDOWN: RegexGroup = {
  id: "markdown",
  label: "Markdown 残留 / leaked Markdown",
  layer: "format",
  suggestion: "清理 Markdown 标记，改成适合 Word/公众号正文的自然排版。",
  patterns: [/^#{1,6}\s/gm, /\*\*[^*\n]+\*\*/g, /^\s*[-*]\s+/gm, /^\s*>\s/gm, /`[^`\n]+`/g],
  scale: 40,
  max: 20,
};

const SCORE_FORMULA = {
  zhUnitChars: 120,
  enUnitWords: 100,
  shortZhChars: 40,
  shortEnWords: 25,
  shortTextConfidence: 0.65,
  thresholds: { high: 70, medium: 40 },
};

interface TextRange {
  start: number;
  end: number;
}

interface ScoringSentence {
  text: string;
  start: number;
}

/** Split text into rough, trimmed sentences with their offsets (heuristic, scoring only). */
function sentenceRangesForScoring(text: string): ScoringSentence[] {
  const ranges: ScoringSentence[] = [];
  const re = /[。.!?！？;；\n]+/g;
  let start = 0;
  for (const match of text.matchAll(re)) {
    const piece = text.slice(start, match.index);
    pushScoringSentence(ranges, piece, start);
    start = (match.index ?? 0) + match[0].length;
  }
  pushScoringSentence(ranges, text.slice(start), start);
  return ranges;
}

function pushScoringSentence(out: ScoringSentence[], value: string, absoluteStart: number): void {
  const leading = value.match(/^\s*/)?.[0].length ?? 0;
  const trimmed = value.trim();
  if (trimmed) {
    out.push({ text: trimmed, start: absoluteStart + leading });
  }
}

function sortedUniquePhrases(phrases: string[]): string[] {
  return [...new Set(phrases.map((p) => p.toLowerCase()).filter(Boolean))].sort((a, b) => b.length - a.length);
}

function phraseRanges(text: string, phrases: string[]): TextRange[] {
  const haystack = text.toLowerCase();
  const ranges: TextRange[] = [];
  for (const phrase of sortedUniquePhrases(phrases)) {
    for (const range of occurrenceRanges(haystack, phrase)) {
      if (!ranges.some((r) => rangesOverlap(r, range))) ranges.push(range);
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** Non-overlapping occurrences of a non-empty `needle`, left to right. */
function occurrenceRanges(haystack: string, needle: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (let start = haystack.indexOf(needle); start >= 0; start = haystack.indexOf(needle, start + needle.length)) {
    ranges.push({ start, end: start + needle.length });
  }
  return ranges;
}

function sentenceStartPhraseRanges(text: string, phrases: string[]): TextRange[] {
  const haystack = text.toLowerCase();
  const sorted = sortedUniquePhrases(phrases);
  const ranges: TextRange[] = [];
  for (const sentence of sentenceRangesForScoring(text)) {
    const sentenceTail = text.slice(sentence.start);
    const stripped = sentenceTail.match(/^[^0-9a-z一-龥]+/i)?.[0].length ?? 0;
    const start = sentence.start + stripped;
    const head = haystack.slice(start);
    const phrase = sorted.find((p) => head.startsWith(p));
    if (phrase) ranges.push({ start, end: start + phrase.length });
  }
  return ranges;
}

function rangesOverlap(a: TextRange, b: TextRange): boolean {
  return a.start < b.end && b.start < a.end;
}

function examplesForRanges(text: string, ranges: TextRange[], limit = 3): SignalExample[] {
  return ranges.slice(0, limit).map((range) => ({
    text: text.slice(range.start, range.end),
    start: range.start,
    end: range.end,
  }));
}

/**
 * Score one phrase group as length-normalized, capped points.
 *
 * @param group The phrase group definition.
 * @param text Lowercased-internally haystack.
 * @param units Length units (per ~100–120 chars/words) for normalization.
 * @returns The group's hits and capped point contribution.
 */
function phraseGroupScore(group: PhraseGroup, text: string, units: number, claimedRanges: TextRange[]): ScoreSignal {
  const ranges = group.atSentenceStart
    ? sentenceStartPhraseRanges(text, group.phrases)
    : phraseRanges(text, group.phrases);
  const accepted: TextRange[] = [];
  for (const range of ranges) {
    if (claimedRanges.some((claimed) => rangesOverlap(claimed, range))) {
      continue;
    }
    claimedRanges.push(range);
    accepted.push(range);
  }
  return groupSignal(group, text, units, accepted);
}

/**
 * Score one regex group (parallelism, leaked Markdown) as capped points.
 *
 * @param group The regex group definition.
 * @param text Haystack.
 * @param units Length units for normalization.
 * @returns The group's hits and capped point contribution.
 */
function regexGroupScore(group: RegexGroup, text: string, units: number): ScoreSignal {
  const ranges = group.patterns.flatMap((re) =>
    Array.from(text.matchAll(re), (match): TextRange => {
      const start = match.index ?? 0;
      return { start, end: start + match[0].length };
    })
  );
  return groupSignal(group, text, units, ranges);
}

/** A group's signal: hits are its matched ranges, points are length-normalized and capped. */
function groupSignal(group: SignalGroup, text: string, units: number, ranges: TextRange[]): ScoreSignal {
  const hits = ranges.length;
  const density = hits / units;
  const points = Math.min(group.max, density * group.scale);
  return {
    id: group.id,
    label: group.label,
    layer: group.layer,
    suggestion: group.suggestion,
    examples: examplesForRanges(text, ranges),
    hits,
    points,
  };
}

const REPETITION_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "will",
  "一个", "我们", "他们", "这些", "那些", "可以", "因为", "但是",
]);

function repetitionSignal(text: string, lang: Lang, units: number): ScoreSignal {
  const tokens =
    lang === "zh"
      ? Array.from(text.matchAll(/[\u4e00-\u9fff]{2,4}/g), (m) => m[0])
      : (text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []);
  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (REPETITION_STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const repeated = [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 2), 0);
  const points = Math.min(10, (repeated / units) * 3.5);
  const exampleRanges = [...counts.entries()]
    .filter(([, count]) => count > 2)
    .sort((a, b) => b[1] - a[1])
    .flatMap(([token]) => occurrenceRanges(text, token));
  return {
    id: "repetition",
    label: lang === "zh" ? "词语重复偏多" : "Repeated wording",
    layer: "rhythm",
    suggestion: lang === "zh" ? "合并重复词，换成更具体的名词或删掉无信息重复。" : "Merge repeated wording or replace it with more specific nouns and verbs.",
    examples: examplesForRanges(text, exampleRanges),
    hits: repeated,
    points,
  };
}

function concretenessSignal(text: string, lang: Lang, units: number): ScoreSignal {
  const anchors =
    (text.match(/\d+(?:[.,]\d+)?%?/g) ?? []).length +
    (text.match(/[《"][^《》"]{2,}[》"]/g) ?? []).length +
    (text.match(/\[[0-9]+\]/g) ?? []).length +
    (lang === "en" ? (text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g) ?? []).length : 0);
  const density = anchors / units;
  const points = Math.min(8, Math.max(0, (0.45 - density) / 0.45) * 8);
  return {
    id: "concreteness",
    label: lang === "zh" ? "具体锚点不足" : "Few concrete anchors",
    layer: "evidence",
    suggestion: lang === "zh" ? "补充数字、时间、人物、来源、案例或引用，让判断有落点。" : "Add numbers, dates, names, sources, examples, or citations so claims have anchors.",
    examples: [],
    hits: anchors,
    points,
  };
}

/**
 * Penalize overly uniform sentence lengths (humans vary more; low CV is an AI tell).
 *
 * @param sentences Pre-split sentences.
 * @param lang Language (decides char vs word length).
 * @returns A signal worth up to ~12 points; 0 when there are too few sentences.
 */
function uniformitySignal(sentences: string[], lang: Lang): ScoreSignal {
  const lens = sentences
    .map((s) => (lang === "zh" ? Array.from(s).length : s.split(/\s+/).filter(Boolean).length))
    .filter((n) => n > 1);
  const label = lang === "zh" ? "句长过于均匀" : "Uniform sentence length";
  const suggestion =
    lang === "zh"
      ? "打破整齐句长：短句下判断，长句交代条件、例子或反例。"
      : "Vary sentence length: use short sentences for judgment and longer ones for context or caveats.";
  if (lens.length < 5) return { id: "uniformity", label, layer: "rhythm", suggestion, examples: [], hits: 0, points: 0 };
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
  const cv = Math.sqrt(variance) / (mean || 1); // 变异系数
  // CV 越低越均匀越像 AI。0.25 以下满扣，0.55 以上不扣。
  const norm = Math.max(0, Math.min(1, (0.55 - cv) / 0.3));
  return { id: "uniformity", label, layer: "rhythm", suggestion, examples: [], hits: 0, points: norm * 12 };
}

/**
 * Score text for human-likeness on a 0–100 scale (higher = more human-like).
 *
 * Fully local and deterministic: matches language-specific AI tells
 * (boilerplate, buzzwords, mechanical connectives, leaked Markdown,
 * parallelism, uniform sentence length), normalizes by length, caps each
 * category, and converts the AI-tell penalty into a human-likeness score.
 *
 * @param text The text to score.
 * @param lang Language selecting the pattern sets.
 * @returns The score, a coarse level, and the hit breakdown (descending).
 */
export function scoreText(text: string, lang: Lang): AiScore {
  const clean = (text ?? "").trim();
  const sentences = sentenceRangesForScoring(clean).map((s) => s.text);
  const len = lang === "zh" ? Array.from(clean).length : clean.split(/\s+/).filter(Boolean).length;
  const units = Math.max(1, len / (lang === "zh" ? SCORE_FORMULA.zhUnitChars : SCORE_FORMULA.enUnitWords));

  const groups = lang === "zh" ? ZH_PHRASES : EN_PHRASES;
  const parallel = lang === "zh" ? PARALLEL_ZH : PARALLEL_EN;
  const claimedPhraseRanges: TextRange[] = [];

  const signals: ScoreSignal[] = [
    ...groups.map((g) => phraseGroupScore(g, clean, units, claimedPhraseRanges)),
    regexGroupScore(parallel, clean, units),
    regexGroupScore(MARKDOWN, clean, units),
    uniformitySignal(sentences, lang),
    repetitionSignal(clean, lang, units),
    concretenessSignal(clean, lang, units),
  ];

  const penalty = Math.max(0, Math.min(100, signals.reduce((a, s) => a + s.points, 0)));
  const enoughText = len >= (lang === "zh" ? SCORE_FORMULA.shortZhChars : SCORE_FORMULA.shortEnWords);
  const lengthConfidence = len === 0 ? 0 : enoughText ? 1 : SCORE_FORMULA.shortTextConfidence;
  const score = Math.round(Math.max(0, Math.min(100, (100 - penalty) * lengthConfidence)));
  const level: AiScore["level"] =
    score >= SCORE_FORMULA.thresholds.high ? "high" : score >= SCORE_FORMULA.thresholds.medium ? "medium" : "low";

  const shown = signals
    .filter((s) => s.points >= 0.5)
    .sort((a, b) => b.points - a.points)
    .map((s) => ({ ...s, points: Math.round(s.points) }));

  return { score, level, signals: shown };
}

/** {@link scoreText} plus per-issue suggestions/examples and a one-line summary. */
export function diagnoseText(text: string, lang: Lang): AiDiagnosticReport {
  const evaluated = scoreText(text, lang);
  const issues = evaluated.signals.map((signal): DiagnosticIssue => ({
    id: signal.id,
    layer: signal.layer ?? "wording",
    label: signal.label,
    hits: signal.hits,
    points: signal.points,
    suggestion: signal.suggestion ?? defaultSuggestion(lang),
    examples: signal.examples ?? [],
  }));

  return {
    ...evaluated,
    summary: diagnosticSummary(evaluated.score, issues, lang),
    issues,
  };
}

function diagnosticSummary(score: number, issues: DiagnosticIssue[], lang: Lang): string {
  if (issues.length === 0) {
    return lang === "zh" ? "暂未发现明显 AI 味，文本已经比较自然。" : "No obvious AI-writing tells were found.";
  }
  const top = issues.slice(0, 3).map((issue) => issue.label).join(lang === "zh" ? "、" : ", ");
  if (lang === "zh") {
    return `当前人类感 ${score}/100，主要问题集中在：${top}。建议先处理扣分最高的几类。`;
  }
  return `Current human-likeness score is ${score}/100. Main issues: ${top}. Start with the highest-impact fixes.`;
}

function defaultSuggestion(lang: Lang): string {
  return lang === "zh" ? "删掉模板感表达，换成具体信息和自然语序。" : "Remove templated phrasing and replace it with concrete details.";
}
