/**
 * 后端语言支持。前端通过请求里的 `lang` 字段传入；缺省回退到英文。
 * Backend language support. Frontend passes `lang` per request; falls back to English.
 */

/** Supported UI/content languages. */
export type Lang = "en" | "zh";

/**
 * Coerce an arbitrary request value into a supported {@link Lang}.
 *
 * @param value Raw `lang` value from a query string or JSON body.
 * @returns "zh" only when explicitly requested; otherwise "en".
 */
export function normalizeLang(value: unknown): Lang {
  return value === "zh" ? "zh" : "en";
}

/** A bilingual label pair. */
type Bi = { en: string; zh: string };

/** API 错误信息 / API error messages */
export const SERVER_MESSAGES = {
  missingTopic: { en: "Missing topic.", zh: "缺少选题 topic" },
  invalidTopic: {
    en: "Invalid topic; provide a title or a generated topic option.",
    zh: "选题格式无效，请提供标题或重新选择一个生成的选题",
  },
  invalidArticleOutput: {
    en: "The model returned an incomplete article after an automatic retry. Please try again.",
    zh: "模型返回的文章不完整，系统已自动重试一次，请重新生成",
  },
  missingTitle: { en: "Missing article title.", zh: "缺少文章标题 title" },
  titleTooLong: {
    en: "Title is too long; keep it under 120 characters.",
    zh: "标题太长，请控制在 120 字以内",
  },
  missingNovelPremise: {
    en: "Describe the story you want to write.",
    zh: "请先写下故事设定",
  },
  novelPremiseTooLong: {
    en: "The story brief is too long; keep it under 2,000 characters.",
    zh: "故事设定太长，请控制在 2000 字以内",
  },
  novelTitleTooLong: {
    en: "The fiction title is too long; keep it under 120 characters.",
    zh: "小说标题太长，请控制在 120 字以内",
  },
  invalidNovelOptions: {
    en: "Invalid fiction settings; choose a supported genre, viewpoint, and tone.",
    zh: "小说设置无效，请重新选择题材、叙事视角和基调",
  },
  invalidNovelOutput: {
    en: "The model returned incomplete fiction after an automatic retry. Please try again.",
    zh: "模型返回的小说不完整，系统已自动重试一次，请重新生成",
  },
  invalidTargetLength: {
    en: "Invalid targetLength; use short, medium, or long.",
    zh: "targetLength 无效，请使用 short、medium 或 long",
  },
  missingFile: { en: "Missing target file (field: file).", zh: "缺少目标文件 file" },
  docNotFound: { en: "Document not found or expired.", zh: "文档不存在或已过期" },
} satisfies Record<string, Bi>;

/** 生成文章里的结构性文案（标题、表格、图注等） / Structural labels in generated articles */
export const ARTICLE_LABELS = {
  references: { en: "References", zh: "参考文献" },
  figureSourceWord: { en: "Source image", zh: "来源图片" },
  defaultAudience: { en: "general readers", zh: "公众号读者" },
  titleAngle: {
    en: "Develop around the user's title; domain auto-matched to: ",
    zh: "围绕用户标题展开，领域自动匹配为：",
  },
  defaultMatch: { en: "default match", zh: "默认匹配" },
  defaultStyleSummary: {
    en: "Article generation: human voice, short sentences first, high information density.",
    zh: "公众号文章生成：去 AI 味、短句优先、信息密度高。",
  },
} satisfies Record<string, Bi>;

/**
 * Resolve a bilingual label to the given language.
 *
 * @param entry The bilingual pair.
 * @param lang Target language.
 * @returns The localized string.
 */
export function tr(entry: Bi, lang: Lang): string {
  return entry[lang];
}
