import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const outdir = join(process.cwd(), `.novel-ui-test-${Date.now()}`);
mkdirSync(outdir, { recursive: true });

try {
  const appOutfile = join(outdir, "app.mjs");
  await build({
    stdin: {
      contents: [
        'export { default as App } from "./src/App.tsx";',
      ].join("\n"),
      resolveDir: process.cwd(),
      sourcefile: "novel-app-entry.ts",
    },
    outfile: appOutfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    logLevel: "silent",
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => "zh",
      setItem: () => undefined,
    },
  });
  const { App } = await import(pathToFileURL(appOutfile));
  const html = renderToStaticMarkup(React.createElement(App));
  assert.match(html, />写小说</, "the third navigation item must be visible");
  assert.match(html, /<span class="side-index" aria-hidden="true">03<\/span>/);
  assert.match(html, /<label for="novel-premise">故事设定<\/label>/);
  assert.match(html, /id="novel-premise"/);
  assert.match(html, />生成小说<\/button>/);
  assert.match(html, /微短篇 450–650 字/);
  assert.match(html, /长篇开篇 3000–3800 字/);

  const apiOutfile = join(outdir, "api.mjs");
  await build({
    entryPoints: ["src/lib/api.ts"],
    outfile: apiOutfile,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const { generateNovel } = await import(pathToFileURL(apiOutfile));
  let capturedUrl = "";
  let capturedBody = "";
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ docId: "novel-doc" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  await generateNovel({
    title: "",
    premise: "A driver meets the same missing passenger every night.",
    genre: "suspense",
    viewpoint: "third-limited",
    tone: "restrained",
    targetLength: "medium",
  }, "en");
  assert.equal(capturedUrl, "/api/novel/generate");
  assert.deepEqual(JSON.parse(capturedBody), {
    title: "",
    premise: "A driver meets the same missing passenger every night.",
    genre: "suspense",
    viewpoint: "third-limited",
    tone: "restrained",
    targetLength: "medium",
    lang: "en",
  });

  const storeOutfile = join(outdir, "store.mjs");
  await build({
    entryPoints: ["src/lib/store.ts"],
    outfile: storeOutfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    logLevel: "silent",
  });
  const { useStore } = await import(pathToFileURL(storeOutfile));
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/score")) {
      return new Response(JSON.stringify({ score: 86, level: "high", signals: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      docId: "novel-doc",
      styleSummary: "Fiction continuity profile",
      titleIndex: 0,
      length: { tier: "medium", unit: "words", actual: 900, min: 850, max: 1100, inRange: true },
      renderBlocks: [
        { type: "paragraph", kind: "heading1", text: "Night Route", paragraphIndex: 0 },
        { type: "paragraph", kind: "normal", text: "The passenger returned.", paragraphIndex: 1 },
      ],
      paragraphs: [
        { index: 0, kind: "heading1", original: "Night Route", rewritten: "Night Route", sentences: ["Night Route"] },
        { index: 1, kind: "normal", original: "The passenger returned.", rewritten: "The passenger returned.", sentences: ["The passenger returned."] },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  useStore.getState().setMode("novel");
  await useStore.getState().doGenerateNovel({
    title: "Night Route",
    premise: "A driver meets the same missing passenger every night.",
    genre: "suspense",
    viewpoint: "third-limited",
    tone: "restrained",
    targetLength: "medium",
  });
  assert.equal(useStore.getState().mode, "novel");
  assert.equal(useStore.getState().step, "ready");
  assert.equal(useStore.getState().docId, "novel-doc");
  useStore.getState().setMode("rewrite");
  assert.equal(useStore.getState().step, "upload", "the rewrite workspace must remain independent");
  assert.equal(useStore.getState().workspaces.novel.step, "ready");
  useStore.getState().setMode("novel");
  assert.equal(useStore.getState().docId, "novel-doc", "returning to fiction restores its editor state");

  console.log("novel UI tests passed");
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
