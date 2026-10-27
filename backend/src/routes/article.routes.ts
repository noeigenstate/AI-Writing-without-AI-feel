import { Router } from "express";
import { createDocxFromBlocks, parseDocx } from "../services/docx.js";
import { splitSentences } from "../services/splitter.js";
import {
  getArticleDomains,
  articleToDocBlocks,
  articleToRenderBlocks,
  articleMediaMatchesBody,
  enrichArticleWithResearch,
  generateArticleDraft,
  ArticleLengthTargetError,
  ArticleModelOutputError,
  generateTopicOptions,
  matchArticleDomainFromTitle,
  resolveArticleDomain,
  type ArticleDomain,
  type ArticleRenderBlock,
  type TopicOption,
} from "../services/article.js";
import { collectResearch, formatResearchContext } from "../services/research/aggregate.js";
import {
  ArticleEvidenceIncompleteError,
  collectArticleEvidence,
  formatArticleEvidenceContext,
  hasDraftableEvidence,
  type ArticleEvidenceResult,
} from "../services/research/evidencePipeline.js";
import { searchLicensedMediaForArticle } from "../services/research/licensedMedia.js";
import type { ResearchBundle } from "../services/research/types.js";
import {
  ArticleEvidenceValidationError,
  auditArticleEvidenceDraft,
  evidenceDraftRepairInstruction,
} from "../services/articleEvidenceAudit.js";
import { titleIndexOf } from "../services/rewrite.js";
import { saveDoc } from "../core/store.js";
import { getBuiltinStyle } from "../data/styles.js";
import { writingSceneProfile } from "../data/writingScenes.js";
import { normalizeLang, SERVER_MESSAGES, ARTICLE_LABELS, tr, type Lang } from "../core/i18n.js";
import {
  isArticleLengthTier,
  measureArticleLength,
  type ArticleLengthTier,
} from "../services/articleLength.js";

/** Routes for topic planning, research preview, and article generation. */
const router = Router();

/** `GET /api/article/domains?lang=` — list the supported article domains. */
router.get("/api/article/domains", (req, res) => {
  const lang = normalizeLang(req.query.lang);
  res.json({ domains: getArticleDomains(lang) });
});

/** `POST /api/article/topics` — auto-generate topic options for a domain. */
router.post("/api/article/topics", async (req, res) => {
  try {
    const { domainId, customDomain, n, lang: rawLang } = req.body as {
      domainId?: string;
      customDomain?: string;
      n?: number;
      lang?: string;
    };
    const lang = normalizeLang(rawLang);
    const domain = resolveArticleDomain(domainId, customDomain, lang);
    const bundle = await collectResearch(domain.name, domain.name);
    const researchContext = formatResearchContext(bundle.items, 12);
    const topics = await generateTopicOptions({
      domain,
      n: n ?? 6,
      researchContext,
      researchCoverage: bundle.coverage,
      lang,
    });
    res.json({ domain, topics, research: withoutRemoteImageUrls(bundle) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** `POST /api/research/preview` — aggregate live sources for a domain/query. */
router.post("/api/research/preview", async (req, res) => {
  try {
    const { domainId, customDomain, query, lang: rawLang } = req.body as {
      domainId?: string;
      customDomain?: string;
      query?: string;
      lang?: string;
    };
    const lang = normalizeLang(rawLang);
    const domain = resolveArticleDomain(domainId, customDomain, lang);
    const bundle = await collectResearch(domain.name, query?.trim() || domain.name);
    res.json({
      ...withoutRemoteImageUrls(bundle),
      context: formatResearchContext(bundle.items, 10),
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** `POST /api/article/generate` — generate a full article from a chosen topic. */
router.post("/api/article/generate", async (req, res) => {
  try {
    const { domainId, customDomain, topic, styleId, sceneId, targetLength, lang: rawLang } = req.body as {
      domainId?: string;
      customDomain?: string;
      topic: TopicOption | string;
      styleId?: string;
      sceneId?: string;
      targetLength?: unknown;
      lang?: string;
    };
    const lang = normalizeLang(rawLang);
    if (targetLength !== undefined && !isArticleLengthTier(targetLength)) {
      return res.status(400).json({ error: tr(SERVER_MESSAGES.invalidTargetLength, lang) });
    }
    if (!topic) return res.status(400).json({ error: tr(SERVER_MESSAGES.missingTopic, lang) });
    if (!isArticleTopic(topic)) {
      return res.status(400).json({ error: tr(SERVER_MESSAGES.invalidTopic, lang) });
    }

    const domain = resolveArticleDomain(domainId, customDomain, lang);
    res.json(await generateArticlePayload({ domain, topic, styleId, sceneId, targetLength, lang }));
  } catch (e) {
    if (e instanceof ArticleLengthTargetError) {
      res.status(422).json({ error: e.message, length: e.length });
      return;
    }
    if (e instanceof ArticleModelOutputError) {
      res.status(422).json({ error: tr(SERVER_MESSAGES.invalidArticleOutput, normalizeLang(req.body?.lang)) });
      return;
    }
    if (e instanceof ArticleEvidenceIncompleteError) {
      res.status(422).json({ error: e.message, evidence: e.evidence });
      return;
    }
    if (e instanceof ArticleEvidenceValidationError) {
      res.status(422).json({ error: e.message, audit: e.audit, repairCycles: e.repairCycles });
      return;
    }
    res.status(500).json({ error: (e as Error).message });
  }
});

/** `POST /api/article/generate-from-title` — infer the domain from a title, then generate. */
router.post("/api/article/generate-from-title", async (req, res) => {
  try {
    const { title, styleId, sceneId, targetLength, lang: rawLang } = req.body as {
      title?: string;
      styleId?: string;
      sceneId?: string;
      targetLength?: unknown;
      lang?: string;
    };
    const lang = normalizeLang(rawLang);
    const cleanTitle = title?.trim() ?? "";
    if (!cleanTitle) return res.status(400).json({ error: tr(SERVER_MESSAGES.missingTitle, lang) });
    if (cleanTitle.length > 120) return res.status(400).json({ error: tr(SERVER_MESSAGES.titleTooLong, lang) });
    if (targetLength !== undefined && !isArticleLengthTier(targetLength)) {
      return res.status(400).json({ error: tr(SERVER_MESSAGES.invalidTargetLength, lang) });
    }

    const matchedDomain = await matchArticleDomainFromTitle(cleanTitle, lang);
    const defaultMatch = tr(ARTICLE_LABELS.defaultMatch, lang);
    const topic: TopicOption = {
      id: "title-input",
      title: cleanTitle,
      angle: `${tr(ARTICLE_LABELS.titleAngle, lang)}${matchedDomain.domain.name}`,
      audience: tr(ARTICLE_LABELS.defaultAudience, lang),
      keywords: matchedDomain.reasons.filter((reason) => reason !== defaultMatch),
    };

    const payload = await generateArticlePayload({
      domain: matchedDomain.domain,
      topic,
      styleId,
      sceneId,
      targetLength,
      lang,
    });
    res.json({ ...payload, domain: matchedDomain.domain, matchedDomain });
  } catch (e) {
    if (e instanceof ArticleLengthTargetError) {
      res.status(422).json({ error: e.message, length: e.length });
      return;
    }
    if (e instanceof ArticleModelOutputError) {
      res.status(422).json({ error: tr(SERVER_MESSAGES.invalidArticleOutput, normalizeLang(req.body?.lang)) });
      return;
    }
    if (e instanceof ArticleEvidenceIncompleteError) {
      res.status(422).json({ error: e.message, evidence: e.evidence });
      return;
    }
    if (e instanceof ArticleEvidenceValidationError) {
      res.status(422).json({ error: e.message, audit: e.audit, repairCycles: e.repairCycles });
      return;
    }
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Run the full generation pipeline: research → draft → enrich → docx → store.
 *
 * Shared by both the topic-based and title-based generation routes.
 *
 * @param input Resolved domain, topic, optional style/length, and language.
 * @returns The API payload (docId, render blocks, paragraphs, research bundle).
 */
export async function generateArticlePayload(input: {
  domain: ArticleDomain;
  topic: TopicOption | string;
  styleId?: string;
  sceneId?: string;
  targetLength?: ArticleLengthTier;
  lang: Lang;
}) {
  const { lang } = input;
  const targetLength = input.targetLength ?? "medium";
  const topicTitle = typeof input.topic === "string" ? input.topic : input.topic.title;
  const evidenceRun = await collectArticleEvidence(input.domain.name, topicTitle);
  if (!hasDraftableEvidence(evidenceRun.evidence)) {
    const message = lang === "zh"
      ? `经过 ${evidenceRun.evidence.iterations} 轮检索仍没有可用于成文的客观事实，已停止生成：${evidenceRun.evidence.stopReason}`
      : `Drafting stopped because ${evidenceRun.evidence.iterations} research rounds produced no objective claim that can support an article: ${evidenceRun.evidence.stopReason}`;
    throw new ArticleEvidenceIncompleteError(message, evidenceRun.evidence);
  }
  const bundleWithImages = evidenceRun.bundle;
  const researchContext = formatArticleEvidenceContext(evidenceRun);
  const builtin = input.styleId ? getBuiltinStyle(input.styleId, lang) : undefined;
  const sceneProfile = writingSceneProfile(input.sceneId, lang);
  const styleSummary = [sceneProfile, builtin?.profile ?? tr(ARTICLE_LABELS.defaultStyleSummary, lang)]
    .filter(Boolean)
    .join("\n\n");
  const draftInput = {
    domainName: input.domain.name,
    topic: input.topic,
    styleSummary,
    targetLength,
    researchContext,
    researchCoverage: bundleWithImages.coverage,
    sceneId: input.sceneId,
    styleId: input.styleId,
    lang,
  };
  let draft = await generateArticleDraft(draftInput);
  let draftAudit = await auditArticleEvidenceDraft(
    topicTitle,
    draft,
    evidenceRun.evidence.claims,
    Math.min(bundleWithImages.items.length, 16),
    {
      requireToneCheck: lang === "zh" && input.sceneId === "wechat",
      evidenceSaturated: evidenceRun.evidence.saturated,
      openGaps: latestCriticalGaps(evidenceRun.evidence),
    }
  );
  let repairCycles = 0;
  while (!draftAudit.pass && repairCycles < 3) {
    repairCycles += 1;
    draft = await generateArticleDraft({
      ...draftInput,
      qualityRepairInstruction: evidenceDraftRepairInstruction(draftAudit, repairCycles),
    });
    draftAudit = await auditArticleEvidenceDraft(
      topicTitle,
      draft,
      evidenceRun.evidence.claims,
      Math.min(bundleWithImages.items.length, 16),
      {
        requireToneCheck: lang === "zh" && input.sceneId === "wechat",
        evidenceSaturated: evidenceRun.evidence.saturated,
        openGaps: latestCriticalGaps(evidenceRun.evidence),
      }
    );
  }
  if (!draftAudit.pass) {
    const message = lang === "zh"
      ? "文章在 3 轮修复后仍未通过事实、引用、语气或主题一致性检查，已停止交付。"
      : "The article still failed its fact, citation, tone, or topic-alignment gates after three repair cycles.";
    throw new ArticleEvidenceValidationError(message, draftAudit, repairCycles);
  }
  const desiredFigureCount = targetLength === "short" ? 2 : targetLength === "long" ? 6 : 4;
  let article = await enrichArticleWithResearch(
    draft,
    bundleWithImages.items,
    new Date(bundleWithImages.generatedAt),
    lang
  );
  const actualFigureCount = Number(Boolean(article.figure)) + (article.bodyFigures?.length ?? 0);
  let supplementalMediaForValidation: Awaited<ReturnType<typeof searchLicensedMediaForArticle>> = [];
  if (actualFigureCount < desiredFigureCount) {
    const supplementalMedia = await searchLicensedMediaForArticle(
      draft,
      bundleWithImages.items.map((item) => item.query),
      desiredFigureCount - actualFigureCount
    );
    if (supplementalMedia.length > 0) {
      supplementalMediaForValidation = supplementalMedia;
      article = await enrichArticleWithResearch(
        draft,
        bundleWithImages.items,
        new Date(bundleWithImages.generatedAt),
        lang,
        { supplementalMedia }
      );
    }
  }
  let mediaMatch = articleMediaMatchesBody(
    article,
    bundleWithImages.items,
    supplementalMediaForValidation
  );
  if (!mediaMatch) {
    // A missing image is safer than an image whose provenance/body relation no
    // longer validates. This keeps the article deliverable without pretending
    // that a discarded visual passed the gate.
    article = { ...article, figure: undefined, bodyFigures: [] };
    mediaMatch = articleMediaMatchesBody(article, bundleWithImages.items);
  }
  const length = measureArticleLength(article.paragraphs, lang, targetLength);

  const docx = await createDocxFromBlocks(articleToDocBlocks(article, lang));
  const parsed = await parseDocx(docx);
  const renderBlocks = articleToRenderBlocks(article, parsed.paragraphs, lang);
  const rewriteIndices = renderBlocks
    .filter((block): block is Extract<ArticleRenderBlock, { type: "paragraph" }> => block.type === "paragraph")
    .map((block) => block.paragraphIndex)
    .filter((index): index is number => typeof index === "number");
  const rec = saveDoc({ buf: docx, paragraphs: parsed.paragraphs, styleSummary, rewriteIndices });

  return {
    docId: rec.id,
    styleSummary,
    length,
    research: withoutRemoteImageUrls(bundleWithImages),
    evidence: {
      ...evidenceRun.evidence,
      repairCycles,
      validation: {
        ...draftAudit,
        length: length.inRange,
        mediaMatch,
      },
    },
    renderBlocks,
    titleIndex: titleIndexOf(parsed.paragraphs),
    paragraphs: parsed.paragraphs.map((p) => ({
      index: p.index,
      kind: p.kind,
      original: p.text,
      rewritten: p.text,
      sentences: splitSentences(p.text),
    })),
  };
}

function latestCriticalGaps(evidence: ArticleEvidenceResult["evidence"]): string[] {
  return evidence.rounds.at(-1)?.gaps
    .filter((gap) => gap.critical)
    .map((gap) => gap.question) ?? [];
}

/** Keep source-page attribution while withholding remote image URLs from API clients. */
function withoutRemoteImageUrls(bundle: ResearchBundle): ResearchBundle {
  return {
    ...bundle,
    items: bundle.items.map((item) => {
      const copy = { ...item };
      delete copy.imageUrl;
      delete copy.content;
      return copy;
    }),
  };
}

/** Accept a non-empty title string or a generated topic object with a title. */
function isArticleTopic(value: unknown): value is TopicOption | string {
  if (typeof value === "string") return value.trim().length > 0;
  if (!value || typeof value !== "object") return false;
  return typeof (value as { title?: unknown }).title === "string"
    && Boolean((value as { title: string }).title.trim());
}

export default router;
