<div align="center">

# AI写作

**Turn AI-shaped drafts into writing that reads like a person wrote it.**

Open-source AI writing workbench for **Word rewriting**, **fiction writing**, **human-likeness scoring**, **source-backed article generation**, and **WeChat Official Account formatting**. It works in English and Chinese.

[![License: MIT](https://img.shields.io/badge/License-MIT-22a06b.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node-%E2%89%A520.9-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)

[中文说明](README.zh.md)

</div>

---

## At A Glance

| Rewrite Word | Generate Articles | Write Fiction |
| --- | --- | --- |
| <img src="assets/screenshots/01-rewrite.jpg" alt="Rewrite Word page under a watercolour meadow-cottage scene" /> | <img src="assets/screenshots/02-generate.jpg" alt="Article generation page under a watercolour cumulus-sky scene" /> | <img src="assets/screenshots/03-novel.jpg" alt="Fiction writing page under a watercolour forest-path scene" /> |

<div align="center">
  <sub>A hand-painted watercolour picture-book workbench: each mode has its own original scene, while the working area stays on calm cream paper.</sub>
</div>

## What It Does

- **Rewrite a `.docx` draft** and export it back to Word.
- **Score how human the text feels** with a local 0-100 human-likeness score.
- **Click any sentence** to get alternatives or edit it by hand.
- **Learn your style** from uploaded `.docx` or `.txt` samples.
- **Show progress while the model works** for fiction and article writing, whole-document rewriting, title options, and topic generation.
- **Write fiction from a story brief**: optionally provide a title, then choose genre, viewpoint, tone, and length. The result opens in the same sentence-level editor and exports to Word.
- **Generate an article from a title or domain** with default searches across relevant web articles, public comments, arXiv papers, and RSS news, using attributed paraphrases or short excerpts.
- **Clean Chinese WeChat drafts with a whitelist pass** adapted from `lieflat-less-ai-tone`: only explicit AI-tone triggers may change, while structure, facts, citations, numbers, URLs, English identifiers, and quotations remain protected.
- **Carry verified source media through the full workflow**: the backend downloads and validates attributed web images or GIFs, then reuses the same bytes in the editor, Word, and WeChat export.
- **Auto-format generated articles for the WeChat Official Account editor**: pick a visual theme in the article editor, click Auto-format, then copy the result straight into 公众号 with one click.
- **Run privately** with any OpenAI-compatible endpoint, including local model servers.

## Basic Environment

You need:

| Tool | Why |
| --- | --- |
| Node.js 20.9+ (22/24 recommended) | Runs the frontend, backend, and verified source-image decoder |
| npm | Installs project packages |
| A model API key | DeepSeek/OpenAI-compatible by default |
| Or a local model server | Ollama, LM Studio, vLLM, etc. |
| Or Codex CLI with a ChatGPT plan | Install the current `@openai/codex` CLI and run `codex login` |
| `.docx` files | Required for Word rewrite mode |

Optional but useful: Git Bash on Windows if you want to run `./run.sh`.

Optional for broader live research: [Agent-Reach](https://github.com/Panniantong/Agent-Reach) with a working `mcporter` command and Exa backend. Social sources such as Reddit and X/Twitter are not enabled by default because they usually need logged-in cookies or separate CLI setup.

## Quick Start

Use one terminal:

```bash
./run.sh
```

On Windows you can also double-click or run:

```bat
run.bat
```

The launchers check basic dependencies, prepare `backend/.env` on first run, and install packages. Both keep the frontend and backend in one terminal, prefer frontend port `51773`, move to the next available port when needed, and print one actual access URL only after both services are ready. Windows `run.bat` also closes stale project instances and prefixes each service's logs. Press `Ctrl+C` once to stop both services.

Stop the services:

```bash
./stop.sh
```

```bat
stop.bat
```

Manual start:

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

Backend: `http://127.0.0.1:8787`

Frontend: `http://127.0.0.1:51773` by default (the launcher prints the actual port)

The backend binds to `127.0.0.1` by default and accepts browser requests only from the two fixed local frontend origins. Deliberate LAN deployments can override `HOST` and set exact comma-separated `CORS_ORIGINS` values in `backend/.env`; wildcard origins are rejected.

## Interface

The current UI is a hand-painted watercolour picture book in the spirit of traditional Japanese animation. Rewrite, generation, and fiction each open on an original scene (a meadow cottage, a cumulus sky, a forest path) whose clouds, grass, light, and windmill drift gently; with reduced motion enabled the movement becomes slower and smaller. Scenery stays in the rail and page header, while the working area uses calm cream-paper cards, with colour, type, and radii drawn from the tokens in `frontend/src/styles/tokens.css`. Rewrite, generation, and fiction remain separate persistent workspaces, so switching modes does not discard an in-progress document or WeChat layout.

The scenery is pre-rendered WebP (`frontend/src/assets/scenery/`), painted procedurally by the generator in `frontend/scripts/paint-scenery/`.

Long-running actions never leave the user waiting without feedback. The frontend shows a progress panel with percentage, current phase, and recent log-style steps for article generation, topic/title generation, and whole-document rewriting.

## Human-Likeness Score

Higher is better.

```text
human-likeness score = round(length_confidence * (100 - total_penalty))
total_penalty = min(100, sum(capped category penalties))
```

The score is fully local. It does not call a model or upload your text.

The scorer normalizes evidence by text length: one unit is **120 Chinese characters** or **100 English words**. Very short text has lower confidence: empty text scores 0; text under 40 Chinese characters or 25 English words uses `length_confidence = 0.65`.

| Signal | Max deduction | What it catches |
| --- | ---: | --- |
| Boilerplate opener/closer | 26 | Stock endings like “in conclusion” / “总而言之” |
| Empty filler | 22 | Correct but hollow phrases |
| AI buzzwords | 18-20 | Overused model-style vocabulary |
| Model catchphrases | 18 | Viral/content-farm phrasing such as “接住”, “更狠一点”, “直接拉满” in Chinese output |
| Mechanical connectives | 18 | Repeated sentence-start transitions |
| Generic frames | 14 | Formulaic “the key is...” structures |
| Parallelism | 14-16 | Too-neat paired sentence patterns |
| Leaked Markdown | 20 | `##`, bullets, bold markers left in prose |
| Uniform sentence length | 12 | Sentences that are suspiciously even |
| Repeated wording | 10 | Excess repeated non-trivial words/phrases |
| Few concrete anchors | 8 | Not enough numbers, names, citations, or quoted specifics |

The rewrite prompt also applies a creator workflow: humanize the prose first, keep concrete evidence from the source material, preserve names/numbers/dates, and add specific scene-level detail only when the original supports it.

| Score | Meaning |
| --- | --- |
| 70-100 | Reads human |
| 40-69 | Getting natural |
| 0-39 | Needs a human pass |

## Live Sources

Topic and article generation issue both a domestic Chinese query and an international English query, then combine Google News, Hacker News-linked articles and public comments, arXiv, open-web search, and domain RSS. Common concepts use a deterministic bilingual map; when that map cannot cross languages, the configured model is asked for a short, validated search-query translation. If translation is unavailable or rejected, both regional searches still run with the original topic instead of inventing coverage. Each topic starts with four domestic and four international feeds, then interleaves results by evidence type, region, and publisher so one geography or aggregator cannot dominate the context. Slow, blocked, or missing sources are recorded as unavailable instead of breaking the whole article.

Domestic feeds include SSPAI, IT Home, cnBeta, GeekPark, ScienceNet and its opinion channel, TMTPost, plus China Daily's China, business, and opinion channels. International feeds include BBC World, NPR World, France 24, Al Jazeera, UN News, WHO News, Nature, TechCrunch, Ars Technica, Wired, MIT Technology Review, Engadget, Hacker News, CNBC, and MarketWatch.

When the backend uses a DeepSeek model, it also queries [DeepSeek Search](https://api-docs.deepseek.com/api/search/) (`POST /v1/tools/search`) as an open-web source, reusing the configured DeepSeek key. It is billed per call, one or two calls per research round. Requests never follow redirects, so the key is not forwarded to another host, and a failure is recorded as unavailable. Set `DEEPSEEK_SEARCH=off` in `backend/.env` to disable it, or `DEEPSEEK_SEARCH_URL` to use another HTTPS endpoint.

Google News and Hacker News search need no key. Set `EXA_API_KEY` in `backend/.env` to search more web articles and public discussions from Reddit, Hacker News, Zhihu, Quora, Stack Overflow, and Stack Exchange directly; Agent-Reach/mcporter remains a fallback. Private or logged-in content is not collected.

The generation page notes that many sources are hosted internationally and that an international proxy can improve coverage on unreliable networks. To route backend requests explicitly, set `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` in `backend/.env`; Node.js 24.14+ enables the proxy after loading `.env`, while Windows `run.bat` also picks up proxy variables already present when it starts.

Writing prompts ask the model to compare shared facts, narrative differences, institutional and market context, and genuine disputes across regions. Source count is never treated as consensus, and the model is told not to manufacture false balance.

The writing prompt tells the model to paraphrase web material by default. When exact wording matters, it asks for no more than 60 Chinese characters or 25 English words and an immediate citation. Public comments are labeled for personal experience, disagreement, or counterpoints rather than facts or statistics; quotations and semantic attribution should still receive a human check before publication.

Inline `[n]` markers are kept only when they resolve to retrieved sources. The model is asked to cite factual claims and external material where possible, but missing markers do not block generation; out-of-range markers are stripped, uncited prose remains uncited, and the retrieved reference list is still attached. Source images are downloaded through the backend's outbound-safety policy and embedded in Word and browser preview data rather than loaded remotely by the browser.

## Evidence Article Pipeline

Full article generation now uses the repository-local [`evidence-article-pipeline`](.agents/skills/evidence-article-pipeline/SKILL.md). Research runs for at least two and at most ten gap-driven rounds. Each round separates source-bound objective facts from opinion, discards public-comment-only claims from the fact ledger, derives specific keywords and unanswered questions, and stops early when the evidence is saturated. Selected sources are checked against Exa/Agent-Reach highlights or bounded source-page text fetched through the outbound safety policy, so the fact extractor is not limited to search snippets. Full source text stays backend-only. If critical gaps remain after round ten, generation continues from the verified subset in limited-evidence mode: conclusions are narrowed and material gaps are disclosed instead of invented.

When generating from a title, the first round searches the title as written. If that returns nothing, which is common for rhetorical headlines, the backend asks the model once to turn the title into two to four searchable queries (entities, events, places, data, and the plain underlying subject) and continues with them plus the topic keywords and domain. If the model is unavailable, deterministic rules strip rhetorical words instead. The API blocks with `422` only when ten rounds produce no objective fact that can support an article, and the message states the actual reason: no source was retrieved at all, every fact assessment failed, or sources were found but no fact survived validation.

After saturation, the backend builds one time, space, event, causal, entity, or question-led clue graph. Every node points back to validated facts and source numbers; only sources with a retrieved real image can be assigned as visual evidence. The drafting prompt receives this fact ledger and clue graph ahead of the ordinary source list. The finished draft is then audited for factual support, citation fit, topic alignment, and—on Chinese WeChat runs—the whitelist tone gate. A failed draft can be regenerated against the same evidence up to three times; persistent failure is returned honestly rather than published.

The skill also defines auditable `research.md`, `clue-graph.md`, `media-manifest.md`, `article.md`, `validation.md`, and `run.json` artifacts for agent-driven article work. Its validator rejects generated images that claim to prove a fact. An agent with `imagegen` may create a clearly labeled non-evidentiary illustration; the web runtime continues to use validated source images and licensed Openverse media only.

## Narrative and Multimedia

Before drafting, the model internally merges duplicated material and organizes it as reader question → evidence → mechanism → dispute/limits → practical judgment, rather than summarizing one source after another. Paragraph roles and section anchors make medium and long pieces scannable. If the opening, evidence, explanation, or closing callback is seriously broken, one optional flow-repair pass may run; it is non-blocking and never turns a usable draft into a hard failure.

Literary craft is budgeted by writing scene. General and newsletter prose may use one source-supported contrast-before-reveal, sparing personification, and an opening scene that echoes at the close. Business, academic, official, and technical writing lowers or disables those devices. Rhetoric may not invent a person's thoughts or dialogue, a witnessed news scene, an institution's intention, or unsupported mass emotion; factual claims and imagery remain distinct.

The system uses only relevant, attributable network images or GIFs whose original bytes pass backend safety validation. It prefers images from the researched publisher pages; when those are insufficient, it searches Openverse for openly licensed photographs and appends the creator, license name and URL, and original work page to the caption and references. The length tier sets a maximum of two source images for short pieces, four for medium, and six for long; it is not a quota. If a source image is unavailable, unrelated, unsafe, over budget, or cannot be attributed, the article has fewer images or none. The application does not draw replacement cards or generate substitute images. GIFs are mounted and decoded only after an explicit play action in the document editor; reduced-motion mode leaves them unmounted there. Word and WeChat export receive the same validated source media. For WeChat formatting, the bytes stay outside the model prompt and replace stable insertion markers only after sanitized HTML returns, producing a self-contained preview without remote hotlinks. Image generation is intentionally reserved for a future dedicated model. Openverse aggregates license metadata, so verify the terms on the original work page before publishing; attribution alone does not grant republication rights.

## Article Length Targets

Length tiers use explicit body-only ranges: Chinese short 450–650 characters, medium 1,000–1,300, and long 3,000–3,800; English short 350–500 words, medium 850–1,100, and long 2,200–2,800. If the first draft misses its band, the backend runs up to five corrective passes. A generation request succeeds only when the final body is inside its selected range; a persistent miss returns a retryable error instead of an off-target article. The final count and target range travel with successful responses and update live while editing. Titles, references, inline citation markers, figure captions, and tables do not count toward the body target.

Fiction generation uses those same validated length bands, but it does not invoke web research or add citations. Short and medium produce compact fiction forms; the long tier produces an opening chapter with a complete scene arc and forward pressure. The generation prompt preserves the chosen viewpoint and tone, and later sentence polishing receives a fiction-specific continuity guard so it does not invent new plot events.

## Whitelist Cleanup for Chinese WeChat Articles

Chinese articles generated with the **WeChat / 公众号** writing scene receive one optional post-draft cleanup adapted from [`lieflat-less-ai-tone`](https://github.com/larashero3-dotcom/lieflat-less-ai-tone), pinned to upstream commit `27d29232f10124db904ca9c0536d0b67cb3b2833`. The upstream skill is based on a 2.83-million-character corpus comparison and deliberately rejects broad “make it sound human” heuristics.

The integration is conservative by design. It first checks for the upstream whitelist triggers; a clean draft causes no extra model call. When cleanup is needed, the model must return paragraph patches tagged with upstream rule numbers. The backend rejects patches without a matching trigger, patches that still contain the claimed trigger, wholesale rewrites, length drift, citation loss, or changes to numbers, URLs, English identifiers, and quoted text. Paragraph order, semantic roles, section positions, media plans, references, and factual research remain outside the cleanup pass. Failure is non-blocking: the last valid sourced draft continues through the normal pipeline.

## WeChat Formatting (公众号排版)

After generating an article, the editor shows a formatting bar: pick a theme from the dropdown, click **Auto-format**, and the article is converted into HTML that survives pasting into the WeChat Official Account editor — inline styles only, every text node wrapped in `<span leaf="">`, no `<div>`/`class`/`id`, full-width punctuation in prose.

- **Six themes** built on [gzh-design-skill](https://github.com/isjiamu/gzh-design-skill) component libraries: 翡翠清新, 红白杂志, 石墨极简, 禅意留白, 创意票据, 橄榄内刊. Each theme defines the cover, chapter titles, quote cards, and signature that the model assembles per chapter.
- **Compliance validation** is deterministic (ported from the skill's Python validator): forbidden tags/styles are errors, unwrapped text and half-width punctuation are warnings, and failing chunks get one automatic repair pass.
- **Self-contained source media**: verified image bytes never enter the formatting-model prompt. Stable placement markers are restored only after the returned HTML is sanitized, so the preview contains the real image and attribution without a remote hotlink.
- **One-click paste**: the live preview renders the exact rich text; “复制到公众号” puts it on the clipboard for direct pasting, and the HTML download is a standalone preview page with its own copy button.

## Private Local Mode

Point the backend at a local OpenAI-compatible server:

```env
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen2.5:14b
LLM_THINKING_TYPE=off
LLM_REASONING_EFFORT=off
```

## Codex CLI Provider

The default provider is `openai`; leaving `LLM_PROVIDER` unset preserves the existing DeepSeek / OpenAI-compatible requests. To use your ChatGPT Codex login, install a current official CLI (`npm install -g @openai/codex`), run `codex login` as the same OS user that runs the backend, and set these environment variables:

```env
LLM_PROVIDER=codex
CODEX_MODEL=gpt-6.1-sol
CODEX_REASONING_EFFORT=medium
CODEX_CONCURRENCY=2
CODEX_TIMEOUT_MS=600000
CODEX_MIN_TIMEOUT_MS=180000
# CODEX_BIN=/absolute/path/to/codex-or-codex.js
```

No `LLM_API_KEY` or `DEEPSEEK_API_KEY` is required for this provider. `LLM_PROVIDER` is trimmed and case-insensitive; unknown providers fail at startup. `CODEX_BIN` optionally overrides an executable or JavaScript entry file. Windows resolution honours PATH/PATHEXT, including native `.exe` installs. npm shims use their JS entry when present; other batch shims run through `cmd.exe` with fixed ASCII placeholders and the prompt on stdin. Embedded quotes or line breaks in batch arguments are rejected; use an executable or JS entry for those configurations.

All Codex calls share `CODEX_CONCURRENCY` slots. The effective budget is `max(CODEX_MIN_TIMEOUT_MS, timeoutMs ?? CODEX_TIMEOUT_MS)`, measured from submission through queue wait and execution. Invalid/non-positive timeout settings use the defaults above. API-tuned 8–45 second budgets therefore get at least 180 seconds by default. An explicit `AbortSignal` cancels immediately, even below that floor: queued calls are removed and running process trees are terminated. Document rewrites retain 12-paragraph chunks and admit only one wave of concurrent Codex calls at a time, so a long document can finish across many call budgets.

Research keeps deterministic translations and the 12-hour cache. Only topics that cannot be translated completely by those rules request a model translation; Codex uses its minimum budget instead of the API's 8 seconds. Timeout cancels the call and falls back to the full original topic. This preserves cross-language recall without paying for calls that are abandoned after 8 seconds. Evidence-model calls with a 45-second budget use the same Codex floor.

`/api/health` reports `codex:gpt-6.1-sol` and performs a real model call on **every request**, consuming quota and typically taking 20–60 seconds plus queue wait. Avoid frequent health polling in Codex mode. For one probe from `backend/`: `LLM_PROVIDER=codex npm run test:llm -- --health-only` (Git Bash / POSIX shell).

Tool switches were checked against the installed CLI 0.164.0 package and the official configuration schema: shell/unified execution, images, JS/code mode, search, agents, apps, hooks, plan updates and user-input tools are disabled where supported. `apply_patch_freeform=false` selects the patch variant; this CLI exposes no general `apply_patch` off switch. Calls therefore also retain the read-only sandbox, isolated temporary working directory, ignored user config/rules and the text-only instruction. A completely tool-free model surface is not guaranteed by the CLI.

Each completion starts an ephemeral agent in a fresh temporary directory, with a read-only sandbox, shell and web search disabled, and user config/rules ignored. Authentication remains managed by the official CLI. Use a current CLI with `--ephemeral`, `--ignore-user-config`, and `--ignore-rules` support. Streaming delivers the final answer as one delta after completion, so SSE content matches the authoritative output file; it is not token-by-token. `disableThinking` selects low reasoning effort; temperature is silently ignored.

This is slower than a direct model API: each call is an agent run with roughly 30k tokens of overhead (which can vary by CLI/model). Usage counts against your ChatGPT plan. This option is intended for personal local use, not production or multi-user service. It does not replace optional research-service credentials; set `DEEPSEEK_SEARCH=off` to avoid separate DeepSeek search calls when that service has no balance.

## Useful Commands

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

## Project Map

```text
backend/
  src/routes/      API endpoints
  src/services/    rewrite, article, novel, whitelist tone cleanup, docx, score, research, gzh formatting
  src/prompts/     model prompts
  assets/gzh/      WeChat theme component libraries (from gzh-design-skill)
  assets/skills/   Third-party writing-skill notices and licenses

frontend/
  src/components/  upload, article generation, novel generation, gzh, editor, common UI
  src/lib/         API client, store, i18n
  src/styles/      design tokens, shell, scenery, surfaces, editor, and responsive styles
  src/assets/scenery/      watercolour scenery layers (WebP)
  scripts/paint-scenery/   offline generator for the scenery layers

assets/screenshots/  README screenshots
docs/                design notes
.agents/skills/evidence-article-pipeline/  auditable research-to-article skill and validator
```

## Notes

- Generated articles still need human fact-checking.
- Live sources can change or go offline.
- Documents are stored in backend memory and disappear after restart.
- Public deployment should add authentication, rate limits, and persistent storage.

## License

This project's own code is under [MIT](LICENSE).

The Chinese WeChat whitelist cleanup adapts [`lieflat-less-ai-tone`](https://github.com/larashero3-dotcom/lieflat-less-ai-tone) by shiujan under the MIT License. The pinned source and bundled license are in [`backend/assets/skills/lieflat-less-ai-tone/`](backend/assets/skills/lieflat-less-ai-tone/).

> **⚠️ Important — bundled AGPL-3.0 content.** The WeChat formatting feature integrates theme component libraries and validation rules from [gzh-design-skill](https://github.com/isjiamu/gzh-design-skill) by 甲木 (Jiamu) × 摸鱼小李 (Moyu Xiaoli), licensed under **AGPL-3.0** (full text: `backend/assets/gzh/LICENSE`).

What that means in practice:

- **Personal / internal use**: no extra obligations — use and modify freely.
- **Attribution**: keep the upstream copyright notice and `backend/assets/gzh/LICENSE` in place (already done here).
- **Redistributing this repo (including a public fork)**: the bundled theme libraries stay AGPL-3.0, and a combined work that includes them must be conveyed under AGPL-3.0 terms. Practically, either license your distribution as AGPL-3.0 overall (MIT code can be included in an AGPL whole), remove/replace the `backend/assets/gzh/` content, or obtain separate permission from the upstream authors.
- **Offering this app as a public network service** (AGPL §13): you must offer users of that service the complete corresponding source of your running (possibly modified) version.
