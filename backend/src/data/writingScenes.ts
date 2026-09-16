import type { Lang } from "../core/i18n.js";

export type WritingSceneId = "general" | "wechat" | "business" | "academic" | "official" | "social" | "technical";

interface WritingScene {
  id: WritingSceneId;
  profile: Record<Lang, string>;
}

const SCENES: WritingScene[] = [
  {
    id: "general",
    profile: {
      zh: "文体场景：通用自然表达。要求：保持信息密度，减少模板句和口号，语气自然但不过度口语化。修辞强度：中等且克制；可用一处具体场景和一个直觉比喻，情绪从好奇自然走向理解，不追求煽情。",
      en: "Writing scene: general natural prose. Keep the information density, reduce templated phrasing, and sound natural without becoming too casual. Rhetorical intensity: moderate and restrained; allow one concrete scene and one intuitive analogy, with an emotional movement from curiosity to understanding rather than melodrama.",
    },
  },
  {
    id: "wechat",
    profile: {
      zh: "文体场景：公众号文章。要求：开头直接给场景或判断，论点先行；允许轻微口语感，但不要营销号夸张和假互动。成稿后按 lieflat-less-ai-tone 的白名单规则做最小清理：未明确命中的句子、文章结构、事实、数字、引用和来源保持不变，不为了制造节奏强拆段落或长句。修辞强度：中等；可用开头场景与结尾回扣，普通问句、句内排比和有信息价值的比喻不视为 AI 痕迹。",
      en: "Writing scene: newsletter/article. Open with a scene or judgment, keep paragraphs short, lead with claims, and avoid hype or fake engagement. Rhetorical intensity: moderate; use an opening scene with a closing echo, at most one evidence-backed contrast-before-reveal, and only sparing personification or scene-emotion. Prefer a question → tension → turn → clarity arc.",
    },
  },
  {
    id: "business",
    profile: {
      zh: "文体场景：商务沟通。要求：克制、清楚、可执行；少情绪词，多结论、风险、影响和下一步。修辞强度：低；只允许服务于解释的简短类比，不用拟人和抒情场景，情绪节奏以“问题—风险—判断—行动”代替戏剧化起伏。",
      en: "Writing scene: business communication. Be restrained, clear, and actionable; prefer conclusions, risks, impact, and next steps over emotional wording. Rhetorical intensity: low; allow only a brief explanatory analogy, avoid personification and lyrical scenes, and use a problem → risk → judgment → action rhythm instead of dramatic emotion.",
    },
  },
  {
    id: "academic",
    profile: {
      zh: "文体场景：学术/报告。要求：概念准确，因果谨慎，避免口语化；每个判断尽量有证据、边界或限定条件。修辞强度：极低；只可用不改变概念边界的解释性类比，禁用拟人、欲扬先抑和情绪化因果。",
      en: "Writing scene: academic/report writing. Keep concepts precise, causality cautious, and claims bounded by evidence, scope, or limitations. Rhetorical intensity: minimal; use only explanatory analogies that preserve conceptual boundaries, with no personification, contrast-for-drama, or emotionalized causality.",
    },
  },
  {
    id: "official",
    profile: {
      zh: "文体场景：公文/正式说明。要求：语气稳妥、结构清晰、少修辞；避免网络词和过度口语，保留责任边界。修辞强度：关闭；不用拟人、欲扬先抑或抒情性场景，仅保留必要的客观说明。",
      en: "Writing scene: formal notice. Use a steady tone, clear structure, limited rhetoric, and keep responsibility boundaries explicit. Rhetorical intensity: off; do not use personification, contrast-before-reveal, or lyrical scenes, and retain only necessary objective explanation.",
    },
  },
  {
    id: "social",
    profile: {
      zh: "文体场景：社媒短文。要求：短句、强切口、少铺垫；可以口语，但必须具体，不要堆热词和夸张情绪。修辞强度：中高但严格限量；可用一个场景、一次反差或一处拟人，不得同时堆满，情绪走向以“抓住—转折—落点”为主。",
      en: "Writing scene: social post. Use short sentences and a sharp angle; be conversational but concrete, without buzzword stacking or exaggerated emotion. Rhetorical intensity: medium-high but tightly budgeted; use one scene, one contrast, or one personification rather than stacking all three, with a hook → turn → payoff arc.",
    },
  },
  {
    id: "technical",
    profile: {
      zh: "文体场景：技术文档/README。要求：步骤清楚、术语稳定、少形容词；命令、参数、限制和注意事项不能被改写错。修辞强度：极低；可用一个帮助理解机制的类比，不用拟人或抒情，结构按“问题—机制—步骤—限制”推进。",
      en: "Writing scene: technical docs/README. Keep steps clear, terminology stable, adjectives sparse, and never distort commands, parameters, limits, or caveats. Rhetorical intensity: minimal; allow one mechanism-explaining analogy, avoid personification and lyricism, and progress through problem → mechanism → steps → limits.",
    },
  },
];

export function writingSceneProfile(id: string | undefined, lang: Lang): string {
  const scene = SCENES.find((item) => item.id === id) ?? SCENES[0];
  return scene.profile[lang];
}
