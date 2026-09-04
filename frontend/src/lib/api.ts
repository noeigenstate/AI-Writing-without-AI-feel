/**
 * Typed client for the backend API. Each function wraps one endpoint; the
 * interfaces below are the response/request DTOs shared with the UI.
 */
import type { Lang } from "./i18n.js";

export interface ParagraphDTO {
  index: number;
  kind: string;
  original: string;
  rewritten?: string;
  sentences: string[];
}

const BASE = "/api";

const LOCAL_BACKEND_UNAVAILABLE: Record<Lang, string> = {
  en: 'Cannot reach the local backend. Run run.bat again, wait for "AI写作 is ready", then retry.',
  zh: "无法连接本地后端。请重新运行 run.bat，等命令行显示“AI写作 is ready”后再试。",
};

async function apiFetch(input: RequestInfo | URL, init: RequestInit | undefined, lang: Lang): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error(LOCAL_BACKEND_UNAVAILABLE[lang]);
  }
}

async function apiError(res: Response, fallback: string): Promise<Error> {
  const contentType = res.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.trim()) {
        return new Error(body.error);
      }
    } else {
      const text = (await res.text()).trim();
      const lower = text.toLowerCase();
      if (text && !lower.startsWith("<!doctype") && !lower.startsWith("<html")) {
        return new Error(text.slice(0, 240));
      }
    }
  } catch {
    /* Keep the stable fallback below. */
  }
  return new Error(fallback);
}

export interface StyleDTO {
  id: string;
  name: string;
  desc: string;
}

export interface ArticleDomainDTO {
  id: string;
  name: string;
  desc: string;
}

export interface TopicOptionDTO {
  id: string;
  title: string;
  angle: string;
  audience: string;
  keywords: string[];
}

export interface ResearchItemDTO {
  id: string;
  sourceKind: "paper" | "news" | "article" | "comment";
  region: "domestic" | "international" | "global";
  sourceName: string;
  title: string;
  summary: string;
  excerpt?: string;
  url: string;
  publishedAt: string;
  authors: string[];
}

export interface ResearchBundleDTO {
  query: string;
  generatedAt: string;
  items: ResearchItemDTO[];
  unavailableSources: string[];
  coverage: {
    domestic: number;
    international: number;
    global: number;
    uniqueSources: number;
  };
  context?: string;
}

export type TargetLength = "short" | "medium" | "long";
export type ArticleLengthUnit = "characters" | "words";

export interface ArticleLengthDTO {
  tier: TargetLength;
  unit: ArticleLengthUnit;
  actual: number;
  min: number;
  max: number;
  inRange: boolean;
}

export type WritingSceneId = "general" | "wechat" | "business" | "academic" | "official" | "social" | "technical";

export type ArticleSourceMediaMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type ArticleRenderBlockDTO =
  | { type: "paragraph"; kind: string; text: string; paragraphIndex?: number }
  | {
      type: "figure";
      origin: "web";
      title: string;
      caption: string;
      alt: string;
      mediaKind: "image" | "gif";
      mimeType: ArticleSourceMediaMime;
      /** Backend-downloaded and binary-validated source bytes; never a remote URL or SVG. */
      mediaDataUri: string;
      width: number;
      height: number;
      sourceName: string;
      sourceTitle: string;
      sourceUrl: string;
      sourceRef: number;
    }
  | { type: "table"; title: string; columns: string[]; rows: string[][]; note?: string }
  | { type: "references"; title: string; items: string[] };

export interface GeneratedArticleResponseDTO {
  docId: string;
  styleSummary: string;
  titleIndex: number;
  paragraphs: ParagraphDTO[];
  length?: ArticleLengthDTO;
  renderBlocks?: ArticleRenderBlockDTO[];
  research?: ResearchBundleDTO;
  domain?: ArticleDomainDTO;
  matchedDomain?: {
    domain: ArticleDomainDTO;
    score: number;
    reasons: string[];
  };
}

/** Fetch the built-in writing styles (empty array on failure). */
export async function fetchStyles(lang: Lang) {
  try {
    const res = await apiFetch(`${BASE}/styles?lang=${lang}`, undefined, lang);
    if (!res.ok) return [] as StyleDTO[];
    return (await res.json()).styles as StyleDTO[];
  } catch {
    return [] as StyleDTO[];
  }
}

/** Fetch the available article domains (empty array on failure). */
export async function fetchArticleDomains(lang: Lang) {
  try {
    const res = await apiFetch(`${BASE}/article/domains?lang=${lang}`, undefined, lang);
    if (!res.ok) return [] as ArticleDomainDTO[];
    return (await res.json()).domains as ArticleDomainDTO[];
  } catch {
    return [] as ArticleDomainDTO[];
  }
}

/** Preview aggregated live sources for a domain/query. */
export async function previewResearch(domainId: string, customDomain = "", query = "", lang: Lang = "en") {
  const res = await apiFetch(`${BASE}/research/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domainId, customDomain, query, lang }),
  }, lang);
  if (!res.ok) throw await apiError(res, "Failed to fetch live sources");
  return res.json() as Promise<ResearchBundleDTO>;
}

/** Generate topic options for a domain, with the research bundle used. */
export async function fetchArticleTopics(domainId: string, customDomain = "", n = 6, lang: Lang = "en") {
  const res = await apiFetch(`${BASE}/article/topics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domainId, customDomain, n, lang }),
  }, lang);
  if (!res.ok) throw await apiError(res, "Failed to generate topics");
  return res.json() as Promise<{
    topics: TopicOptionDTO[];
    research?: ResearchBundleDTO;
  }>;
}

/** Generate a full article from a chosen topic. */
export async function generateArticle(
  domainId: string,
  customDomain: string,
  topic: TopicOptionDTO,
  styleId: string,
  sceneId: WritingSceneId,
  targetLength: TargetLength,
  lang: Lang = "en"
) {
  const res = await apiFetch(`${BASE}/article/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domainId, customDomain, topic, styleId, sceneId, targetLength, lang }),
  }, lang);
  if (!res.ok) throw await apiError(res, "Failed to generate article");
  return res.json() as Promise<GeneratedArticleResponseDTO>;
}

/** Generate an article from a title alone (backend infers the domain). */
export async function generateArticleFromTitle(
  title: string,
  styleId: string,
  sceneId: WritingSceneId,
  targetLength: TargetLength,
  lang: Lang = "en"
) {
  const res = await apiFetch(`${BASE}/article/generate-from-title`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, styleId, sceneId, targetLength, lang }),
  }, lang);
  if (!res.ok) throw await apiError(res, "Failed to generate article from title");
  return res.json() as Promise<GeneratedArticleResponseDTO>;
}

/** Upload the target docx plus optional sample files; returns parsed structure. */
export async function uploadFiles(target: File, references: File[], styleId = "", sceneId: WritingSceneId = "general", lang: Lang = "en") {
  const fd = new FormData();
  fd.append("file", target);
  references.forEach((r) => fd.append("references", r));
  if (styleId) fd.append("styleId", styleId);
  fd.append("sceneId", sceneId);
  fd.append("lang", lang);
  const res = await apiFetch(`${BASE}/upload`, { method: "POST", body: fd }, lang);
  if (!res.ok) throw await apiError(res, "Upload failed");
  return res.json() as Promise<{
    docId: string;
    styleSummary: string;
    titleIndex: number;
    paragraphs: ParagraphDTO[];
  }>;
}

/** A human-likeness score with its level and AI-tell deduction breakdown. */
export interface AiScoreDTO {
  score: number;
  level: "low" | "medium" | "high";
  signals: ScoreSignalDTO[];
}

export type ScoreLayerDTO = "wording" | "sentence" | "structure" | "rhythm" | "evidence" | "format";

export interface ScoreSignalDTO {
  id: string;
  label: string;
  hits: number;
  points: number;
  layer?: ScoreLayerDTO;
  suggestion?: string;
  examples?: { text: string; start: number; end: number }[];
}

export interface DiagnosticReportDTO extends AiScoreDTO {
  summary: string;
  issues: {
    id: string;
    layer: ScoreLayerDTO;
    label: string;
    hits: number;
    points: number;
    suggestion: string;
    examples: { text: string; start: number; end: number }[];
  }[];
}

/** De-AI the whole document; returns paragraphs and before/after scores. */
export async function rewriteDoc(docId: string, lang: Lang = "en") {
  const res = await apiFetch(`${BASE}/rewrite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docId, lang }),
  }, lang);
  if (!res.ok) throw await apiError(res, "Rewrite failed");
  return res.json() as Promise<{ paragraphs: ParagraphDTO[]; score?: { before: DiagnosticReportDTO; after: DiagnosticReportDTO } }>;
}

/** Score text for human-likeness via the local (no-model) backend endpoint. */
export async function scoreText(text: string, lang: Lang = "en") {
  const res = await apiFetch(`${BASE}/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, lang }),
  }, lang);
  if (!res.ok) throw await apiError(res, "Score failed");
  return res.json() as Promise<AiScoreDTO>;
}

/** Return an explainable local diagnosis without rewriting the document. */
export async function diagnoseText(text: string, lang: Lang = "en") {
  const res = await apiFetch(`${BASE}/diagnose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, lang }),
  }, lang);
  if (!res.ok) throw await apiError(res, "Diagnosis failed");
  return res.json() as Promise<DiagnosticReportDTO>;
}

/** Fetch N title candidates for a document (empty array on failure). */
export async function fetchTitles(docId: string, n = 3, lang: Lang = "en") {
  const res = await apiFetch(`${BASE}/title`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docId, n, lang }),
  }, lang);
  if (!res.ok) throw await apiError(res, "Failed to generate titles");
  return (await res.json()).titles as string[];
}

/** Fetch alternative phrasings for one sentence in its paragraph context. */
export async function fetchAlternatives(
  docId: string,
  context: string,
  sentence: string,
  n = 3,
  lang: Lang = "en"
) {
  const res = await apiFetch(`${BASE}/sentence/alternatives`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docId, context, sentence, n, lang }),
  }, lang);
  if (!res.ok) throw await apiError(res, "Failed to generate alternatives");
  return (await res.json()).alternatives as string[];
}

/** A registered 公众号 formatting theme (color swatch + usage scene). */
export interface GzhThemeDTO {
  id: string;
  name: string;
  primary: string;
  accent?: string;
  scene: string;
}

/** Result of formatting an article into WeChat-ready HTML. */
export interface GzhFormatResponseDTO {
  html: string;
  title: string;
  themeId: string;
  themeName: string;
  validation: { errors: string[]; warnings: string[]; leafCount: number };
}

/** Fetch the registered 公众号 formatting themes (empty array on failure). */
export async function fetchGzhThemes(lang: Lang) {
  try {
    const res = await apiFetch(`${BASE}/gzh/themes?lang=${lang}`, undefined, lang);
    if (!res.ok) return [] as GzhThemeDTO[];
    return (await res.json()).themes as GzhThemeDTO[];
  } catch {
    return [] as GzhThemeDTO[];
  }
}

/** Format a Markdown article into paste-ready 公众号 HTML. */
export async function formatGzhArticle(markdown: string, themeId: string, author: string, lang: Lang = "en") {
  const res = await apiFetch(`${BASE}/gzh/format`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown, themeId, author, lang }),
  }, lang);
  if (!res.ok) throw await apiError(res, "Formatting failed");
  return res.json() as Promise<GzhFormatResponseDTO>;
}

/** Export the edited document to docx and trigger a browser download. */
export async function exportDoc(docId: string, texts: Record<number, string>, lang: Lang = "en") {
  const res = await apiFetch(`${BASE}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docId, texts }),
  }, lang);
  if (!res.ok) throw await apiError(res, "Export failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "rewritten.docx";
  a.click();
  URL.revokeObjectURL(url);
}
