import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const outdir = join(tmpdir(), `speak-plainly-api-network-${Date.now()}`);
mkdirSync(outdir, { recursive: true });

const originalFetch = globalThis.fetch;

try {
  const outfile = join(outdir, "api.mjs");
  await build({
    entryPoints: ["src/lib/api.ts"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });

  const {
    fetchArticleDomains,
    fetchArticleTopics,
    fetchGzhThemes,
    fetchStyles,
    previewResearch,
  } = await import(pathToFileURL(outfile));

  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };

  await assert.rejects(
    () => previewResearch("ai-tech", "", "AI", "zh"),
    {
      message: "无法连接本地后端。请重新运行 run.bat，等命令行显示“AI写作 is ready”后再试。",
    },
    "Chinese API calls should replace the browser's raw network error with a recovery step"
  );

  await assert.rejects(
    () => fetchArticleTopics("ai-tech", "", 6, "en"),
    {
      message: 'Cannot reach the local backend. Run run.bat again, wait for "AI写作 is ready", then retry.',
    },
    "English API calls should expose the same actionable recovery path"
  );

  assert.deepEqual(await fetchStyles("zh"), [], "style loading should degrade to an empty list offline");
  assert.deepEqual(await fetchArticleDomains("en"), [], "domain loading should degrade to an empty list offline");
  assert.deepEqual(await fetchGzhThemes("zh"), [], "theme loading should degrade to an empty list offline");

  console.log("API network error localization tests passed.");
} finally {
  globalThis.fetch = originalFetch;
  rmSync(outdir, { recursive: true, force: true });
}
