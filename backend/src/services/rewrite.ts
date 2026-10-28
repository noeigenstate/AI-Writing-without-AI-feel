import { chat, type ChatFn } from "./llm.js";
import {
  styleProfilePrompt,
  rewriteDocPrompt,
  alternativesPrompt,
  rewriteTitlePrompt,
} from "../prompts/rewrite.prompts.js";
import { parseJson } from "../lib/json.js";
import type { Lang } from "../core/i18n.js";

/**
 * Distill a style profile from sample text.
 *
 * @param samples Concatenated sample excerpts.
 * @param lang Output language.
 * @returns The style summary, or "" when there are no samples.
 */
export async function extractStyleProfile(samples: string, lang: Lang = "en"): Promise<string> {
  if (!samples.trim()) return "";
  return (await chat(styleProfilePrompt(samples, lang), { temperature: 0.3 })).trim();
}

/** A single rewritten paragraph keyed by its source index. */
export interface RewriteResult {
  index: number;
  text: string;
}

/**
 * Join non-empty paragraphs into one plain-text blob (used to summarize for titles).
 *
 * @param paragraphs Paragraphs with text.
 * @returns Newline-joined non-empty paragraph text.
 */
export function fullText(paragraphs: { text: string }[]): string {
  return paragraphs.map((p) => p.text).filter((t) => t.trim()).join("\n");
}

/**
 * Find the index of the document title (the first non-empty paragraph).
 *
 * @param paragraphs Paragraphs with index and text.
 * @returns The title paragraph's index, or -1 if none.
 */
export function titleIndexOf(paragraphs: { index: number; text: string }[]): number {
  const first = paragraphs.find((p) => p.text.trim().length > 0);
  return first ? first.index : -1;
}

/**
 * Generate N title candidates from the full article text.
 *
 * @param styleSummary Style profile to imitate.
 * @param text The full article body.
 * @param n Number of titles to request.
 * @param lang Output language.
 * @returns Up to `n` title strings, or [] if parsing fails.
 */
export async function generateTitles(
  styleSummary: string,
  text: string,
  n = 3,
  lang: Lang = "en",
  ask: ChatFn = chat
): Promise<string[]> {
  const raw = await ask(rewriteTitlePrompt(styleSummary, text, n, lang), { temperature: 0.85 });
  try {
    const arr = parseJson<string[]>(raw);
    return arr.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()).slice(0, n);
  } catch {
    return [];
  }
}

/**
 * Rewrite a whole document, paragraph by paragraph.
 *
 * The body is sent in parallel chunks to bound request size and latency; the
 * title is handled separately (summarize the whole piece, grab attention). On a
 * chunk parse failure the original text is kept so the whole doc never breaks.
 *
 * @param styleSummary Style profile to imitate.
 * @param paragraphs Source paragraphs (index, kind, text).
 * @param chunkSize Paragraphs per model call (default 12).
 * @param lang Output language.
 * @returns A map of paragraph index → rewritten text.
 */
export async function rewriteDocument(
  styleSummary: string,
  paragraphs: { index: number; kind: string; text: string }[],
  chunkSize = 12,
  lang: Lang = "en",
  ask: ChatFn = chat
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const nonEmpty = paragraphs.filter((p) => p.text.trim().length > 0);
  const titleIndex = titleIndexOf(paragraphs);

  // 标题：独立逻辑，读全文概括起标题（取第一个候选）
  if (titleIndex >= 0) {
    const titles = await generateTitles(styleSummary, fullText(paragraphs), 1, lang, ask);
    const original = nonEmpty.find((p) => p.index === titleIndex)!.text;
    result.set(titleIndex, titles[0] ?? original);
  }

  // 正文：排除标题后分块
  const todo = nonEmpty.filter((p) => p.index !== titleIndex);
  const chunks: typeof todo[] = [];
  for (let i = 0; i < todo.length; i += chunkSize) chunks.push(todo.slice(i, i + chunkSize));

  // 各块并行调用，缩短整篇等待时间
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const allowed = new Set(chunk.map((p) => p.index));
        const raw = await ask(rewriteDocPrompt(styleSummary, chunk, lang), { temperature: 0.7 });
        const items = parseJson<{ index: number | string; text: unknown }[]>(raw);
        for (const it of items) {
          const idx = Number(it.index); // 模型可能把序号返回成字符串
          if (Number.isInteger(idx) && allowed.has(idx) && typeof it.text === "string") {
            result.set(idx, it.text);
          }
        }
      } catch {
        // 解析失败：保留原文，避免整篇崩
        for (const p of chunk) result.set(p.index, p.text);
      }
    })
  );
  return result;
}

/**
 * Generate alternative phrasings for a single sentence.
 *
 * @param styleSummary Style profile to imitate.
 * @param context The paragraph the sentence appears in.
 * @param sentence The target sentence.
 * @param n Number of alternatives to request.
 * @param lang Output language.
 * @returns Up to `n` phrasings, or [] if parsing fails.
 */
export async function generateAlternatives(
  styleSummary: string,
  context: string,
  sentence: string,
  n = 3,
  lang: Lang = "en"
): Promise<string[]> {
  const raw = await chat(alternativesPrompt(styleSummary, context, sentence, n, lang), {
    temperature: 0.9,
  });
  try {
    const arr = parseJson<string[]>(raw);
    return arr.filter((x) => typeof x === "string" && x.trim()).slice(0, n);
  } catch {
    return [];
  }
}
