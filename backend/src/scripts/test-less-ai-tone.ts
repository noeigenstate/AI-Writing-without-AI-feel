import assert from "node:assert/strict";
import { generateArticleDraft, type GeneratedArticle } from "../services/article.js";
import {
  applyLieflatLessAiTone,
  articleNeedsLieflatLessAiTone,
  paragraphTriggersRule,
} from "../services/lessAiTone.js";
import { LIEFLAT_LESS_AI_TONE_SOURCE } from "../prompts/lessAiTone.prompts.js";

const baseArticle: GeneratedArticle = {
  title: "边界清楚的测试稿",
  paragraphs: [
    "真正的壁垒不是技术，而是认知。2026 年样本增长了 20%[1]。",
    "这个问句要不要保留？当然要保留，因为问句本身不是 AI 痕迹。",
    "团队已经把处理时间从两小时缩短到四十分钟。",
    "最后一段保留原有判断。",
  ],
  paragraphRoles: ["hook", "evidence", "mechanism", "resolution"],
  sectionBreaks: [
    { beforeParagraphIndex: 1, heading: "一、样本变化" },
    { beforeParagraphIndex: 2, heading: "二、流程变化" },
    { beforeParagraphIndex: 3, heading: "三、最终判断" },
  ],
  mediaHints: [],
};

assert.equal(paragraphTriggersRule(1, "真正的壁垒不是技术，而是认知。", 0, []), true);
assert.equal(paragraphTriggersRule(2, "系统覆盖采集、存储、展示三个环节。", 0, []), true);
assert.equal(
  paragraphTriggersRule(3, "系统读取数据，团队检查结果。模型读取日志，工程师检查输出。", 0, []),
  true
);
assert.equal(paragraphTriggersRule(4, "答案其实很简单——专注。", 0, []), true);
assert.equal(paragraphTriggersRule(5, "核心是：先解决支付失败。", 0, []), true);
assert.equal(paragraphTriggersRule(6, "一、这是标题", 0, []), false, "heading cleanup is deterministic");
assert.equal(paragraphTriggersRule(7, "它像一位智慧的导师，不仅给结论，还给建议。", 0, []), true);
assert.equal(paragraphTriggersRule(8, "团队完成了对流程的优化。", 0, []), true);
assert.equal(paragraphTriggersRule(9, "说白了，这个项目预算不足。", 0, []), true);
assert.equal(paragraphTriggersRule(10, "对于早期团队来说，招人最难。", 0, []), true);
assert.equal(
  paragraphTriggersRule(11, "值得注意的是，配置按用户分层存放。", 1, ["上文。", "当前段。"]),
  true
);
assert.equal(
  articleNeedsLieflatLessAiTone({
    title: "不该误判",
    paragraphs: ["为什么要改？这是一个真实问题。", "首先检查输入，其次检查输出。", "这个长句本身不构成修改理由。"],
  }),
  false,
  "questions, body ordinals, and long sentences alone are not rewrite reasons"
);

assert.equal(articleNeedsLieflatLessAiTone(baseArticle), true);
let cleanupCalls = 0;
const cleaned = await applyLieflatLessAiTone(
  baseArticle,
  "作者偏好克制表达；事实和数字原样保留。",
  async (prompt, options) => {
    cleanupCalls += 1;
    assert.match(prompt, new RegExp(LIEFLAT_LESS_AI_TONE_SOURCE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.match(prompt, /白名单式改写/);
    assert.match(prompt, /风格参考与标点\/句式规则冲突时，以风格参考为准/);
    assert.equal(options?.temperature, 0.1);
    assert.equal(options?.disableThinking, true);
    return JSON.stringify({
      changes: [
        {
          paragraphIndex: 0,
          ruleIds: [1],
          text: "真正的壁垒是认知。2026 年样本增长了 20%[1]。",
        },
        {
          paragraphIndex: 1,
          ruleIds: [9],
          text: "这个问句被错误修改。",
        },
      ],
    });
  }
);
assert.equal(cleanupCalls, 1);
assert.equal(cleaned.paragraphs[0], "真正的壁垒是认知。2026 年样本增长了 20%[1]。");
assert.equal(cleaned.paragraphs[1], baseArticle.paragraphs[1], "a patch without its claimed trigger must be rejected");
assert.deepEqual(cleaned.paragraphRoles, baseArticle.paragraphRoles);
assert.deepEqual(cleaned.mediaHints, baseArticle.mediaHints);
assert.deepEqual(cleaned.sectionBreaks, [
  { beforeParagraphIndex: 1, heading: "样本变化" },
  { beforeParagraphIndex: 2, heading: "流程变化" },
  { beforeParagraphIndex: 3, heading: "最终判断" },
]);

let numberedStyleCalls = 0;
const numberedStyle = await applyLieflatLessAiTone({
  title: baseArticle.title,
  paragraphs: naturalParagraphs(),
  sectionBreaks: baseArticle.sectionBreaks,
}, "作者习惯：小标题保留一、二、三编号。", async () => {
  numberedStyleCalls += 1;
  return JSON.stringify({ changes: [] });
});
assert.equal(numberedStyleCalls, 0);
assert.deepEqual(numberedStyle.sectionBreaks, baseArticle.sectionBreaks, "explicit style guidance overrides rule 6");

const protectedArticle: GeneratedArticle = {
  title: "保护标记",
  paragraphs: [
    "说白了，2026 年的处理时间可能是 40 分钟，详见 https://example.com/report [2]，原文写着“保持引用”。",
    "第二段保持原样。",
    "第三段保持原样。",
  ],
};
const protectedResult = await applyLieflatLessAiTone(protectedArticle, "", async () => JSON.stringify({
  changes: [{ paragraphIndex: 0, ruleIds: [9], text: "处理时间变短了。" }],
}));
assert.equal(
  protectedResult.paragraphs[0],
  protectedArticle.paragraphs[0],
  "numbers, URLs, citations, and quoted text must block a lossy patch"
);

const wholesaleResult = await applyLieflatLessAiTone({
  title: "最小改动",
  paragraphs: ["说白了，这个项目预算不足。", "第二段保持原样。", "第三段保持原样。"],
}, "", async () => JSON.stringify({
  changes: [{ paragraphIndex: 0, ruleIds: [9], text: "天气转晴，团队准备出发。" }],
}));
assert.equal(
  wholesaleResult.paragraphs[0],
  "说白了，这个项目预算不足。",
  "a wholesale rewrite must be rejected even when its claimed rule exists"
);

const adjacentSentenceResult = await applyLieflatLessAiTone({
  title: "只改命中句",
  paragraphs: [
    "说白了，这个项目预算不足。第二句已经自然，不应该被顺手改掉。",
    "第二段保持原样。",
    "第三段保持原样。",
  ],
}, "", async () => JSON.stringify({
  changes: [{
    paragraphIndex: 0,
    ruleIds: [9],
    text: "这个项目预算不足。第二句被顺手改掉了。",
  }],
}));
assert.equal(
  adjacentSentenceResult.paragraphs[0],
  "说白了，这个项目预算不足。第二句已经自然，不应该被顺手改掉。",
  "sentences without a whitelist trigger must remain byte-for-byte intact"
);

const shortReversal = await applyLieflatLessAiTone({
  title: "翻案腔",
  paragraphs: ["这不是一个工具的问题，而是一个思维方式的问题。", "第二段保持原样。", "第三段保持原样。"],
}, "", async () => JSON.stringify({
  changes: [{ paragraphIndex: 0, ruleIds: [1], text: "这是思维方式的问题。" }],
}));
assert.equal(shortReversal.paragraphs[0], "这是思维方式的问题。", "the upstream minimal rewrite example remains admissible");

const naturalArticle: GeneratedArticle = {
  title: "无需清理",
  paragraphs: naturalParagraphs(),
};
let unnecessaryCalls = 0;
const untouched = await applyLieflatLessAiTone(naturalArticle, "", async () => {
  unnecessaryCalls += 1;
  return JSON.stringify({ changes: [] });
});
assert.equal(unnecessaryCalls, 0, "no whitelist trigger means no cleanup model call");
assert.equal(untouched, naturalArticle, "a clean article should retain object identity");

const triggerParagraph = `真正的壁垒不是技术，而是认知。${"甲".repeat(115)}`;
const fillerParagraph = (seed: string) => `${seed}${"乙".repeat(115)}`;
let integrationCalls = 0;
const integrated = await generateArticleDraft(
  {
    domainName: "AI 与科技",
    topic: "公众号成稿应用白名单清理",
    styleSummary: "公众号作者风格：克制、具体。",
    targetLength: "short",
    sceneId: "wechat",
    lang: "zh",
  },
  async (prompt, options) => {
    integrationCalls += 1;
    assert.equal(options?.disableThinking, true);
    if (integrationCalls === 1) {
      return JSON.stringify({
        title: "公众号清理测试",
        paragraphs: [
          triggerParagraph,
          fillerParagraph("第二段。"),
          fillerParagraph("第三段。"),
          fillerParagraph("第四段。"),
        ],
      });
    }
    assert.match(prompt, /lieflat-less-ai-tone/);
    return JSON.stringify({
      changes: [{
        paragraphIndex: 0,
        ruleIds: [1],
        text: `真正的壁垒是认知。${"甲".repeat(115)}`,
      }],
    });
  }
);
assert.equal(integrationCalls, 2, "Chinese WeChat generation adds one bounded cleanup pass");
assert.match(integrated.paragraphs[0], /^真正的壁垒是认知。/u);
assert.equal(integrated.length?.inRange, true);

let cleanWechatCalls = 0;
await generateArticleDraft(
  {
    domainName: "AI 与科技",
    topic: "无白名单命中的公众号稿",
    targetLength: "short",
    sceneId: "wechat",
    lang: "zh",
  },
  async () => {
    cleanWechatCalls += 1;
    return JSON.stringify({
      title: "无需二次调用",
      paragraphs: [
        fillerParagraph("开场段。"),
        fillerParagraph("第二段。"),
        fillerParagraph("第三段。"),
        fillerParagraph("收束段。"),
      ],
    });
  }
);
assert.equal(cleanWechatCalls, 1, "a clean WeChat draft skips the cleanup model call");

let generalSceneCalls = 0;
const generalScene = await generateArticleDraft(
  {
    domainName: "AI 与科技",
    topic: "非公众号场景不应用该 skill",
    targetLength: "short",
    sceneId: "general",
    lang: "zh",
  },
  async () => {
    generalSceneCalls += 1;
    return JSON.stringify({
      title: "通用场景",
      paragraphs: [
        triggerParagraph,
        fillerParagraph("第二段。"),
        fillerParagraph("第三段。"),
        fillerParagraph("第四段。"),
      ],
    });
  }
);
assert.equal(generalSceneCalls, 1);
assert.match(generalScene.paragraphs[0], /不是技术，而是认知/u);

function naturalParagraphs(): string[] {
  return [
    "用户为什么留下？这句话提出了一个真实问题。",
    "团队先看数据，再决定下一步怎么做。",
    "结果没有被夸大，判断也保留了边界。",
  ];
}

console.log("lieflat less-AI-tone integration tests passed");
