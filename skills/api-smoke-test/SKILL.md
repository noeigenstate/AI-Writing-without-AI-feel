---
name: api-smoke-test
description: How to smoke-test the speak_plainly backend against a real model (DeepSeek or the local Codex CLI provider) — starting the server in a given provider mode, sending Chinese request bodies without mojibake, and the endpoints and expected results for health, a JSON call, a short story and an article from a title. Use after changing llm.ts, codexProvider, research or article pipelines, or when a user reports that generation fails.
---

# Backend smoke test against a real model

## Start the server in the mode you want to test

- **Pick the provider by environment variable.** The default provider is OpenAI-compatible (DeepSeek). To use Codex, set `LLM_PROVIDER=codex` before starting:
  ```
  cd backend && LLM_PROVIDER=codex npx tsx src/index.ts
  ```
  - Codex mode uses the local `codex login` and needs no API key.
  - The model defaults to `gpt-6.1-sol`, set by `CODEX_MODEL`.
- **Never edit `backend/.env` for a test.** Use the environment variable. A permanent switch is the owner's edit.
- **Restart after a code change.** `npx tsx src/index.ts` is not a watcher, so a server already running keeps the old code. Before restarting, stop both the node process listening on the port and its `tsx` parent.
- **Test on another port** (for example `PORT=8799`) when the owner's server on 8787 must keep running.

## Chinese request bodies: always send them from a UTF-8 file

On Windows, Git Bash sends Chinese literals inside `curl -d '...'` in the ANSI code page (GBK). The server then sees mojibake.

The model receives a garbled title, retrieval runs 10 empty rounds, and the request fails with "No objective fact remained after source validation". It looks like a pipeline bug, but it is not one.

Write the body to a file with an editor or the Write tool, then send that file:

```
curl -s -N -m 3500 -X POST http://127.0.0.1:8787/api/article/generate-from-title \
  -H 'Content-Type: application/json; charset=utf-8' --data-binary @<scratch>/body.json
```

In PowerShell, send `[Text.Encoding]::UTF8.GetBytes($json)` as the `-Body`.

**How to spot it:** in the `evidence.rounds[].query` field of the response, `�` or GBK-looking text means the encoding broke. The model itself may also report the title as garbled.

## Checks and what to expect

| Check | How | Codex mode, measured 2026-10-29 |
| --- | --- | --- |
| Health | `GET /api/health` | `{"ok":true,"model":"codex:gpt-6.1-sol"}`, about 7 s |
| JSON call with a short budget | Script that calls `chat(..., { disableThinking: true, timeoutMs: 45000 })` and runs `JSON.parse` on the reply. Wrap it in an async IIFE, because `tsx -e` rejects top-level await. | `{ ok: true }`, about 15 s. The minimum timeout `CODEX_MIN_TIMEOUT_MS` stops false timeouts. |
| Short story | `POST /api/novel/generate` with `{"premise":"…","targetLength":"short","lang":"zh"}` | About 45 s, `length.inRange: true` |
| Article from a title | `POST /api/article/generate-from-title` with `{"title":"…","lang":"zh","sceneId":"wechat","targetLength":"short"}` | About 11 min, `evidence.validation.pass: true`, dozens of claims, at least 10 sources |

`/api/rewrite`, `/api/title` and `/api/sentence/alternatives` need a `docId`, and a `docId` comes from `POST /api/upload`, which takes a docx. To test a JSON rewrite without a docx, use `npm run test:llm`, which generates alternatives for one sentence.

## Afterwards

- Stop any test server you started.
- Report to the owner which provider mode the server on 8787 is left running in.
