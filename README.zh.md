<div align="center">

# AI写作

**把 AI 味很重的初稿，改成更像真人写的文字。**

一个开源 AI 写作工作台：支持 **Word 改写**、**小说创作**、**人类感评分**、**带资料来源的文章生成**、**公众号一键排版**。界面支持中文和英文。

[![License: MIT](https://img.shields.io/badge/License-MIT-22a06b.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node-%E2%89%A520.9-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)

[English](README.md) · 中文说明

</div>

---

## 一眼看懂

| 改写 Word | 生成文章 | 写小说 |
| --- | --- | --- |
| <img src="assets/screenshots/01-rewrite.jpg" alt="草坡小屋水彩场景下的 Word 改写页" /> | <img src="assets/screenshots/02-generate.jpg" alt="积云晴空水彩场景下的文章生成页" /> | <img src="assets/screenshots/03-novel.jpg" alt="林间小路水彩场景下的小说创作页" /> |

<div align="center">
  <sub>手绘水彩绘本风格的写作台：每种模式各有一幅原创场景，正文工作区保持安静的奶油色纸面。</sub>
</div>

## 它能做什么

- **上传 `.docx` 初稿**，改写后再导出成 Word。
- **给文字打“人类感评分”**，0-100 分，越高越像真人文章。
- **逐句修改**：点任意句子，选择替代表达，或者手动改。
- **学习你的口吻**：上传 `.docx` 或 `.txt` 范文，让输出更像你的风格。
- **显示模型工作进度**：创作小说、生成文章、整篇润色、标题候选、选题生成都会显示百分比、当前阶段和日志。
- **根据故事设定写小说**：标题可以留空，再选择题材、叙事视角、故事基调和篇幅；生成后进入同一个逐句编辑器，并可导出 Word。
- **按标题或领域生成文章**：默认搜索相关网页文章、公开评论、arXiv 论文和新闻 RSS，合理转述或短摘录，并带来源、图表和引用。
- **公众号中文成稿做白名单式去 AI 味**：接入 `lieflat-less-ai-tone` 的明确触发规则，只改命中的句子，同时保护文章结构、事实、引用、数字、网址、英文专名和引语。
- **让真实来源素材贯穿完整流程**：后端下载并校验带署名的网络图片或 GIF，同一份安全字节会用于编辑器预览、Word 和公众号导出。
- **生成文章后一键排版公众号**：在文章编辑器里选主题、点「自动排版」，排版结果一键复制、直接粘贴进微信公众号编辑器，样式不丢。
- **可以本地私有运行**：支持 Ollama、LM Studio、vLLM 等 OpenAI 兼容接口。

## 基础环境

你需要先安装这些：

| 环境 | 用来做什么 |
| --- | --- |
| Node.js 20.9+（推荐 22/24） | 运行前端、后端及真实来源图片解码校验 |
| npm | 安装项目依赖 |
| 模型 API Key | 默认可接 DeepSeek / OpenAI 兼容接口 |
| 或本地模型服务 | 例如 Ollama、LM Studio、vLLM |
| 或已登录 ChatGPT 套餐的 Codex CLI | 安装最新版 `@openai/codex`，执行 `codex login` |
| `.docx` 文件 | Word 改写模式需要 |

Windows 用户如果想运行 `./run.sh`，建议装 Git Bash。也可以直接用 `run.bat`。

如果想让文章资料来源更广，可以额外安装 [Agent-Reach](https://github.com/Panniantong/Agent-Reach)，并确保 `mcporter` 命令和 Exa 后端可用。Reddit、X/Twitter 等社交来源通常需要登录态或 cookies，目前不会默认自动启用。

## 快速启动

一个终端就够：

```bash
./run.sh
```

Windows 也可以双击或运行：

```bat
run.bat
```

启动脚本会检查基础依赖，首次运行会准备 `backend/.env` 并安装依赖。两个脚本都会在同一个终端中运行前后端；它们优先使用前端端口 `51773`，被其他程序占用时会自动选择下一个空闲端口，并在前后端都就绪后打印唯一的实际访问地址。Windows 的 `run.bat` 还会先关闭本项目的旧实例并用名称前缀区分日志。按一次 `Ctrl+C` 即可同时停止两个服务。

停止服务：

```bash
./stop.sh
```

```bat
stop.bat
```

手动启动：

```bash
cp backend/.env.example backend/.env
cd backend
npm install
npm start
```

```bash
cd frontend
npm install
npm run dev
```

后端：`http://127.0.0.1:8787`

前端：默认 `http://127.0.0.1:51773`（一键启动器会打印实际端口）

后端默认只监听 `127.0.0.1`，浏览器请求也只允许两个固定的本地前端地址。如确需在局域网部署，可在 `backend/.env` 中覆盖 `HOST`，并用 `CORS_ORIGINS` 填写逗号分隔的精确来源；系统不会接受通配符来源。

## 界面风格

当前界面是日式手绘动画风格的水彩绘本：改写、生成、小说三种模式分别对应草坡小屋、积云晴空和林间小路三幅原创场景，云、草、光和风车等图层会缓慢轻动；开启“减少动态效果”时动作会变得更慢、更小。场景只出现在边栏和页头，正文工作区保持奶油色纸面卡片，颜色、字号和圆角统一来自 `frontend/src/styles/tokens.css`。改写、生成和小说拥有彼此独立、持续保留的工作区，切换模式不会丢掉正在编辑的文稿或公众号排版结果。

场景图是离线绘制好的 WebP（`frontend/src/assets/scenery/`），由 `frontend/scripts/paint-scenery/` 里的生成脚本程序化绘制。

所有长耗时动作都会有明确反馈。前端会为文章生成、选题/标题生成和整篇润色显示进度面板，包括百分比、当前阶段和最近日志，避免用户空等。

## 人类感评分怎么算

分数越高越好。

```text
人类感评分 = round(文本长度置信度 * (100 - 总扣分))
总扣分 = min(100, 各类 AI 痕迹封顶扣分之和)
```

这个评分完全在本地计算，不调用模型，也不会上传你的文本。

评分会先按文本长度归一化：中文每 **120 个字** 算 1 个长度单位，英文每 **100 个词** 算 1 个长度单位。文本太短时证据不足，空文本为 0 分；少于 40 个中文字或 25 个英文词时，`文本长度置信度 = 0.65`。

| 信号 | 最高扣分 | 主要判断 |
| --- | ---: | --- |
| 套话开头/结尾 | 26 | “总而言之”“由此可见”等模板收束 |
| 空泛废话 | 22 | 正确但没有信息量的表达 |
| AI 黑话 | 18-20 | 赋能、闭环、cutting-edge 等高频模型词 |
| 模型腔口头禅 | 18 | “稳稳拖住”“接住”“更狠一点”“直接拉满”等短视频/模型腔表达 |
| 机械连接词 | 18 | 句首反复“此外/然而/因此”等 |
| 泛化框架句 | 14 | “关键在于”“核心在于”等套路结构 |
| 排比堆叠 | 14-16 | 过于整齐的并列句式 |
| Markdown 残留 | 20 | `##`、列表、加粗符号等泄漏到正文 |
| 句长过于均匀 | 12 | 句子长短变化太小 |
| 词语重复偏多 | 10 | 非停用词反复出现 |
| 具体锚点不足 | 8 | 数字、人名、引用、专有信息太少 |

整篇去 AI 味的提示词也会按内容创作者工作流约束：先去掉模型腔，再保留具体证据、名字、数字、时间；需要画面感时补具体场景，不用抽象口号硬拔高。

| 分数 | 含义 |
| --- | --- |
| 70-100 | 读起来像人 |
| 40-69 | 逐渐自然 |
| 0-39 | 需要人工润色 |

## 实时资料来源

生成选题和文章时，后端会同时发出国内中文检索和国际英文检索，并从 Google News、Hacker News 收录的网页文章与公开评论、arXiv、开放网页搜索和领域 RSS 汇总资料。常见概念优先使用本地双语映射；本地映射无法跨语言时，再由当前配置的模型生成简短且经过校验的另一语种检索词。翻译不可用或未通过校验时，两侧仍会用原主题继续检索，不会编造覆盖结果。每个主题默认各选 4 个国内、4 个国际 RSS 源，再按“资料类型 × 地区 × 发布机构”交错排序，避免结果被单一地区或聚合平台占满。某个来源慢、超时或未配置，不会让整篇文章失败，只会记录为“暂不可用”。

国内来源包括少数派、IT之家、cnBeta、极客公园、科学网、科学网评论、钛媒体，以及 China Daily 的中国、商业和评论频道；国际来源包括 BBC World、NPR World、France 24、Al Jazeera、UN News、WHO News、Nature、TechCrunch、Ars Technica、Wired、MIT Technology Review、Engadget、Hacker News、CNBC 和 MarketWatch。

使用 DeepSeek 模型时，后端会同时调用 [DeepSeek 联网搜索](https://api-docs.deepseek.com/api/search/)（`POST /v1/tools/search`）作为开放网页来源，直接复用已配置的 DeepSeek 密钥；它按次计费，每轮检索调用 1–2 次。请求不跟随重定向，密钥不会被带到其他站点；失败只记为“暂不可用”。在 `backend/.env` 设置 `DEEPSEEK_SEARCH=off` 可关闭，`DEEPSEEK_SEARCH_URL` 可改用其他 HTTPS 端点。

Google News 和 Hacker News 检索不需要密钥。在 `backend/.env` 中配置 `EXA_API_KEY` 后，系统会直接搜索更多网页文章，并从 Reddit、Hacker News、知乎、Quora、Stack Overflow / Stack Exchange 等公开讨论页补充观点；未配置时仍兼容 Agent-Reach / mcporter。需要登录态的私密内容不会抓取。

生成页会提示：境外站点较多，网络不稳定时开启境外代理通常能获得更完整的检索结果。如果希望后端请求也明确走本地代理，可在 `backend/.env` 设置 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`；Node.js 24.14+ 会在加载 `.env` 后动态启用代理，Windows 的 `run.bat` 也会读取启动前已存在的代理环境变量。

写作提示会要求模型对照国内外资料中的共同事实、叙事差异、制度与市场背景及真实争议；来源数量本身不被当成共识，也不会为了“平衡”而制造虚假的两边论。

写作提示会要求模型默认转述网页内容；只有原话本身有分析价值时才使用短摘录，并要求每处不超过 60 个中文字或 25 个英文词、紧跟来源编号。公开评论会被明确标为个人体验、分歧或反方观点，不应当成事实、统计或权威证据；发布前仍应人工复核引语和语义归属。

正文中的 `[n]` 只保留能对应真实检索资料的编号。模型会尽量为事实、数据和外部材料标注来源，但缺少编号不会阻断文章生成；指向不存在参考文献的编号会被清理，无引用段落保持无引用，不会补造来源。检索到的参考资料仍会附在文末。来源图片会经过后端出站安全策略下载，再以内嵌数据用于 Word 和浏览器预览；浏览器不会直接加载来源站的图片地址。

## 证据驱动文章流水线

完整文章生成现在会执行仓库内置的 [`evidence-article-pipeline`](.agents/skills/evidence-article-pipeline/SKILL.md)。资料检索至少两轮、最多十轮，每轮都会把有来源的客观事实与观点分开，删除仅由公开评论支撑的“事实”，再从实体、文件、日期、地点、反例和资料缺口生成下一轮关键词。高价值来源会进一步读取 Exa / Agent-Reach 高亮或经过出站安全策略抓取的有界原文，事实提取不再只依赖搜索摘要；原文正文只在后端使用，不返回前端。证据提前饱和就立即进入写作；第十轮仍有关键缺口时也会使用已有可核验事实继续成文，但会收窄结论并披露重要证据边界，不会填补或猜测缺失信息。

按标题生成时，第一轮会先用标题原文检索；如果一条资料都没有（带修辞的长标题常见这种情况），后端会让模型把标题一次性拆成 2–4 个可检索的关键词（实体、事件、地点、数据和底层主题），并结合选题关键词与领域名继续检索。模型不可用时改用确定性规则去掉“所有人”“到底”“为什么”等修辞成分。只有十轮后一条可用于成文的客观事实都没有时，接口才返回 `422`，并说明真实原因：一篇资料都没检索到、每轮事实评估都失败，还是资料都有但没有事实通过校验。

资料饱和后，后端会从时间、空间、事件、因果、人物机构或“问题—证据—结论”中选择一条主轴建立线索图。每个节点都回指事实编号和来源编号；只有确实抓取到真实图片的来源才能承担图片证据。事实账本和线索图会先于普通来源清单进入写作提示。成稿还会检查事实支持、引用匹配、主题一致性，以及中文公众号的白名单语气；不通过时最多依据同一份证据重新成文三轮，仍失败就如实停止交付。

这个 skill 还规定了适用于 Agent 工作流的 `research.md`、`clue-graph.md`、`media-manifest.md`、`article.md`、`validation.md` 和 `run.json`，并附带机器验收器。验收器会拒绝任何把模型生成图当作事实证据的做法。有 `imagegen` 能力的 Agent 可以生成明确标注、且不承担事实证明的示意图；网页服务仍只使用经过校验的来源图片和 Openverse 开放许可素材。

## 叙事与多媒体

生成前会先在模型内部合并重复资料，并按“读者问题—事实证据—机制解释—争议与限制—可落地判断”组织，而不是按来源逐条摘要。正文带有段落角色和章节锚点：中长文自动生成便于扫读的小标题；严重缺失开场、证据、解释或结尾回扣时，系统最多做一次非阻断式阅读流修复，修复失败仍保留原本可用的文章。

文学手法按场景限量使用。公众号和通用文章可以使用有资料支撑的欲扬先抑、少量拟人、场景与结尾回扣，让情绪从疑问或落差走向理解；商务、学术、公文和技术写作会主动降低或关闭这些修辞。修辞不能制造人物心理、对话、新闻现场、机构意图或群体情绪，事实句与意象句保持边界。

系统只使用与正文相关、来源明确且原始字节通过后端安全校验的真实网络图片或 GIF。系统会优先采用资料原文中的图片；不足时检索 Openverse 收录的开放许可实拍图，并把创作者、许可名称与链接、原始作品页追加到图片说明和参考资料中。篇幅档位只规定上限：短篇最多 2 张、中篇最多 4 张、长篇最多 6 张，并不是必须凑满的数量。图片无法下载、与正文无关、校验失败、超出预算或无法核验来源时，文章会少配图或不配图，不会绘制阅读地图、证据卡、占位图，也不会生成替代图片。文章编辑器里的 GIF 只有在用户主动点击播放后才挂载和解码；开启“减少动态效果”时不会挂载。Word 与公众号导出使用同一份已校验来源媒体。公众号排版时，图片字节不会进入模型提示词；经过净化的 HTML 返回后，前端才按稳定插入标记恢复真实图片，从而生成不依赖远程盗链的自包含预览。图像生成能力留待以后接入专门模型。Openverse 汇集的许可元数据仍需在原始作品页复核；标注来源本身不等于自动获得转载许可。

## 文章字数目标

字数档位使用明确范围，并只计算正文：中文短篇 450–650 字、中篇 1000–1300 字、长篇 3000–3800 字；英文短篇 350–500 词、中篇 850–1100 词、长篇 2200–2800 词。模型首次生成偏离范围时，后端最多自动校准五轮；只有最终正文落在所选范围内，生成请求才会成功，持续偏离会返回可重试错误而不是展示一篇不达标的成品。成功结果会返回实际字数和目标范围，并在编辑器中随修改实时更新。标题、参考资料、行内引用编号、图注和表格不计入正文目标。

小说创作沿用同一套经过校验的篇幅范围，但不会启动网页检索，也不会添加引用。微短篇和短篇会形成紧凑的完整叙事，长档则生成具有完整场景弧和后续张力的长篇开篇。后续逐句润色会带上小说连续性约束，避免擅自增加关键情节。

## 公众号中文成稿白名单清理

选择 **公众号** 写作场景并生成中文文章时，系统会在首稿完成后追加一次可选清理。规则改编自 [`lieflat-less-ai-tone`](https://github.com/larashero3-dotcom/lieflat-less-ai-tone)，固定使用上游提交 `27d29232f10124db904ca9c0536d0b67cb3b2833`。该 skill 基于 283 万字人类与模型语料对比，核心原则是只处理可定位的白名单问题，不凭“读起来像 AI”随意改文。

本项目会先做本地触发检查；没有命中就不会增加模型调用。需要清理时，模型只能返回带上游规则编号的段落补丁。后端会拒绝没有对应触发标记、改完仍未解决触发项、整段重写、导致字数越界、丢失引用，或改动数字、网址、英文专名和引语的补丁。段落顺序、语义角色、小标题位置、配图计划、参考资料和研究事实都不进入这一步。清理失败不会阻断生成，系统会继续使用上一版已经通过校验的有来源文章。

## 公众号排版

生成文章后，编辑器顶部会出现排版工具条：下拉选一套主题、点「**自动排版**」，文章就被转成能安全粘贴进微信公众号编辑器的 HTML——全部内联样式、文字节点 `<span leaf="">` 包裹、不用 `<div>`/`class`/`id`、正文全角标点。

- **六套主题** 基于 [gzh-design-skill](https://github.com/isjiamu/gzh-design-skill) 的组件库：翡翠清新、红白杂志、石墨极简、禅意留白、创意票据、橄榄内刊。每套主题定义了封面、章节标题、引言卡、签名区等组件，模型按章节取组件装配。
- **确定性合规校验**（移植自该 skill 的 Python 校验器）：禁用标签/样式记为错误，漏包裹和半角标点记为提醒，违规块自动修复一轮。
- **自包含来源素材**：已经校验的图片字节不会进入排版模型提示词；返回的 HTML 完成净化后，前端才恢复稳定占位标记，所以预览会带回真实图片与署名，也不依赖远程盗链。
- **一键粘贴**：预览即最终效果，点「复制到公众号」把富文本放进剪贴板直接去粘贴；下载的 HTML 是自带复制按钮的独立预览页。

## 本地私有模式

把 `backend/.env` 指向本地 OpenAI 兼容服务：

```env
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen2.5:14b
LLM_THINKING_TYPE=off
LLM_REASONING_EFFORT=off
```

## Codex CLI 模型提供方

默认提供方为 `openai`；不设置 `LLM_PROVIDER` 时，原有 DeepSeek / OpenAI 兼容请求保持不变。如需使用 ChatGPT 的 Codex 登录，先安装最新版官方 CLI（`npm install -g @openai/codex`），用运行后端的同一系统用户执行 `codex login`，然后设置环境变量：

```env
LLM_PROVIDER=codex
CODEX_MODEL=gpt-6.1-sol
CODEX_REASONING_EFFORT=medium
CODEX_CONCURRENCY=2
CODEX_TIMEOUT_MS=600000
CODEX_MIN_TIMEOUT_MS=180000
# CODEX_BIN=/absolute/path/to/codex-or-codex.js
```

此提供方无需 `LLM_API_KEY` 或 `DEEPSEEK_API_KEY`。`LLM_PROVIDER` 会去掉首尾空白并转为小写，未知值会在启动时明确报错。`CODEX_BIN` 可指定可执行文件或 JavaScript 入口；Windows 按 PATH/PATHEXT 查找，支持独立安装的 `.exe`。npm shim 在 JS 入口存在时通过 Node 启动；其他批处理 shim 通过 `cmd.exe` 启动，命令行仅含固定 ASCII 占位符，提示词始终走 stdin。批处理参数中的双引号和换行会被拒绝，此类配置请直接指定可执行文件或 JS 入口。

所有 Codex 调用共享 `CODEX_CONCURRENCY` 个并发名额。实际预算为 `max(CODEX_MIN_TIMEOUT_MS, timeoutMs ?? CODEX_TIMEOUT_MS)`，从提交时开始，包含排队和执行时间；无效或非正数配置使用上述默认值。原本面向 API 的 8–45 秒预算因此默认至少得到 180 秒。显式 `AbortSignal` 不受下限限制：取消会删除排队任务，或终止运行中的进程树。文档改写保留每块 12 段，只在并发名额空出时提交后续 Codex 调用，使长文可以跨多次调用预算完成。

研究流程保留确定性翻译和 12 小时缓存，仅对规则无法完整翻译的主题调用模型；Codex 使用其最低预算，其他提供方仍为 8 秒。翻译超时会取消调用，并退回完整原始主题。这样保留跨语言召回，也避免任务在 8 秒后被遗弃却继续消耗额度。证据模型原有的 45 秒预算同样适用 Codex 下限。

`/api/health` 显示 `codex:gpt-6.1-sol`，**每次请求都会真实调用模型并消耗额度**，通常需 20–60 秒加上排队时间。Codex 模式请避免频繁轮询。在 `backend/` 下可执行 `LLM_PROVIDER=codex npm run test:llm -- --health-only`（Git Bash / POSIX shell）进行一次探测。

已对照本地 CLI 0.164.0 安装包和官方配置 schema 核对工具开关，关闭支持开关的 shell/unified execution、图片、JS/code mode、搜索、代理、应用、hook、计划更新和用户输入工具。`apply_patch_freeform=false` 只选择补丁工具的实现形式，此版本没有通用的 `apply_patch` 关闭开关，因此仍保留只读沙箱、隔离临时工作目录、忽略用户配置和规则，以及仅输出文本的指令；CLI 无法保证完全不向模型提供任何工具。

每次调用会在新的临时空目录运行一次临时代理，使用只读沙箱，禁用 shell 和网页搜索，忽略用户配置与规则；认证仍由官方 CLI 管理。请使用支持 `--ephemeral`、`--ignore-user-config`、`--ignore-rules` 的新版 CLI。流式接口在调用完成后一次推送最终答案，确保 SSE 内容与最终输出文件一致，并非逐 token 输出。`disableThinking` 映射为低推理强度，temperature 参数会被静默忽略。

这比直接调用模型 API 慢：每次都启动代理，约有 3 万 token 的额外上下文开销（随 CLI 和模型变化），用量计入 ChatGPT 套餐。此模式适合个人本地使用，不适合生产环境或多用户服务。它不会代替可选检索服务的凭证；DeepSeek 无余额时，可设置 `DEEPSEEK_SEARCH=off` 关闭单独计费的 DeepSeek 联网搜索。

## 常用命令

```bash
cd backend
npm run build
npm run test:article
npm run test:less-ai-tone
npm run test:novel
npm run test:research
npm run test:evidence-pipeline
npm run test:research-security
npm run test:licensed-media
npm run test:docx
npm run test:gzh-security
npm run test:score
```

```bash
cd frontend
npm run build
npm run test:progress
npm run test:gzh-security
npm run test:api-network
npm run test:novel-ui
```

## 项目结构

```text
backend/
  src/routes/      API 路由
  src/services/    改写、文章、小说、白名单语气清理、Word、评分、资料检索、公众号排版
  src/prompts/     模型提示词
  assets/gzh/      公众号主题组件库（来自 gzh-design-skill）
  assets/skills/   第三方写作 skill 的来源说明与许可证

frontend/
  src/components/  上传、文章生成、小说生成、公众号排版、编辑器、通用组件
  src/lib/         API、状态、国际化文案
  src/styles/      设计令牌、外壳、场景、卡片、编辑器与响应式样式
  src/assets/scenery/      水彩场景图层（WebP）
  scripts/paint-scenery/   场景图层的离线生成脚本

assets/screenshots/  README 截图
docs/                设计资料
.agents/skills/evidence-article-pipeline/  可审计的资料搜集、线索图、成文与验收 skill
```

## 使用提醒

- 生成内容仍然需要人工核对事实。
- 实时来源可能会变慢、超时或下线。
- 文档目前存在后端内存里，重启后会丢失。
- 如果公开部署，需要自己加登录、限流和持久化存储。

## 许可证

本项目自身代码：[MIT](LICENSE)。

公众号中文白名单清理改编自 shiujan 的 [`lieflat-less-ai-tone`](https://github.com/larashero3-dotcom/lieflat-less-ai-tone)，采用 MIT 协议。固定来源提交和随附许可证位于 [`backend/assets/skills/lieflat-less-ai-tone/`](backend/assets/skills/lieflat-less-ai-tone/)。

> **⚠️ 重点：内含 AGPL-3.0 内容。** 公众号排版功能整合了 [gzh-design-skill](https://github.com/isjiamu/gzh-design-skill)（作者：甲木 × 摸鱼小李）的主题组件库和校验规则，该项目采用 **AGPL-3.0** 协议（完整文本见 `backend/assets/gzh/LICENSE`）。

实际怎么遵循：

- **个人 / 内部使用**：没有额外义务，随便用、随便改。
- **署名**：保留上游版权声明和 `backend/assets/gzh/LICENSE` 文件（本仓库已保留）。
- **再分发本仓库（含公开 fork）**：内置主题库始终是 AGPL-3.0；包含它们的整体作品需要按 AGPL-3.0 条款分发。可行做法三选一——整体按 AGPL-3.0 分发（MIT 代码可以并入 AGPL 整体）、删掉或替换 `backend/assets/gzh/` 内容后再分发、或联系上游作者取得单独授权。
- **公开部署为网络服务**（AGPL 第 13 条）：必须向该服务的用户提供你正在运行的（含修改的）完整对应源码。
