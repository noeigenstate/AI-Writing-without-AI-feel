---
name: code-refactoring
description: Mandatory rules for refactoring, cleanup, optimization or code-quality review of this repo (Node/Express TypeScript backend in backend/, React + Vite frontend in frontend/). Remove redundancy, lower complexity, keep behaviour and interfaces unchanged, and verify every phase with scripts/check.sh.
---

# Code quality and refactoring rules

Goal: less redundancy, lower cognitive complexity, better readability, maintainability and efficiency — without changing what the program does.

## What to fix

1. **Redundant code** — duplicated helpers across files, pointless intermediate variables, wrappers that only forward. Shared string helpers (`truncate`, `cleanLine`, `uniqueLines`, `containsHan`, `isOneOf`…) live in `backend/src/lib/text.ts`, research parsing helpers (`isRecord`, `asString`, `tryParseJson`, `normalizeDate`, `xmlText`…) in `backend/src/services/research/parse.ts`, the request limiter in `research/rateLimit.ts`; reuse them instead of adding local copies, and merge copies only when they really behave the same. The HTML-entity decoders, `escapeHtmlAttribute` and `normalizeHostname` copies look alike but differ on purpose.
2. **Control flow** — flatten nested `if`/`else` with early returns and guard clauses; replace flag variables with expressions.
3. **Concise code** — prefer array methods, optional chaining and `??` over hand-written loops when they read better.
4. **Structure** — split functions and modules that do several jobs; extract shared logic only with at least two real call sites.
5. **Readability** — `camelCase` in TS, match surrounding formatting and comment density; comments say *why*, delete comments that restate the code.
6. **Code smells** — duplicated code, overlong functions (aim under ~60 lines), oversized modules, over-design, unused code and dependencies.

Find hotspots with `node skills/code-refactoring/scripts/fn-metrics.cjs <files...>` (lists functions over 60 lines or nesting depth ≥ 5) and with a scan for function names defined in several files.

## Rules

- Keep features, HTTP routes and payloads, exported function signatures, persisted formats and user-visible text unchanged. A refactor that changes behaviour is a bug — including "harmless" ones such as decoding HTML entities where the old code did not.
- The image validators in `research/images.ts` and the outbound checks in `research/networkSafety.ts` are security boundaries: keep every check, limit and rejection path; only restructure.
- No new abstractions, patterns or dependencies unless they remove real duplication.
- Work in phases (one module or concern at a time). After each phase run from the repo root:
  `bash skills/code-refactoring/scripts/check.sh <label>` — backend `tsc --noEmit` plus every offline `test:*` script, frontend `tsc`, `vite build` and `node test/*.mjs`. All must stay green; `test:llm`, `test:full` and `test:rewrite` call the live model and are not part of it.
- For parsers, validators and sanitizers, also keep a copy of the old file in a temp folder and compare old and new outputs on many generated or mutated inputs; this caught an `&nbsp;` → plain-space regression the tests missed. For React components, compare `renderToStaticMarkup` snapshots of the touched states before and after.
- Tests may only change when the code they check was deliberately restructured; never weaken an assertion.
- Working-copy files use LF (`core.autocrlf=true`); keep them LF. Never touch `backend/.env`, `personal_paper/`, `/test/`, `/docs/` or build output.
- Commit only when the user asks; then commit each phase separately with a message that states what was simplified.

## Finish with a summary

Per phase: redundancy removed (files, functions, rough line counts), complexity reduced (functions split, nesting removed, with before/after from `fn-metrics.cjs`), check results before and after, and issues deliberately left with the reason.
