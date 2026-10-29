import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_CLI = String.raw`
import fs from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
const argv = process.argv.slice(2);
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
const user = stdin.split("\n\nUSER PROMPT:\n").at(-1);
const record = (data) => fs.appendFileSync(process.env.CODEX_TEST_LOG, JSON.stringify(data) + "\n");
record({ kind: "start", pid: process.pid, argv, stdin, cwd: process.cwd(), empty: fs.readdirSync(".").length === 0 });
const event = (data) => process.stdout.write(JSON.stringify(data) + "\n");
const message = (text, extra = {}) => event({ type: "item.completed", item: { id: "answer", type: "agent_message", text, ...extra } });
const output = argv[argv.indexOf("-o") + 1];
if (user === "timeout" || user === "abort-running" || user.startsWith("hold-")) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  record({ kind: "descendant", pid: child.pid });
  setInterval(() => {}, 1000);
} else if (["rate", "quota", "auth", "generic", "event-error", "echo-error"].includes(user) || user.startsWith("stdin-")) {
  const error = { rate: "429 rate limit", quota: "usage limit reached", auth: "not logged in", generic: "unknown failure", "event-error": "rate_limit_exceeded", "echo-error": "unknown failure" }[user] ?? "429 rate limit";
  if (user === "event-error") event({ type: "turn.failed", error: { message: error + " sk-fixture-secret " + stdin } });
  else {
    process.stderr.write("Error: " + error + "\n");
    process.stderr.write('prompt echo: quota usage_limit authentication 401 429 Bearer fixture-secret ' + stdin);
    if (user === "echo-error") event({ type: "error", prompt: "quota rate_limit_exceeded authentication", item: { text: "usage limit reached" } });
  }
  process.exitCode = user === "event-error" ? 0 : 1;
} else {
  if (user.startsWith("delay")) await new Promise((resolve) => setTimeout(resolve, user === "delay-budget" ? 800 : 200));
  if (user === "retry-success") event({ type: "error", message: "reconnecting after rate_limit_exceeded" });
  if (user === "held-pipes") {
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: tmpdir(), detached: true, stdio: ["ignore", process.stdout, process.stderr], windowsHide: true });
    record({ kind: "pipe-holder", pid: grandchild.pid });
    grandchild.unref();
  }
  if (user === "stream") {
    process.stdout.write("not json\n");
    event({ type: "item.updated", item: { type: "agent_message", text: "partial" } });
    message("private reasoning", { type: "reasoning" });
    message("working...", { phase: "commentary" });
    message("你");
    message("你");
    await new Promise((resolve) => setTimeout(resolve, 40));
    message("你好");
    fs.writeFileSync(output, "你好");
  } else if (user === "empty" || user === "commentary-only") {
    if (user === "commentary-only") message("working", { phase: "commentary" });
  } else if (user.includes('"task":"translate_search_query"')) {
    const request = JSON.parse(user);
    const query = "Roman concrete history";
    const text = JSON.stringify({ query, anchors: request.requiredAnchors.map((source) => ({ source, target: query })) });
    message(text); fs.writeFileSync(output, text);
  } else if (user.includes("Source:\n[")) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const text = JSON.stringify([...user.matchAll(/^\[(\d+)\] \([^)]*\) (.*)$/gm)].map(([, index, text]) => ({ index: Number(index), text: "rewritten " + text })));
    message(text); fs.writeFileSync(output, text);
  } else if (user.includes('e.g. ["Title one","Title two"]')) {
    message('["Rewritten title"]'); fs.writeFileSync(output, '["Rewritten title"]');
  } else if (user === "file-only") fs.writeFileSync(output, "file only");
  else if (user === "success") { message("event answer"); fs.writeFileSync(output, "file answer\n"); }
  else if (user === "fallback") { message("earlier"); message("last answer"); }
  else {
    const text = user === "json" ? '{"ok":true,"text":"原样"}' : "ok";
    // Deliberately split a JSONL record, including a multibyte answer, across writes.
    const bytes = Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
    process.stdout.write(bytes.subarray(0, bytes.length - 3));
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.stdout.write(bytes.subarray(bytes.length - 3));
    fs.writeFileSync(output, text);
  }
  record({ kind: "end", pid: process.pid });
  if (user === "held-pipes") process.exit(0);
}
`;

async function records(): Promise<Record<string, any>[]> {
  const log = process.env.CODEX_TEST_LOG!;
  if (!existsSync(log)) return [];
  return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitUntil(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isPrompt(row: Record<string, any>, prompt: string): boolean {
  return row.kind === "start" && row.stdin.endsWith(`USER PROMPT:\n${prompt}`);
}

async function testCodex() {
  const { config } = await import("../core/config.js");
  const { chat, chatStream, health } = await import("../services/llm.js");
  assert.equal(config.llm.apiKey, "", "Codex must import and run without an API key");
  assert.equal(config.llm.codex.model, "gpt-6.1-sol");
  assert.equal(config.llm.codex.reasoningEffort, "medium");
  assert.equal(config.llm.codex.concurrency, 2);
  assert.equal(config.llm.codex.timeoutMs, 600000);
  assert.equal(config.llm.codex.minTimeoutMs, 180000);
  assert.equal(await chat("success", { system: "SYSTEM-SENTINEL", temperature: 0.12 }), "file answer\n");
  assert.equal(await chat("json", { system: "Return only JSON", disableThinking: true }), '{"ok":true,"text":"原样"}');
  assert.equal(await chat("fallback"), "last answer");
  assert.equal(await chat("retry-success"), "ok", "retryable error events must not override a successful final answer");
  for (const prompt of ["empty", "commentary-only"]) await assert.rejects(chat(prompt), /未返回最终回复/);
  const deltas: string[] = [];
  assert.equal(await chatStream("stream", (delta) => deltas.push(delta)), "你好");
  assert.deepEqual(deltas, ["你好"]);
  for (const [prompt, expected] of [["success", "file answer\n"], ["fallback", "last answer"]]) {
    const chunks: string[] = [];
    assert.equal(await chatStream(prompt, (delta) => chunks.push(delta)), expected);
    assert.equal(chunks.join(""), expected, "SSE must match the authoritative final answer, even after multiple messages");
  }
  const fileDeltas: string[] = [];
  assert.equal(await chatStream("file-only", (delta) => fileDeltas.push(delta)), "file only");
  assert.deepEqual(fileDeltas, ["file only"]);
  assert.deepEqual(await health(), { ok: true, model: "codex:gpt-6.1-sol", error: undefined });
  for (const [prompt, expected] of [["rate", /过于频繁/], ["quota", /用量已达上限/], ["auth", /codex login/], ["generic", /退出码 1/], ["echo-error", /退出码 1/], ["event-error", /过于频繁/]] as const) {
    await assert.rejects(chat(prompt), (error: Error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /fixture-secret|SYSTEM PROMPT|USER PROMPT|Act purely/);
      return true;
    });
  }
  for (const test of [testTimeout, testFloor, testQueuedCancellation, testRunningCancellation,
    testInheritedPipes, testConcurrency, testStdinErrors, testResearchTranslation, testLongRewrite, testWindowsShim]) {
    try { await test(chat); } catch (error) { throw new Error(`${test.name} failed`, { cause: error }); }
  }
  await testHealthRoute();
  const originalBin = config.llm.codex.bin;
  try {
    config.llm.codex.bin = path.join(tmpdir(), "codex-provider-missing-executable.exe");
    const result = await health();
    assert.equal(result.ok, false);
    assert.equal(result.model, "codex:gpt-6.1-sol");
    assert.match(result.error!, /无法启动 Codex CLI/);
  } finally {
    config.llm.codex.bin = originalBin;
  }
  const starts = (await records()).filter((row) => row.kind === "start");
  for (const row of starts) {
    assert.equal(row.empty, true);
    assert.equal(existsSync(row.cwd), false, "every working directory must be removed, including failures");
    assert.equal(row.argv.at(-1), "-");
    assert.equal(row.argv[0], "exec");
    for (const arg of ["read-only", "--skip-git-repo-check", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "features.shell_tool=false", "features.unified_exec=false", "features.view_image=false", "features.apply_patch_freeform=false", "features.js_repl=false", "features.code_mode=false", "features.multi_agent=false", "features.enable_mcp_apps=false", "features.image_generation=false", "features.hooks=false", "agents.enabled=false", "tools.update_plan.enabled=false", "tools.experimental_request_user_input.enabled=false", "web_search=disabled"]) assert.ok(row.argv.includes(arg), `missing isolation argument: ${arg}`);
    assert.ok(row.stdin.startsWith("Act purely as a text model."));
    assert.ok(row.stdin.includes("SYSTEM PROMPT:\n"));
    assert.doesNotMatch(row.argv.join(" "), /SYSTEM-SENTINEL|USER PROMPT|temperature|Return only JSON/);
    assert.equal(path.dirname(row.argv[row.argv.indexOf("-o") + 1]), row.cwd);
  }
  assert.ok(starts[0].stdin.includes("SYSTEM PROMPT:\nSYSTEM-SENTINEL\n\nUSER PROMPT:\nsuccess"));
  assert.ok(starts[0].argv.includes("model_reasoning_effort=medium"));
  assert.ok(starts[1].argv.includes("model_reasoning_effort=low"));
}

async function testTimeout(chat: typeof import("../services/llm.js").chat) {
  const { config } = await import("../core/config.js");
  const floor = config.llm.codex.minTimeoutMs;
  try {
    config.llm.codex.minTimeoutMs = 100;
    await assert.rejects(chat("timeout", { timeoutMs: 1500 }), /调用超时（1500ms）/);
  } finally {
    config.llm.codex.minTimeoutMs = floor;
  }
  const rows = await records();
  const parent = rows.find((row) => row.kind === "start" && row.stdin.endsWith("USER PROMPT:\ntimeout"));
  const descendant = rows.find((row) => row.kind === "descendant");
  assert.ok(parent && descendant, "the timeout fixture must start both processes");
  for (const pid of [parent.pid, descendant.pid]) {
    assert.throws(() => process.kill(pid, 0), "the timed-out CLI and its descendant must both be dead");
  }
  assert.equal(await chat("after timeout"), "ok", "a timeout must release its queue slot");
}

async function testFloor(chat: typeof import("../services/llm.js").chat) {
  const { config } = await import("../core/config.js");
  const floor = config.llm.codex.minTimeoutMs;
  try {
    config.llm.codex.minTimeoutMs = 1_000;
    assert.equal(await chat("delay-floor", { timeoutMs: 1 }), "ok", "API-tuned budgets must be raised to the Codex floor");
    const startedAt = Date.now();
    await assert.rejects(chat("timeout", { timeoutMs: 1 }), /调用超时（1000ms）/);
    assert.ok(Date.now() - startedAt >= 900, "the floor must also be the actual timeout, not just a documented value");
  } finally {
    config.llm.codex.minTimeoutMs = floor;
  }
}

async function testQueuedCancellation(chat: typeof import("../services/llm.js").chat) {
  const { config } = await import("../core/config.js");
  const floor = config.llm.codex.minTimeoutMs;
  const controllers = [new AbortController(), new AbortController()];
  const blockers = controllers.map((controller, index) => assert.rejects(
    chat(`hold-queue${index}`, { signal: controller.signal }), /queue cleanup/));
  try {
    await waitUntil(async () => (await records()).filter((row) => /^hold-queue\d$/.test(row.stdin?.split("USER PROMPT:\n").at(-1))).length === 2, "both queue blockers must start");
    config.llm.codex.minTimeoutMs = 100;
    await assert.rejects(chat("queued-timeout", { timeoutMs: 150 }), /调用超时（150ms）/);
    const controller = new AbortController();
    const canceled = assert.rejects(chat("queued-abort", { signal: controller.signal }), /queued cancel/);
    controller.abort(new Error("queued cancel"));
    await canceled;
    await assert.rejects(chat("already-aborted", { signal: AbortSignal.abort(new Error("pre-aborted")) }), /pre-aborted/);
    const release = setTimeout(() => controllers[0].abort(new Error("queue cleanup")), 500);
    try {
      await assert.rejects(chat("delay-budget", { timeoutMs: 1_000 }), /调用超时（1000ms）/);
    } finally {
      clearTimeout(release);
    }
    const rows = await records();
    for (const prompt of ["queued-timeout", "queued-abort", "already-aborted"]) {
      assert.equal(rows.some((row) => isPrompt(row, prompt)), false, `canceled waiter must never spawn: ${prompt}`);
    }
    assert.ok(rows.some((row) => isPrompt(row, "delay-budget")), "the total-budget test must spend time both queued and running");
  } finally {
    controllers.forEach((controller) => controller.abort(new Error("queue cleanup")));
    await Promise.all(blockers);
    config.llm.codex.minTimeoutMs = floor;
  }
  assert.equal(await chat("after queued cancellation"), "ok", "removed waiters must not block later calls");
}

async function testRunningCancellation(chat: typeof import("../services/llm.js").chat) {
  const before = (await records()).length;
  const controller = new AbortController();
  const canceled = assert.rejects(chat("abort-running", { signal: controller.signal }), /running cancel/);
  try {
    await waitUntil(async () => (await records()).slice(before).some((row) => row.kind === "descendant"), "running abort must exercise a live process tree");
  } finally {
    controller.abort(new Error("running cancel"));
    await canceled;
  }
  for (const row of (await records()).slice(before).filter((row) => ["start", "descendant"].includes(row.kind))) {
    assert.throws(() => process.kill(row.pid, 0), "abort must kill both the CLI and its descendant before returning");
  }
  assert.equal(await chat("after running cancellation"), "ok");
}

async function testInheritedPipes(chat: typeof import("../services/llm.js").chat) {
  const before = (await records()).length;
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(new Error("inherited pipes hung the provider")), 3_000);
  try {
    assert.equal(await chat("held-pipes", { signal: controller.signal }), "ok");
    const holder = (await records()).slice(before).find((row) => row.kind === "pipe-holder");
    assert.ok(holder, "the CLI must spawn a detached process inheriting its pipes");
    assert.doesNotThrow(() => process.kill(holder.pid, 0), "the call must finish while the grandchild still holds stdout open");
    assert.equal(await chat("after held pipes"), "ok", "exit must release the slot without waiting for close");
  } finally {
    clearTimeout(watchdog);
    for (const row of (await records()).slice(before).filter((row) => row.kind === "pipe-holder")) {
      try { process.kill(row.pid, "SIGKILL"); } catch { /* Already exited. */ }
    }
  }
}

async function testStdinErrors(chat: typeof import("../services/llm.js").chat) {
  const original = childProcess.spawn;
  for (const code of ["EPIPE", "EOF", "ERR_STREAM_DESTROYED"]) {
    try {
      childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
        const child = original(...args);
        child.stdin?.once("finish", () => queueMicrotask(() => child.stdin?.emit("error", Object.assign(new Error("fixture stdin closed"), { code }))));
        return child;
      }) as typeof spawn;
      syncBuiltinESMExports();
      await assert.rejects(chat(`stdin-${code}`), /过于频繁/, "CLI exit diagnostics must take precedence over an early stdin close");
    } finally {
      childProcess.spawn = original;
      syncBuiltinESMExports();
    }
  }
}

async function testResearchTranslation() {
  const { resolveRegionalQueryPlan, regionalQueryPlan } = await import("../services/research/aggregate.js");
  const before = (await records()).filter((row) => row.kind === "start").length;
  const deterministic = "Remote work policies for small companies";
  assert.deepEqual(await resolveRegionalQueryPlan(deterministic), regionalQueryPlan(deterministic));
  assert.equal((await records()).filter((row) => row.kind === "start").length, before);
  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual(await resolveRegionalQueryPlan("罗马混凝土史", "history"), { domestic: "罗马混凝土史", international: "Roman concrete history" });
  }
  assert.equal((await records()).filter((row) => row.kind === "start").length, before + 1, "Codex translations must retain the cache");
  const { chat } = await import("../services/llm.js");
  let signal: AbortSignal | undefined;
  const plan = await resolveRegionalQueryPlan("未知历史主题", "history", {
    timeoutMs: 300,
    translate: (_prompt, options) => {
      signal = options.signal;
      return chat("hold-translation", options);
    },
  });
  assert.equal(signal?.aborted, true);
  assert.deepEqual(plan, regionalQueryPlan("未知历史主题", "history"));
  await waitUntil(async () => {
    const row = (await records()).find((row) => isPrompt(row, "hold-translation"));
    return !row || !existsSync(row.cwd);
  }, "translation timeout must clean up its process and release the slot");
}

async function testLongRewrite() {
  const { config } = await import("../core/config.js");
  const { rewriteDocument } = await import("../services/rewrite.js");
  const { timeoutMs, minTimeoutMs } = config.llm.codex;
  const paragraphs = Array.from({ length: 241 }, (_, index) => ({ index, kind: "p", text: `paragraph ${index}` }));
  try {
    config.llm.codex.timeoutMs = 1_000;
    config.llm.codex.minTimeoutMs = 100;
    const before = (await records()).length;
    const result = await rewriteDocument("", paragraphs);
    assert.equal(result.get(0), "Rewritten title");
    assert.equal(result.size, paragraphs.length);
    for (const paragraph of paragraphs.slice(1)) assert.equal(result.get(paragraph.index), `rewritten ${paragraph.text}`);
    assert.equal((await records()).slice(before).filter((row) => row.kind === "start").length, 21, "retain the default 12-paragraph chunks");
  } finally {
    Object.assign(config.llm.codex, { timeoutMs, minTimeoutMs });
  }
}

async function testWindowsShim(chat: typeof import("../services/llm.js").chat) {
  if (process.platform !== "win32") return;
  const { config } = await import("../core/config.js");
  const bin = config.llm.codex.bin!;
  const dir = await mkdtemp(path.join(tmpdir(), "codex shim 测试 & "));
  const shim = path.join(dir, "codex.cmd");
  const previousNode = process.env.SPEAK_CODEX_TEST_NODE;
  const previousEntry = process.env.SPEAK_CODEX_TEST_ENTRY;
  try {
    // Real npm/pnpm shims use ASCII syntax and resolve Unicode paths at runtime.
    await writeFile(shim, '@"%SPEAK_CODEX_TEST_NODE%" "%SPEAK_CODEX_TEST_ENTRY%" %*\n');
    process.env.SPEAK_CODEX_TEST_NODE = process.execPath;
    process.env.SPEAK_CODEX_TEST_ENTRY = bin;
    config.llm.codex.bin = shim;
    assert.equal(await chat('Unicode 提示词 " & | ^ %PATH% !\n下一行'), "ok");
  } finally {
    config.llm.codex.bin = bin;
    if (previousNode === undefined) delete process.env.SPEAK_CODEX_TEST_NODE;
    else process.env.SPEAK_CODEX_TEST_NODE = previousNode;
    if (previousEntry === undefined) delete process.env.SPEAK_CODEX_TEST_ENTRY;
    else process.env.SPEAK_CODEX_TEST_ENTRY = previousEntry;
    await rm(dir, { recursive: true, force: true });
  }
}

async function testConcurrency(chat: typeof import("../services/llm.js").chat) {
  const before = (await records()).length;
  assert.deepEqual(await Promise.all(Array.from({ length: 7 }, (_, i) => chat(`delay${i}`))), Array(7).fill("ok"));
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  for (const row of (await records()).slice(before)) {
    active += row.kind === "start" ? 1 : -1;
    peak = Math.max(peak, active);
    if (row.kind === "start") order.push(row.stdin.split("USER PROMPT:\n").at(-1));
  }
  assert.equal(active, 0);
  assert.equal(peak, 2, "concurrent pipelines must share the configured cap");
  assert.deepEqual(order.slice(0, 2).sort(), ["delay0", "delay1"]);
}

async function testHealthRoute() {
  const { default: express } = await import("express");
  const { default: healthRouter } = await import("../routes/health.routes.js");
  const app = express();
  app.use(healthRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`);
    assert.deepEqual(await response.json(), { ok: true, model: "codex:gpt-6.1-sol" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testOpenAI() {
  const requests: string[] = [];
  let abortedConnections = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(body);
    if (JSON.parse(body).messages.at(-1).content.startsWith("abort-")) {
      res.once("close", () => abortedConnections += 1);
      return;
    }
    if (JSON.parse(body).stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  process.env.LLM_API_KEY = "offline-fixture";
  try {
    const { config } = await import("../core/config.js");
    const { chat, chatStream, health } = await import("../services/llm.js");
    assert.equal(config.llm.provider, "openai");
    assert.equal(await chat("plain"), "ok");
    assert.equal(await chat("structured", { system: "sys", temperature: 0, disableThinking: true, timeoutMs: 2000 }), "ok");
    const deltas: string[] = [];
    assert.equal(await chatStream("stream", (delta) => deltas.push(delta)), "ok");
    assert.deepEqual(deltas, ["ok"]);
    assert.equal((await health()).model, "deepseek-v4-pro");
    const base = { model: "deepseek-v4-pro", temperature: 0.7, messages: [{ role: "user", content: "plain" }], stream: false, thinking: { type: "enabled" }, reasoning_effort: "high" };
    assert.equal(requests[0], JSON.stringify(base, null, 2), "default OpenAI request bytes must stay unchanged");
    assert.equal(requests[1], JSON.stringify({ model: base.model, temperature: 0, messages: [{ role: "system", content: "sys" }, { role: "user", content: "structured" }], stream: false, thinking: { type: "disabled" } }, null, 2));
    assert.equal(requests[2], JSON.stringify({ ...base, messages: [{ role: "user", content: "stream" }], stream: true }, null, 2));
    for (const streaming of [false, true]) {
      const controller = new AbortController();
      const before = requests.length;
      const canceled = assert.rejects(streaming
        ? chatStream("abort-stream", () => undefined, { signal: controller.signal })
        : chat("abort-chat", { signal: controller.signal }), /abort/i);
      await waitUntil(() => requests.length > before, "OpenAI request must reach the SDK transport before abort");
      controller.abort();
      await canceled;
    }
    await waitUntil(() => abortedConnections === 2, "both canceled SDK requests must close their HTTP connections");
    assert.deepEqual(await records(), [], "neither the default provider nor explicit openai may spawn Codex");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testWindowsResolution(dir: string) {
  const { resolveCodexCommand } = await import("../services/codexCommand.js");
  const root = path.join(dir, "resolution");
  const native = path.join(root, "native 独立安装");
  const npm = path.join(root, "npm");
  const pnpm = path.join(root, "pnpm shims");
  const entry = path.join(npm, "node_modules/@openai/codex/bin/codex.js");
  for (const folder of [native, pnpm, path.dirname(entry)]) await mkdir(folder, { recursive: true });
  for (const file of [path.join(native, "codex.exe"), path.join(npm, "codex.cmd"), path.join(npm, "codex.ps1"), entry, path.join(pnpm, "codex.cmd"), path.join(root, "codex.cmd")]) await writeFile(file, "fixture");
  const env = { PATH: `;;  ;"";"${native}";${npm}`, PATHEXT: ".EXE;.CMD" };
  assert.equal(resolveCodexCommand("codex", env, "win32").bin, path.join(native, "codex.exe"));
  assert.equal(resolveCodexCommand(path.join(native, "codex.exe"), {}, "win32").bin, path.join(native, "codex.exe"));
  assert.deepEqual(resolveCodexCommand("codex", { ...env, PATH: `${npm};${native}` }, "win32"), { bin: process.execPath, prefix: [entry] });
  assert.deepEqual(resolveCodexCommand(path.join(npm, "codex.ps1"), {}, "win32"), { bin: process.execPath, prefix: [entry] });
  const shim = resolveCodexCommand("codex", { PATH: pnpm, PATHEXT: ".CMD;.EXE" }, "win32");
  assert.equal(shim.bin, path.join(pnpm, "codex.cmd"));
  assert.equal(shim.cmdShim, true);
  await writeFile(path.join(native, "codex.cmd"), "fixture");
  assert.equal(resolveCodexCommand("codex", { ...env, PATHEXT: ".CMD;.EXE" }, "win32").cmdShim, true, "PATHEXT order must be respected");
  assert.throws(() => resolveCodexCommand("codex", { PATH: native, PATHEXT: ".MISSING" }, "win32"), /找不到 Codex CLI/);
  const cwd = process.cwd();
  try {
    process.chdir(root);
    assert.throws(() => resolveCodexCommand("codex", { PATH: ';;  ;"";', PATHEXT: ".CMD" }, "win32"), /找不到 Codex CLI/, "empty PATH entries must not search cwd");
  } finally {
    process.chdir(cwd);
  }
}

async function runIsolated(mode: string, dir: string, bin: string) {
  await new Promise<void>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env, DOTENV_CONFIG_PATH: path.join(dir, "absent.env"), CODEX_BIN: bin,
      CODEX_TEST_LOG: path.join(dir, `${mode}.jsonl`), LLM_API_KEY: "", DEEPSEEK_API_KEY: "",
      LLM_MODEL: "deepseek-v4-pro", LLM_TEMPERATURE: "0.7", LLM_THINKING_TYPE: "enabled", LLM_REASONING_EFFORT: "high",
      CODEX_MODEL: "gpt-6.1-sol", CODEX_REASONING_EFFORT: "medium", CODEX_CONCURRENCY: "2", CODEX_TIMEOUT_MS: "600000",
    };
    if (mode === "default") delete env.LLM_PROVIDER;
    else env.LLM_PROVIDER = mode === "codex" ? "codex" : mode === "normalized" ? " CoDeX " : mode === "invalid" ? "typo-provider" : " OPENAI ";
    delete env.CODEX_MIN_TIMEOUT_MS;
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), mode], { env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Codex provider ${mode} tests failed (${code})`)));
  });
}

const mode = process.argv[2];
if (mode === "codex") await testCodex();
else if (mode === "default" || mode === "openai") await testOpenAI();
else if (mode === "normalized") {
  const { config } = await import("../core/config.js");
  const { chat } = await import("../services/llm.js");
  assert.equal(config.llm.provider, "codex");
  assert.equal(await chat("normalized provider"), "ok");
} else if (mode === "invalid") {
  await assert.rejects(import("../core/config.js"), /Unsupported LLM_PROVIDER; expected openai or codex/);
}
else {
  const dir = await mkdtemp(path.join(tmpdir(), "codex provider 测试 "));
  try {
    const bin = path.join(dir, "fake codex.mjs");
    await writeFile(bin, FAKE_CLI);
    await testWindowsResolution(dir);
    for (const selected of ["codex", "default", "openai", "normalized", "invalid"]) await runIsolated(selected, dir, bin);
    console.log("Codex resolution/shims, total budgets/floor, queue/running aborts, inherited pipes, retry events, stdin errors, translation/cache, long rewrites, health and unchanged OpenAI requests passed.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
