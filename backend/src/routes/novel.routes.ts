import { Router } from "express";
import { createDocxFromBlocks, parseDocx, type DocxBlock } from "../services/docx.js";
import { splitSentences } from "../services/splitter.js";
import { saveDoc } from "../core/store.js";
import { normalizeLang, SERVER_MESSAGES, tr } from "../core/i18n.js";
import { isArticleLengthTier } from "../services/articleLength.js";
import {
  generateNovelDraft,
  isNovelGenre,
  isNovelTone,
  isNovelViewpoint,
  novelStyleSummary,
  NovelLengthTargetError,
  NovelModelOutputError,
  type GenerateNovelInput,
} from "../services/novel.js";
import { titleIndexOf } from "../services/rewrite.js";

const router = Router();

/** `POST /api/novel/generate` — generate editable fiction without research citations. */
router.post("/api/novel/generate", async (req, res) => {
  try {
    const body = (
      req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {}
    ) as {
      title?: unknown;
      premise?: unknown;
      genre?: unknown;
      viewpoint?: unknown;
      tone?: unknown;
      targetLength?: unknown;
      lang?: unknown;
    };
    const lang = normalizeLang(body.lang);
    const premise = typeof body.premise === "string" ? body.premise.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const genre = body.genre ?? "literary";
    const viewpoint = body.viewpoint ?? "third-limited";
    const tone = body.tone ?? "restrained";
    const targetLength = body.targetLength ?? "medium";

    if (!premise) return res.status(400).json({ error: tr(SERVER_MESSAGES.missingNovelPremise, lang) });
    if (premise.length > 2_000) {
      return res.status(400).json({ error: tr(SERVER_MESSAGES.novelPremiseTooLong, lang) });
    }
    if (body.title !== undefined && typeof body.title !== "string") {
      return res.status(400).json({ error: tr(SERVER_MESSAGES.invalidNovelOptions, lang) });
    }
    if (title.length > 120) {
      return res.status(400).json({ error: tr(SERVER_MESSAGES.novelTitleTooLong, lang) });
    }
    if (!isNovelGenre(genre) || !isNovelViewpoint(viewpoint) || !isNovelTone(tone)) {
      return res.status(400).json({ error: tr(SERVER_MESSAGES.invalidNovelOptions, lang) });
    }
    if (!isArticleLengthTier(targetLength)) {
      return res.status(400).json({ error: tr(SERVER_MESSAGES.invalidTargetLength, lang) });
    }

    const input: GenerateNovelInput = {
      title,
      premise,
      genre,
      viewpoint,
      tone,
      targetLength,
      lang,
    };
    res.json(await generateNovelPayload(input));
  } catch (error) {
    if (error instanceof NovelLengthTargetError) {
      res.status(422).json({ error: error.message, length: error.length });
      return;
    }
    if (error instanceof NovelModelOutputError) {
      res.status(422).json({ error: tr(SERVER_MESSAGES.invalidNovelOutput, normalizeLang(req.body?.lang)) });
      return;
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

/** Build and store the same editable document payload returned by the route. */
export async function generateNovelPayload(
  input: GenerateNovelInput,
  generateDraft: typeof generateNovelDraft = generateNovelDraft
) {
  const novel = await generateDraft(input);
  const styleSummary = novelStyleSummary(input);
  const blocks: DocxBlock[] = [
    { type: "paragraph", kind: "heading1", text: novel.title },
    ...novel.paragraphs.map((text) => ({ type: "paragraph" as const, kind: "normal" as const, text })),
  ];
  const docx = await createDocxFromBlocks(blocks);
  const parsed = await parseDocx(docx);
  const renderBlocks = parsed.paragraphs.map((paragraph) => ({
    type: "paragraph" as const,
    kind: paragraph.kind,
    text: paragraph.text,
    paragraphIndex: paragraph.index,
  }));
  const rec = saveDoc({
    buf: docx,
    paragraphs: parsed.paragraphs,
    styleSummary,
    rewriteIndices: parsed.paragraphs.map((paragraph) => paragraph.index),
  });

  return {
    docId: rec.id,
    styleSummary,
    length: novel.length,
    renderBlocks,
    titleIndex: titleIndexOf(parsed.paragraphs),
    paragraphs: parsed.paragraphs.map((paragraph) => ({
      index: paragraph.index,
      kind: paragraph.kind,
      original: paragraph.text,
      rewritten: paragraph.text,
      sentences: splitSentences(paragraph.text),
    })),
  };
}

export default router;
