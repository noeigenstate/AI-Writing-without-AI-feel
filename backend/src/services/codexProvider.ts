import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { config } from "../core/config.js";
import type { ChatOptions } from "../lib/chat.js";
import { createConcurrencyGate } from "../lib/concurrency.js";
import { isRecord, tryParseJson } from "../lib/json.js";
import { resolveCodexCommand, spawnCodex } from "./codexCommand.js";

const settings = config.llm.codex;
const limit = Number.isInteger(settings.concurrency) && settings.concurrency > 0 ? settings.concurrency : 2;
const runLimited = createConcurrencyGate(limit);
const PREAMBLE = "Act purely as a text model. Do not run commands, use tools, or read files. " +
  "Output only the requested answer, without commentary or added formatting. " +
  "If JSON is requested, output raw JSON without code fences.";

function positiveTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Run the official CLI; the budget starts before entering the shared queue. */
export async function codexChat(prompt: string, opts: ChatOptions = {}, onDelta?: (text: string) => void): Promise<string> {
  const timeoutMs = Math.max(positiveTimeout(settings.minTimeoutMs, 180_000),
    positiveTimeout(opts.timeoutMs, positiveTimeout(settings.timeoutMs, 600_000)));
  const controller = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error(`Codex 调用超时（${timeoutMs}ms），已取消调用。`)), timeoutMs);
  try {
    return await runLimited(async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "speak-plainly-codex-"));
      try {
        signal.throwIfAborted();
        return await runCodex(dir, `${PREAMBLE}\n\nSYSTEM PROMPT:\n${opts.system ?? ""}\n\nUSER PROMPT:\n${prompt}`, opts, signal, onDelta);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, signal);
  } finally {
    clearTimeout(timer);
  }
}

// Tool-related feature keys present in the installed 0.164.0 package. Read-only
// sandboxing remains necessary: apply_patch_freeform controls the patch variant.
const DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "shell_snapshot", "view_image", "apply_patch_freeform",
  "js_repl", "js_repl_tools_only", "code_mode", "code_mode_host", "code_mode_only", "code_mode_tool_search",
  "search_tool", "web_search_request", "web_search_cached", "multi_env_copy_file",
  "multi_agent", "multi_agent_v2", "enable_fanout", "enable_mcp_apps", "tool_search",
  "in_app_browser", "browser_use_external", "image_generation", "request_permissions_tool", "hooks",
  "goals", "sleep_tool", "agent_message_board", "send_async_message", "send_message_to_user_async",
  "default_mode_request_user_input", "skill_search", "skill_mcp_dependency_install",
];

function argumentsFor(output: string, opts: ChatOptions): string[] {
  return [
    "exec", "-m", settings.model,
    "-c", `model_reasoning_effort=${opts.disableThinking ? "low" : settings.reasoningEffort}`,
    "-s", "read-only", "--skip-git-repo-check", "--json", "--ephemeral",
    "--ignore-user-config", "--ignore-rules",
    ...DISABLED_FEATURES.flatMap((feature) => ["-c", `features.${feature}=false`]),
    "-c", "agents.enabled=false", "-c", "tools.update_plan.enabled=false",
    "-c", "tools.experimental_request_user_input.enabled=false",
    "-c", "web_search=disabled", "-o", output, "-",
  ];
}

/** Return safe messages without exposing arbitrary CLI output or prompt echoes. */
function providerError(diagnostic: string, code: number | null): Error {
  if (/quota|usage.?limit|insufficient.{0,20}(credit|balance)|用量.{0,10}(上限|额度)|余额不足/i.test(diagnostic)) {
    return new Error("Codex 用量已达上限，请检查 ChatGPT 套餐额度后重试。");
  }
  if (/rate[ _-]?limit|too many requests|\b429\b|限流/i.test(diagnostic)) {
    return new Error("Codex 请求过于频繁，请稍后重试。");
  }
  if (/not (logged|signed) in|unauthori[sz]ed|authentication|sign.?in required|\b401\b|token.{0,20}expired|refresh.{0,20}token/i.test(diagnostic)) {
    return new Error("Codex 尚未登录或登录已失效，请先运行 codex login。");
  }
  return new Error(`Codex 调用失败（退出码 ${code ?? "未知"}），请检查 CLI 安装、登录和模型配置。`);
}

async function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    return;
  }
  // taskkill /T must run before killing the parent, while its tree is discoverable.
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const killer = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/taskkill.exe"),
      ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { killer.kill("SIGKILL"); child.kill("SIGKILL"); resolve(); }, 2_000);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) child.kill("SIGKILL");
      resolve();
    };
    killer.once("error", () => finish(null));
    killer.once("exit", finish);
  });
}

function collectEvents() {
  let lastMessage = "";
  let diagnostic = "";
  let pendingStderr = "";
  let failed = false;
  const add = (value: unknown) => {
    if (typeof value === "string") diagnostic = (diagnostic + "\n" + value).slice(-16_384);
  };
  const stderrLine = (line: string) => {
    if (/^(?:\d{4}-\d\d-\d\dT\S+\s+)?(?:codex[: ]+)?(?:error|warn(?:ing)?)(?:[: ]|$)/i.test(line)) add(line);
  };
  return {
    stderr(text: string) {
      const lines = (pendingStderr + text).split(/\r?\n/);
      pendingStderr = lines.pop()!.slice(-16_384);
      lines.forEach(stderrLine);
    },
    line(line: string) {
      const event = tryParseJson(line);
      if (!isRecord(event)) return;
      if (event.type === "error" || event.type === "turn.failed") {
        failed ||= event.type === "turn.failed";
        add(event.message);
        add(typeof event.error === "string" ? event.error : undefined);
        if (isRecord(event.error)) { add(event.error.message); add(event.error.code); }
        add(event.code);
      }
      const item = event.item;
      if (event.type !== "item.completed" || !isRecord(item) || item.type !== "agent_message") return;
      if (item.phase === "commentary" || typeof item.text !== "string") return;
      lastMessage = item.text;
    },
    error(code: number | null) {
      stderrLine(pendingStderr);
      return code !== 0 || failed ? providerError(diagnostic, code) : undefined;
    },
    finish(text: string = lastMessage) { return text; },
  };
}

function waitForCodex(child: ChildProcessWithoutNullStreams, prompt: string,
  events: ReturnType<typeof collectEvents>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let failure: { error: unknown } | undefined;
    let killing: Promise<void> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const lines = createInterface({ input: child.stdout });
    const finish = async (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      signal.removeEventListener("abort", abort);
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      await killing;
      if (failure) return reject(failure.error);
      const error = events.error(code);
      if (error) reject(error);
      else resolve();
    };
    const drain = (code: number | null) => {
      if (!settled) grace ??= setTimeout(() => void finish(code), 100);
    };
    const stop = (error: unknown) => {
      failure ??= { error };
      killing ??= killTree(child);
      void killing.then(() => drain(child.exitCode));
    };
    const abort = () => stop(signal.reason);
    lines.on("line", (line) => events.line(line));
    child.stderr.setEncoding("utf8").on("data", (text: string) => events.stderr(text));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (!["EPIPE", "EOF", "ERR_STREAM_DESTROYED"].includes(error.code ?? "")) stop(new Error("Codex 提示词发送失败。"));
    });
    child.once("error", () => { failure ??= { error: new Error("无法启动 Codex CLI，请检查安装或 CODEX_BIN。") }; void finish(null); });
    child.once("exit", drain);
    child.once("close", (code) => void finish(code));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else child.stdin.end(prompt);
  });
}

async function runCodex(dir: string, prompt: string, opts: ChatOptions, signal: AbortSignal,
  onDelta?: (text: string) => void): Promise<string> {
  const output = path.join(dir, "last.md");
  const events = collectEvents();
  const child = spawnCodex(resolveCodexCommand(settings.bin), argumentsFor(output, opts), dir);
  await waitForCodex(child, prompt, events, signal);
  let text: string | undefined;
  try {
    text = await readFile(output, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Codex 回复文件读取失败。");
  }
  signal.throwIfAborted();
  const full = events.finish(text);
  if (!full.trim()) throw new Error("Codex 未返回最终回复，请重试。");
  // Emit the authoritative final answer once so SSE and the returned text agree.
  onDelta?.(full);
  return full;
}
