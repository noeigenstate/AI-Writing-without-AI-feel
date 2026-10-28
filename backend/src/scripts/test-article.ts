import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import JSZip from "jszip";
import { createApp } from "../app.js";
import { assertDraftableEvidence } from "../routes/article.routes.js";
import { ArticleEvidenceIncompleteError, type ArticleEvidenceReport } from "../services/research/evidencePipeline.js";
import { parseDocx, exportDocx, createDocxFromBlocks, createDocxFromParagraphs } from "../services/docx.js";
import {
  ARTICLE_DOMAINS,
  analyzeArticleReadingFlow,
  articleBodyLength,
  articleToDocBlocks,
  articleToDocParagraphs,
  articleToRenderBlocks,
  enrichArticleWithResearch,
  ArticleModelOutputError,
  generateArticleDraft,
  generateTopicOptions,
  matchArticleDomainFromTitle,
  preservesSectionStructure,
  type ArticleMediaDependencies,
} from "../services/article.js";
import { articleDraftPrompt, articleLengthFixPrompt, articleTopicsPrompt } from "../prompts/article.prompts.js";
import { writingSceneProfile } from "../data/writingScenes.js";
import { escapeSvg, truncate } from "../lib/text.js";
import type { SafeImageBinary } from "../services/research/images.js";
import type { LicensedMediaItem } from "../services/research/licensedMedia.js";
import type { ResearchItem } from "../services/research/types.js";
import {
  ARTICLE_LENGTH_SPECS,
  countArticleBody,
  isArticleLengthTier,
  measureArticleLength,
} from "../services/articleLength.js";

const emptyEvidence: ArticleEvidenceReport = {
  status: "incomplete",
  iterations: 10,
  saturated: false,
  stopReason: "No verifiable source material was retrieved.",
  rounds: [],
  claims: [],
  clueGraph: { primaryAxis: "event", rationale: "", nodes: [], edges: [] },
};
assert.throws(() => assertDraftableEvidence(emptyEvidence, "zh"), (error) => {
  assert.ok(error instanceof ArticleEvidenceIncompleteError);
  assert.equal(error.message, "经过 10 轮检索没有找到任何可用来源，已停止生成。可以换一个更具体的标题或话题再试。");
  assert.equal(error.evidence, emptyEvidence);
  return true;
});
assert.throws(() => assertDraftableEvidence(emptyEvidence, "en"), /10 research rounds found no usable sources/);
assert.throws(() => assertDraftableEvidence({
  ...emptyEvidence,
  stopReason: "No objective fact remained after source validation.",
}, "zh"), /仍没有可用于成文的客观事实/);

const docx = await createDocxFromParagraphs([
  { kind: "heading1", text: "这是一篇公众号文章标题" },
  { kind: "normal", text: "第一段正文，保留自然语气。" },
  { kind: "normal", text: "第二段正文，继续展开观点。" },
]);

const unicodeBoundary = truncate(`${"a".repeat(94)}😀b`, 96);
assert.doesNotThrow(() => encodeURIComponent(`<svg><text>${escapeSvg(unicodeBoundary)}</text></svg>`));
assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(unicodeBoundary), false);
assert.equal(escapeSvg("bad\ud83d control\u0001"), "bad� control");

const parsed = await parseDocx(docx);
assert.equal(parsed.paragraphs.length, 3);
assert.equal(parsed.paragraphs[0].kind, "heading1");
assert.equal(parsed.paragraphs[0].text, "这是一篇公众号文章标题");

const exported = await exportDocx(docx, ["换一个更有钩子的标题", undefined, "第二段改成新的表达。"]);
const reparsed = await parseDocx(exported);
assert.equal(reparsed.paragraphs[0].text, "换一个更有钩子的标题");
assert.equal(reparsed.paragraphs[1].text, "第一段正文，保留自然语气。");
assert.equal(reparsed.paragraphs[2].text, "第二段改成新的表达。");

const domain = ARTICLE_DOMAINS[0];
const lengthPromptBase = {
  domainName: domain.name,
  topic: { id: "length", title: "AI agents for small teams", angle: "cost and workflow", audience: "founders", keywords: ["AI"] },
  lang: "zh" as const,
  researchCoverage: { domestic: 2, international: 2, global: 0, uniqueSources: 4 },
};
assert.deepEqual(ARTICLE_LENGTH_SPECS.zh, {
  short: { unit: "characters", min: 450, max: 650 },
  medium: { unit: "characters", min: 1000, max: 1300 },
  long: { unit: "characters", min: 3000, max: 3800 },
});
assert.deepEqual(ARTICLE_LENGTH_SPECS.en, {
  short: { unit: "words", min: 350, max: 500 },
  medium: { unit: "words", min: 850, max: 1100 },
  long: { unit: "words", min: 2200, max: 2800 },
});
assert.ok(articleDraftPrompt({ ...lengthPromptBase, targetLength: "short" }).includes("450-650 字正文"));
assert.ok(articleDraftPrompt({ ...lengthPromptBase, targetLength: "medium" }).includes("1000-1300 字正文"));
assert.ok(articleDraftPrompt({ ...lengthPromptBase, targetLength: "long" }).includes("3000-3800 字正文"));
assert.ok(
  articleDraftPrompt({ ...lengthPromptBase, lang: "en", targetLength: "medium" }).includes("850-1100 body words")
);
assert.ok(
  articleDraftPrompt({
    ...lengthPromptBase,
    researchCoverage: { domestic: 3, international: 0, global: 0, uniqueSources: 3 },
  }).includes("不要虚构国际观点")
);
assert.ok(
  articleDraftPrompt({
    ...lengthPromptBase,
    lang: "en",
    researchCoverage: { domestic: 0, international: 3, global: 0, uniqueSources: 3 },
  }).includes("do not invent domestic views")
);
assert.ok(articleDraftPrompt({ ...lengthPromptBase, targetLength: "medium" }).includes("同时使用国内外材料"));
assert.ok(
  articleDraftPrompt({ ...lengthPromptBase, lang: "en", targetLength: "medium" }).includes(
    "Use both domestic and international material"
  )
);

// 中英文草稿提示都必须把“材料逻辑化、叙事节拍与视觉意图”写成可解析契约，
// 同时明确文学手法的事实边界，避免把修辞变成硬凑的任务清单。
const structuredZhPrompt = articleDraftPrompt({ ...lengthPromptBase, targetLength: "medium" });
for (const phrase of [
  "合并重复信息",
  "不得按来源顺序摘要",
  "role：hook",
  "欲扬先抑最多 1 次",
  "拟人最多",
  "情景交融最多",
  "paragraphs 必须优先使用对象数组",
  "mediaHints 必须存在",
  "afterParagraph",
  "优先用 sourceRefs 绑定标有“来源图片可用: 是”",
  "没有与内容匹配的有图来源时，mediaHints 可以为空",
]) {
  assert.ok(structuredZhPrompt.includes(phrase), `Chinese article prompt is missing: ${phrase}`);
}

const structuredEnPrompt = articleDraftPrompt({
  ...lengthPromptBase,
  lang: "en",
  targetLength: "medium",
});
for (const phrase of [
  "merge that duplication internally",
  "Never organize the article as",
  "uses one role: hook",
  "Use contrast-before-reveal at most once",
  "Use personification at most",
  "scene-emotion anchor",
  "paragraphs must use the preferred object array",
  "mediaHints must be present",
  "afterParagraph",
  'Prioritize sourceRefs whose existing "source material N" entry is marked "来源图片可用: 是"',
  "If no image-bearing source genuinely matches the content, mediaHints may be empty",
]) {
  assert.ok(structuredEnPrompt.includes(phrase), `English article prompt is missing: ${phrase}`);
}
const crossRegionFixPrompt = articleLengthFixPrompt(
  { title: "短稿", paragraphs: ["内容不足。"] },
  { ...lengthPromptBase, targetLength: "medium" },
  5
);
assert.ok(crossRegionFixPrompt.includes("优先补充国内外材料的跨区域对照"));
assert.ok(crossRegionFixPrompt.includes("不要把来源数量当成共识证据"));
assert.ok(articleTopicsPrompt("科技", "技术变化", 3, "", "zh").includes("国内外视角的共同点"));
assert.ok(
  articleTopicsPrompt("Technology", "technical change", 3, "", "en").includes(
    "domestic and international perspectives"
  )
);
assert.equal(isArticleLengthTier("short"), true);
assert.equal(isArticleLengthTier("medium"), true);
assert.equal(isArticleLengthTier("long"), true);
assert.equal(isArticleLengthTier("regular"), false);
assert.equal(isArticleLengthTier(3), false);

// 两个生成入口都必须在进入研究/模型流程前拒绝非法 targetLength。
const app = createApp();
const server = app.listen(0);
await once(server, "listening");
try {
  const port = (server.address() as AddressInfo).port;
  for (const request of [
    { path: "/api/article/generate", body: { topic: "Runtime validation", targetLength: "regular" } },
    {
      path: "/api/article/generate-from-title",
      body: { title: "Runtime validation", targetLength: "regular" },
    },
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
    });
    assert.equal(response.status, 400);
    assert.match(String((await response.json() as { error?: unknown }).error), /targetLength/);
  }
  const malformedTopic = await fetch(`http://127.0.0.1:${port}/api/article/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic: {}, lang: "zh" }),
  });
  assert.equal(malformedTopic.status, 400);
  assert.match(String((await malformedTopic.json() as { error?: unknown }).error), /选题格式无效/);
} finally {
  server.close();
  await once(server, "close");
}

// 标题不计入正文；中文去空白后按 Unicode code points（代理对 emoji 只算 1）计数。
assert.equal(countArticleBody(["你 好", "🙂\n界"], "zh"), 4);
assert.equal(countArticleBody(["正文[1]仍是正文[12]"], "zh"), 6);
assert.equal(articleBodyLength({ title: "这个标题很长很长", paragraphs: ["正文"] }, "zh"), 2);
assert.equal(countArticleBody(["One  two", "three\nfour"], "en"), 4);
assert.equal(countArticleBody(["One claim [1] and another [22]"], "en"), 4);
assert.deepEqual(measureArticleLength(["word ".repeat(350)], "en", "short"), {
  tier: "short",
  unit: "words",
  actual: 350,
  min: 350,
  max: 500,
  inRange: true,
});
assert.ok(writingSceneProfile("wechat", "zh").includes("公众号"));
assert.ok(writingSceneProfile("technical", "en").includes("technical docs"));

let topicPrompt = "";
const topicResearchTitle = "Useful AI Agents for Small Teams";
const topics = await generateTopicOptions(
  {
    domain,
    n: 2,
    researchContext: `来源：arXiv\n${topicResearchTitle}`,
  },
  async (prompt, opts) => {
    topicPrompt = prompt;
    assert.equal(opts?.disableThinking, true);
    return JSON.stringify([
      {
        title: "AI 应用开始进入小团队",
        angle: "从成本和交付效率切入",
        audience: "创业者、产品经理",
        keywords: ["AI", "效率"],
      },
      {
        title: "大模型工具的隐形门槛",
        angle: "讲清楚普通团队踩坑的地方",
        audience: "内容创作者",
        keywords: ["大模型", "工作流"],
      },
    ]);
  }
);
assert.equal(topics.length, 2);
assert.ok(topics[0].id);
assert.ok(topicPrompt.includes(domain.name));
assert.ok(topicPrompt.includes(topicResearchTitle));
assert.deepEqual(topics[0].keywords, ["AI", "效率"]);

const wrappedTopics = await generateTopicOptions(domain, 1, async () =>
  JSON.stringify({
    topics: [
      {
        title: "包装在对象里的选题",
        angle: "验证模型返回对象时也能解析",
        audience: "产品经理",
        keywords: ["解析"],
      },
    ],
  })
);
assert.equal(wrappedTopics.length, 1);
assert.equal(wrappedTopics[0].title, "包装在对象里的选题");

let topicRepairCalls = 0;
const repairedTopics = await generateTopicOptions(domain, 1, async () => {
  topicRepairCalls += 1;
  if (topicRepairCalls === 1) {
    return '{"topics":[{"title":"Broken topic","angle":"Missing tail"';
  }
  return JSON.stringify([
    {
      title: "修复后的选题",
      angle: "验证坏 JSON 会自动修复",
      audience: "测试用户",
      keywords: ["repair"],
    },
  ]);
});
assert.equal(topicRepairCalls, 2);
assert.equal(repairedTopics.length, 1);
assert.equal(repairedTopics[0].title, "修复后的选题");

const matchedDomain = await matchArticleDomainFromTitle("孩子用 AI 写作业，学校到底该怎么管", "zh", async (prompt, opts) => {
  assert.ok(prompt.includes("孩子用 AI 写作业"));
  assert.equal(opts?.disableThinking, true);
  return JSON.stringify({
    domainId: "education",
    confidence: 91,
    reasons: ["标题核心对象是学生和学校", "争议焦点是教育管理"],
  });
});
assert.equal(matchedDomain.domain.id, "education");
assert.equal(matchedDomain.score, 91);
assert.equal(matchedDomain.reasons.length, 2);

let articlePrompt = "";
let articleDraftCalls = 0;
const articleResearchTitle = "Small Teams Adopt Agentic Workflows";
// 四段各 136 字，总长落在 zh short 档的精确区间内，不应触发长度纠偏
const inBandParagraph = "小团队先把重复流程挑出来，再决定要不要上工具，这一步决定后面的成败。".repeat(4);
const article = await generateArticleDraft(
  {
    domainName: domain.name,
    topic: topics[0],
    styleSummary: "短句多，少套话，开头直接。",
    targetLength: "short",
    researchContext: `来源：Industry Report\n${articleResearchTitle}`,
    lang: "zh",
  },
  async (prompt, opts) => {
    articleDraftCalls += 1;
    articlePrompt = prompt;
    assert.equal(opts?.disableThinking, true);
    return JSON.stringify({
      title: "小团队用 AI，先别急着买工具",
      paragraphs: [inBandParagraph, inBandParagraph, inBandParagraph, inBandParagraph],
    });
  }
);
assert.equal(article.title, "小团队用 AI，先别急着买工具");
assert.equal(article.paragraphs.length, 4);
assert.ok(articlePrompt.includes(articleResearchTitle));
// 长度已达标：只调用一次，不触发纠偏
assert.equal(articleDraftCalls, 1);
assert.deepEqual(article.length, {
  tier: "short",
  unit: "characters",
  actual: 544,
  min: 450,
  max: 650,
  inRange: true,
});

const englishParagraph = (label: string, wordCount = 70) =>
  [label, ...Array.from({ length: wordCount - 1 }, () => "word")].join(" ");

// 首选对象式 paragraphs 必须被规范化为正文、role、section heading 与 0-based 媒体锚点。
let structuredDraftCalls = 0;
const structuredArticle = await generateArticleDraft(
  {
    domainName: domain.name,
    topic: "Turn research into a readable argument",
    targetLength: "short",
    lang: "en",
  },
  async (_prompt, opts) => {
    structuredDraftCalls += 1;
    assert.equal(opts?.disableThinking, true);
    return JSON.stringify({
      title: "A research pile is not yet an article",
      paragraphs: [
        { role: "hook", heading: "", text: englishParagraph("opening") },
        { role: "context", heading: "", text: englishParagraph("context") },
        { role: "evidence", heading: "What the evidence changes", text: englishParagraph("evidence") },
        { role: "mechanism", heading: "", text: englishParagraph("mechanism") },
        { role: "resolution", heading: "", text: englishParagraph("resolution") },
      ],
      mediaHints: [
        {
          afterParagraph: 3,
          kind: "gif",
          purpose: "explanation",
          query: "an editorial process diagram moving from scattered notes to one clear argument",
          alt: "Scattered research notes converging into a single article structure",
          caption: "From source pile to narrative spine",
          sourceRefs: [2, 1, 2, -1],
        },
      ],
    });
  }
);
assert.equal(structuredDraftCalls, 1, "a sound structured draft should not trigger flow or length repair");
assert.deepEqual(structuredArticle.paragraphRoles, ["hook", "context", "evidence", "mechanism", "resolution"]);
assert.deepEqual(structuredArticle.sectionBreaks, [
  { beforeParagraphIndex: 2, heading: "What the evidence changes" },
]);
assert.deepEqual(structuredArticle.mediaHints, [
  {
    afterParagraphIndex: 2,
    kind: "gif",
    purpose: "explanation",
    query: "an editorial process diagram moving from scattered notes to one clear argument",
    alt: "Scattered research notes converging into a single article structure",
    caption: "From source pile to narrative spine",
    sourceRefs: [2, 1],
  },
]);
assert.equal(structuredArticle.length?.actual, 350);

// Once object paragraphs opt into the structured contract, every paragraph
// must provide a valid role. An incomplete object draft gets one bounded retry
// with the original full prompt instead of silently becoming a legacy draft.
let incompleteStructuredDraftCalls = 0;
let incompleteStructuredPrompt = "";
const recoveredStructuredArticle = await generateArticleDraft(
  {
    domainName: domain.name,
    topic: "retry an incomplete structured draft",
    targetLength: "short",
    lang: "en",
  },
  async (prompt) => {
    incompleteStructuredDraftCalls += 1;
    if (incompleteStructuredDraftCalls === 1) {
      incompleteStructuredPrompt = prompt;
      return JSON.stringify({
        title: "Incomplete structured draft",
        paragraphs: Array.from({ length: 5 }, (_, index) => ({
          ...(index < 4 ? { role: "context" } : {}),
          heading: "",
          text: englishParagraph(`incomplete-${index}`, 80),
        })),
      });
    }
    assert.equal(prompt, incompleteStructuredPrompt, "invalid structured output must retry the full generation prompt");
    return JSON.stringify({
      title: "Recovered structured draft",
      paragraphs: ["hook", "context", "evidence", "mechanism", "resolution"].map((role, index) => ({
        role,
        heading: "",
        text: englishParagraph(`recovered-${index}`, 80),
      })),
    });
  }
);
assert.equal(incompleteStructuredDraftCalls, 2);
assert.equal(recoveredStructuredArticle.title, "Recovered structured draft");
assert.deepEqual(recoveredStructuredArticle.paragraphRoles, ["hook", "context", "evidence", "mechanism", "resolution"]);
assert.equal(recoveredStructuredArticle.length?.inRange, true);

const structuredDocBlocks = articleToDocBlocks(structuredArticle);
const structuredHeadingIndex = structuredDocBlocks.findIndex(
  (block) => block.type === "paragraph" && block.kind === "heading2" && block.text === "What the evidence changes"
);
const structuredEvidenceIndex = structuredDocBlocks.findIndex(
  (block) => block.type === "paragraph" && block.kind === "normal" && block.text.startsWith("evidence ")
);
assert.equal(structuredHeadingIndex + 1, structuredEvidenceIndex, "heading2 must be inserted immediately before its section");

const structuredParsedParagraphs = structuredDocBlocks.flatMap((block, index) =>
  block.type === "paragraph" ? [{ index, text: block.text }] : []
);
const structuredRenderBlocks = articleToRenderBlocks(structuredArticle, structuredParsedParagraphs);
const renderedHeadingIndex = structuredRenderBlocks.findIndex(
  (block) => block.type === "paragraph" && block.kind === "heading2" && block.text === "What the evidence changes"
);
const renderedEvidenceIndex = structuredRenderBlocks.findIndex(
  (block) => block.type === "paragraph" && block.kind === "normal" && block.text.startsWith("evidence ")
);
assert.equal(renderedHeadingIndex + 1, renderedEvidenceIndex);
assert.equal(
  structuredRenderBlocks[renderedHeadingIndex]?.type === "paragraph"
    ? structuredRenderBlocks[renderedHeadingIndex].paragraphIndex
    : undefined,
  structuredParsedParagraphs.find((paragraph) => paragraph.text === "What the evidence changes")?.index
);

// 阅读流评分只检查可观察结构：坏稿显著降分，角色齐全、证据后有机制且可扫读的稿件保持高分。
const badFlowArticle = {
  title: "Flat source digest",
  paragraphs: Array.from({ length: 6 }, () => "The same source summary appears again."),
  paragraphRoles: Array.from({ length: 6 }, () => "context" as const),
};
const goodFlowArticle = {
  title: "A readable argument",
  paragraphs: ["Open question", "Verified evidence", "Mechanism", "Boundary", "Turn", "Closing answer"],
  paragraphRoles: ["hook", "evidence", "mechanism", "counterpoint", "turn", "resolution"] as const,
  sectionBreaks: [
    { beforeParagraphIndex: 1, heading: "What changed?" },
    { beforeParagraphIndex: 3, heading: "Where is the limit?" },
  ],
};
const badFlow = analyzeArticleReadingFlow(badFlowArticle, "medium", "en");
const goodFlow = analyzeArticleReadingFlow(
  { ...goodFlowArticle, paragraphRoles: [...goodFlowArticle.paragraphRoles] },
  "medium",
  "en"
);
assert.ok(badFlow.score < 66, `bad flow score should trigger a repair, got ${badFlow.score}`);
assert.ok(badFlow.issues.length >= 5);
assert.equal(goodFlow.score, 100);
assert.deepEqual(goodFlow.issues, []);

const repeatedFlowParagraph = englishParagraph("repeated");
const improvedFlowPayload = {
  title: "The repaired narrative",
  paragraphs: [
    { role: "hook", heading: "", text: englishParagraph("hook") },
    { role: "context", heading: "", text: englishParagraph("setting") },
    { role: "evidence", heading: "", text: englishParagraph("proof") },
    { role: "mechanism", heading: "", text: englishParagraph("explanation") },
    { role: "resolution", heading: "", text: englishParagraph("answer") },
  ],
  mediaHints: [],
};

let improvingFlowCalls = 0;
const improvedFlowArticle = await generateArticleDraft(
  { domainName: domain.name, topic: "repair reading flow", targetLength: "short", lang: "en" },
  async (prompt) => {
    improvingFlowCalls += 1;
    if (improvingFlowCalls === 1) {
      return JSON.stringify({
        title: "The flat original",
        paragraphs: Array.from({ length: 5 }, () => ({ role: "context", heading: "", text: repeatedFlowParagraph })),
        mediaHints: [],
      });
    }
    assert.ok(prompt.includes("reading-flow repair"));
    return JSON.stringify(improvedFlowPayload);
  }
);
assert.equal(improvingFlowCalls, 2, "flow repair is attempted once for a structurally poor draft");
assert.equal(improvedFlowArticle.title, "The repaired narrative");
assert.equal(analyzeArticleReadingFlow(improvedFlowArticle, "short", "en").score, 100);

const mediumSectionBreaks = [
  { beforeParagraphIndex: 2, heading: "What the evidence shows" },
  { beforeParagraphIndex: 5, heading: "Where the boundary sits" },
];
const mediumFlatParagraphs = Array.from({ length: 8 }, () => ({
  role: "context",
  heading: "",
  text: englishParagraph("flat-medium", 110),
}));
mediumFlatParagraphs[2].heading = mediumSectionBreaks[0].heading;
mediumFlatParagraphs[5].heading = mediumSectionBreaks[1].heading;
const mediumImprovedRoles = [
  "hook",
  "context",
  "evidence",
  "mechanism",
  "counterpoint",
  "evidence",
  "mechanism",
  "resolution",
] as const;
const mediumImprovedParagraphs = (withHeadings: boolean) => mediumImprovedRoles.map((role, index) => ({
  role,
  heading: withHeadings
    ? mediumSectionBreaks.find((section) => section.beforeParagraphIndex === index)?.heading ?? ""
    : "",
  text: englishParagraph(`improved-medium-${index}`, 110),
}));

assert.equal(preservesSectionStructure(
  {
    title: "Original with sections",
    paragraphs: mediumFlatParagraphs.map((paragraph) => paragraph.text),
    paragraphRoles: mediumFlatParagraphs.map(() => "context" as const),
    sectionBreaks: mediumSectionBreaks,
  },
  {
    title: "Candidate without sections",
    paragraphs: mediumImprovedParagraphs(false).map((paragraph) => paragraph.text),
    paragraphRoles: [...mediumImprovedRoles],
  },
  "medium"
), false, "blank or missing headings cannot satisfy the medium section floor");

let sectionDroppingFlowCalls = 0;
const articleAfterSectionDroppingRepair = await generateArticleDraft(
  { domainName: domain.name, topic: "preserve medium section headings", targetLength: "medium", lang: "en" },
  async () => {
    sectionDroppingFlowCalls += 1;
    return JSON.stringify({
      title: sectionDroppingFlowCalls === 1 ? "Keep sectioned original" : "Do not drop its sections",
      paragraphs: sectionDroppingFlowCalls === 1 ? mediumFlatParagraphs : mediumImprovedParagraphs(false),
      mediaHints: [],
    });
  }
);
assert.equal(sectionDroppingFlowCalls, 2);
assert.equal(articleAfterSectionDroppingRepair.title, "Keep sectioned original");
assert.deepEqual(articleAfterSectionDroppingRepair.sectionBreaks, mediumSectionBreaks);

let sectionPreservingFlowCalls = 0;
const articleAfterSectionPreservingRepair = await generateArticleDraft(
  { domainName: domain.name, topic: "retain medium section headings", targetLength: "medium", lang: "en" },
  async () => {
    sectionPreservingFlowCalls += 1;
    return JSON.stringify({
      title: sectionPreservingFlowCalls === 1 ? "Flat but sectioned original" : "Improved and still sectioned",
      paragraphs: sectionPreservingFlowCalls === 1 ? mediumFlatParagraphs : mediumImprovedParagraphs(true),
      mediaHints: [],
    });
  }
);
assert.equal(sectionPreservingFlowCalls, 2);
assert.equal(articleAfterSectionPreservingRepair.title, "Improved and still sectioned");
assert.deepEqual(articleAfterSectionPreservingRepair.sectionBreaks, mediumSectionBreaks);
assert.equal(analyzeArticleReadingFlow(articleAfterSectionPreservingRepair, "medium", "en").score, 100);

let nonImprovingFlowCalls = 0;
const retainedFlowArticle = await generateArticleDraft(
  { domainName: domain.name, topic: "reject a lateral rewrite", targetLength: "short", lang: "en" },
  async () => {
    nonImprovingFlowCalls += 1;
    return JSON.stringify({
      title: nonImprovingFlowCalls === 1 ? "Keep this original" : "Do not adopt this lateral rewrite",
      paragraphs: Array.from({ length: 5 }, () => ({ role: "context", heading: "", text: repeatedFlowParagraph })),
      mediaHints: [],
    });
  }
);
assert.equal(nonImprovingFlowCalls, 2);
assert.equal(retainedFlowArticle.title, "Keep this original", "a repair is adopted only when its flow score improves");

let shorterFlowCalls = 0;
const articleAfterShorterFlowRepair = await generateArticleDraft(
  { domainName: domain.name, topic: "reject a shorter flow rewrite", targetLength: "short", lang: "en" },
  async () => {
    shorterFlowCalls += 1;
    if (shorterFlowCalls === 1) {
      return JSON.stringify({
        title: "Keep the in-range original",
        paragraphs: Array.from({ length: 5 }, () => ({ role: "context", heading: "", text: repeatedFlowParagraph })),
        mediaHints: [],
      });
    }
    return JSON.stringify({
      ...improvedFlowPayload,
      title: "Structurally better but much too short",
      paragraphs: improvedFlowPayload.paragraphs.map((paragraph) => ({
        ...paragraph,
        text: englishParagraph(paragraph.role, 10),
      })),
    });
  }
);
assert.equal(shorterFlowCalls, 2);
assert.equal(articleAfterShorterFlowRepair.title, "Keep the in-range original");
assert.equal(articleAfterShorterFlowRepair.length?.inRange, true);

let citationDroppingFlowCalls = 0;
const articleAfterCitationDroppingRepair = await generateArticleDraft(
  { domainName: domain.name, topic: "preserve citations during flow repair", targetLength: "short", lang: "en" },
  async () => {
    citationDroppingFlowCalls += 1;
    if (citationDroppingFlowCalls === 1) {
      return JSON.stringify({
        title: "Keep cited original",
        paragraphs: Array.from({ length: 5 }, (_, index) => ({
          role: "context",
          heading: "",
          text: `${repeatedFlowParagraph}${index < 2 ? " [1]" : ""}`,
        })),
        mediaHints: [],
      });
    }
    return JSON.stringify({
      ...improvedFlowPayload,
      title: "Dropped one occurrence of the original citation",
      paragraphs: improvedFlowPayload.paragraphs.map((paragraph, index) => ({
        ...paragraph,
        text: `${paragraph.text}${index === 0 ? " [1]" : ""}`,
      })),
    });
  }
);
assert.equal(citationDroppingFlowCalls, 2);
assert.equal(articleAfterCitationDroppingRepair.title, "Keep cited original");

let mediaDroppingFlowCalls = 0;
const articleAfterMediaDroppingRepair = await generateArticleDraft(
  { domainName: domain.name, topic: "preserve media intent during flow repair", targetLength: "short", lang: "en" },
  async () => {
    mediaDroppingFlowCalls += 1;
    if (mediaDroppingFlowCalls === 1) {
      return JSON.stringify({
        title: "Keep media-planned original",
        paragraphs: Array.from({ length: 5 }, () => ({ role: "context", heading: "", text: repeatedFlowParagraph })),
        mediaHints: [{
          afterParagraph: 3,
          kind: "image",
          purpose: "explanation",
          query: "a three-step explanation card",
          alt: "Three connected explanation steps",
          sourceRefs: [1],
        }],
      });
    }
    return JSON.stringify({ ...improvedFlowPayload, title: "Dropped the visual plan", mediaHints: [] });
  }
);
assert.equal(mediaDroppingFlowCalls, 2);
assert.equal(articleAfterMediaDroppingRepair.title, "Keep media-planned original");
assert.equal(articleAfterMediaDroppingRepair.mediaHints?.length, 1);

let legacyFlowCalls = 0;
const articleAfterLegacyFlowRepair = await generateArticleDraft(
  { domainName: domain.name, topic: "reject structureless flow rewrite", targetLength: "short", lang: "en" },
  async () => {
    legacyFlowCalls += 1;
    if (legacyFlowCalls === 1) {
      return JSON.stringify({
        title: "Keep structured original",
        paragraphs: Array.from({ length: 5 }, () => ({ role: "context", heading: "", text: repeatedFlowParagraph })),
        mediaHints: [],
      });
    }
    return JSON.stringify({
      title: "Legacy string-array candidate",
      paragraphs: Array.from({ length: 5 }, (_, index) => englishParagraph(`legacy-${index}`)),
    });
  }
);
assert.equal(legacyFlowCalls, 2);
assert.equal(articleAfterLegacyFlowRepair.title, "Keep structured original");

let partialRoleFlowCalls = 0;
const articleAfterPartialRoleRepair = await generateArticleDraft(
  { domainName: domain.name, topic: "reject partial-role flow rewrite", targetLength: "short", lang: "en" },
  async () => {
    partialRoleFlowCalls += 1;
    if (partialRoleFlowCalls === 1) {
      return JSON.stringify({
        title: "Keep complete role metadata",
        paragraphs: Array.from({ length: 5 }, () => ({ role: "context", heading: "", text: repeatedFlowParagraph })),
        mediaHints: [],
      });
    }
    return JSON.stringify({
      title: "Partial role candidate",
      paragraphs: [
        { role: "hook", text: englishParagraph("partial-hook") },
        englishParagraph("partial-context"),
        { text: englishParagraph("partial-evidence") },
        englishParagraph("partial-mechanism"),
        englishParagraph("partial-resolution"),
      ],
    });
  }
);
assert.equal(partialRoleFlowCalls, 2);
assert.equal(articleAfterPartialRoleRepair.title, "Keep complete role metadata");

let failedFlowRepairCalls = 0;
const articleAfterFailedFlowRepair = await generateArticleDraft(
  { domainName: domain.name, topic: "non-blocking flow repair", targetLength: "short", lang: "en" },
  async () => {
    failedFlowRepairCalls += 1;
    if (failedFlowRepairCalls > 1) throw new Error("temporary flow repair failure");
    return JSON.stringify({
      title: "Usable even before repair",
      paragraphs: Array.from({ length: 5 }, () => ({ role: "context", heading: "", text: repeatedFlowParagraph })),
      mediaHints: [],
    });
  }
);
assert.equal(failedFlowRepairCalls, 2, "the optional repair gets one bounded provider call and remains non-blocking");
assert.equal(articleAfterFailedFlowRepair.title, "Usable even before repair");
assert.equal(articleAfterFailedFlowRepair.length?.inRange, true);

let structurePreservingLengthCalls = 0;
const structurePreservingLengthArticle = await generateArticleDraft(
  { domainName: domain.name, topic: "preserve structure across length repair", targetLength: "short", lang: "en" },
  async () => {
    structurePreservingLengthCalls += 1;
    if (structurePreservingLengthCalls === 1) {
      return JSON.stringify({
        title: "Structured but short",
        paragraphs: [
          { role: "hook", heading: "", text: englishParagraph("short-hook", 20) },
          { role: "context", heading: "Context", text: englishParagraph("short-context", 20) },
          { role: "evidence", heading: "", text: `${englishParagraph("short-evidence", 20)} [1]` },
          { role: "mechanism", heading: "Meaning", text: englishParagraph("short-mechanism", 20) },
          { role: "resolution", heading: "", text: englishParagraph("short-resolution", 20) },
        ],
        mediaHints: [{
          afterParagraph: 3,
          kind: "image",
          purpose: "evidence",
          query: "structured evidence card",
          alt: "Evidence arranged into one readable card",
          sourceRefs: [1],
        }],
      });
    }
    if (structurePreservingLengthCalls === 2) {
      return JSON.stringify({
        title: "Long enough but structureless",
        paragraphs: Array.from({ length: 6 }, (_, index) => englishParagraph(`legacy-length-${index}`, 60)),
      });
    }
    return JSON.stringify({
      title: "Long enough and structured",
      paragraphs: [
        { role: "hook", heading: "", text: englishParagraph("fixed-hook", 70) },
        { role: "evidence", heading: "Evidence", text: `${englishParagraph("fixed-evidence", 70)} [1]` },
        { role: "mechanism", heading: "Meaning", text: englishParagraph("fixed-mechanism", 70) },
        { role: "turn", heading: "Boundary", text: englishParagraph("fixed-turn", 70) },
        { role: "resolution", heading: "", text: englishParagraph("fixed-resolution", 70) },
      ],
      mediaHints: [{
        afterParagraph: 2,
        kind: "image",
        purpose: "evidence",
        query: "structured evidence card",
        alt: "Evidence arranged into one readable card",
        sourceRefs: [1],
      }],
    });
  }
);
assert.equal(structurePreservingLengthCalls, 3);
assert.equal(structurePreservingLengthArticle.title, "Long enough and structured");
assert.equal(structurePreservingLengthArticle.paragraphRoles?.length, 5);
assert.ok(structurePreservingLengthArticle.sectionBreaks?.length);
assert.ok(structurePreservingLengthArticle.mediaHints?.length);

// A same-size length rewrite may improve the body while accidentally returning
// only part of a valid medium section plan. Keep the better prose and inherit
// the original two-heading plan instead of accepting the structural regression.
let sectionSafeLengthCalls = 0;
const sectionSafeLengthArticle = await generateArticleDraft(
  { domainName: domain.name, topic: "preserve sections during medium expansion", targetLength: "medium", lang: "en" },
  async () => {
    sectionSafeLengthCalls += 1;
    const original = sectionSafeLengthCalls === 1;
    const roles = original
      ? ["context", "context", "evidence", "mechanism", "turn", "evidence", "mechanism", "context"]
      : ["hook", "context", "evidence", "mechanism", "turn", "evidence", "mechanism", "resolution"];
    const headings = original
      ? new Map([[2, "What the evidence shows"], [5, "Where the boundary sits"]])
      : new Map([[2, "A partial replacement heading"]]);
    return JSON.stringify({
      title: original ? "Short sectioned medium draft" : "Expanded draft with inherited sections",
      paragraphs: roles.map((role, index) => ({
        role,
        heading: headings.get(index) ?? "",
        text: englishParagraph(`section-length-${sectionSafeLengthCalls}-${index}`, original ? 100 : 130),
      })),
      mediaHints: [],
    });
  }
);
assert.equal(sectionSafeLengthCalls, 2);
assert.equal(sectionSafeLengthArticle.title, "Expanded draft with inherited sections");
assert.deepEqual(sectionSafeLengthArticle.sectionBreaks, [
  { beforeParagraphIndex: 2, heading: "What the evidence shows" },
  { beforeParagraphIndex: 5, heading: "Where the boundary sits" },
]);
assert.equal(analyzeArticleReadingFlow(sectionSafeLengthArticle, "medium", "en").score, 100);
assert.equal(sectionSafeLengthArticle.length?.actual, 1040);

// A lateral first correction must not consume the second bounded correction
// pass. The original stays in place, then the second correction can reach band.
let lateralLengthCalls = 0;
const recoveredAfterLateralLengthPass = await generateArticleDraft(
  { domainName: domain.name, topic: "use the full length correction budget", targetLength: "short", lang: "en" },
  async () => {
    lateralLengthCalls += 1;
    const wordCount = lateralLengthCalls < 3 ? 10 : 400;
    return JSON.stringify({
      title: lateralLengthCalls < 3 ? "Still ten words" : "Second correction reaches target",
      paragraphs: [englishParagraph(`length-pass-${lateralLengthCalls}`, wordCount)],
    });
  }
);
assert.equal(lateralLengthCalls, 3);
assert.equal(recoveredAfterLateralLengthPass.title, "Second correction reaches target");
assert.equal(recoveredAfterLateralLengthPass.length?.actual, 400);

let flatLengthRepairCalls = 0;
const flowSafeLengthArticle = await generateArticleDraft(
  { domainName: domain.name, topic: "length repair must preserve flow", targetLength: "short", lang: "en" },
  async () => {
    flatLengthRepairCalls += 1;
    const roles = flatLengthRepairCalls === 2
      ? ["context", "context", "context", "context", "context"]
      : ["hook", "evidence", "mechanism", "turn", "resolution"];
    const words = flatLengthRepairCalls === 1 ? 20 : 70;
    return JSON.stringify({
      title: flatLengthRepairCalls === 2 ? "Long enough but flat" : "Flow-safe length draft",
      paragraphs: roles.map((role, index) => ({
        role,
        heading: "",
        text: englishParagraph(`flow-length-${flatLengthRepairCalls}-${index}`, words),
      })),
      mediaHints: [],
    });
  }
);
assert.equal(flatLengthRepairCalls, 3);
assert.equal(flowSafeLengthArticle.title, "Flow-safe length draft");
assert.ok(analyzeArticleReadingFlow(flowSafeLengthArticle, "short", "en").score >= 66);

let citedLengthRepairCalls = 0;
const citationSafeLengthArticle = await generateArticleDraft(
  { domainName: domain.name, topic: "length repair must preserve citations", targetLength: "short", lang: "en" },
  async () => {
    citedLengthRepairCalls += 1;
    const words = citedLengthRepairCalls === 1 ? 20 : 70;
    return JSON.stringify({
      title: citedLengthRepairCalls === 2 ? "Dropped citation during expansion" : "Citation-safe length draft",
      paragraphs: ["hook", "evidence", "mechanism", "turn", "resolution"].map((role, index) => ({
        role,
        heading: "",
        text: `${englishParagraph(`citation-length-${citedLengthRepairCalls}-${index}`, words)}${
          index < (citedLengthRepairCalls === 2 ? 1 : 2) ? " [1]" : ""
        }`,
      })),
      mediaHints: [],
    });
  }
);
assert.equal(citedLengthRepairCalls, 3);
assert.equal(citationSafeLengthArticle.title, "Citation-safe length draft");
assert.equal((citationSafeLengthArticle.paragraphs.join(" ").match(/\[1\]/gu) ?? []).length, 2);

let rewrittenMediaLengthCalls = 0;
const rewrittenMediaLengthArticle = await generateArticleDraft(
  { domainName: domain.name, topic: "allow media brief wording to improve", targetLength: "short", lang: "en" },
  async () => {
    rewrittenMediaLengthCalls += 1;
    const words = rewrittenMediaLengthCalls === 1 ? 20 : 70;
    return JSON.stringify({
      title: rewrittenMediaLengthCalls === 1 ? "Short media brief" : "Expanded media brief",
      paragraphs: ["hook", "evidence", "mechanism", "turn", "resolution"].map((role, index) => ({
        role,
        heading: "",
        text: englishParagraph(`media-reword-${rewrittenMediaLengthCalls}-${index}`, words),
      })),
      mediaHints: [{
        afterParagraph: 3,
        kind: "image",
        purpose: "explanation",
        query: rewrittenMediaLengthCalls === 1 ? "three steps on a clean editorial card" : "clean editorial diagram with three connected steps",
        alt: rewrittenMediaLengthCalls === 1 ? "Three steps" : "Three connected steps explaining the mechanism",
        sourceRefs: [1],
      }],
    });
  }
);
assert.equal(rewrittenMediaLengthCalls, 2);
assert.equal(rewrittenMediaLengthArticle.title, "Expanded media brief");
assert.ok(rewrittenMediaLengthArticle.mediaHints?.[0].query.includes("connected"));

let orphanMediaLengthCalls = 0;
const orphanMediaLengthArticle = await generateArticleDraft(
  { domainName: domain.name, topic: "drop a genuinely orphaned visual", targetLength: "short", lang: "en" },
  async () => {
    orphanMediaLengthCalls += 1;
    if (orphanMediaLengthCalls === 1) {
      return JSON.stringify({
        title: "Draft with a removable aside",
        paragraphs: [
          { role: "hook", heading: "", text: englishParagraph("orphan-hook", 90) },
          {
            role: "context",
            heading: "",
            text: Array.from({ length: 91 }, (_, index) => `orchid-submarine-zeppelin-${index}`).join(" "),
          },
          { role: "evidence", heading: "", text: englishParagraph("orphan-evidence", 90) },
          { role: "mechanism", heading: "", text: englishParagraph("orphan-mechanism", 90) },
          { role: "turn", heading: "", text: englishParagraph("orphan-turn", 90) },
          { role: "resolution", heading: "", text: englishParagraph("orphan-resolution", 90) },
        ],
        mediaHints: [{
          afterParagraph: 2,
          kind: "image",
          purpose: "breather",
          query: "orchid submarine zeppelin aside",
          alt: "A removable aside",
          sourceRefs: [],
        }],
      });
    }
    return JSON.stringify({
      title: "Condensed without the aside",
      paragraphs: ["hook", "evidence", "mechanism", "turn", "resolution"].map((role, index) => ({
        role,
        heading: "",
        text: englishParagraph(`kept-core-${index}`, 70),
      })),
      mediaHints: [],
    });
  }
);
assert.equal(orphanMediaLengthCalls, 2);
assert.equal(orphanMediaLengthArticle.title, "Condensed without the aside");
assert.equal(orphanMediaLengthArticle.mediaHints, undefined);

let protectedLocalCompactionCalls = 0;
const protectedLocalCompaction = await generateArticleDraft(
  { domainName: domain.name, topic: "local compaction keeps evidence and the turn", targetLength: "short", lang: "en" },
  async () => {
    protectedLocalCompactionCalls += 1;
    return JSON.stringify({
      title: "A modest overrun",
      paragraphs: [
        { role: "hook", heading: "", text: englishParagraph("compact-hook", 90) },
        { role: "context", heading: "", text: `${englishParagraph("compact-cited-context", 85)} [1] [2]` },
        { role: "evidence", heading: "", text: englishParagraph("compact-evidence", 85) },
        { role: "mechanism", heading: "", text: englishParagraph("compact-mechanism", 90) },
        { role: "turn", heading: "", text: englishParagraph("compact-only-turn", 85) },
        { role: "resolution", heading: "", text: englishParagraph("compact-resolution", 85) },
      ],
      mediaHints: [],
    });
  }
);
assert.equal(protectedLocalCompactionCalls, 6, "lateral model repairs still leave the local compaction pass available");
assert.equal(protectedLocalCompaction.length?.inRange, true);
assert.ok(protectedLocalCompaction.paragraphRoles?.includes("turn"));
assert.equal((protectedLocalCompaction.paragraphs.join(" ").match(/\[(?:1|2)\]/gu) ?? []).length, 2);

// 草稿明显低于目标档位时，触发一次扩写纠偏并采用达标结果
let lengthFixCalls = 0;
let lengthFixPrompt = "";
const expandedParagraph = "这里有足够的案例细节、数据对比和机制解释来支撑观点，读者能看懂结论从哪来。".repeat(4);
const expandedArticle = await generateArticleDraft(
  {
    domainName: domain.name,
    topic: "长度档位测试",
    targetLength: "medium",
    researchContext: "来源：Industry Report\n测试资料",
    lang: "zh",
  },
  async (prompt, opts) => {
    lengthFixCalls += 1;
    assert.equal("maxTokens" in (opts ?? {}), false);
    assert.equal(opts?.disableThinking, true);
    if (lengthFixCalls === 1) {
      return JSON.stringify({ title: "太短的草稿", paragraphs: ["只有一小段，远低于常规档的字数要求。"] });
    }
    lengthFixPrompt = prompt;
    return JSON.stringify({
      title: "扩写后的文章",
      paragraphs: Array.from({ length: 8 }, () => expandedParagraph),
    });
  }
);
assert.equal(lengthFixCalls, 2);
assert.ok(lengthFixPrompt.includes("1000-1300 字"));
assert.ok(lengthFixPrompt.includes("扩写"));
assert.ok(lengthFixPrompt.includes("太短的草稿"));
const expandedLength = articleBodyLength(expandedArticle, "zh");
assert.ok(expandedLength >= 1000 && expandedLength <= 1300, `expanded length ${expandedLength} out of band`);
assert.equal(expandedArticle.length?.actual, expandedLength);
assert.equal(expandedArticle.length?.inRange, true);

// 最多五次纠偏：持续未达标时明确失败，不能把 off-band 草稿当成完成态。
let boundedFixCalls = 0;
await assert.rejects(
  () => generateArticleDraft(
    {
      domainName: domain.name,
      topic: "bounded retries",
      targetLength: "short",
      lang: "en",
    },
    async () => {
      boundedFixCalls += 1;
      const words = boundedFixCalls === 1 ? 10 : boundedFixCalls === 2 ? 100 : 200;
      return JSON.stringify({ title: "Retry cap", paragraphs: ["word ".repeat(words)] });
    }
  ),
  /actual 200, target 350-500/
);
assert.equal(boundedFixCalls, 6);

// 模型常把引用编号/标点也算进字数，容易在边界上下偏约 1-2%。
// 五轮模型校准后，小幅超出应本地收敛到上限，小幅不足应补非事实性收束句。
let overrunCalls = 0;
const exactZhParagraphs = (length: number, count = 10) =>
  Array.from({ length: count }, (_, index) => {
    const size = Math.floor(length / count) + (index < length % count ? 1 : 0);
    return `${"甲".repeat(Math.max(1, size - 1))}。`;
  });
const normalizedOverrun = await generateArticleDraft(
  {
    domainName: domain.name,
    topic: "small length overrun",
    targetLength: "medium",
    lang: "zh",
  },
  async (_prompt, opts) => {
    overrunCalls += 1;
    assert.equal(opts?.disableThinking, true);
    const lengths = [1500, 1400, 1319];
    return JSON.stringify({
      title: "边界压缩",
      paragraphs: exactZhParagraphs(lengths[Math.min(overrunCalls - 1, lengths.length - 1)]),
    });
  }
);
assert.equal(overrunCalls, 6);
assert.ok((normalizedOverrun.length?.actual ?? 0) >= 1000);
assert.ok((normalizedOverrun.length?.actual ?? 0) <= 1300);
assert.equal(normalizedOverrun.length?.inRange, true);

let underrunCalls = 0;
const normalizedUnderrun = await generateArticleDraft(
  {
    domainName: domain.name,
    topic: "small length underrun",
    targetLength: "medium",
    lang: "zh",
  },
  async (_prompt, opts) => {
    underrunCalls += 1;
    assert.equal(opts?.disableThinking, true);
    const lengths = [700, 850, 981];
    return JSON.stringify({
      title: "边界扩充",
      paragraphs: ["乙".repeat(lengths[Math.min(underrunCalls - 1, lengths.length - 1)])],
    });
  }
);
assert.equal(underrunCalls, 6);
assert.ok((normalizedUnderrun.length?.actual ?? 0) >= 1000);
assert.ok((normalizedUnderrun.length?.actual ?? 0) <= 1300);
assert.equal(normalizedUnderrun.length?.inRange, true);

// 引用用于事实核验，但不再是整篇文章的阻断门槛：开头、过渡、分析和收束
// 可以没有编号，也不应触发额外的强制引用重写。
let uncitedDraftCalls = 0;
const uncitedArticle = await generateArticleDraft(
  {
    domainName: domain.name,
    topic: "non-blocking citation guidance",
    targetLength: "short",
    lang: "en",
    researchContext: "--- 来源资料 1 ---\n标题: Verified source\n来源: Example\n链接: https://example.com/source",
  },
  async (_prompt, opts) => {
    uncitedDraftCalls += 1;
    assert.equal(opts?.disableThinking, true);
    return JSON.stringify({
      title: "Citations help without blocking",
      paragraphs: [`${"word ".repeat(349)}analysis`],
    });
  }
);
assert.equal(uncitedDraftCalls, 1);
assert.equal(uncitedArticle.length?.actual, 350);
assert.equal(uncitedArticle.paragraphs[0].includes("["), false);

let articleRepairCalls = 0;
const repairedArticle = await generateArticleDraft(
  {
    domainName: domain.name,
    topic: topics[0],
    targetLength: "short",
  },
  async (_prompt, opts) => {
    articleRepairCalls += 1;
    assert.equal(opts?.disableThinking, true);
    if (articleRepairCalls === 1) {
      return '{"title":"Broken article","paragraphs":["Missing tail"';
    }
    return JSON.stringify({
      title: "修复后的文章",
      paragraphs: ["word ".repeat(articleRepairCalls === 2 ? 100 : 350)],
    });
  }
);
// 三次调用：草稿（坏 JSON）→ JSON 修复 → 一次长度纠偏并达标。
assert.equal(articleRepairCalls, 3);
assert.equal(repairedArticle.title, "修复后的文章");
assert.equal(repairedArticle.length?.actual, 350);

// 思考模型可能耗尽 token 后返回空 content：必须跳过无意义的 JSON 修复，
// 用完整生成提示重试一次，并且每次都显式关闭 provider thinking。
let emptyDraftCalls = 0;
const recoveredEmptyDraft = await generateArticleDraft(
  {
    domainName: domain.name,
    topic: "empty visible content",
    targetLength: "short",
    lang: "en",
  },
  async (_prompt, opts) => {
    emptyDraftCalls += 1;
    assert.equal(opts?.disableThinking, true);
    if (emptyDraftCalls === 1) return "";
    return JSON.stringify({ title: "Recovered draft", paragraphs: ["word ".repeat(350)] });
  }
);
assert.equal(emptyDraftCalls, 2);
assert.equal(recoveredEmptyDraft.title, "Recovered draft");
assert.equal(recoveredEmptyDraft.length?.inRange, true);

let transientProviderCalls = 0;
const recoveredProviderDraft = await generateArticleDraft(
  {
    domainName: domain.name,
    topic: "transient provider error",
    targetLength: "short",
    lang: "en",
  },
  async (_prompt, opts) => {
    transientProviderCalls += 1;
    assert.equal(opts?.disableThinking, true);
    if (transientProviderCalls === 1) throw new Error("temporary provider failure");
    return JSON.stringify({ title: "Recovered provider draft", paragraphs: ["word ".repeat(350)] });
  }
);
assert.equal(transientProviderCalls, 2);
assert.equal(recoveredProviderDraft.length?.inRange, true);

let unusableDraftCalls = 0;
await assert.rejects(
  () => generateArticleDraft(
    {
      domainName: domain.name,
      topic: "persistently empty visible content",
      targetLength: "short",
      lang: "en",
    },
    async (_prompt, opts) => {
      unusableDraftCalls += 1;
      assert.equal(opts?.disableThinking, true);
      return "";
    }
  ),
  (error: unknown) => error instanceof ArticleModelOutputError
);
assert.equal(unusableDraftCalls, 2);

const docParagraphs = articleToDocParagraphs(article);
assert.equal(docParagraphs[0].kind, "heading1");
assert.equal(docParagraphs[0].text, article.title);
assert.equal(docParagraphs[1].kind, "normal");

// 媒体只能来自后端已经安全下载并验证的真实网络图片；无合格来源时保持零配图。
const SAFE_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const SAFE_GIF_BYTES = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64"
);
const SAFE_PNG_DATA_URI = "data:image/png;base64," + SAFE_PNG_BYTES.toString("base64");
const SAFE_GIF_DATA_URI = "data:image/gif;base64," + SAFE_GIF_BYTES.toString("base64");

function safeBinary(
  bytes: Buffer,
  mimeType: SafeImageBinary["mimeType"],
  width: number,
  height: number
): SafeImageBinary {
  return {
    bytes,
    mimeType,
    finalUrl: "https://cdn.example.test/final-media",
    width,
    height,
  };
}

function testImageFetcher(
  images: ReadonlyMap<string, SafeImageBinary | undefined>,
  calls: string[] = []
): NonNullable<ArticleMediaDependencies["fetchImage"]> {
  return async (url) => {
    calls.push(url);
    const image = images.get(url);
    return image
      ? { ...image, bytes: Buffer.from(image.bytes), finalUrl: url }
      : undefined;
  };
}

function researchImage(
  index: number,
  title: string,
  summary: string,
  imageUrl: string
): ResearchItem {
  return {
    id: "news:media-" + index,
    sourceKind: "news",
    region: "international",
    sourceName: "Source " + index,
    sourceId: "source-" + index,
    title,
    summary,
    url: "https://source.example.test/article-" + index,
    imageUrl,
    publishedAt: "2026-01-05T10:00:00.000Z",
    authors: [],
    query: title,
  };
}

function gatheredFigures(articleWithFigures: Awaited<ReturnType<typeof enrichArticleWithResearch>>) {
  return [articleWithFigures.figure, ...(articleWithFigures.bodyFigures ?? [])].filter(
    (figure): figure is NonNullable<typeof figure> => Boolean(figure)
  );
}

assert.match(
  articleDraftPrompt({ ...lengthPromptBase, targetLength: "short" }),
  /严禁生成、补画、合成/
);
assert.doesNotMatch(
  articleDraftPrompt({ ...lengthPromptBase, targetLength: "short" }),
  /搜索\/生成简报/
);
assert.match(
  articleDraftPrompt({ ...lengthPromptBase, lang: "en", targetLength: "short" }),
  /Never generate, complete, composite, or imagine/
);

const noSourceMedia = await enrichArticleWithResearch(
  {
    title: "No source media",
    paragraphs: ["The article remains readable without an illustration."],
    length: { tier: "long", unit: "words", actual: 8, min: 2200, max: 2800, inRange: false },
    mediaHints: [{
      afterParagraphIndex: 0,
      kind: "image",
      purpose: "scene",
      query: "a real scene from source material 1",
      alt: "A real sourced scene",
      sourceRefs: [1],
    }],
  },
  [],
  new Date("2026-06-01T00:00:00.000Z"),
  "en"
);
assert.equal(noSourceMedia.figure, undefined);
assert.deepEqual(noSourceMedia.bodyFigures, []);

const failedUrl = "https://images.example.test/fails.png";
const failedSourceMedia = await enrichArticleWithResearch(
  {
    title: "River flood sensors",
    paragraphs: ["River flood sensors guide emergency planning. [1]"],
    length: { tier: "short", unit: "words", actual: 7, min: 350, max: 500, inRange: false },
  },
  [researchImage(1, "River Flood Sensors Guide Emergency Planning", "River flood sensors guide emergency planning.", failedUrl)],
  new Date("2026-06-01T00:00:00.000Z"),
  "en",
  { fetchImage: testImageFetcher(new Map([[failedUrl, undefined]])) }
);
assert.equal(failedSourceMedia.figure, undefined);
assert.deepEqual(failedSourceMedia.bodyFigures, []);

const staticImageUrl = "https://images.example.test/river.png";
const staticSource = researchImage(
  1,
  "River Flood Sensors Guide Emergency Planning",
  "River flood sensors and flood forecasts guide emergency planning.",
  staticImageUrl
);
const sourceOnlyArticle = await enrichArticleWithResearch(
  {
    title: "Climate Teams Track River Flood Risk",
    paragraphs: [
      "Cities use river flood sensors and flood forecasts to plan emergency routes. [1]",
      "The evidence helps teams compare warning thresholds.",
    ],
    length: { tier: "short", unit: "words", actual: 20, min: 350, max: 500, inRange: false },
  },
  [staticSource],
  new Date("2026-06-01T00:00:00.000Z"),
  "en",
  {
    fetchImage: testImageFetcher(new Map([
      [staticImageUrl, safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1)],
    ])),
  }
);
const sourceOnlyFigures = gatheredFigures(sourceOnlyArticle);
assert.equal(sourceOnlyFigures.length, 1);
const sourceOnlyFigure = sourceOnlyFigures[0];
assert.equal(sourceOnlyFigure.origin, "web");
assert.equal(sourceOnlyFigure.mediaKind, "image");
assert.equal(sourceOnlyFigure.mimeType, "image/png");
assert.equal(sourceOnlyFigure.mediaDataUri, SAFE_PNG_DATA_URI);
assert.equal(sourceOnlyFigure.width, 1);
assert.equal(sourceOnlyFigure.height, 1);
assert.equal(sourceOnlyFigure.alt, staticSource.title);
assert.equal(sourceOnlyFigure.sourceName, staticSource.sourceName);
assert.equal(sourceOnlyFigure.sourceTitle, staticSource.title);
assert.equal(sourceOnlyFigure.sourceUrl, staticSource.url);
assert.equal(sourceOnlyFigure.sourceRef, 1);
assert.equal("svg" in sourceOnlyFigure, false);
assert.equal("imageUrl" in sourceOnlyFigure, false);

const sourceOnlyRender = articleToRenderBlocks(sourceOnlyArticle);
const renderedSourceFigure = sourceOnlyRender.find(
  (block): block is Extract<(typeof sourceOnlyRender)[number], { type: "figure" }> => block.type === "figure"
);
assert.ok(renderedSourceFigure);
assert.equal(renderedSourceFigure.origin, "web");
assert.equal(renderedSourceFigure.mediaDataUri, SAFE_PNG_DATA_URI);
assert.equal(renderedSourceFigure.sourceTitle, staticSource.title);
assert.equal("svg" in renderedSourceFigure, false);
assert.equal("imageUrl" in renderedSourceFigure, false);
assert.equal(JSON.stringify(renderedSourceFigure).includes(staticImageUrl), false);

const invalidMimeRender = articleToRenderBlocks({
  title: "Reject mismatched inline media",
  paragraphs: ["Mismatched media is omitted instead of receiving a fallback card."],
  figure: {
    title: "Invalid GIF",
    caption: "Wrong MIME prefix",
    origin: "web",
    mediaKind: "gif",
    mimeType: "image/gif",
    mediaDataUri: SAFE_PNG_DATA_URI,
    width: 1,
    height: 1,
    alt: "Invalid media",
    sourceName: "Invalid source",
    sourceTitle: "Invalid source media",
    sourceUrl: "https://source.example.test/invalid",
    sourceRef: 1,
  },
});
assert.equal(invalidMimeRender.some((block) => block.type === "figure"), false);

const invalidSourceRefRender = articleToRenderBlocks({
  title: "Reject unattributed inline media",
  paragraphs: ["A real image without a valid reference number must be omitted."],
  figure: {
    title: "Unattributed image",
    caption: "Missing reference binding",
    origin: "web",
    mediaKind: "image",
    mimeType: "image/png",
    mediaDataUri: SAFE_PNG_DATA_URI,
    width: 1,
    height: 1,
    alt: "A source image without a reference number",
    sourceName: "Example source",
    sourceTitle: "Example source article",
    sourceUrl: "https://source.example.test/unattributed",
    sourceRef: 0,
  },
});
assert.equal(
  invalidSourceRefRender.some((block) => block.type === "figure"),
  false,
  "a source image without a positive reference number must not enter the render DTO"
);

const manualGifFigure = {
  title: "Figure 1. First GIF",
  caption: "Real source GIF",
  origin: "web" as const,
  mediaKind: "gif" as const,
  mimeType: "image/gif" as const,
  mediaDataUri: SAFE_GIF_DATA_URI,
  width: 1,
  height: 1,
  alt: "A real animated process",
  sourceName: "Motion source",
  sourceTitle: "Recorded motion",
  sourceUrl: "https://source.example.test/motion",
  sourceRef: 1,
};
const oneGifOnlyRender = articleToRenderBlocks({
  title: "Only one animation",
  paragraphs: ["The first motion cue.", "The second motion cue."],
  figure: manualGifFigure,
  bodyFigures: [{
    ...manualGifFigure,
    title: "Figure 2. Second GIF",
    sourceRef: 2,
    afterParagraphIndex: 1,
  }],
});
assert.equal(
  oneGifOnlyRender.filter((block) => block.type === "figure").length,
  1,
  "render DTO must omit a second GIF rather than synthesize a fallback"
);

const strongUrl = "https://images.example.test/strong.png";
const weakUrl = "https://images.example.test/weak.png";
const relevanceFetchCalls: string[] = [];
const relevanceArticle = await enrichArticleWithResearch(
  {
    title: "Flood Sensors Guide City Planning",
    paragraphs: ["Cities use river flood sensors to plan emergency routes."],
    length: { tier: "short", unit: "words", actual: 10, min: 350, max: 500, inRange: false },
  },
  [
    researchImage(1, "River Flood Sensors Help Cities", "Flood sensors guide city emergency planning.", strongUrl),
    researchImage(2, "Hardware Prices Fall", "Sensors.", weakUrl),
  ],
  new Date("2026-06-01T00:00:00.000Z"),
  "en",
  {
    fetchImage: testImageFetcher(
      new Map([
        [strongUrl, safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1)],
        [weakUrl, safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1)],
      ]),
      relevanceFetchCalls
    ),
  }
);
assert.deepEqual(gatheredFigures(relevanceArticle).map((figure) => figure.sourceTitle), ["River Flood Sensors Help Cities"]);
assert.deepEqual(relevanceFetchCalls, [strongUrl], "weak relevance must not backfill a visual quota");

const strictRetryUrls = [1, 2, 3].map((index) => `https://images.example.test/strict-retry-${index}.png`);
const strictRetryItems = strictRetryUrls.map((url, index) => researchImage(
  index + 1,
  `River Flood Sensor Emergency Route ${index + 1}`,
  "Verified river flood sensors guide emergency route planning.",
  url
));
const strictRetryCalls: string[] = [];
const strictRetryArticle = await enrichArticleWithResearch(
  {
    title: "River Flood Sensor Emergency Routes",
    paragraphs: ["Verified river flood sensors guide emergency route planning."],
    length: { tier: "short", unit: "words", actual: 8, min: 350, max: 500, inRange: false },
  },
  strictRetryItems,
  new Date("2026-06-01T00:00:00.000Z"),
  "en",
  {
    fetchImage: testImageFetcher(
      new Map([
        [strictRetryUrls[0], undefined],
        [strictRetryUrls[1], undefined],
        [strictRetryUrls[2], safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1)],
      ]),
      strictRetryCalls
    ),
  }
);
assert.equal(gatheredFigures(strictRetryArticle)[0]?.sourceRef, 3);
assert.deepEqual(
  strictRetryCalls,
  strictRetryUrls,
  "strict ranking must count successful safe images, not truncate attempts before decoding"
);

const mixedStrictUrl = "https://images.example.test/mixed-strict-failed.png";
const mixedFallbackUrl = "https://images.example.test/mixed-fallback-safe.png";
const mixedStrictFallbackCalls: string[] = [];
const mixedStrictFallbackArticle = await enrichArticleWithResearch(
  {
    title: "AI研学团挤进科技馆，孩子学到的是AI还是人设",
    paragraphs: ["科技馆里的机器人展览很热闹，但孩子是否真正学习才是教育问题。"],
    length: { tier: "short", unit: "characters", actual: 32, min: 450, max: 650, inRange: false },
  },
  [
    {
      ...researchImage(
        1,
        "科技馆机器人展览记录",
        "科技馆记录孩子参加机器人展览与研学活动的现场。",
        mixedStrictUrl
      ),
      query: "科技馆 AI研学 孩子 教育 展览",
    },
    {
      ...researchImage(
        2,
        "Children Explore AI at a Science Museum Exhibition",
        "A museum education program records students learning through artificial-intelligence exhibits.",
        mixedFallbackUrl
      ),
      query: "children learn artificial intelligence through science museum education exhibits",
    },
  ],
  new Date("2026-06-01T00:00:00.000Z"),
  "zh",
  {
    fetchImage: testImageFetcher(
      new Map([
        [mixedStrictUrl, undefined],
        [mixedFallbackUrl, safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1)],
      ]),
      mixedStrictFallbackCalls
    ),
  }
);
assert.equal(gatheredFigures(mixedStrictFallbackArticle)[0]?.sourceRef, 2);
assert.deepEqual(
  mixedStrictFallbackCalls,
  [mixedStrictUrl, mixedFallbackUrl],
  "a failed strict image must not prevent one conservative related fallback"
);

// When a bilingual model draft omits both mediaHints and [n] citations, a
// detailed upstream research query may bridge the article to a source whose own
// title/summary contains the same concrete concepts. The first failed binary is
// skipped, the next related real source is used, and the fallback stops at one.
const fallbackFailedUrl = "https://images.example.test/ai-museum-failed.png";
const fallbackSuccessUrl = "https://images.example.test/ai-museum-success.png";
const fallbackUnusedUrl = "https://images.example.test/ai-museum-unused.png";
const genericAiUrl = "https://images.example.test/generic-ai-stock.png";
const detailedEducationQuery = "children learn artificial intelligence through science museum education field trips";
const bilingualFallbackItems = [
  {
    ...researchImage(
      1,
      "Children Learn Artificial Intelligence During Science Museum Field Trips",
      "Museum education programs let students examine artificial intelligence through guided exhibits and classroom activities.",
      fallbackFailedUrl
    ),
    query: detailedEducationQuery,
  },
  {
    ...researchImage(
      2,
      "Artificial Intelligence Stocks Predicted to Rally",
      "Semiconductor valuations and quarterly market forecasts led the discussion.",
      genericAiUrl
    ),
    query: detailedEducationQuery,
  },
  {
    ...researchImage(
      3,
      "Children Learn Artificial Intelligence During Science Museum Field Trips",
      "Museum education programs let students examine artificial intelligence through guided exhibits and classroom activities.",
      fallbackSuccessUrl
    ),
    query: detailedEducationQuery,
  },
  {
    ...researchImage(
      4,
      "Children Learn Artificial Intelligence During Science Museum Field Trips",
      "Museum education programs let students examine artificial intelligence through guided exhibits and classroom activities.",
      fallbackUnusedUrl
    ),
    query: detailedEducationQuery,
  },
];
const bilingualFallbackCalls: string[] = [];
const bilingualFallbackArticle = await enrichArticleWithResearch(
  {
    title: "AI研学团挤进科技馆，孩子学到的是AI还是人设",
    paragraphs: [
      "孩子走进科技馆参加AI研学，真正的问题不是拍照，而是能否理解技术。",
      "教育活动只有把展览、课堂和提问连起来，学习才不会停在热闹表面。",
    ],
    length: { tier: "long", unit: "characters", actual: 57, min: 3000, max: 3800, inRange: false },
  },
  bilingualFallbackItems,
  new Date("2026-06-01T00:00:00.000Z"),
  "zh",
  {
    fetchImage: testImageFetcher(
      new Map([
        [fallbackFailedUrl, undefined],
        [fallbackSuccessUrl, safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1)],
        [fallbackUnusedUrl, safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1)],
        [genericAiUrl, safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1)],
      ]),
      bilingualFallbackCalls
    ),
  }
);
assert.equal(gatheredFigures(bilingualFallbackArticle).length, 1);
assert.equal(
  gatheredFigures(bilingualFallbackArticle)[0]?.sourceRef,
  3
);
assert.deepEqual(
  bilingualFallbackCalls,
  [fallbackFailedUrl, fallbackSuccessUrl],
  "fallback should retry the next related source, ignore generic AI, and stop after one safe image"
);

const genericOnlyCalls: string[] = [];
const genericOnlyArticle = await enrichArticleWithResearch(
  {
    title: "AI研学团挤进科技馆，孩子学到的是AI还是人设",
    paragraphs: ["孩子在科技馆参加研学活动，文章讨论教育是否真正发生。"],
    length: { tier: "short", unit: "characters", actual: 27, min: 450, max: 650, inRange: false },
  },
  [{
    ...researchImage(
      1,
      "Artificial Intelligence Stocks Predicted to Rally",
      "Semiconductor valuations and quarterly market forecasts led the discussion.",
      genericAiUrl
    ),
    query: detailedEducationQuery,
  }],
  new Date("2026-06-01T00:00:00.000Z"),
  "zh",
  {
    fetchImage: testImageFetcher(
      new Map([[genericAiUrl, safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1)]]),
      genericOnlyCalls
    ),
  }
);
assert.equal(gatheredFigures(genericOnlyArticle).length, 0);
assert.deepEqual(genericOnlyCalls, [], "a generic AI-only source must not be fetched as a fallback");

const genericChineseAiUrl = "https://images.example.test/generic-ai-financing.png";
const genericChineseAiCalls: string[] = [];
const genericChineseAiArticle = await enrichArticleWithResearch(
  {
    title: "人工智能研学团挤进科技馆",
    paragraphs: ["孩子参加人工智能研学，文章追问科技馆里的教育是否真正发生。"],
    length: { tier: "short", unit: "characters", actual: 30, min: 450, max: 650, inRange: false },
  },
  [{
    ...researchImage(
      1,
      "人工智能企业融资创新高",
      "人工智能产业投资消息与公司估值成为市场关注焦点。",
      genericChineseAiUrl
    ),
    query: "人工智能研学 科技馆 孩子 教育",
  }],
  new Date("2026-06-01T00:00:00.000Z"),
  "zh",
  {
    fetchImage: testImageFetcher(
      new Map([[genericChineseAiUrl, safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1)]]),
      genericChineseAiCalls
    ),
  }
);
assert.equal(gatheredFigures(genericChineseAiArticle).length, 0);
assert.deepEqual(
  genericChineseAiCalls,
  [],
  "shared 人工智能 n-grams alone must not turn an unrelated financing source into an article image"
);

const relevantWithoutImage = {
  ...bilingualFallbackItems[2],
  imageUrl: undefined,
};
const noSafeImageCalls: string[] = [];
const noSafeImageArticle = await enrichArticleWithResearch(
  {
    title: "AI研学团挤进科技馆，孩子学到的是AI还是人设",
    paragraphs: ["科技馆里的AI教育需要让孩子真正参与学习。"],
    length: { tier: "short", unit: "characters", actual: 22, min: 450, max: 650, inRange: false },
  },
  [relevantWithoutImage],
  new Date("2026-06-01T00:00:00.000Z"),
  "zh",
  { fetchImage: testImageFetcher(new Map(), noSafeImageCalls) }
);
assert.equal(gatheredFigures(noSafeImageArticle).length, 0);
assert.deepEqual(noSafeImageCalls, [], "a relevant source without a safe image URL remains text-only");

const hintedSourceUrl = "https://images.example.test/hinted-warning-dashboard.png";
const hintedPathCalls: string[] = [];
const hintedPathArticle = await enrichArticleWithResearch(
  {
    title: "Preparing Before the River Rises",
    paragraphs: ["Communities rehearse decisions before the water reaches homes."],
    mediaHints: [{
      afterParagraphIndex: 0,
      kind: "image",
      purpose: "evidence",
      query: "municipal river warning dashboard thresholds",
      alt: "A real municipal river warning dashboard",
      sourceRefs: [1],
    }],
    length: { tier: "short", unit: "words", actual: 9, min: 350, max: 500, inRange: false },
  },
  [{
    ...researchImage(
      1,
      "Municipal Warning Dashboard",
      "Verified emergency thresholds for river monitoring teams.",
      hintedSourceUrl
    ),
    query: "river flood preparation warning thresholds",
  }],
  new Date("2026-06-01T00:00:00.000Z"),
  "en",
  {
    fetchImage: testImageFetcher(
      new Map([[hintedSourceUrl, safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1)]]),
      hintedPathCalls
    ),
  }
);
assert.equal(gatheredFigures(hintedPathArticle).length, 1, "an explicit sourceRef media hint keeps strict priority");
assert.deepEqual(hintedPathCalls, [hintedSourceUrl]);

const unrelatedSupplementalUrl = "https://cdn.example.test/city-skyline.png";
const unrelatedSupplementalThumb = "https://api.openverse.org/v1/images/11111111-1111-4111-8111-111111111111/thumb/";
const unrelatedSupplemental: LicensedMediaItem = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "City skyline after dark",
  creator: "Example Photographer",
  license: "by",
  licenseVersion: "4.0",
  licenseName: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  landingUrl: "https://photos.example.test/works/city-skyline",
  downloadUrl: unrelatedSupplementalUrl,
  thumbnailUrl: unrelatedSupplementalThumb,
  attribution: "City skyline after dark by Example Photographer",
  mimeType: "image/png",
  width: 1200,
  height: 800,
  query: "city skyline architecture",
  tags: ["city", "skyline", "architecture"],
};
const supplementalCollisionCalls: string[] = [];
const supplementalCollisionArticle = await enrichArticleWithResearch(
  {
    title: "Children learn through science museum exhibits",
    paragraphs: ["Children test an interactive museum exhibit while a teacher explains the experiment."],
    mediaHints: [{
      afterParagraphIndex: 0,
      kind: "image",
      purpose: "scene",
      query: "children science museum exhibit",
      alt: "Children learning in a science museum",
      // This was invalid when the draft saw only one evidence reference. It
      // must not become a valid anchor after supplemental ref 2 is appended.
      sourceRefs: [2],
    }],
    length: { tier: "short", unit: "words", actual: 12, min: 350, max: 500, inRange: false },
  },
  [researchImage(
    1,
    "Children Learn in Science Museums",
    "Hands-on exhibits help children discuss scientific ideas.",
    "https://images.example.test/evidence-without-media.png"
  )].map((item) => ({ ...item, imageUrl: undefined })),
  new Date("2026-06-01T00:00:00.000Z"),
  "en",
  {
    supplementalMedia: [unrelatedSupplemental],
    fetchImage: testImageFetcher(new Map([
      [unrelatedSupplementalUrl, safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1)],
      [unrelatedSupplementalThumb, safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1)],
    ]), supplementalCollisionCalls),
  }
);
assert.equal(
  gatheredFigures(supplementalCollisionArticle).length,
  0,
  "an invalid draft-time ref must not be reinterpreted as an unrelated supplemental media ref"
);
assert.deepEqual(supplementalCollisionCalls, []);

const evidenceWindowItems = Array.from({ length: 17 }, (_, index) => {
  const withinEvidenceWindow = index < 16;
  return researchImage(
    index + 1,
    withinEvidenceWindow ? "Unrelated Market Bulletin " + index : "River Flood Sensors Guide Emergency Planning",
    withinEvidenceWindow ? "Quarterly retail pricing update." : "River flood sensors guide emergency planning.",
    "https://images.example.test/window-" + (index + 1) + ".png"
  );
});
const evidenceWindowCalls: string[] = [];
const evidenceWindowArticle = await enrichArticleWithResearch(
  {
    title: "River Flood Sensors",
    paragraphs: ["River flood sensors guide emergency planning."],
    length: { tier: "long", unit: "words", actual: 7, min: 2200, max: 2800, inRange: false },
  },
  evidenceWindowItems,
  new Date("2026-06-01T00:00:00.000Z"),
  "en",
  {
    fetchImage: testImageFetcher(
      new Map(evidenceWindowItems.map((item) => [
        item.imageUrl ?? "",
        safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1),
      ])),
      evidenceWindowCalls
    ),
  }
);
assert.equal(gatheredFigures(evidenceWindowArticle).length, 0);
assert.deepEqual(evidenceWindowCalls, [], "items outside the first 16 evidence sources are not media candidates");

for (const [tier, expectedMaximum] of [["short", 2], ["medium", 4], ["long", 6]] as const) {
  const candidates = Array.from({ length: 7 }, (_, index) =>
    researchImage(
      index + 1,
      "River Flood Sensor Evidence " + (index + 1),
      "Verified river flood sensor evidence guides city planning.",
      "https://images.example.test/cap-" + tier + "-" + (index + 1) + ".png"
    )
  );
  const articleAtCap = await enrichArticleWithResearch(
    {
      title: "River Flood Sensor Evidence",
      paragraphs: ["Verified river flood sensor evidence guides city planning."],
      length: {
        tier,
        unit: "words",
        actual: 8,
        min: ARTICLE_LENGTH_SPECS.en[tier].min,
        max: ARTICLE_LENGTH_SPECS.en[tier].max,
        inRange: false,
      },
    },
    candidates,
    new Date("2026-06-01T00:00:00.000Z"),
    "en",
    {
      fetchImage: testImageFetcher(new Map(candidates.map((item) => [
        item.imageUrl ?? "",
        safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1),
      ]))),
    }
  );
  const figures = gatheredFigures(articleAtCap);
  assert.equal(figures.length, expectedMaximum, tier + " uses its maximum only when enough safe source media exists");
  assert.ok(figures.every((figure) => figure.origin === "web" && figure.mediaKind === "image"));
  assert.deepEqual(
    figures.map((figure) => figure.title.match(/^Figure ([0-9]+)\./)?.[1]),
    Array.from({ length: expectedMaximum }, (_, index) => String(index + 1))
  );
}

let activeSourceDecodes = 0;
let peakSourceDecodes = 0;
const sequentialMediaItems = Array.from({ length: 4 }, (_, index) => researchImage(
  index + 1,
  `River Flood Sensor Evidence ${index + 1}`,
  "Verified river flood sensor evidence guides city planning.",
  `https://images.example.test/sequential-${index + 1}.png`
));
await enrichArticleWithResearch(
  {
    title: "River Flood Sensor Evidence",
    paragraphs: ["Verified river flood sensor evidence guides city planning."],
    length: { tier: "medium", unit: "words", actual: 8, min: 850, max: 1100, inRange: false },
  },
  sequentialMediaItems,
  new Date("2026-06-01T00:00:00.000Z"),
  "en",
  {
    fetchImage: async (url) => {
      activeSourceDecodes += 1;
      peakSourceDecodes = Math.max(peakSourceDecodes, activeSourceDecodes);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeSourceDecodes -= 1;
      return { ...safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1), finalUrl: url };
    },
  }
);
assert.equal(peakSourceDecodes, 1, "source images must be fetched and decoded sequentially to bound peak memory");

const gifOneUrl = "https://images.example.test/motion-one.gif";
const gifTwoUrl = "https://images.example.test/motion-two.gif";
const gifBudgetArticle = await enrichArticleWithResearch(
  {
    title: "Flood Warning Motion",
    paragraphs: [
      "Flood warning motion one crosses the first threshold. [1]",
      "Flood warning motion two crosses the second threshold. [2]",
    ],
    mediaHints: [{
      afterParagraphIndex: 0,
      kind: "gif",
      purpose: "explanation",
      query: "real flood warning motion",
      alt: "A real flood warning sequence",
      sourceRefs: [1, 2],
    }],
    length: { tier: "medium", unit: "words", actual: 16, min: 850, max: 1100, inRange: false },
  },
  [
    researchImage(1, "Flood Warning Motion One", "Flood warning motion crosses the first threshold.", gifOneUrl),
    researchImage(2, "Flood Warning Motion Two", "Flood warning motion crosses the second threshold.", gifTwoUrl),
  ],
  new Date("2026-06-01T00:00:00.000Z"),
  "en",
  {
    fetchImage: testImageFetcher(new Map([
      [gifOneUrl, safeBinary(SAFE_GIF_BYTES, "image/gif", 1, 1)],
      [gifTwoUrl, safeBinary(SAFE_GIF_BYTES, "image/gif", 1, 1)],
    ])),
  }
);
const gifBudgetFigures = gatheredFigures(gifBudgetArticle);
assert.equal(gifBudgetFigures.length, 1);
assert.equal(gifBudgetFigures[0].mediaKind, "gif");
assert.equal(gifBudgetFigures[0].mediaDataUri, SAFE_GIF_DATA_URI);
assert.ok(gifBudgetFigures.every((figure) => figure.origin === "web"));

const largeSourceBytes = (fill: number) => {
  const bytes = Buffer.alloc(3 * 1024 * 1024, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  return bytes;
};
const byteBudgetItems = [1, 2, 3].map((index) =>
  researchImage(
    index,
    "Budget Evidence Chart " + index,
    "Budget evidence chart compares verified costs.",
    "https://images.example.test/budget-" + index + ".png"
  )
);
const byteBudgetArticle = await enrichArticleWithResearch(
  {
    title: "Budget Evidence Charts",
    paragraphs: ["Budget evidence charts compare verified costs for planning."],
    length: { tier: "long", unit: "words", actual: 9, min: 2200, max: 2800, inRange: false },
  },
  byteBudgetItems,
  new Date("2026-06-01T00:00:00.000Z"),
  "en",
  {
    fetchImage: testImageFetcher(new Map(byteBudgetItems.map((item, index) => [
      item.imageUrl ?? "",
      safeBinary(largeSourceBytes(index + 1), "image/png", 1000, 600),
    ]))),
  }
);
assert.equal(gatheredFigures(byteBudgetArticle).length, 2, "media beyond the total 8 MiB budget is omitted");
assert.ok(gatheredFigures(byteBudgetArticle).every((figure) => figure.origin === "web"));

const citedImageUrl = "https://images.example.test/evidence.png";
const enriched = await enrichArticleWithResearch(
  {
    title: "Evidence driven article",
    paragraphs: [
      "Evidence driven article has a real citation. [1]",
      "This paragraph cites a missing source. [9]",
      "This paragraph has no citation.",
    ],
    length: { tier: "short", unit: "words", actual: 20, min: 350, max: 500, inRange: false },
  },
  [
    {
      id: "arxiv:1",
      sourceKind: "paper",
      region: "international",
      sourceName: "arXiv",
      sourceId: "arxiv",
      title: "Useful AI Agents for Small Teams",
      summary: "Agent workflows can reduce coordination cost when tasks are scoped.",
      url: "https://arxiv.org/abs/2601.12345",
      publishedAt: "2026-01-04T08:30:00.000Z",
      authors: ["Ada Chen", "Ben Rao"],
      query: "ai agents",
    },
    researchImage(
      2,
      "Evidence Driven Article Chart",
      "A chart for evidence driven article workflows and source checks.",
      citedImageUrl
    ),
  ],
  new Date("2026-06-01T00:00:00.000Z"),
  "zh",
  {
    fetchImage: testImageFetcher(new Map([
      [citedImageUrl, safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1)],
    ])),
  }
);
assert.ok(enriched.paragraphs[0].includes("[1]"));
assert.ok(!enriched.paragraphs[1].includes("[9]"));
assert.ok(!/[[]\d+[]]/.test(enriched.paragraphs[2]));
assert.equal(enriched.length?.actual, countArticleBody(enriched.paragraphs, "zh"));
assert.equal(enriched.length?.tier, "short");
assert.equal(enriched.references?.length, 2);
assert.ok(enriched.references?.[0].text.includes("Ada Chen, Ben Rao"));
assert.equal(gatheredFigures(enriched)[0]?.sourceTitle, "Evidence Driven Article Chart");

const bodyImageUrl = "https://images.example.test/budget-body.png";
const bodyImageArticle = await enrichArticleWithResearch(
  {
    title: "Remote Work Budget Choices",
    paragraphs: [
      "The opening explains why managers are reviewing remote work policy.",
      "The practical question is how teams compare travel budgets, office leases, and hiring costs. [1]",
    ],
  },
  [researchImage(
    1,
    "Travel Budget Charts Shape Remote Work Decisions",
    "Budget charts compare travel costs, office leases, and hiring plans.",
    bodyImageUrl
  )],
  new Date("2026-06-01T00:00:00.000Z"),
  "en",
  {
    fetchImage: testImageFetcher(new Map([
      [bodyImageUrl, safeBinary(SAFE_PNG_BYTES, "image/png", 1, 1)],
    ])),
  }
);
assert.equal(bodyImageArticle.figure, undefined);
assert.equal(bodyImageArticle.bodyFigures?.length, 1);
const bodyImageBlocks = articleToDocBlocks(bodyImageArticle);
const matchedParagraphIndex = bodyImageBlocks.findIndex(
  (block) => block.type === "paragraph" && block.text.includes("travel budgets")
);
const matchedFigureIndex = bodyImageBlocks.findIndex(
  (block) => block.type === "figure" && block.caption.includes("https://source.example.test/article-1")
);
assert.ok(matchedParagraphIndex < matchedFigureIndex, "a source visual remains after the paragraph it explains");
const matchedFigure = bodyImageBlocks.find(
  (block): block is Extract<(typeof bodyImageBlocks)[number], { type: "figure" }> => block.type === "figure"
);
assert.match(matchedFigure?.caption ?? "", /source \[1\]:/i, "Word-visible captions must retain the reference number");
const orderedFigureTitles = bodyImageBlocks
  .filter((block): block is Extract<(typeof bodyImageBlocks)[number], { type: "figure" }> => block.type === "figure")
  .map((block) => block.title);
assert.deepEqual(orderedFigureTitles.map((title) => title.match(/^Figure ([0-9]+)\./)?.[1]), ["1"]);

const richBlocks = articleToDocBlocks(enriched);
assert.ok(richBlocks.some((block) => block.type === "figure"));
assert.ok(!richBlocks.some((block) => block.type === "table"));
const richDocx = await createDocxFromBlocks(richBlocks);
const richZip = await JSZip.loadAsync(richDocx);
const embeddedPng = await richZip.file("word/media/figure1.png")?.async("nodebuffer");
assert.deepEqual(embeddedPng, SAFE_PNG_BYTES);
assert.equal(richZip.file("word/media/figure1.svg"), null);
const richXml = await richZip.file("word/document.xml")?.async("string");
const richRels = await richZip.file("word/_rels/document.xml.rels")?.async("string");
const richContentTypes = await richZip.file("[Content_Types].xml")?.async("string");
assert.ok(richXml?.includes('r:embed="rIdFigure1"'));
assert.match(richXml ?? "", /(?:source|来源) \[\d+\][：:]/i, "DOCX XML must retain source-reference attribution");
assert.ok(!richXml?.includes("asvg:svgBlip"));
assert.ok(richRels?.includes('Target="media/figure1.png"'));
assert.ok(richContentTypes?.includes('Extension="png" ContentType="image/png"'));
assert.ok(!richXml?.includes("<w:tbl>"));
const richParsed = await parseDocx(richDocx);
assert.ok(richParsed.paragraphs.some((paragraph) => paragraph.text === "References"));
assert.ok(!richParsed.paragraphs.some((paragraph) => paragraph.text.includes("表1 主要证据与出处")));

const renderBlocks = articleToRenderBlocks(enriched, richParsed.paragraphs);
const renderedFigures = renderBlocks.filter(
  (block): block is Extract<(typeof renderBlocks)[number], { type: "figure" }> => block.type === "figure"
);
assert.ok(renderedFigures.length > 0);
assert.ok(renderedFigures.every((block) =>
  block.origin === "web"
  && block.mediaDataUri.startsWith("data:image/")
  && !("svg" in block)
  && !("imageUrl" in block)
));
assert.ok(!renderBlocks.some((block) => block.type === "table"));
assert.ok(renderBlocks.some((block) => block.type === "references"));



console.log("article generation tests passed");
