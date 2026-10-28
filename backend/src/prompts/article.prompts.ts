/**
 * Prompt builders for the article-generation flow: topic planning and full drafts.
 * Both are bilingual (en/zh) and embed the shared anti-AI ruleset.
 */

import type {
  GeneratedArticle,
  GenerateArticleInput,
  ResearchCoverageSummary,
  TopicOption,
} from "../services/article.js";
import type { Lang } from "../core/i18n.js";
import { getArticleLengthSpec, type ArticleLengthTier } from "../services/articleLength.js";
import { ANTI_AI_RULES_ZH, ANTI_AI_RULES_EN } from "./rules.js";

/**
 * Build the prompt that proposes article topics for a domain.
 *
 * @param domainName Human-readable domain name.
 * @param domainDesc Short description of the domain.
 * @param n Number of topics to request.
 * @param researchContext Optional live-source context to ground the topics.
 * @param lang Output language.
 * @returns A prompt requesting a JSON array of topic objects.
 */
export function articleTopicsPrompt(
  domainName: string,
  domainDesc: string,
  n: number,
  researchContext = "",
  lang: Lang = "en",
  researchCoverage?: ResearchCoverageSummary
): string {
  if (lang === "zh") {
    return `${ANTI_AI_RULES_ZH}

你是一个公众号选题策划。请围绕下面领域生成 ${n} 个适合公众号文章的一手选题。

领域：${domainName}
领域说明：${domainDesc}

最新参考资料：
${researchContext || "（暂无实时资料，按领域常识生成，但不要编造具体事实。）"}

选题要求：
1. 选题要具体，不要泛泛写"趋势""启示""思考"。
2. 每个选题要有清晰切口，读者一看就知道文章会讲什么。
3. 避开营销号标题党，不能承诺无法验证的结果。
4. 优先给出能写成长文、能展开案例和观点的题目。
5. ${topicRegionRule("zh", researchCoverage)}

严格只输出 JSON 数组，每项形如：
{"title":"选题标题","angle":"文章切入角度","audience":"适合读者","keywords":["关键词1","关键词2"]}
不要任何额外文字、不要 markdown 代码块。`;
  }

  return `${ANTI_AI_RULES_EN}

You are an editorial topic planner. Propose ${n} first-hand article topics for the domain below.

Domain: ${domainName}
Domain notes: ${domainDesc}

Latest reference material:
${researchContext || "(no live material; use domain common sense, but do not invent specific facts.)"}

Requirements:
1. Topics must be specific — no vague "trends", "lessons", or "reflections".
2. Each topic needs a clear angle so a reader immediately knows what the piece will cover.
3. Avoid clickbait; do not promise results that cannot be verified.
4. Prefer topics that can sustain a long piece with cases and a point of view.
5. ${topicRegionRule("en", researchCoverage)}

Output strictly a JSON array, each item like:
{"title":"Topic title","angle":"Entry angle","audience":"Intended reader","keywords":["keyword1","keyword2"]}
No extra text, no markdown code block.`;
}

/**
 * Build the prompt that writes a full, publishable article from a topic.
 *
 * Length guidance and citation rules vary by language. The model writes body
 * text plus semantic paragraph metadata and media intent; the article service
 * resolves actual figures and references later.
 *
 * @param input Domain, topic, style, target length, research context, and language.
 * @returns A prompt requesting `{title, paragraphs: object[], mediaHints}` JSON.
 */
export function articleDraftPrompt(input: GenerateArticleInput): string {
  const lang: Lang = input.lang ?? "en";
  const topic = typeof input.topic === "string" ? { title: input.topic } : (input.topic as TopicOption);
  const targetLength = input.targetLength ?? "medium";
  const lengthHint = articleLengthHint(lang, targetLength);
  const lengthRule = articleLengthRule(lang, targetLength);
  const planningRule = articlePlanningRule(lang);
  const structureRule = articleStructureRule(lang, targetLength);
  const craftRule = narrativeCraftRule(lang, targetLength);
  const mediaRule = articleMediaRule(lang, targetLength);
  const outputContract = articleOutputContract(lang, targetLength);

  if (lang === "zh") {
    return `${ANTI_AI_RULES_ZH}

你要直接写一篇可发布的中文文章。先在内部整理材料与叙事节拍，但不要把提纲或写作思路输出成额外文字。

领域：${input.domainName}
选题：${topic.title}
切入角度：${"angle" in topic ? topic.angle : "围绕选题展开"}
目标读者：${"audience" in topic ? topic.audience : "公众号读者"}
目标长度：${lengthHint}

要模仿的风格：
${input.styleSummary || "（无特定范文，按去 AI 味原则写，短句优先，信息密度高。）"}

最新参考资料：
${input.researchContext || "（暂无实时资料。不要编造新闻、论文或数据。）"}

动笔前的内部整理（只执行，不输出）：
${planningRule}

${input.qualityRepairInstruction
  ? `本轮强制修复要求（只落实到成稿，不要提及审查过程）：\n${input.qualityRepairInstruction}\n`
  : ""}

写作要求：
1. 开头直接进入问题或场景，不要说"在当今时代""随着发展"。
2. 只使用上方参考资料能支撑的事实、数据、机构名、论文结论、网页文章和新闻事件。资料里没有的内容，不要写。
3. 涉及事实、数据、机构、论文、网页文章或新闻事件时，在相关句末尽量标注能直接支撑它的来源编号，如 [1]、[2]。引用编号只能来自"来源资料 N"；开头、过渡、个人分析和收束段无需为了凑编号强行引用。
4. "公开评论/讨论"只能用来呈现个人体验、舆论分歧或反方视角。必须写清是谁、在哪个平台表达，不能把个别评论写成普遍事实、统计结论或权威证据。
5. 摘录默认转述。只有原话本身有分析价值时才直接引用；中文原话每处不超过 60 个字，英文不超过 25 个词，不拼接多段原文，并在引号后立刻标注引用编号。
6. ${articleRegionRule("zh", input.researchCoverage)}
7. ${structureRule}
8. ${craftRule}
9. ${lengthRule}不同长度档位要有明显差别，不能只多写一两段。
10. 禁止 AI 口头禅和废话：不要写"值得注意的是""不可忽视""赋能""新范式""深度融合""未来可期""综上所述"。
11. 不要擅自发散，不要写无法验证的预测，不要把推测写成事实。
12. 语言凝练通俗，论点先行，论据跟上。句子长短有变化，不堆形容词。用具体例子、画面和直觉类比把专业概念讲清；开头留钩子，但不夸大、不做无法验证的承诺。
13. ${mediaRule}
14. 正文字段、小标题和媒体提示都不得包含 Markdown。不要自行插入图片链接、Markdown 图片或列表符号。

${outputContract}
不要任何额外文字、不要 markdown 代码块。`;
  }

  return `${ANTI_AI_RULES_EN}

Write a publishable English article directly. First organize the material and narrative beats internally, but do not emit an outline or process commentary as extra text.

Domain: ${input.domainName}
Topic: ${topic.title}
Angle: ${"angle" in topic ? topic.angle : "develop around the topic"}
Audience: ${"audience" in topic ? topic.audience : "general readers"}
Target length: ${lengthHint}

Style to imitate:
${input.styleSummary || "(no specific sample; write with the de-AI principles, short sentences first, high information density.)"}

Latest reference material:
${input.researchContext || "(no live material. Do not invent news, papers, or data.)"}

Internal preparation before drafting (perform it, do not output it):
${planningRule}

${input.qualityRepairInstruction
  ? `Mandatory repair for this draft (apply it silently; do not mention the audit):\n${input.qualityRepairInstruction}\n`
  : ""}

Requirements:
1. Open straight into the problem or scene; do not say "In today's era" or "With the development of".
2. Use only facts, numbers, institution names, paper findings, web articles, and news events that the material above can support. If it is not in the material, do not write it.
3. When stating facts, numbers, institutions, paper findings, web articles, or news events, cite a source that directly supports the relevant sentence where possible, e.g. [1], [2]. Citation numbers may only come from "source material N"; do not force citations into openings, transitions, personal analysis, or closing paragraphs merely to fill a marker.
4. Treat "public comment/discussion" only as personal experience, disagreement, or a counterpoint. Attribute the speaker and platform; never turn one comment into a general fact, statistic, or authoritative evidence.
5. Paraphrase excerpts by default. Quote directly only when the wording itself matters: no more than 25 English words or 60 Chinese characters per quote, never stitch passages together, and place the citation immediately after the quote.
6. ${articleRegionRule("en", input.researchCoverage)}
7. ${structureRule}
8. ${craftRule}
9. ${lengthRule} The three modes must feel substantially different, not just one or two extra paragraphs.
10. No AI filler: avoid "It is worth noting", "cannot be ignored", "empower", "new paradigm", "deep integration", "a promising future", "in conclusion".
11. Do not wander, write unverifiable predictions, or present speculation as fact.
12. Use tight, plain prose, claim first then evidence. Vary sentence length without piling up adjectives. Use concrete examples, visual detail, and intuitive analogies so a non-expert grasps the point at a glance; open with a hook, without hype or unverifiable promises.
13. ${mediaRule}
14. Body text, headings, and media hints must contain no Markdown. Do not insert image URLs, Markdown images, or list bullets yourself.

${outputContract}
No extra text, no markdown code block.`;
}

/**
 * Build the corrective prompt that expands or condenses a draft to its length band.
 *
 * Used when the first draft misses the target-length band: the model gets its
 * own draft back plus the research context and must return the same JSON shape.
 *
 * @param article The off-target draft.
 * @param input The original generation input (for research context and language).
 * @param currentLength Measured body length (chars for zh, words for en).
 * @returns A prompt requesting the same structured article JSON contract.
 */
export function articleLengthFixPrompt(
  article: GeneratedArticle,
  input: GenerateArticleInput,
  currentLength: number
): string {
  const lang: Lang = input.lang ?? "en";
  const tier = input.targetLength ?? "medium";
  const spec = getArticleLengthSpec(lang, tier);
  const expand = currentLength < spec.min;
  const draftJson = JSON.stringify(articleRevisionPayload(article));
  const outputContract = articleOutputContract(lang, tier);

  if (lang === "zh") {
    return `${ANTI_AI_RULES_ZH}

下面这篇文章草稿的正文目前约 ${currentLength} 字，但目标长度是 ${spec.min}-${spec.max} 字。请把它${
      expand ? "扩写" : "压缩"
    }到目标区间，直接输出改后的完整文章。

原稿（JSON）：
${draftJson}

参考资料：
${input.researchContext || "（暂无实时资料。不要编造新闻、论文或数据。）"}

要求：
1. ${
      expand
        ? `扩写只能基于参考资料展开：${expansionRegionPriority("zh", input.researchCoverage)}再补案例细节、数据对比、机制解释、反方观点和限制条件；不要重复原有内容，资料里没有的事实一律不写。`
        : "压缩时删掉重复表述和空话，优先合并同义段落；所有关键事实、数据和判断必须保留。"
    }
2. 保留原稿的叙事骨架：开场 hook、关键 turn、反方或边界、resolution 都不得因字数调整而消失。压缩优先收紧中间重复处，不要砍掉结尾回扣；扩写要增加新的逻辑节拍，不要换词重复。
3. 保留每段的 role 和章节小标题。若原稿 paragraphs 是旧的字符串数组，为它们补出合理的 role 与 heading，并按新对象格式返回。中长文保留足以快速扫读的小标题，短文不为凑结构强加标题。
4. 保留原有的引用编号（如 [1]、[2]），不要新增指向不存在来源的编号。
5. 公开评论仍只能作为个人观点或争议视角，不能扩写成事实；直接摘录仍须保持简短并明确归属。
6. ${articleRegionRule("zh", input.researchCoverage)}
7. 保持原稿的语气、情绪曲线和克制的修辞预算。不要为了扩写额外堆叠欲扬先抑、拟人、比喻或抒情；也不要在压缩时把必要的场景与转折全部删掉。
8. 保留 mediaHints 的语义锚点、kind 和 purpose。段落数变化后，把 afterParagraph 重新计算为有效的 1-based 段落号，移到与原意最接近的段落；删掉已无相关正文的提示，不要伪造 URL 或新来源。
9. 改完后的正文总字数必须落在 ${spec.min}-${spec.max} 字之间。只统计 paragraphs 中的 text，不含 title、heading、mediaHints 和 [n] 引用编号；去除空白后按 Unicode 字符计数。

${outputContract}
不要任何额外文字、不要 markdown 代码块。`;
  }

  return `${ANTI_AI_RULES_EN}

The article body below is about ${currentLength} words, but the target length is ${spec.min}-${spec.max} words. ${
    expand ? "Expand" : "Condense"
  } it into the target band and output the full revised article directly.

Draft (JSON):
${draftJson}

Reference material:
${input.researchContext || "(no live material. Do not invent news, papers, or data.)"}

Requirements:
1. ${
    expand
      ? `Expand only from the reference material: ${expansionRegionPriority("en", input.researchCoverage)}then add case detail, data comparisons, mechanism, counterpoints, and limits. Do not repeat existing material or write unsupported facts.`
      : "Cut repetition and filler, merge redundant paragraphs; keep every key fact, number, and judgment."
  }
2. Preserve the narrative spine: the opening hook, key turn, counterpoint or boundary, and resolution must not disappear merely to hit the length band. Condense repeated middle material before touching the closing echo; when expanding, add a new logical beat rather than paraphrasing an existing one.
3. Preserve each paragraph's role and section heading. If the draft uses the legacy string array, infer sensible roles and headings and return the preferred object format. Keep enough headings for medium and long pieces to scan quickly; do not force headings into a short piece.
4. Keep existing citation markers (e.g. [1], [2]); do not add markers that point to no source.
5. Public comments remain personal viewpoints or counterpoints, never facts; any direct excerpt must stay short and attributed.
6. ${articleRegionRule("en", input.researchCoverage)}
7. Preserve the draft's voice, emotional movement, and restrained rhetorical budget. Do not pile on extra contrast-before-reveal, personification, metaphor, or lyricism merely to expand; do not delete every scene and turn merely to condense.
8. Preserve each media hint's semantic anchor, kind, and purpose. After changing paragraph count, recalculate afterParagraph as a valid 1-based paragraph number nearest to the same idea. Drop an orphaned hint when its related text is gone; never invent a URL or source.
9. The revised body must land between ${spec.min} and ${spec.max} words. Count only paragraph text, excluding title, headings, mediaHints, and [n] citation markers; words are whitespace-delimited tokens.

${outputContract}
No extra text, no markdown code block.`;
}

/**
 * Build a narrowly scoped repair prompt for readability/flow problems.
 *
 * Unlike length correction, this pass may only address the supplied structural
 * issues. It must preserve the article's evidence boundary and visual intent.
 */
export function articleFlowFixPrompt(
  article: GeneratedArticle,
  input: GenerateArticleInput,
  issues: string[]
): string {
  const lang: Lang = input.lang ?? "en";
  const tier = input.targetLength ?? "medium";
  const spec = getArticleLengthSpec(lang, tier);
  const draftJson = JSON.stringify(articleRevisionPayload(article));
  const issueJson = JSON.stringify(issues.slice(0, 12));
  const outputContract = articleOutputContract(lang, tier);

  if (lang === "zh") {
    return `${ANTI_AI_RULES_ZH}

下面这篇文章的事实边界已经确定。你只做一次局部的阅读流修复，不要把全文改成另一篇文章。

原稿（JSON）：
${draftJson}

只需修复的问题（JSON 数组）：
${issueJson}

参考资料：
${input.researchContext || "（暂无实时资料。不要编造新闻、论文或数据。）"}

修复规则：
1. 只改与问题列表直接相关的段落、role 或 heading；已经清楚、有证据的内容尽量不动。
2. 不新增任何事实、数据、机构、人物、引语、场景细节或因果关系。不得删改原有事实的含义。
3. 保留有效的 [n] 引用，不新增指向不存在来源的编号。${articleRegionRule("zh", input.researchCoverage)}
4. 遇到重复，要合并删减或补上新的解释关系，不要只换同义词。禁止按来源顺序重写成资料流水账。
5. evidence 段后若缺少“这说明什么/为什么”，只能用已有资料和原稿判断补 mechanism；证据不足时收紧判断或改写为限制，不要编造机制。
6. 缺 role 时补出最小必要的角色；中长文缺章节时用简短 heading 按问题分层。结尾没有回扣时，让 resolution 回应开场问题或意象，不要加“综上所述”式总结。
7. 保持原稿的语气、情绪曲线和修辞预算；不要为修结构额外堆比喻、拟人或欲扬先抑。
8. 保留 mediaHints 的 kind、purpose、query、alt 和可用的 sourceRefs。段落顺序变化后，把 afterParagraph 调整为语义最接近的有效 1-based 段落号；不新增无关媒体提示。
9. 正文尽量保持在 ${spec.min}-${spec.max} 字，只统计 paragraphs.text，不含 title、heading、mediaHints 和 [n] 引用编号。

${outputContract}
不要任何额外文字、不要 markdown 代码块。`;
  }

  return `${ANTI_AI_RULES_EN}

The factual boundary of the article below is already fixed. Perform one local reading-flow repair only; do not turn it into a different article.

Draft (JSON):
${draftJson}

Issues to repair and nothing else (JSON array):
${issueJson}

Reference material:
${input.researchContext || "(no live material. Do not invent news, papers, or data.)"}

Repair rules:
1. Change only paragraphs, roles, or headings directly implicated by the issue list. Leave already clear, supported material alone where possible.
2. Add no facts, numbers, institutions, people, quotations, scene details, or causal relationships. Do not alter the meaning of existing facts.
3. Keep valid [n] citations and add no marker for a nonexistent source. ${articleRegionRule("en", input.researchCoverage)}
4. For repetition, merge or cut material, or supply the missing relationship from existing content; do not merely swap synonyms. Never rewrite the piece as a source-by-source digest.
5. If an evidence paragraph lacks the "what this means/why" step, add a mechanism only from the supplied material and existing draft. When evidence is insufficient, narrow the claim or express the limitation instead of inventing causality.
6. Add the minimum missing roles. For a medium or long piece missing sections, use brief question-led headings. If the ending lacks a callback, make the resolution answer the opening question or image without an "in conclusion" summary.
7. Preserve the draft's voice, emotional movement, and rhetorical budget. Do not pile on metaphor, personification, or contrast-before-reveal merely to repair structure.
8. Preserve each media hint's kind, purpose, query, alt, and usable sourceRefs. After reordering, move afterParagraph to the nearest semantically matching valid 1-based paragraph; add no unrelated media hint.
9. Keep the body near ${spec.min}-${spec.max} words. Count only paragraphs.text, excluding title, headings, mediaHints, and [n] citation markers.

${outputContract}
No extra text, no markdown code block.`;
}

/** Tell the model how to turn a flat source bundle into a reader-first argument. */
function articlePlanningRule(lang: Lang): string {
  if (lang === "zh") {
    return `1. 先识别哪些资料在报道同一件事或复述同一结论，合并重复信息；多个来源只作交叉佐证，不把同一件事扩写多遍。
2. 按“读者问题—事实证据—因果或机制—争议与限制—可落地判断”归组，提炼一个全文核心判断。相互冲突的材料要呈现分歧，不得合并成虚假共识。
3. 按读者的理解依赖排列段落：先让人知道为什么值得关心，再给证据、解释机制、呈现边界并收束。禁止按“来源 1 说……来源 2 又说……”的流水账组织全文。
4. 为每段先确定唯一任务、role、所属章节和证据编号，再写 text；证据段之后要回答“这说明什么”，不让读者自己拼接材料。
5. 先确定普通图片或 GIF 真正能帮助进入场景、理解证据、看清过程或缓冲阅读的位置；媒体提示不得引入新事实。`;
  }

  return `1. Identify sources that report the same event or repeat the same finding, and merge that duplication internally. Multiple sources may corroborate one point; they must not inflate it into several paragraphs.
2. Group material by reader question, factual evidence, cause or mechanism, dispute and limits, and actionable judgment. Distill one central claim. Preserve genuine conflicts as disagreement instead of merging them into false consensus.
3. Order paragraphs by what the reader needs to understand next: why this matters, what the evidence shows, how it works, where the boundaries are, and what judgment follows. Never organize the article as "source 1 says... source 2 says...".
4. Assign each paragraph one job, role, section, and evidence mapping before writing its text. Evidence must be followed by the "what this means" step so the reader is not left to assemble a pile of material.
5. Decide where a still image or GIF genuinely helps the reader enter a scene, inspect evidence, understand motion/process, or take a visual breath. A media hint must never introduce a new fact.`;
}

/** Describe the semantic paragraph/heading contract for the requested length. */
function articleStructureRule(lang: Lang, tier: ArticleLengthTier): string {
  const headingRule =
    lang === "zh"
      ? tier === "short"
        ? "短文 heading 默认留空，只有一次明显转折确实需要分层时才用 1 个小标题。"
        : tier === "long"
          ? "长文用 4-6 个短小标题按问题分层。同一章节只在首段写 heading，后续段落 heading 留空。"
          : "中等长度用 2-3 个短小标题按问题分层。同一章节只在首段写 heading，后续段落 heading 留空。"
      : tier === "short"
        ? "For a short piece, leave heading empty by default; use at most one heading only when a real turn needs separation."
        : tier === "long"
          ? "Use 4-6 brief, question-led headings in a long piece. Put the heading only on the first paragraph of its section and leave it empty on following paragraphs."
          : "Use 2-3 brief, question-led headings at medium length. Put the heading only on the first paragraph of its section and leave it empty on following paragraphs.";

  if (lang === "zh") {
    return `正文必须按问题、因果和争议推进，不得按来源顺序摘要。每段只推进一个意思，并使用 role：hook（只用于开场）、context、evidence、mechanism、turn、counterpoint、resolution（用于收束回扣）。前两段内要让读者明白核心问题或判断；evidence 之后及时用 mechanism 或 turn 解释“这意味着什么”。资料不支持反方时不要硬造 counterpoint。${headingRule}`;
  }

  return `Organize the body by questions, causality, and disputes, never by source order. Each paragraph advances one idea and uses one role: hook (opening only), context, evidence, mechanism, turn, counterpoint, or resolution (closing callback). By the end of paragraph two, make the central question or judgment clear. Follow evidence promptly with a mechanism or turn that explains what it means. Do not manufacture a counterpoint when the material does not support one. ${headingRule}`;
}

/** Bound literary techniques so they help comprehension without corrupting facts. */
function narrativeCraftRule(lang: Lang, tier: ArticleLengthTier): string {
  const personificationLimit = tier === "long" ? 2 : 1;
  const sceneLimit = tier === "short" ? 1 : 2;
  if (lang === "zh") {
    return `文学性必须服务于理解，不是修辞任务清单；“要模仿的风格”里的修辞强度可以进一步降低下述上限，并且优先级更高。欲扬先抑最多 1 次，且只能把资料已经支撑的限制、质疑或落差放在真实转折之前，不得制造稻草人。拟人最多 ${personificationLimit} 处，只用于过渡或解释意象，不放在 evidence 事实句中，不给市场、机构、技术或人物编造意图、情绪和因果。情景交融最多 ${sceneLimit} 个场景锚点；真实人物的动作、心理、对话、时间和地点必须有来源，无来源的概括性场景不得写成亲历新闻现场。全文情绪从疑问或落差走向转折、理解与判断；这是读者的阅读节奏，不是“全民焦虑”一类无证据的群体情绪断言。事实句先按字面写清并标注来源；比喻或意象另句表达，不让引用编号看起来在为修辞背书。`;
  }

  return `Literary craft must improve comprehension, not become a checklist. The rhetorical intensity in the requested style may lower the following ceilings and takes priority. Use contrast-before-reveal at most once, and only by placing a source-supported limitation, objection, or gap before a genuine turn; never manufacture a straw man. Use personification at most ${personificationLimit} time${personificationLimit === 1 ? "" : "s"}, only as a transition or explanatory image, never inside an evidence claim, and never to invent intentions, emotions, or causality for a market, institution, technology, or person. Use at most ${sceneLimit} scene-emotion anchor${sceneLimit === 1 ? "" : "s"}. A real person's actions, thoughts, dialogue, time, and place require source support; a generic framing scene must not masquerade as witnessed news. Let the reading emotion move from a question or gap through a turn toward understanding and judgment. That is reader rhythm, not permission to assert unsupported mass emotion. State factual claims literally with citations first; keep metaphor or imagery in a separate sentence so a source marker does not appear to endorse the flourish.`;
}

/** Ask only for search intent that can be matched to real retrieved web media. */
function articleMediaRule(lang: Lang, tier: ArticleLengthTier): string {
  const target = tier === "short" ? "1-2" : tier === "long" ? "4-6" : "2-4";
  if (lang === "zh") {
    return `在确有相关视觉锚点时，给出 ${target} 个 mediaHints；资料不足时可以更少或为空。媒体只能从本次检索资料所引用的真实网页图片或 GIF 中选择，严禁生成、补画、合成或设想不存在的画面。kind 只能是 image 或 gif；GIF 最多 1 个，只用于动作、流程或随时间变化的内容，静态概念不用 GIF。purpose 只能是 scene、evidence、explanation 或 breather。query 只写可用于查找现有网络素材的具体检索条件，包括真实主体、事件或过程及必要的时间/地点限定，不写生成提示词、构图、氛围或视觉风格。每项都应优先用 sourceRefs 绑定标有“来源图片可用: 是”的现有“来源资料 N”；没有与内容匹配的有图来源时，mediaHints 可以为空，不得改绑无图来源或为凑数编造。alt 只客观描述期望查找的真实画面。不要输出远程 URL。`;
  }

  return `When a relevant visual anchor genuinely exists, provide ${target} mediaHints; use fewer or an empty array when the material is insufficient. Media may only select real web images or GIFs cited by the retrieved sources. Never generate, complete, composite, or imagine a nonexistent visual. kind is image or gif. Use at most one GIF, only for action, process, or change over time—never for a static concept. purpose is scene, evidence, explanation, or breather. Write query only as concrete retrieval criteria for existing web media: the real subject, event, or process plus any necessary time or place qualifier. Do not write an image-generation prompt or specify composition, mood, or visual style. Prioritize sourceRefs whose existing "source material N" entry is marked "来源图片可用: 是". If no image-bearing source genuinely matches the content, mediaHints may be empty; do not bind an image-less source or invent one to fill a quota. Make alt an objective description of the real visual to find. Output no remote URL.`;
}

/** Describe the preferred object-based article JSON while documenting legacy input. */
function articleOutputContract(lang: Lang, tier: ArticleLengthTier): string {
  const headingRule =
    lang === "zh"
      ? tier === "short"
        ? "短文 heading 通常为空字符串。"
        : "只在新章节的首段填写 heading，同节后续段落留空。"
      : tier === "short"
        ? "For short pieces, heading should usually be an empty string."
        : "Set heading only on the first paragraph of a new section; leave it empty on later paragraphs in that section.";

  if (lang === "zh") {
    return `严格只输出一个 JSON 对象。JSON 只是传输外壳；其中的 title、heading、text、query、alt 和 caption 都必须是无 Markdown 的纯文本。
本次输出的 paragraphs 必须优先使用对象数组，每项严格包含 role、heading、text。role 只能是 hook、context、evidence、mechanism、turn、counterpoint、resolution。${headingRule}系统仍能读取旧 paragraphs:string[]，但那只是兼容输入，本次不要输出字符串数组。
mediaHints 必须存在，没有合适素材时输出 []。每项包含 afterParagraph（从 1 开始的段落号，必须落在 paragraphs 范围内）、kind、purpose、query、alt、sourceRefs；caption 可选。sourceRefs 至少包含一个编号，且只能引用已存在的“来源资料 N”；优先引用标有“来源图片可用: 是”的编号，没有匹配的有图来源时输出 []。
格式示例：
{"title":"文章标题","paragraphs":[{"role":"hook","heading":"","text":"开场段落"},{"role":"evidence","heading":"一个具体问题","text":"证据段落[1]"},{"role":"resolution","heading":"","text":"回扣开场的收束段"}],"mediaHints":[{"afterParagraph":1,"kind":"image","purpose":"scene","query":"来源资料1中的真实主体或事件现场","alt":"客观的真实画面描述","sourceRefs":[1]},{"afterParagraph":2,"kind":"gif","purpose":"explanation","query":"来源资料1记录的真实动态过程","alt":"真实动作或流程描述","caption":"可选图注","sourceRefs":[1]}]}`;
  }

  return `Output exactly one JSON object. JSON is only the transport wrapper; title, heading, text, query, alt, and caption must all be plain text without Markdown.
For this output, paragraphs must use the preferred object array. Every item contains role, heading, and text. role is one of hook, context, evidence, mechanism, turn, counterpoint, or resolution. ${headingRule} The system still accepts legacy paragraphs:string[] as input compatibility, but do not emit a string array now.
mediaHints must be present; use [] when no honest visual fits. Every item contains afterParagraph (a 1-based paragraph number inside the paragraphs array), kind, purpose, query, alt, and sourceRefs. caption is optional. sourceRefs must contain at least one number and may reference only existing "source material N" entries; prioritize entries marked "来源图片可用: 是", and use [] when no matching image-bearing source exists.
Example:
{"title":"Article title","paragraphs":[{"role":"hook","heading":"","text":"Opening paragraph"},{"role":"evidence","heading":"A concrete question","text":"Evidence paragraph [1]"},{"role":"resolution","heading":"","text":"Closing paragraph that echoes the opening"}],"mediaHints":[{"afterParagraph":1,"kind":"image","purpose":"scene","query":"real subject or event documented by source material 1","alt":"objective description of the real visual","sourceRefs":[1]},{"afterParagraph":2,"kind":"gif","purpose":"explanation","query":"real dynamic process documented by source material 1","alt":"description of the real action or process","caption":"optional caption","sourceRefs":[1]}]}`;
}

/** Rebuild the preferred model-facing object shape from the normalized article. */
function articleRevisionPayload(article: GeneratedArticle): Record<string, unknown> {
  const headingByIndex = new Map<number, string>();
  for (const section of article.sectionBreaks ?? []) {
    if (!headingByIndex.has(section.beforeParagraphIndex)) {
      headingByIndex.set(section.beforeParagraphIndex, section.heading);
    }
  }

  const paragraphs = article.paragraphs.map((text, index) => ({
    role: article.paragraphRoles?.[index] ?? defaultParagraphRole(index, article.paragraphs.length),
    heading: headingByIndex.get(index) ?? "",
    text,
  }));
  const mediaHints = (article.mediaHints ?? []).map((hint) => ({
    afterParagraph: hint.afterParagraphIndex + 1,
    kind: hint.kind,
    purpose: hint.purpose,
    query: hint.query,
    alt: hint.alt,
    ...(hint.caption ? { caption: hint.caption } : {}),
    ...(hint.sourceRefs.length > 0 ? { sourceRefs: hint.sourceRefs } : {}),
  }));

  return { title: article.title, paragraphs, mediaHints };
}

function defaultParagraphRole(index: number, count: number): "hook" | "context" | "resolution" {
  if (index === 0) return "hook";
  if (index === count - 1) return "resolution";
  return "context";
}

/** Build tier-specific prompt guidance from the shared runtime specification. */
function articleLengthHint(lang: Lang, tier: ArticleLengthTier): string {
  const spec = getArticleLengthSpec(lang, tier);
  if (lang === "zh") {
    const shape =
      tier === "short"
        ? "4-6 个短段落，适合快速发布"
        : tier === "long"
          ? "至少 14 个段落，充分展开案例、证据、机制、反方观点和收束判断"
          : "8-10 个段落，适合标准公众号文章";
    return `${spec.min}-${spec.max} 字正文（不含标题和 [n] 引用编号；去除空白后按 Unicode 字符计数），${shape}。`;
  }

  const shape =
    tier === "short"
      ? "4-6 short paragraphs for a quick post"
      : tier === "long"
        ? "at least 14 paragraphs with fuller cases, evidence, counterpoints, and a closing judgment"
        : "8-10 paragraphs for a standard article";
  return `${spec.min}-${spec.max} body words (title and [n] citation markers excluded; words are whitespace-delimited tokens), ${shape}.`;
}

/** Build the strict length rule without duplicating numeric ranges. */
function articleLengthRule(lang: Lang, tier: ArticleLengthTier): string {
  const spec = getArticleLengthSpec(lang, tier);
  return lang === "zh"
    ? `正文必须落在 ${spec.min}-${spec.max} 字；只统计 paragraphs 中的 text，不含 title、heading、mediaHints 和 [n] 引用编号，去除空白后按 Unicode 字符计数。`
    : `The body must contain ${spec.min}-${spec.max} words; count only paragraphs.text, exclude title, headings, mediaHints, and [n] citation markers, and treat whitespace-delimited tokens as words.`;
}

function hasRegion(coverage: ResearchCoverageSummary | undefined, region: "domestic" | "international"): boolean {
  return !coverage || coverage[region] > 0;
}

/** Make the cross-region instruction match the evidence actually retrieved. */
function articleRegionRule(lang: Lang, coverage?: ResearchCoverageSummary): string {
  const domestic = hasRegion(coverage, "domestic");
  const international = hasRegion(coverage, "international");
  if (domestic && international) {
    return lang === "zh"
      ? "同时使用国内外材料：比较共同事实、叙事差异、制度或市场语境与争议。不要把来源数量当成共识证据，也不要为求对称而制造虚假平衡；结论以可核验事实为准。"
      : "Use both domestic and international material. Compare shared facts, narrative differences, institutional or market context, and disputes. Source count is not evidence of consensus; do not create false balance for symmetry. Base conclusions on verifiable facts.";
  }
  if (domestic) {
    return lang === "zh"
      ? "当前资料只有可确认的国内来源；明确这一证据边界，不要虚构国际观点、案例或所谓海外共识。结论只基于可核验资料。"
      : "The retrieved evidence has confirmed domestic sources only. State that boundary; do not invent international views, cases, or overseas consensus. Base conclusions only on verifiable material.";
  }
  if (international) {
    return lang === "zh"
      ? "当前资料只有可确认的国际来源；明确这一证据边界，不要虚构国内观点、案例或所谓本土共识。结论只基于可核验资料。"
      : "The retrieved evidence has confirmed international sources only. State that boundary; do not invent domestic views, cases, or local consensus. Base conclusions only on verifiable material.";
  }
  return lang === "zh"
    ? "当前没有可确认地区的资料；不要编造国内外对照、新闻、案例或数据，只能明确资料缺口。"
    : "No regionally verified evidence was retrieved. Do not invent cross-region comparisons, news, cases, or data; state the evidence gap plainly.";
}

function topicRegionRule(lang: Lang, coverage?: ResearchCoverageSummary): string {
  const domestic = hasRegion(coverage, "domestic");
  const international = hasRegion(coverage, "international");
  if (domestic && international) {
    return lang === "zh"
      ? "选题角度优先利用国内外视角的共同点、叙事差异和制度或市场语境，不要只追热点。"
      : "Prefer angles that use shared facts, narrative differences, and institutional or market context across domestic and international perspectives instead of merely chasing trends.";
  }
  return lang === "zh"
    ? "只从已检索到的地区视角提炼选题，并明确缺失的另一侧证据；不要为了国际化而补造材料。"
    : "Build angles only from the regional perspectives actually retrieved, and make the missing side explicit; never fabricate material merely to appear international.";
}

function expansionRegionPriority(lang: Lang, coverage?: ResearchCoverageSummary): string {
  const domestic = hasRegion(coverage, "domestic");
  const international = hasRegion(coverage, "international");
  if (domestic && international) {
    return lang === "zh"
      ? "优先补充国内外材料的跨区域对照，"
      : "prioritize cross-regional comparisons between domestic and international material, ";
  }
  return lang === "zh"
    ? "只补充已检索资料能支撑的地区视角，明确另一侧资料缺失，"
    : "expand only the regional perspective supported by retrieved evidence and state that the other side is missing, ";
}
