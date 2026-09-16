import { chat, type ChatOptions } from "./llm.js";
import { parseJson } from "../lib/json.js";
import { lessAiToneCleanupPrompt } from "../prompts/lessAiTone.prompts.js";
import type { GeneratedArticle, ArticleSectionBreak } from "./article.js";

type AskFn = (prompt: string, options?: ChatOptions) => Promise<string>;
type LessAiToneRuleId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

interface LessAiToneChange {
  paragraphIndex: number;
  ruleIds: LessAiToneRuleId[];
  text: string;
}

const RULE_IDS = new Set<LessAiToneRuleId>([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const REVERSAL = /(?:不是|并非|不在于)[^，。！？\n]{1,30}[，,]?(?:而是|而在于)|与其说[^。！？\n]{1,30}不如说|表面[^。！？\n]{1,30}(?:实际|其实)|看似[^。！？\n]{1,30}实则|你以为[^。！？\n]{1,30}其实|回头才发现|说到底|答案恰恰相反|[^。！？\n]{1,20}不重要[，,]?重要的是/u;
const DENSE_ENUMERATION = /[^，。！？；：、\n]{1,18}、[^，。！？；：、\n]{1,18}、[^，。！？；：、\n]{1,18}/u;
const PROMPT_COLON = /(?:一句话(?:总结|说|概括)|简单说|说白了|总结|小结|结论|核心(?:是|在于|观点)?|关键(?:是|在于)?|重点(?:是)?|原因(?:如下|有|在于)?|问题(?:是|在于)?|答案(?:是)?|本质(?:是|上)?|定义(?:是)?|具体(?:来说|如下|包括)?|举例(?:来说)?|换句话说|也就是说|我的(?:观点|判断|结论)|建议(?:是)?)[：:]/u;
const IDEALIZED_ROLE = /(?:像|相当于)\s*(?:一个|一位)(?:(?:[^，。！？\n]{0,12}(?:智慧|全能|永不疲倦|贴身|专业|秒级)[^，。！？\n]{0,10}(?:导师|秘书|助手|顾问|管家|审查员|实习生))|(?:[^，。！？\n]{0,18}(?:导师|秘书|助手|顾问|管家|审查员|实习生)[^。！？\n]{0,24}(?:不仅|更|永不疲倦|智慧|全能|贴身|专业|秒级)))/u;
const NOMINALIZATION = /(?:完成|实现|进行|开展)了?(?:对)?[^，。！？\n]{0,14}的(?:优化|提升|调整|分析|改造|升级)/u;
const ABSTRACT_SUMMARY = /显著提升|大幅增长|明显改善|效率的提升|大量|众多/u;
const SPECIFIC_ANCHOR = /\d+(?:[.,]\d+)*(?:%|％|年|月|日|元|万元|小时|分钟|秒|次)?/u;
const BANNED_OPENER = /(?:^|[。！？；]\s*)(?:说白了|说穿了|先说结论)[，,:：]?/u;
const TRANSLATIONESE = /(?:一个|一种|一套|这种|这个)[^，。、；：！？\n]{15,}的[\p{Script=Han}]{2,5}|当[^，。\n]{2,20}(?<!的时候)时，|(?:对于[^，。\n]{2,15}来说|对[^，。\n]{2,15}而言|就[^，。\n]{2,15}而言|在[^，。\n]{2,12}方面)|(?:^|[。！？；]\s*)(?:然而|因此|此外|与此同时|换言之|总而言之)[，、]|(?:这意味着|这表明|这说明|换句话说)/u;
const COMMENT_OPENER = /^(?:听起来|看起来|看上去|听上去|说白了|说到底|换句话说|意味着|值得注意|不难看出|细看|再看|回过头看|问题在于|原因在于|结果是|有意思的是|更重要的是|关键在于|真正的)/u;
const ANAPHOR = /^(?:这|那|其|此|上面|前面|刚才|以上|该|它|他|她|它们|他们|同样|类似|相比|反过来|但|不过|所以|因此|于是|而|另|除此|与此)/u;
const PROTECTED_TOKEN = /\[\d+\]|https?:\/\/[^\s)）]+|\d+(?:[.,]\d+)*(?:%|％)?|百分之[〇零一二三四五六七八九十百千万亿两]+|[〇零一二三四五六七八九十百千万亿两]+(?:年|月|日|点|小时|分钟|秒|元|万元|亿元|次)|(?:可能|通常|往往|大约|据说|或许|有时|在某些情况下)|[A-Za-z][A-Za-z0-9._/+:#-]*/gu;
const QUOTED_TEXT = /“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'/gu;
const NUMBERED_HEADING = /^(第?[一二三四五六七八九十]+)[、，,.．:：\s]+/u;
const CHINESE_ORDINALS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  第一: 1, 第二: 2, 第三: 3, 第四: 4, 第五: 5, 第六: 6, 第七: 7, 第八: 8, 第九: 9, 第十: 10,
};

/** Apply the upstream whitelist skill to Chinese WeChat prose only. */
export async function applyLieflatLessAiTone(
  article: GeneratedArticle,
  styleSummary = "",
  ask: AskFn = chat
): Promise<GeneratedArticle> {
  const withHeadings = cleanSequentialHeadingNumbers(article, styleSummary);
  if (!withHeadings.paragraphs.some((text, index, paragraphs) => paragraphHasAnyTrigger(text, index, paragraphs))) {
    return withHeadings;
  }

  let parsed: unknown;
  try {
    const raw = await ask(lessAiToneCleanupPrompt(withHeadings, styleSummary), {
      temperature: 0.1,
      disableThinking: true,
    });
    if (!raw.trim()) return withHeadings;
    parsed = parseJson<unknown>(raw);
  } catch {
    return withHeadings;
  }

  const changes = normalizeChanges(parsed);
  if (changes.length === 0) return withHeadings;
  const paragraphs = [...withHeadings.paragraphs];
  const changedIndices = new Set<number>();
  for (const change of changes) {
    const original = paragraphs[change.paragraphIndex];
    if (original === undefined || changedIndices.has(change.paragraphIndex)) continue;
    if (!change.ruleIds.every((ruleId) => paragraphTriggersRule(
      ruleId,
      original,
      change.paragraphIndex,
      withHeadings.paragraphs
    ))) continue;
    const rewritten = change.text.trim();
    if (
      !rewritten
      || rewritten === original
      || !preservesProtectedContent(original, rewritten)
      || !preservesUnmatchedSentences(
        original,
        rewritten,
        change.ruleIds,
        change.paragraphIndex,
        withHeadings.paragraphs
      )
      || !isMinimalRewrite(original, rewritten)
    ) continue;
    const candidateParagraphs = [...paragraphs];
    candidateParagraphs[change.paragraphIndex] = rewritten;
    if (change.ruleIds.some((ruleId) => paragraphTriggersRule(
      ruleId,
      rewritten,
      change.paragraphIndex,
      candidateParagraphs
    ))) continue;
    paragraphs[change.paragraphIndex] = rewritten;
    changedIndices.add(change.paragraphIndex);
  }

  return changedIndices.size > 0 ? { ...withHeadings, paragraphs } : withHeadings;
}

/** Cheap preflight used to avoid a model call when no whitelist trigger exists. */
export function articleNeedsLieflatLessAiTone(article: GeneratedArticle, styleSummary = ""): boolean {
  if (cleanSequentialHeadingNumbers(article, styleSummary) !== article) return true;
  return article.paragraphs.some((text, index, paragraphs) => paragraphHasAnyTrigger(text, index, paragraphs));
}

function normalizeChanges(value: unknown): LessAiToneChange[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const changes = (value as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return [];
  return changes.slice(0, 128).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const paragraphIndex = Number(record.paragraphIndex);
    const text = typeof record.text === "string" ? record.text : "";
    const ruleIds = Array.isArray(record.ruleIds)
      ? [...new Set(record.ruleIds.map(Number))]
      : [];
    if (
      !Number.isInteger(paragraphIndex)
      || paragraphIndex < 0
      || !text.trim()
      || ruleIds.length === 0
      || !ruleIds.every((ruleId): ruleId is LessAiToneRuleId => RULE_IDS.has(ruleId as LessAiToneRuleId))
    ) return [];
    return [{ paragraphIndex, ruleIds, text }];
  });
}

function paragraphHasAnyTrigger(text: string, index: number, paragraphs: readonly string[]): boolean {
  return ([1, 2, 3, 4, 5, 7, 8, 9, 10, 11] as LessAiToneRuleId[])
    .some((ruleId) => paragraphTriggersRule(ruleId, text, index, paragraphs));
}

export function paragraphTriggersRule(
  ruleId: LessAiToneRuleId,
  text: string,
  index: number,
  paragraphs: readonly string[]
): boolean {
  switch (ruleId) {
    case 1: return REVERSAL.test(text);
    case 2: return DENSE_ENUMERATION.test(text);
    case 3: return hasIsomorphicAdjacentSentences(text);
    case 4: return text.includes("——");
    case 5: return PROMPT_COLON.test(text);
    case 6: return false;
    case 7: return IDEALIZED_ROLE.test(text);
    case 8: {
      if (NOMINALIZATION.test(text)) return true;
      if (!ABSTRACT_SUMMARY.test(text)) return false;
      return paragraphs.slice(Math.max(0, index - 1), index + 2).some((paragraph) => SPECIFIC_ANCHOR.test(paragraph));
    }
    case 9: return BANNED_OPENER.test(text);
    case 10: return TRANSLATIONESE.test(text);
    case 11: {
      const trimmed = text.trim();
      return index > 0
        && COMMENT_OPENER.test(trimmed)
        && !ANAPHOR.test(trimmed)
        && !BANNED_OPENER.test(trimmed)
        && !TRANSLATIONESE.test(trimmed);
    }
  }
}

function hasIsomorphicAdjacentSentences(paragraph: string): boolean {
  const sentences = paragraph
    .split(/[。！？]/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 10);
  for (let index = 0; index < sentences.length - 1; index += 1) {
    const current = sentenceSignature(sentences[index]);
    const next = sentenceSignature(sentences[index + 1]);
    if (current === next && sentences[index].includes("，")) return true;
  }
  return false;
}

function sentenceSignature(sentence: string): string {
  return [
    sentence.split("，").length - 1,
    Number(sentence.includes("：")),
    Number(sentence.includes("（") || sentence.includes("(")),
    Math.floor(sentence.length / 15),
  ].join(":");
}

function preservesProtectedContent(before: string, after: string): boolean {
  return sameMatches(before, after, PROTECTED_TOKEN) && sameMatches(before, after, QUOTED_TEXT);
}

function preservesUnmatchedSentences(
  before: string,
  after: string,
  ruleIds: readonly LessAiToneRuleId[],
  paragraphIndex: number,
  paragraphs: readonly string[]
): boolean {
  const sentences = before.match(/[^。！？；]+[。！？；]?/gu)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  if (sentences.length <= 1 || ruleIds.includes(3)) return true;
  let cursor = 0;
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index];
    const matched = ruleIds.some((ruleId) =>
      (ruleId === 11 && index === 0)
      || paragraphTriggersRule(ruleId, sentence, paragraphIndex, paragraphs)
    );
    if (matched) continue;
    const foundAt = after.indexOf(sentence, cursor);
    if (foundAt < 0) return false;
    cursor = foundAt + sentence.length;
  }
  return true;
}

function isMinimalRewrite(before: string, after: string): boolean {
  const beforeCompact = before.replace(/\s/gu, "");
  const afterCompact = after.replace(/\s/gu, "");
  if (!beforeCompact || !afterCompact) return false;
  const lengthRatio = afterCompact.length / beforeCompact.length;
  if (lengthRatio < 0.35 || lengthRatio > 1.55) return false;
  const beforePairs = characterPairs(beforeCompact);
  const afterPairs = characterPairs(afterCompact);
  if (beforePairs.size === 0 || afterPairs.size === 0) return beforeCompact === afterCompact;
  let shared = 0;
  for (const pair of beforePairs) if (afterPairs.has(pair)) shared += 1;
  return shared / Math.min(beforePairs.size, afterPairs.size) >= 0.45;
}

function characterPairs(value: string): Set<string> {
  const characters = Array.from(value);
  return new Set(characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`));
}

function sameMatches(before: string, after: string, pattern: RegExp): boolean {
  const collect = (value: string) => [...value.matchAll(pattern)].map((match) => match[0]).sort();
  return JSON.stringify(collect(before)) === JSON.stringify(collect(after));
}

function cleanSequentialHeadingNumbers(article: GeneratedArticle, styleSummary: string): GeneratedArticle {
  const sections = article.sectionBreaks;
  if (!sections || sections.length < 3 || stylePrefersNumberedHeadings(styleSummary)) return article;
  const ordinals = sections.map((section) => headingOrdinal(section.heading));
  const strip = new Set<number>();
  let runStart = 0;
  for (let index = 1; index <= ordinals.length; index += 1) {
    const continues = index < ordinals.length
      && ordinals[index - 1] !== undefined
      && ordinals[index] === (ordinals[index - 1] ?? 0) + 1;
    if (continues) continue;
    if (index - runStart >= 3 && ordinals[runStart] !== undefined) {
      for (let runIndex = runStart; runIndex < index; runIndex += 1) strip.add(runIndex);
    }
    runStart = index;
  }
  if (strip.size === 0) return article;
  const sectionBreaks = sections.map((section, index): ArticleSectionBreak => {
    if (!strip.has(index)) return section;
    const heading = section.heading.replace(NUMBERED_HEADING, "").trim();
    return heading ? { ...section, heading } : section;
  });
  return { ...article, sectionBreaks };
}

function headingOrdinal(heading: string): number | undefined {
  const match = heading.match(NUMBERED_HEADING);
  return match ? CHINESE_ORDINALS[match[1]] : undefined;
}

function stylePrefersNumberedHeadings(styleSummary: string): boolean {
  return /(?:小标题|标题|章节)[^。\n]{0,16}(?:使用|保留|采用|偏好)[^。\n]{0,10}(?:编号|序号|一、二、三|第一、第二、第三)|(?:编号|序号)[^。\n]{0,12}(?:风格|习惯|保留)/u.test(styleSummary);
}
