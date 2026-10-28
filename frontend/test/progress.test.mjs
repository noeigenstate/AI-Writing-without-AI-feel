import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const outdir = join(tmpdir(), `speak-plainly-progress-${Date.now()}`);
mkdirSync(outdir, { recursive: true });

try {
  const outfile = join(outdir, "progress.mjs");
  await build({
    entryPoints: ["src/lib/progress.ts"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    logLevel: "silent",
  });

  const { PROGRESS_PLANS, getProgressLogEntries, getProgressSnapshot } = await import(pathToFileURL(outfile));

  assert.ok(PROGRESS_PLANS.articleTopics, "topic/title planning has progress");
  assert.ok(PROGRESS_PLANS.novel, "fiction generation has progress");
  assert.ok(PROGRESS_PLANS.titleCandidates, "title candidate generation has progress");

  for (const [task, plan] of Object.entries(PROGRESS_PLANS)) {
    const first = getProgressSnapshot(plan, 0);
    assert.equal(first.phaseIndex, 0, `${task} starts in its first phase`);
    assert.ok(first.percent >= 1, `${task} starts with visible progress`);
    assert.ok(first.percent < 100, `${task} does not claim completion at start`);

    let previous = 0;
    for (const elapsed of [0, 1000, 5000, 12000, 30000, 60000, 120000]) {
      const next = getProgressSnapshot(plan, elapsed);
      assert.ok(next.percent >= previous, `${task} progress never moves backward at ${elapsed}ms`);
      assert.ok(next.percent <= 94, `${task} pending progress stays below completion`);
      previous = next.percent;
    }

    const saturated = getProgressSnapshot(plan, 10 * 60 * 1000);
    assert.equal(saturated.percent, 94, `${task} keeps waiting visible without reaching 100%`);

    const complete = getProgressSnapshot(plan, 0, true);
    assert.equal(complete.percent, 100, `${task} can render completion`);
    assert.equal(complete.phaseIndex, plan.length - 1, `${task} completion uses final phase`);
  }

  const logs = getProgressLogEntries(["one", "two", "three"], 1);
  assert.deepEqual(
    logs.map((entry) => entry.status),
    ["done", "active", "pending"],
    "progress logs show completed, active, and pending phases"
  );

  const lengthOutfile = join(outdir, "article-length.mjs");
  await build({
    entryPoints: ["src/components/editor/DocEditor.tsx"],
    outfile: lengthOutfile,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const {
    INITIAL_GIF_PLAYBACK_STATE,
    measureArticleBody,
    resolveSourceFigureMedia,
    safeSourceMediaDataUri,
    safeSourcePageUrl,
    shouldMountGifMedia,
    transitionGifPlayback,
  } = await import(pathToFileURL(lengthOutfile));

  assert.equal(INITIAL_GIF_PLAYBACK_STATE, "idle", "GIFs default to an unloaded state");
  assert.equal(transitionGifPlayback("idle", "toggle"), "playing", "explicit activation starts playback");
  assert.equal(transitionGifPlayback("playing", "toggle"), "idle", "pausing unloads the GIF");
  assert.equal(transitionGifPlayback("playing", "error"), "error", "load failures enter the recoverable error state");
  assert.equal(transitionGifPlayback("error", "toggle"), "playing", "the error state offers an explicit retry");
  assert.equal(
    transitionGifPlayback("playing", "toggle", true),
    "idle",
    "reduced-motion always keeps the GIF unloaded"
  );
  assert.equal(shouldMountGifMedia("idle"), false, "idle GIFs mount no image element");
  assert.equal(shouldMountGifMedia("error"), false, "failed GIFs stay unloaded");
  assert.equal(shouldMountGifMedia("playing"), true, "only explicit playback mounts the GIF");
  assert.equal(shouldMountGifMedia("playing", true), false, "reduced motion prevents GIF mounting");
  const validPngData = "data:image/png;base64,iVBORw0KGgo=";
  const validJpegData = "data:image/jpeg;base64,/9j/2Q==";
  const validWebpData = "data:image/webp;base64,UklGRg==";
  const validGifData = "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==";
  assert.equal(safeSourceMediaDataUri(validPngData, "image/png", "image"), validPngData);
  assert.equal(safeSourceMediaDataUri(validJpegData, "image/jpeg", "image"), validJpegData);
  assert.equal(safeSourceMediaDataUri(validWebpData, "image/webp", "image"), validWebpData);
  assert.equal(safeSourceMediaDataUri(validGifData, "image/gif", "gif"), validGifData);
  assert.equal(safeSourceMediaDataUri(validJpegData, "image/png", "image"), undefined, "declared and encoded MIME must agree");
  assert.equal(safeSourceMediaDataUri(validPngData, "image/png", "gif"), undefined, "kind and MIME must agree");
  assert.equal(safeSourceMediaDataUri(validGifData, "image/gif", "image"), undefined, "GIF bytes require GIF controls");
  assert.equal(safeSourceMediaDataUri("data:image/svg+xml;base64,PHN2Zz4=", "image/svg+xml", "image"), undefined);
  assert.equal(safeSourceMediaDataUri("https://example.com/remote.gif", "image/gif", "gif"), undefined);
  assert.equal(safeSourcePageUrl("javascript:alert(1)"), undefined);
  assert.equal(safeSourcePageUrl("https://example.com/story"), "https://example.com/story");
  assert.equal(safeSourcePageUrl("https://trusted.example:secret@evil.example/article"), undefined, "credential-bearing attribution URLs are rejected");
  assert.equal(safeSourcePageUrl("http://127.0.0.1:3000/admin"), undefined, "loopback attribution URLs are rejected");
  assert.equal(safeSourcePageUrl("https://192.168.1.2/story"), undefined, "private-network attribution URLs are rejected");
  assert.equal(safeSourcePageUrl("https://example.com:8443/story"), undefined, "non-default attribution ports are rejected");
  assert.equal(safeSourcePageUrl("https://[::1]/story"), undefined, "IPv6 loopback attribution URLs are rejected");
  assert.equal(safeSourcePageUrl("http://2130706433/admin"), undefined, "numeric loopback spellings are rejected");
  assert.equal(safeSourcePageUrl("https://example.com/story%c2%80tail"), undefined, "encoded control characters are rejected");
  assert.equal(safeSourcePageUrl("http://[64:ff9b::7f00:1]/admin"), undefined, "NAT64 loopback spellings are rejected");
  assert.equal(safeSourcePageUrl("http://[2002:7f00:1::]/admin"), undefined, "6to4 loopback spellings are rejected");
  assert.equal(safeSourcePageUrl("http://[fec0::1]/admin"), undefined, "deprecated site-local IPv6 addresses are rejected");
  assert.equal(safeSourcePageUrl("http://[2001::1]/admin"), undefined, "special-use 2001:: IPv6 addresses are rejected");
  assert.equal(safeSourcePageUrl("http://168.63.129.16/admin"), undefined, "cloud metadata infrastructure addresses are rejected");

  const validFigure = {
    type: "figure",
    origin: "web",
    title: "Source image",
    caption: "Evidence from the source page",
    alt: "A documented event",
    mediaKind: "image",
    mimeType: "image/png",
    mediaDataUri: validPngData,
    width: 1200,
    height: 800,
    sourceName: "Example News",
    sourceTitle: "Original report",
    sourceUrl: "https://example.com/story",
    sourceRef: 2,
  };
  assert.deepEqual(resolveSourceFigureMedia(validFigure), {
    src: validPngData,
    alt: "A documented event",
    width: 1200,
    height: 800,
    sourceName: "Example News",
    sourceTitle: "Original report",
    sourceUrl: "https://example.com/story",
  });
  assert.equal(resolveSourceFigureMedia({ ...validFigure, origin: "generated" }), undefined);
  assert.equal(resolveSourceFigureMedia({ ...validFigure, sourceUrl: "data:text/html,bad" }), undefined);
  assert.equal(resolveSourceFigureMedia({ ...validFigure, sourceUrl: "http://localhost/story" }), undefined);
  assert.equal(resolveSourceFigureMedia({ ...validFigure, mediaDataUri: "data:image/svg+xml;base64,PHN2Zz4=" }), undefined);
  assert.equal(resolveSourceFigureMedia({ ...validFigure, width: 0 }), undefined);
  assert.equal(resolveSourceFigureMedia({ ...validFigure, sourceRef: 0 }), undefined, "source media requires a positive reference number");

  const blocks = [
    { type: "paragraph", kind: "heading1", text: "Title", paragraphIndex: 0 },
    { type: "paragraph", kind: "normal", text: "Body", paragraphIndex: 1 },
    { type: "figure", title: "Figure", caption: "excluded caption", svg: "" },
    { type: "paragraph", kind: "normal", text: "More", paragraphIndex: 2 },
    { type: "references", title: "References", items: ["excluded reference"] },
  ];
  const zhParagraphs = [
    { index: 0, kind: "heading1", original: "title", sentences: ["edited title"] },
    { index: 1, kind: "normal", original: "body", sentences: ["\u4f60\u597d \u{1F44B}", " \u4e16\u754c"] },
    { index: 2, kind: "normal", original: "more", sentences: ["\u518d\u89c1[12]"] },
  ];
  const enParagraphs = [
    { index: 0, kind: "heading1", original: "Title", sentences: ["Edited title"] },
    { index: 1, kind: "normal", original: "Body", sentences: ["one two", " three"] },
    { index: 2, kind: "normal", original: "More", sentences: ["four five [12]"] },
  ];
  assert.equal(
    measureArticleBody(zhParagraphs, blocks, 0, "characters"),
    7,
    "article length counts edited Unicode body characters, excluding title and non-paragraph blocks"
  );
  assert.equal(
    measureArticleBody(enParagraphs, blocks, 0, "words"),
    5,
    "article length counts edited body words, excluding title and non-paragraph blocks"
  );
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
