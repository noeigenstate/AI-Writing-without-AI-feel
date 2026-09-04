import { chat, type ChatOptions } from "./llm.js";
import { parseJson, parseJsonWithRepair } from "../lib/json.js";
import {
  articleLengthDistance,
  getArticleLengthSpec,
  measureArticleLength,
  type ArticleLengthMetadata,
  type ArticleLengthTier,
} from "./articleLength.js";
import {
  novelDraftPrompt,
  novelLengthFixPrompt,
  type NovelPromptInput,
} from "../prompts/novel.prompts.js";
import type { Lang } from "../core/i18n.js";

export const NOVEL_GENRES = [
  "literary",
  "romance",
  "suspense",
  "science-fiction",
  "fantasy",
  "historical",
  "realism",
] as const;
export const NOVEL_VIEWPOINTS = ["first-person", "third-limited", "omniscient"] as const;
export const NOVEL_TONES = ["restrained", "warm", "dark", "humorous", "tense"] as const;

export type NovelGenre = (typeof NOVEL_GENRES)[number];
export type NovelViewpoint = (typeof NOVEL_VIEWPOINTS)[number];
export type NovelTone = (typeof NOVEL_TONES)[number];

export interface GenerateNovelInput {
  title?: string;
  premise: string;
  genre: NovelGenre;
  viewpoint: NovelViewpoint;
  tone: NovelTone;
  targetLength: ArticleLengthTier;
  lang?: Lang;
}

export interface GeneratedNovel {
  title: string;
  paragraphs: string[];
  length: ArticleLengthMetadata;
}

type ChatFn = (prompt: string, options?: ChatOptions) => Promise<string>;
type NovelBody = Pick<GeneratedNovel, "title" | "paragraphs">;

const MAX_LENGTH_FIX_PASSES = 2;
const MAX_NOVEL_PARAGRAPHS = 80;
const MAX_NOVEL_BODY_CHARS = 60_000;

const GENRE_LABELS: Record<NovelGenre, Record<Lang, string>> = {
  literary: { en: "literary fiction", zh: "文学" },
  romance: { en: "romance", zh: "言情" },
  suspense: { en: "suspense / mystery", zh: "悬疑" },
  "science-fiction": { en: "science fiction", zh: "科幻" },
  fantasy: { en: "fantasy", zh: "奇幻" },
  historical: { en: "historical fiction", zh: "历史" },
  realism: { en: "contemporary realism", zh: "现实主义" },
};

const VIEWPOINT_LABELS: Record<NovelViewpoint, Record<Lang, string>> = {
  "first-person": { en: "first person", zh: "第一人称" },
  "third-limited": { en: "third-person limited", zh: "第三人称限知" },
  omniscient: { en: "third-person omniscient", zh: "第三人称全知" },
};

const TONE_LABELS: Record<NovelTone, Record<Lang, string>> = {
  restrained: { en: "restrained and observant", zh: "克制冷静" },
  warm: { en: "warm and humane", zh: "温暖细腻" },
  dark: { en: "dark and oppressive", zh: "冷峻暗黑" },
  humorous: { en: "dryly humorous", zh: "轻松幽默" },
  tense: { en: "tense and propulsive", zh: "紧张强烈" },
};

export class NovelModelOutputError extends Error {
  constructor() {
    super("The model did not return usable fiction JSON after one retry.");
    this.name = "NovelModelOutputError";
  }
}

export class NovelLengthTargetError extends Error {
  readonly length: ArticleLengthMetadata;

  constructor(length: ArticleLengthMetadata, lang: Lang) {
    super(lang === "zh"
      ? `小说正文长度为 ${length.actual} 字，未达到 ${length.min}-${length.max} 字的目标，请重试。`
      : `The fiction body is ${length.actual} words, outside the ${length.min}-${length.max} word target. Please retry.`);
    this.name = "NovelLengthTargetError";
    this.length = length;
  }
}

export function isNovelGenre(value: unknown): value is NovelGenre {
  return typeof value === "string" && NOVEL_GENRES.some((genre) => genre === value);
}

export function isNovelViewpoint(value: unknown): value is NovelViewpoint {
  return typeof value === "string" && NOVEL_VIEWPOINTS.some((viewpoint) => viewpoint === value);
}

export function isNovelTone(value: unknown): value is NovelTone {
  return typeof value === "string" && NOVEL_TONES.some((tone) => tone === value);
}

/** Generate and length-check an editable fiction draft. */
export async function generateNovelDraft(
  input: GenerateNovelInput,
  ask: ChatFn = chat
): Promise<GeneratedNovel> {
  const lang = input.lang ?? "en";
  const spec = getArticleLengthSpec(lang, input.targetLength);
  const promptInput: NovelPromptInput = {
    title: input.title?.trim() ?? "",
    premise: input.premise.trim(),
    genre: GENRE_LABELS[input.genre][lang],
    viewpoint: VIEWPOINT_LABELS[input.viewpoint][lang],
    tone: TONE_LABELS[input.tone][lang],
    targetLength: input.targetLength,
    length: spec,
  };
  let novel = await requestNovelJson(novelDraftPrompt(promptInput, lang), ask, promptInput.title);

  for (let pass = 0; pass < MAX_LENGTH_FIX_PASSES; pass += 1) {
    const current = measureArticleLength(novel.paragraphs, lang, input.targetLength);
    if (current.inRange) return { ...novel, length: current };

    const candidate = await requestOptionalNovelJson(
      novelLengthFixPrompt(novel, promptInput, current.actual, lang),
      ask,
      novel.title
    );
    if (!candidate) continue;

    const candidateLength = measureArticleLength(candidate.paragraphs, lang, input.targetLength);
    if (
      articleLengthDistance(candidateLength.actual, spec)
      < articleLengthDistance(current.actual, spec)
    ) {
      novel = candidate;
    }
  }

  const length = measureArticleLength(novel.paragraphs, lang, input.targetLength);
  if (!length.inRange) throw new NovelLengthTargetError(length, lang);
  return { ...novel, length };
}

/** Style context reused by sentence rewriting after the fiction draft is stored. */
export function novelStyleSummary(input: GenerateNovelInput): string {
  const lang = input.lang ?? "en";
  const details = lang === "zh"
    ? `题材：${GENRE_LABELS[input.genre][lang]}；视角：${VIEWPOINT_LABELS[input.viewpoint][lang]}；基调：${TONE_LABELS[input.tone][lang]}。`
    : `Genre: ${GENRE_LABELS[input.genre][lang]}; viewpoint: ${VIEWPOINT_LABELS[input.viewpoint][lang]}; tone: ${TONE_LABELS[input.tone][lang]}.`;
  const guard = lang === "zh"
    ? "小说润色：保持人物身份、叙事视角、时态、既有情节事实和人物声音一致；改善句子时不得新增关键情节。"
    : "Fiction revision: preserve character identity, viewpoint, tense, established story facts, and character voice; sentence polishing must not invent new plot events.";
  return `${guard}\n${details}`;
}

async function requestNovelJson(prompt: string, ask: ChatFn, fixedTitle: string): Promise<NovelBody> {
  let providerError: unknown;
  const options: ChatOptions = { temperature: 0.82, disableThinking: true };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw: string;
    try {
      raw = await ask(prompt, {
        ...options,
        temperature: attempt === 0 ? options.temperature : 0.55,
      });
    } catch (error) {
      providerError = error;
      continue;
    }
    providerError = undefined;
    if (!raw.trim()) continue;
    try {
      const parsed = await parseJsonWithRepair<unknown>(raw, ask, "fiction JSON object");
      const novel = normalizeNovel(parsed, fixedTitle);
      if (novel) return novel;
    } catch {
      // Retry the complete fiction prompt once without exposing model output.
    }
  }
  if (providerError) throw providerError;
  throw new NovelModelOutputError();
}

async function requestOptionalNovelJson(
  prompt: string,
  ask: ChatFn,
  fixedTitle: string
): Promise<NovelBody | undefined> {
  try {
    const raw = await ask(prompt, { temperature: 0.58, disableThinking: true });
    if (!raw.trim()) return undefined;
    return normalizeNovel(parseJson<unknown>(raw), fixedTitle) ?? undefined;
  } catch {
    return undefined;
  }
}

function normalizeNovel(value: unknown, fixedTitle: string): NovelBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const modelTitle = typeof record.title === "string" ? record.title.trim() : "";
  const title = fixedTitle || modelTitle;
  if (!title || title.length > 120 || !Array.isArray(record.paragraphs)) return null;

  const paragraphs = record.paragraphs
    .filter((paragraph): paragraph is string => typeof paragraph === "string")
    .flatMap((paragraph) => paragraph.split(/\n\s*\n/gu))
    .map((paragraph) => paragraph.replace(/[\t ]*\n[\t ]*/gu, " ").trim())
    .filter(Boolean)
    .filter((paragraph, index) => index > 0 || paragraph !== title)
    .slice(0, MAX_NOVEL_PARAGRAPHS);
  if (paragraphs.length < 3) return null;
  if (paragraphs.join("").length > MAX_NOVEL_BODY_CHARS) return null;
  return { title, paragraphs };
}
