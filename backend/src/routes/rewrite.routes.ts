import { Router } from "express";
import multer from "multer";
import { parseDocx, exportDocx } from "../services/docx.js";
import { splitSentences } from "../services/splitter.js";
import {
  extractStyleProfile,
  rewriteDocument,
  generateAlternatives,
  generateTitles,
  titleIndexOf,
  fullText,
} from "../services/rewrite.js";
import { diagnoseText, scoreText } from "../services/aiScore.js";
import { preservesProtectedFragments } from "../services/protect.js";
import { saveDoc, getDoc, type DocRecord } from "../core/store.js";
import { getBuiltinStyle } from "../data/styles.js";
import { writingSceneProfile } from "../data/writingScenes.js";
import { normalizeLang, SERVER_MESSAGES, tr } from "../core/i18n.js";
import type { Lang } from "../core/i18n.js";

/** Routes for the de-AI rewrite flow: upload, rewrite, titles, alternatives, export. */
const router = Router();

/** Multer instance keeping uploads in memory (docs are processed, not persisted). */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 11,
  },
});

type SourceParagraph = { index: number; kind: string; text: string };

type RewrittenParagraph = {
  index: number;
  kind: string;
  original: string;
  rewritten: string;
  sentences: string[];
};

function paragraphResponse(source: SourceParagraph, rewritten: string): RewrittenParagraph {
  return {
    index: source.index,
    kind: source.kind,
    original: source.text,
    rewritten,
    sentences: splitSentences(rewritten),
  };
}

function humanScoreSafeParagraphs(
  original: SourceParagraph[],
  rewritten: RewrittenParagraph[],
  beforeScore: ReturnType<typeof scoreText>,
  lang: Lang
): { paragraphs: RewrittenParagraph[]; score: ReturnType<typeof scoreText> } {
  const originalByIndex = new Map(original.map((p) => [p.index, p]));
  const guarded = rewritten.map((p) => {
    const source = originalByIndex.get(p.index);
    if (!source) return p;

    const originalScore = scoreText(source.text, lang).score;
    const rewrittenScore = scoreText(p.rewritten, lang).score;
    const keepsFacts = preservesProtectedFragments(source.text, p.rewritten);
    return keepsFacts && rewrittenScore >= originalScore ? p : paragraphResponse(source, source.text);
  });

  const guardedScore = scoreText(rewrittenText(guarded, originalByIndex), lang);
  if (guardedScore.score >= beforeScore.score) {
    return { paragraphs: guarded, score: guardedScore };
  }

  const fallback = rewritten.map((p) => {
    const source = originalByIndex.get(p.index);
    return source ? paragraphResponse(source, source.text) : p;
  });
  return { paragraphs: fallback, score: beforeScore };
}

function protectedFragmentSafeParagraphs(
  original: SourceParagraph[],
  rewritten: RewrittenParagraph[]
): RewrittenParagraph[] {
  const originalByIndex = new Map(original.map((p) => [p.index, p]));
  return rewritten.map((p) => {
    const source = originalByIndex.get(p.index);
    if (!source || preservesProtectedFragments(source.text, p.rewritten)) {
      return p;
    }
    return paragraphResponse(source, source.text);
  });
}

function rewriteTargetsForDoc(rec: DocRecord): DocRecord["paragraphs"] {
  if (!rec.rewriteIndices) {
    return rec.paragraphs;
  }
  const allowed = new Set(rec.rewriteIndices);
  return rec.paragraphs.filter((p) => allowed.has(p.index));
}

/** Source text of the paragraphs, joined for scoring. */
function sourceText(paragraphs: { text: string }[]): string {
  return paragraphs.map((p) => p.text).join("\n");
}

/** Rewritten text of the paragraphs that were rewrite targets, joined for scoring. */
function rewrittenText(paragraphs: RewrittenParagraph[], targetByIndex: Map<number, SourceParagraph>): string {
  return paragraphs
    .filter((p) => targetByIndex.has(p.index))
    .map((p) => p.rewritten)
    .join("\n");
}

/**
 * `POST /api/upload` — accept the target docx (field `file`) plus optional samples
 * (field `references[]`, docx or txt). Returns docId, paragraph structure, and the
 * extracted style profile.
 */
router.post(
  "/api/upload",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "references", maxCount: 10 },
  ]),
  async (req, res) => {
    try {
      const files = req.files as Record<string, Express.Multer.File[]>;
      const lang = normalizeLang(req.body?.lang);
      const target = files?.file?.[0];
      if (!target) return res.status(400).json({ error: tr(SERVER_MESSAGES.missingFile, lang) });

      const parsed = await parseDocx(target.buffer);

      // 风格来源：内置 skill（styleId）+/或 上传范文
      const styleId = (req.body?.styleId as string) || "";
      const sceneId = (req.body?.sceneId as string) || "general";
      const builtin = styleId ? getBuiltinStyle(styleId, lang) : undefined;

      let sampleText = "";
      for (const f of files?.references ?? []) {
        if (f.originalname.toLowerCase().endsWith(".docx")) {
          const p = await parseDocx(f.buffer);
          sampleText += p.paragraphs.map((x) => x.text).join("\n") + "\n\n";
        } else {
          sampleText += f.buffer.toString("utf8") + "\n\n";
        }
      }
      const extracted = sampleText.trim()
        ? await extractStyleProfile(sampleText, lang).catch(() => "")
        : "";

      const sampleLabel = lang === "zh" ? "补充范文风格：" : "Extra style from samples:";
      const sceneProfile = writingSceneProfile(sceneId, lang);
      const styleSummary = [sceneProfile, builtin?.profile, extracted && `${sampleLabel}\n${extracted}`]
        .filter(Boolean)
        .join("\n\n");

      const rec = saveDoc({ buf: target.buffer, paragraphs: parsed.paragraphs, styleSummary });

      res.json({
        docId: rec.id,
        styleSummary,
        titleIndex: titleIndexOf(parsed.paragraphs),
        paragraphs: parsed.paragraphs.map((p) => ({
          index: p.index,
          kind: p.kind,
          original: p.text,
          sentences: splitSentences(p.text),
        })),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  }
);

/** `POST /api/rewrite` — de-AI the whole document; also returns before/after human-likeness scores. */
router.post("/api/rewrite", async (req, res) => {
  try {
    const { docId, lang: rawLang } = req.body as { docId: string; lang?: string };
    const lang = normalizeLang(rawLang);
    const rec = getDoc(docId);
    if (!rec) return res.status(404).json({ error: tr(SERVER_MESSAGES.docNotFound, lang) });
    const rewriteTargets = rewriteTargetsForDoc(rec);

    const map = await rewriteDocument(
      rec.styleSummary,
      rewriteTargets.map((p) => ({ index: p.index, kind: p.kind, text: p.text })),
      12,
      lang
    );

    let paragraphs = rec.paragraphs.map((p) => {
      const text = map.get(p.index) ?? p.text;
      return paragraphResponse(p, text);
    });
    paragraphs = protectedFragmentSafeParagraphs(rewriteTargets, paragraphs);

    // 本地算改写前后的人类感分，给前端展示「42 → 86」的效果对照。
    const before = scoreText(sourceText(rewriteTargets), lang);
    const targetByIndex = new Map(rewriteTargets.map((p) => [p.index, p]));
    let after = scoreText(rewrittenText(paragraphs, targetByIndex), lang);

    if (after.score < before.score) {
      const guarded = humanScoreSafeParagraphs(rewriteTargets, paragraphs, before, lang);
      paragraphs = guarded.paragraphs;
      after = guarded.score;
    }

    const beforeDiagnosis = diagnoseText(sourceText(rewriteTargets), lang);
    const afterDiagnosis = diagnoseText(rewrittenText(paragraphs, targetByIndex), lang);

    res.json({ paragraphs, score: { before: beforeDiagnosis, after: afterDiagnosis } });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** `POST /api/title` — generate N title candidates from the full text. */
router.post("/api/title", async (req, res) => {
  try {
    const { docId, n, lang: rawLang } = req.body as { docId: string; n?: number; lang?: string };
    const lang = normalizeLang(rawLang);
    const rec = getDoc(docId);
    if (!rec) return res.status(404).json({ error: tr(SERVER_MESSAGES.docNotFound, lang) });
    const titles = await generateTitles(rec.styleSummary, fullText(rec.paragraphs), n ?? 3, lang);
    res.json({ titles });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** `POST /api/sentence/alternatives` — offer alternative phrasings for one sentence. */
router.post("/api/sentence/alternatives", async (req, res) => {
  try {
    const { docId, context, sentence, n, lang: rawLang } = req.body as {
      docId: string;
      context: string;
      sentence: string;
      n?: number;
      lang?: string;
    };
    const lang = normalizeLang(rawLang);
    const rec = getDoc(docId);
    if (!rec) return res.status(404).json({ error: tr(SERVER_MESSAGES.docNotFound, lang) });
    const alts = await generateAlternatives(rec.styleSummary, context, sentence, n ?? 3, lang);
    res.json({ alternatives: alts });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * `POST /api/export` — rebuild the docx, applying `body.texts` ({ paragraphIndex: text }).
 * Paragraphs not present keep their original content (and character-level formatting).
 */
router.post("/api/export", async (req, res) => {
  try {
    const { docId, texts } = req.body as { docId: string; texts: Record<string, string> };
    const rec = getDoc(docId);
    if (!rec) {
      return res
        .status(404)
        .json({ error: tr(SERVER_MESSAGES.docNotFound, normalizeLang((req.body as { lang?: string }).lang)) });
    }

    const max = rec.paragraphs.length;
    const arr: (string | undefined)[] = new Array(max).fill(undefined);
    for (const [k, v] of Object.entries(texts ?? {})) {
      const i = Number(k);
      if (Number.isInteger(i) && i >= 0 && i < max) arr[i] = v;
    }

    const out = await exportDocx(rec.buf, arr);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", 'attachment; filename="rewritten.docx"');
    res.send(out);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export default router;
