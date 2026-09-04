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

| Rewrite Word | Generate Articles | WeChat Formatting |
| --- | --- | --- |
| <img src="assets/screenshots/01-rewrite.png" alt="Rewrite Word workflow in the editorial proof-desk interface" /> | <img src="assets/screenshots/02-generate.png" alt="Source-backed article generation workflow" /> | <img src="assets/screenshots/03-gzh.png" alt="WeChat-formatted article preview with a restored source image and attribution" /> |

<div align="center">
  <sub>An editorial proof desk for Word rewriting, fiction drafting, source-backed article generation, and self-contained WeChat-ready layouts.</sub>
</div>

## What It Does

- **Rewrite a `.docx` draft** and export it back to Word.
- **Score how human the text feels** with a local 0-100 human-likeness score.
- **Click any sentence** to get alternatives or edit it by hand.
- **Learn your style** from uploaded `.docx` or `.txt` samples.
- **Show progress while the model works** for fiction and article writing, whole-document rewriting, title options, and topic generation.
- **Write fiction from a story brief**: optionally provide a title, then choose genre, viewpoint, tone, and length. The result opens in the same sentence-level editor and exports to Word.
- **Generate an article from a title or domain** with default searches across relevant web articles, public comments, arXiv papers, and RSS news, using attributed paraphrases or short excerpts.
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

The current UI is an editorial proof desk: a deep ink-green rail frames a cool paper canvas, coral marks authorship actions, cyan identifies evidence and focus, and the finished draft sits on a white document galley. Rewrite and generation remain separate persistent workspaces, so switching modes does not discard an in-progress document or WeChat layout.

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

Google News and Hacker News search need no key. Set `EXA_API_KEY` in `backend/.env` to search more web articles and public discussions from Reddit, Hacker News, Zhihu, Quora, Stack Overflow, and Stack Exchange directly; Agent-Reach/mcporter remains a fallback. Private or logged-in content is not collected.

The generation page notes that many sources are hosted internationally and that an international proxy can improve coverage on unreliable networks. To route backend requests explicitly, set `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` in `backend/.env`; Node.js 24.14+ enables the proxy after loading `.env`, while Windows `run.bat` also picks up proxy variables already present when it starts.

Writing prompts ask the model to compare shared facts, narrative differences, institutional and market context, and genuine disputes across regions. Source count is never treated as consensus, and the model is told not to manufacture false balance.

The writing prompt tells the model to paraphrase web material by default. When exact wording matters, it asks for no more than 60 Chinese characters or 25 English words and an immediate citation. Public comments are labeled for personal experience, disagreement, or counterpoints rather than facts or statistics; quotations and semantic attribution should still receive a human check before publication.

Inline `[n]` markers are kept only when they resolve to retrieved sources. The model is asked to cite factual claims and external material where possible, but missing markers do not block generation; out-of-range markers are stripped, uncited prose remains uncited, and the retrieved reference list is still attached. Source images are downloaded through the backend's outbound-safety policy and embedded in Word and browser preview data rather than loaded remotely by the browser.

## Narrative and Multimedia

Before drafting, the model internally merges duplicated material and organizes it as reader question → evidence → mechanism → dispute/limits → practical judgment, rather than summarizing one source after another. Paragraph roles and section anchors make medium and long pieces scannable. If the opening, evidence, explanation, or closing callback is seriously broken, one optional flow-repair pass may run; it is non-blocking and never turns a usable draft into a hard failure.

Literary craft is budgeted by writing scene. General and newsletter prose may use one source-supported contrast-before-reveal, sparing personification, and an opening scene that echoes at the close. Business, academic, official, and technical writing lowers or disables those devices. Rhetoric may not invent a person's thoughts or dialogue, a witnessed news scene, an institution's intention, or unsupported mass emotion; factual claims and imagery remain distinct.

The system uses only relevant, attributable network images or GIFs whose original bytes pass backend safety validation. It prefers images from the researched publisher pages; when those are insufficient, it searches Openverse for openly licensed photographs and appends the creator, license name and URL, and original work page to the caption and references. The length tier sets a maximum of two source images for short pieces, four for medium, and six for long; it is not a quota. If a source image is unavailable, unrelated, unsafe, over budget, or cannot be attributed, the article has fewer images or none. The application does not draw replacement cards or generate substitute images. GIFs are mounted and decoded only after an explicit play action in the document editor; reduced-motion mode leaves them unmounted there. Word and WeChat export receive the same validated source media. For WeChat formatting, the bytes stay outside the model prompt and replace stable insertion markers only after sanitized HTML returns, producing a self-contained preview without remote hotlinks. Image generation is intentionally reserved for a future dedicated model. Openverse aggregates license metadata, so verify the terms on the original work page before publishing; attribution alone does not grant republication rights.

## Article Length Targets

Length tiers use explicit body-only ranges: Chinese short 450–650 characters, medium 1,000–1,300, and long 3,000–3,800; English short 350–500 words, medium 850–1,100, and long 2,200–2,800. If the first draft misses its band, the backend runs up to two corrective passes. A generation request succeeds only when the final body is inside its selected range; a persistent miss returns a retryable error instead of an off-target article. The final count and target range travel with successful responses and update live while editing. Titles, references, inline citation markers, figure captions, and tables do not count toward the body target.

Fiction generation uses those same validated length bands, but it does not invoke web research or add citations. Short and medium produce compact fiction forms; the long tier produces an opening chapter with a complete scene arc and forward pressure. The generation prompt preserves the chosen viewpoint and tone, and later sentence polishing receives a fiction-specific continuity guard so it does not invent new plot events.

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

## Useful Commands

```bash
cd backend
npm run build
npm run test:article
npm run test:novel
npm run test:research
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
  src/services/    rewrite, article, novel, docx, score, research, gzh formatting
  src/prompts/     model prompts
  assets/gzh/      WeChat theme component libraries (from gzh-design-skill)

frontend/
  src/components/  upload, article generation, novel generation, gzh, editor, common UI
  src/lib/         API client, store, i18n
  src/styles.css   editorial proof-desk theme and responsive layouts

assets/screenshots/  README screenshots
docs/                design notes
```

## Notes

- Generated articles still need human fact-checking.
- Live sources can change or go offline.
- Documents are stored in backend memory and disappear after restart.
- Public deployment should add authentication, rate limits, and persistent storage.

## License

This project's own code is under [MIT](LICENSE).

> **⚠️ Important — bundled AGPL-3.0 content.** The WeChat formatting feature integrates theme component libraries and validation rules from [gzh-design-skill](https://github.com/isjiamu/gzh-design-skill) by 甲木 (Jiamu) × 摸鱼小李 (Moyu Xiaoli), licensed under **AGPL-3.0** (full text: `backend/assets/gzh/LICENSE`).

What that means in practice:

- **Personal / internal use**: no extra obligations — use and modify freely.
- **Attribution**: keep the upstream copyright notice and `backend/assets/gzh/LICENSE` in place (already done here).
- **Redistributing this repo (including a public fork)**: the bundled theme libraries stay AGPL-3.0, and a combined work that includes them must be conveyed under AGPL-3.0 terms. Practically, either license your distribution as AGPL-3.0 overall (MIT code can be included in an AGPL whole), remove/replace the `backend/assets/gzh/` content, or obtain separate permission from the upstream authors.
- **Offering this app as a public network service** (AGPL §13): you must offer users of that service the complete corresponding source of your running (possibly modified) version.
