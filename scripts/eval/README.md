# 本地 AI 味评分器 pilot

所有命令从仓库根目录运行。只新增评估工具和 `data/eval/` 本地数据；
不改应用代码、不修改质量检查入口、不提交数据。

## 运行

需要已有三个人类语料 manifest、`scripts/corpus/node_modules/opencc-js`，
以及 backend 已安装的 `tsx` / `openai`。不额外安装依赖。

```powershell
node scripts/eval/sample.mjs
node scripts/eval/check.mjs
node backend/node_modules/tsx/dist/cli.mjs scripts/eval/generate.ts --dry-run
node backend/node_modules/tsx/dist/cli.mjs scripts/eval/generate.ts --concurrency=4
node backend/node_modules/tsx/dist/cli.mjs scripts/eval/evaluate.ts
bash skills/code-refactoring/scripts/check.sh evalpilot <tmpdir>
```

部分受管理的 Windows 运行环境中，`os.userInfo()` 会报
`uv_os_get_passwd ENOMEM`。仅在遇到此问题时，先为当前 PowerShell 进程设置：

```powershell
$env:NODE_OPTIONS='--require=' + (Join-Path (Get-Location) 'scripts/eval/runtime.cjs')
```

该兼容文件仅在 Windows 账户查询失败时提供临时缓存用户名，不改应用文件。
普通环境不需要。若仓库绝对路径有空格，使用
`$env:NODE_OPTIONS='--require="' + (Join-Path (Get-Location) 'scripts/eval/runtime.cjs') + '"'`。

原有 `check.sh` 中 DOCX 回归会读写仓库根目录 `test/` 的私人文件。
为遵守本任务禁止接触该目录的要求，本次验收使用公开合成文档，原检查脚本和
全部断言均不改动；仅通过 opt-in 运行时适配将那两个确切文件路径重定向到评估数据目录：

```powershell
$env:NODE_OPTIONS='--require=' + (Join-Path (Get-Location) 'scripts/eval/runtime.cjs')
node backend/node_modules/tsx/dist/cli.mjs scripts/eval/prepare-check.ts
$env:EVALPILOT_CHECK_FIXTURES=(Join-Path (Get-Location) 'data/eval/pilot/check-fixtures')
bash skills/code-refactoring/scripts/check.sh evalpilot /tmp/speak-plainly-evalpilot
Remove-Item Env:EVALPILOT_CHECK_FIXTURES
```

重定向只作用于 `fs/promises` 的这两个确切DOCX路径，不打开原目录。
这验证公开合成文档的往返和原测试内置的图片/拒绝路径，不能宣称验证了私人样例。
`check-fixture-note.json` 记录此限制。

`sample` 固定种子 `20261028`，每个子集100篇，按体裁×来源比例配额，
每个已观察分层至少一篇，优先600–3000汉字。
抽样后按组优化 dev/test 总数和分层平衡。PD 按作者，open 按 source+work，
gov 按 work。`sample-audit.json` 记录配额和语料 manifest 摘要。
样本的 `char_count` 是实际简体文本的 Han 字数，不是文件字节数或总字符数。
标题也转为简体，原文只读；原始 manifest 的 `work` 仍用于分组。

HC3 的 `work` 是领域数据集名，只有 finance / psychology 两组，
不能将同一组拆开以改善分层；报告解释由此产生的领域差异及CI限制。

## 模型与费用

`generate` 在进程内切换到 backend 工作目录，然后导入项目的 `config`，
由项目配置加载环境；脚本从不自行读取、打印或序列化 `.env` / API key。
使用 backend 的 OpenAI SDK、配置的地址/凭据/温度/思考参数，模型名称仅为
`deepseek-flash`、`deepseek-v4-pro`。改写函数自身指定的温度按原接口传递。
错误日志只保存HTTP状态、预设错误类型，不保存可能包含凭据的提供商错误正文。

DeepSeek 部分每篇×2模型×3变体，共1800份文档。另有 Codex/GPT 每篇2变体，
共600份；完整评估由 `common.mjs` 的 `EVAL_SOURCES` 定义，共2400份。
`generate.ts` 仅调用两个 DeepSeek 模型；两种生成器都会保留其他来源的清单记录。

- plain：简体自然请求，目标字数四舍五入到50；HC3直接回答标题问题。
- humanized：同一请求，system 使用 `antiAiRules('zh')`。
- rewrite：给源文增加独立标题段，再按空行分段，调用
  `rewriteDocument('', paragraphs, 12, 'zh', ask)`。这保留全部原文正文，
  避免函数将原文第一正文段误当标题。输出包含函数生成的标题及全部正文。
  注入 ask 对实际JSON、段落覆盖和完成原因检查，静默回退不计为生成成功。
  `unchanged_paragraph_fraction` 单独记录合法返回但未改动的正文段比例。

1800份文档不等于1800次调用。plain/humanized各600次；rewrite至少
`600 × (1次标题 + ceil(正文段数/12))` 次。
全局API信号量限制为3或4，包括 rewrite 内部的并行请求。
每次请求最多4次尝试，指数退避加随机抖动，SDK自动重试关闭避免重复计数。
不可恢复的模型/认证/余额等HTTP错误立即停止；逻辑调用重试耗尽比例超过10%
（至少10次已结束逻辑调用）时熔断。低于熔断比例的失败继续处理其余任务，
结束时以非零退出码说明需要恢复哪些输出；全部成功缓存均保留。
限流或请求失败的状态保存在 `api-events.jsonl`。

精确费用由当前网关价格及实际输出/思考长度决定。此pilot不猜测价格；
`--dry-run` 只输出任务数和人类字数，不调用模型。
可用 `--limit=6` 做真实小批试运行，完成后去掉参数恢复全量；默认两模型轮流调度。
`generation-summary.json` 和结束控制台给出每模型输入/输出/总token、失败和重试。
输入缓存命中优惠应按实际账单核对。响应返回但内容无效时的token也累计；
传输失败可能没有返回usage，不能把本地token累计当作精确账单。

## Codex / GPT 来源

需要 PATH 中已有可用且已登录的 `codex` CLI。本来源使用 ChatGPT/Codex 登录，
不读取 DeepSeek 配置或 API key。先确认本机登录和额度可用：

```powershell
node scripts/eval/codex-gen.mjs --dry-run
node scripts/eval/codex-gen-check.mjs
node scripts/eval/codex-gen.mjs --limit=1 --concurrency=1
node scripts/eval/codex-gen.mjs --concurrency=2
node scripts/eval/codex-gen.mjs --ingest-only
node backend/node_modules/tsx/dist/cli.mjs scripts/eval/evaluate.ts --allow-partial
```

`--dry-run` 报告完整网格600个任务、75批（尚未扣除缓存），不启动进程。
每批最多8篇；`--limit=N` 限制本次新启动批数，重试批也计入；并发支持1、2、3，默认2。
`--ingest-only` 仅恢复已有批次输出，不启动 Codex。
`codex-gen-check.mjs` 使用临时隔离目录手写夹具，检查有效/过短/缺失/分隔符污染、
恢复和最多两次重试、重复导入和用量均摊，结束后删除夹具，不污染正式 AI 数据。

清单模型id为 `codex-gpt`，实际作者模型为 `gpt-6.1-sol`，推理强度 medium。
仅支持 plain、humanized；rewrite 依赖应用流水线，不包含在 Codex 来源中。
两者复用 `common.mjs` 的 `requestFor`，与 DeepSeek 的逐篇请求一致。
只传标题、体裁和目标长度，不向模型提供人类正文。
humanized 通过现有 tsx 运行时导入 `antiAiRules('zh')`，将其放入用户提示的
“写作要求”块；sidecar 记录 `system_in_user_prompt: true`。
plain 记录该标志为 false。这里没有独立 system 消息，Codex 自带的代理系统提示仍存在，
与 DeepSeek 的 system 规则位置不同；同批其他写作任务也可能影响输出。
这属于另一种作者条件，不能把来源差异完全归因于模型家族。

每批通过 stdin 提交提示（不出现在命令行），执行：

```text
codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s read-only --skip-git-repo-check --json -o <batch-out.md> -
```

Windows 将 PATH 中 npm 的 `codex.cmd` 解析到其 Node 入口，支持含空格和中文路径。
进程 cwd 为 `data/eval/pilot/codex-work/batch-*/`，不使用仓库根目录。
提示要求纯写作，禁止工具、读文件和编辑；输出严格为
`<<<ITEM id=j0000>>>` / 正文 / `<<<END>>>`，无其他文字。
解析器逐篇要求至少200 Han汉字、无残留分隔符；缺失或非法输出记入日志，
进入后续批次重试，单项最多3次尝试（首次加2次重试），跨重启保留计数。
如果事件流显示调用工具则拒绝该批。认证、额度、限流导致的非零退出立即停止整个运行；
其他非零退出也停止，避免对本地启动或沙箱错误反复消耗请求。

每批保留 `batch.json`、`prompt.txt`、`output.md`、`events.jsonl` 和 `stderr.log`。
中断后先导入已有输出，再调度未完成任务；已有文本和sidecar必须匹配 prompt_hash
及输出哈希，否则拒绝覆盖。`generator.lock` 防止同来源多进程；若进程被强杀，
确认旧进程已退出后再移除该锁。不要同时运行 DeepSeek 与 Codex 生成器。

`turn.completed.usage` 为批次实测用量，按批内请求篇数均摊写入sidecar的
`usage`，并标记 `usage_estimated: true`；无完整用量则为 null。
无效项也消耗批次用量；`codex-generation-summary.json` 累计全部批次而非只累计成功文本，
因此逐篇估计之和可能小于总用量。报告用量表注明口径；不据此推测登录订阅费用。
原始批次提示和事件流用于审计，应只保留在本地。

## 缓存与恢复

最终文本：`data/eval/pilot/ai/<model>/<variant>/<human_id>.txt`。
同路径 `.txt.json` 为校验sidecar，清单位于 `ai-manifest.jsonl`。
每个输出有提示/配置/源实现指纹、创建时间、Han字数、输出SHA256、用量及请求指纹。
API中间结果位于 `api-cache/<model>/<request hash>.json`；
标题和正文调用分别缓存，重启不会为已成功的中间请求再次付费。
实际尝试/响应/失败按事件追加保存，最终用量按事件累计，缓存命中不重复计费。
遇到已完成输出的指纹不匹配时拒绝覆盖；先保留旧pilot目录再重做，
不要在同一pilot中混用不同提示、语料或配置。
单个生成进程负责该pilot目录，不要同时启动多个生成进程。

## 离线评估

`evaluate` 直接导入 `backend/src/services/aiScore.ts` 的 `scoreText(text,'zh')`，
不导入配置、不联网。默认1000次组 bootstrap，可设 `--bootstrap=2000`。
缺少AI文件时仍写出明确标注的基线报告，但以非零退出码提示未完成。
使用 `--allow-partial` 可明确接受部分缓存/人类基线；它不会生成缺失数据或伪造指标。

主分析：按完整句界切约500汉字的连续块，末块不足200丢弃；
不在长句内部硬切，所以块可超过目标。另报整篇评分。
dev/test、总体、各子集和各体裁分别统计；摘要与HTML另列 test 总体每个模型×变体的
AUC、配对篇数、95% CI 和 AI 通过率，缺失数据保留空值：

- AUC = P(人类分数更高) + 0.5 P(同分)，CI重抽样单位为泄漏分组，
  同步保留组内配对文档及块。AUC只比较实际都有评分单元的配对文档。
  主结果按块加权，另报按篇结果；单组不报CI，少于10组标注不稳定。
- 人类FPR：<40、<70；AI通过率：≥70；均值、中位、P10、P90和直方图。
- 每信号正扣分触发率、字面hits>0率、平均hits/points，AI/人类触发率lift，
  以及对人类触发更多的误伤规则。人类率为0时，正AI率lift显示∞，双方0则未定义。
  scorer隐藏points<0.5并将输出扣分取整；诊断只能反映公开接口。
  `uniformity.hits` 恒为0，`concreteness.hits` 是锚点数而非违规次数，
  因此“触发”用返回的正points定义，不能盲目用hits。
- Pearson r：块分数/块汉字数、整篇分数/篇汉字数；另报以文档为单位的
  平均块分数/平均块长相关性。恒定值或不足3个观测返回null。

输出都在 `data/eval/pilot/`：`results.json`、`scores.jsonl`、`report.html`、
`summary.md`。中文HTML包含所有分层表格和内联SVG直方图，使用系统字体和
`prefers-color-scheme`，无CDN、无外部资源、无脚本依赖；宽表格局部横向滚动。

`check.mjs` 验证AUC方向、同分、缺失配对、组bootstrap、阈值、句界、
尾块、信号语义和抽样完整性，不改变应用测试或检查入口。
历史语料、模型记忆及humanized的同项目规则依赖都限制结果外推；
rewrite是AI润色灰类，不应与从零生成的AI混为同一真实性标签。

报告为独立、无品牌的离线评估文档，定义自己的明暗色tokens，不是应用界面的改版。
设计钩子对其颜色不在应用 `DESIGN.md` 的提示已逐项按此上下文审阅：这些是有意的
文档配色，非应用设计漂移；不修改应用设计文件，也不添加钩子忽略配置。
