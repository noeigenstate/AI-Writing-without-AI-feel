import assert from "node:assert/strict";
import {
  collectArticleEvidence,
  formatArticleEvidenceContext,
  hasDraftableEvidence,
} from "../services/research/evidencePipeline.js";
import {
  auditArticleEvidenceDraft,
  evidenceDraftRepairInstruction,
} from "../services/articleEvidenceAudit.js";
import { articleMediaMatchesBody, type GeneratedArticle } from "../services/article.js";
import type { ResearchBundle, ResearchItem } from "../services/research/types.js";

function item(input: Partial<ResearchItem> & Pick<ResearchItem, "id" | "title">): ResearchItem {
  return {
    id: input.id,
    sourceKind: input.sourceKind ?? "article",
    sourceName: input.sourceName ?? "Official Example",
    sourceId: input.sourceId ?? "official-example",
    region: input.region ?? "global",
    title: input.title,
    summary: input.summary ?? `${input.title} summary`,
    excerpt: input.excerpt,
    url: input.url ?? `https://example.com/${input.id}`,
    imageUrl: input.imageUrl,
    publishedAt: input.publishedAt ?? "2026-01-01T00:00:00.000Z",
    authors: input.authors ?? [],
    query: input.query ?? "fixture topic",
  };
}

function bundle(query: string, items: ResearchItem[]): ResearchBundle {
  return {
    query,
    generatedAt: "2026-09-16T00:00:00.000Z",
    items,
    unavailableSources: [],
    coverage: {
      domestic: items.filter((entry) => entry.region === "domestic").length,
      international: items.filter((entry) => entry.region === "international").length,
      global: items.filter((entry) => entry.region === "global").length,
      uniqueSources: new Set(items.map((entry) => entry.sourceName)).size,
    },
  };
}

const official = item({
  id: "official-1",
  title: "Official timeline",
  sourceKind: "article",
  publishedAt: "2026-03-01T00:00:00.000Z",
});
const comment = item({
  id: "comment-1",
  title: "A public comment",
  sourceKind: "comment",
  sourceName: "Forum",
  publishedAt: "2026-01-01T00:00:00.000Z",
});
const paper = item({
  id: "paper-1",
  title: "Peer-reviewed measurements",
  sourceKind: "paper",
  sourceName: "Journal",
  imageUrl: "https://example.com/chart.png",
  publishedAt: "2026-02-01T00:00:00.000Z",
});

const searched: string[] = [];
let assessmentCall = 0;
const result = await collectArticleEvidence("Test domain", "Fixture topic", {
  collect: async (_domain, query) => {
    searched.push(query);
    return searched.length === 1
      ? bundle(query, [official, comment])
      : bundle(query, [paper]);
  },
  enrichContent: async (items) => items,
  enrichImages: async (items) => items,
  ask: async (prompt) => {
    if (prompt.includes("TASK: evidence-clue-graph")) {
      return JSON.stringify({
        primaryAxis: "time",
        rationale: "The dated evidence forms a clear sequence.",
        nodes: [
          {
            id: "N01",
            label: "The official record",
            axisValue: "2026-03-01",
            role: "opening",
            claimIds: ["C01"],
            sourceRefs: [1],
            mediaSourceRefs: [],
            uncertainty: "",
          },
          {
            id: "N02",
            label: "The measured result",
            axisValue: "2026-02-01",
            role: "evidence",
            claimIds: ["C02"],
            sourceRefs: [2],
            mediaSourceRefs: [2],
            uncertainty: "",
          },
        ],
        edges: [
          {
            from: "N01",
            to: "N02",
            type: "supports",
            explanation: "The measurement adds evidence to the official record.",
          },
        ],
      });
    }

    assessmentCall += 1;
    if (assessmentCall === 1) {
      return JSON.stringify({
        objectiveFacts: [
          { statement: "The official record contains a dated event.", sourceRefs: [1], confidence: "confirmed" },
          { statement: "Everyone agrees with the event.", sourceRefs: [2], confidence: "confirmed" },
        ],
        keywords: ["official measurement"],
        gaps: [{ question: "Is there an independent measurement?", critical: true }],
        nextQueries: ["Fixture topic independent measurement"],
        saturated: false,
        reason: "An independent measurement is missing.",
      });
    }
    return JSON.stringify({
      objectiveFacts: [
        { statement: "The official record contains a dated event.", sourceRefs: [1], confidence: "confirmed" },
        { statement: "A paper reports an independent measurement.", sourceRefs: [2], confidence: "confirmed" },
      ],
      keywords: ["measurement methodology"],
      gaps: [],
      nextQueries: [],
      saturated: true,
      reason: "The material claim is independently measured and no critical gap remains.",
    });
  },
});

assert.deepEqual(searched, ["Fixture topic", "Fixture topic independent measurement"]);
assert.equal(result.evidence.iterations, 2);
assert.equal(result.evidence.saturated, true);
assert.equal(result.evidence.claims.length, 2, "comment-only generalization must be discarded");
assert.deepEqual(result.evidence.claims.map((claim) => claim.sourceRefs), [[1], [2]]);
assert.equal(result.bundle.items[0].id, "official-1");
assert.equal(result.bundle.items[1].id, "paper-1");
assert.deepEqual(result.evidence.clueGraph.nodes[1].mediaSourceRefs, [2]);
assert.match(formatArticleEvidenceContext(result), /OBJECTIVE FACT LEDGER/);
assert.match(formatArticleEvidenceContext(result), /C02\. A paper reports an independent measurement\. \[2\]/);

let cappedCollectCount = 0;
let cappedAssessmentCount = 0;
const capped = await collectArticleEvidence("Test domain", "Never saturated", {
  maxIterations: 99,
  minIterations: 1,
  collect: async (_domain, query) => {
    cappedCollectCount += 1;
    return bundle(query, [official]);
  },
  enrichContent: async (items) => items,
  enrichImages: async (items) => items,
  ask: async () => {
    cappedAssessmentCount += 1;
    return JSON.stringify({
      objectiveFacts: [
        { statement: "The official record contains a dated event.", sourceRefs: [1], confidence: "confirmed" },
      ],
      keywords: [`gap-${cappedAssessmentCount}`],
      gaps: [{ question: "A critical gap remains.", critical: true }],
      nextQueries: [`Never saturated query ${cappedAssessmentCount}`],
      saturated: false,
      reason: "A critical gap remains.",
    });
  },
});

assert.equal(cappedCollectCount, 10, "research must enforce the ten-round hard limit");
assert.equal(capped.evidence.iterations, 10);
assert.equal(capped.evidence.saturated, false);
assert.match(capped.evidence.stopReason, /10-round limit/i);
assert.equal(hasDraftableEvidence(capped.evidence), true);
assert.ok(capped.evidence.clueGraph.nodes.length > 0);
assert.match(formatArticleEvidenceContext(capped), /LIMITED-EVIDENCE MODE/);
assert.equal(hasDraftableEvidence({ ...capped.evidence, claims: [] }), false);

const passingAudit = await auditArticleEvidenceDraft(
  "Fixture topic",
  { title: "Fixture topic", paragraphs: ["A sourced statement.[1]"] },
  result.evidence.claims,
  2,
  {
    ask: async () => JSON.stringify({
      factsSupported: true,
      citationsReasonable: true,
      topicAligned: true,
      toneAcceptable: true,
      issues: [],
    }),
  }
);
assert.equal(passingAudit.pass, true);
assert.equal(passingAudit.evidenceBoundaryHonest, true);

const limitedEvidenceAudit = await auditArticleEvidenceDraft(
  "Fixture topic",
  { title: "What verified sources show", paragraphs: ["The verified record contains a dated event.[1]"] },
  result.evidence.claims,
  2,
  {
    evidenceSaturated: false,
    openGaps: ["The long-term outcome remains unverified."],
    ask: async () => JSON.stringify({
      factsSupported: true,
      citationsReasonable: true,
      topicAligned: true,
      toneAcceptable: true,
      evidenceBoundaryHonest: true,
      issues: [],
    }),
  }
);
assert.equal(limitedEvidenceAudit.pass, true, "ten-round limited evidence may still yield a valid article");

const invalidCitationAudit = await auditArticleEvidenceDraft(
  "Fixture topic",
  { title: "Fixture topic", paragraphs: ["A claim with an invented source.[99]"] },
  result.evidence.claims,
  2,
  {
    requireToneCheck: true,
    ask: async () => JSON.stringify({
      factsSupported: true,
      citationsReasonable: true,
      topicAligned: true,
      toneAcceptable: false,
      issues: ["The ending uses a formulaic AI summary."],
    }),
  }
);
assert.equal(invalidCitationAudit.pass, false);
assert.equal(invalidCitationAudit.citationsReasonable, false);
assert.equal(invalidCitationAudit.toneAcceptable, false);
assert.match(invalidCitationAudit.issues.join(" "), /\[99\]/);
assert.match(evidenceDraftRepairInstruction(invalidCitationAudit, 1), /cycle 1 of 3/i);

const articleWithMatchedMedia: GeneratedArticle = {
  title: "Official timeline",
  paragraphs: ["The official timeline records the event.[1]"],
  figure: {
    title: "Figure 1",
    caption: "Figure 1. The official timeline.",
    origin: "web",
    mediaKind: "image",
    mimeType: "image/png",
    mediaDataUri: "data:image/png;base64,AAAA",
    width: 1,
    height: 1,
    alt: "The official timeline",
    sourceName: official.sourceName,
    sourceTitle: official.title,
    sourceUrl: official.url,
    sourceRef: 1,
    afterParagraphIndex: 0,
  },
};
assert.equal(articleMediaMatchesBody(articleWithMatchedMedia, [official]), true);
assert.equal(
  articleMediaMatchesBody({
    ...articleWithMatchedMedia,
    figure: { ...articleWithMatchedMedia.figure!, sourceUrl: "https://wrong.example/image" },
  }, [official]),
  false,
  "a figure whose provenance no longer matches its source ref must fail"
);

console.log("evidence pipeline tests passed");
