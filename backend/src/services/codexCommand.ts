import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

interface CodexCommand {
  bin: string;
  prefix: string[];
  cmdShim?: boolean;
}

function isFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

/** Resolve Windows PATH/PATHEXT explicitly: spawning a batch shim needs a shell. */
export function resolveCodexCommand(
  bin = "codex",
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): CodexCommand {
  if (/\.[cm]?js$/i.test(bin)) return { bin: process.execPath, prefix: [path.resolve(bin)] };
  if (platform !== "win32") return { bin, prefix: [] };
  const explicitPath = path.isAbsolute(bin) || /[/\\]/.test(bin);
  const dirs = explicitPath ? [path.dirname(path.resolve(bin))] : (env.PATH ?? env.Path ?? "")
    .split(";").map((dir) => dir.trim().replace(/^"(.*)"$/, "$1").trim()).filter(Boolean);
  const extensions = path.extname(bin) ? [""] : (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";").map((ext) => ext.trim()).filter((ext) => /^\.[a-z0-9]+$/i.test(ext))
    .flatMap((ext) => [ext.toLowerCase(), ext]);
  const name = explicitPath ? path.basename(bin) : bin;
  const file = dirs.flatMap((dir) => extensions.map((ext) => path.join(dir, name + ext))).find(isFile);
  if (!file) {
    // Let spawn report a missing explicitly configured executable consistently on every OS.
    if (explicitPath && /\.(exe|com)$/i.test(bin)) return { bin: path.resolve(bin), prefix: [] };
    throw new Error("找不到 Codex CLI，请安装最新版 @openai/codex 或设置 CODEX_BIN。");
  }
  if (/\.(cmd|bat|ps1)$/i.test(file)) {
    const entry = path.join(path.dirname(file), "node_modules/@openai/codex/bin/codex.js");
    if (isFile(entry)) return { bin: process.execPath, prefix: [entry] };
  }
  if (/\.ps1$/i.test(file)) {
    return {
      bin: path.join(env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      prefix: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", file],
    };
  }
  return { bin: file, prefix: [], cmdShim: /\.(cmd|bat)$/i.test(file) || undefined };
}

/** Keep the prompt on stdin; batch launch syntax contains only fixed ASCII placeholders. */
export function spawnCodex(command: CodexCommand, args: string[], cwd: string) {
  const options = { cwd, windowsHide: true, detached: process.platform !== "win32" };
  if (!command.cmdShim) return spawn(command.bin, [...command.prefix, ...args], options);
  const values = [command.bin, ...args];
  if (values.some((value) => /["\0\r\n]/.test(value))) {
    throw new Error("Codex shim 参数包含不支持的字符，请将 CODEX_BIN 设置为可执行文件或 JS 入口。");
  }
  const env = { ...process.env };
  const quoted = values.map((value, index) => {
    const name = `SPEAK_CODEX_ARG_${index}`;
    env[name] = value;
    return `"%${name}%"`;
  }).join(" ");
  const shell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/cmd.exe");
  return spawn(shell, ["/d", "/v:off", "/s", "/c", `"${quoted}"`], {
    ...options, env, windowsVerbatimArguments: true,
  });
}
