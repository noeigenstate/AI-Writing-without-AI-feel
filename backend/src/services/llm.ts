import OpenAI from "openai";
import { config } from "../core/config.js";
import { codexChat } from "./codexProvider.js";
import type { ChatOptions } from "../lib/chat.js";
export type { ChatFn, ChatOptions } from "../lib/chat.js";

const client = config.llm.provider === "codex" ? undefined : new OpenAI({
  baseURL: config.llm.baseURL,
  apiKey: config.llm.apiKey,
});

/**
 * Send one prompt and return the full completion text.
 *
 * @param prompt The user prompt.
 * @param opts Optional system prompt and temperature.
 * @returns The model's reply, or "" if empty.
 */
export async function chat(prompt: string, opts: ChatOptions = {}): Promise<string> {
  if (config.llm.provider === "codex") return codexChat(prompt, opts);
  const res = await client!.chat.completions.create(
    {
      ...baseRequest(prompt, opts),
      stream: false,
      ...deepSeekOptions(opts),
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & Record<string, unknown>,
    requestOptions(opts)
  );
  return res.choices[0]?.message?.content ?? "";
}

/**
 * Stream a completion, invoking `onDelta` for each chunk.
 *
 * @param prompt The user prompt.
 * @param onDelta Called with each content delta as it arrives.
 * @param opts Optional system prompt and temperature.
 * @returns The full concatenated reply once the stream ends.
 */
export async function chatStream(
  prompt: string,
  onDelta: (chunk: string) => void,
  opts: ChatOptions = {}
): Promise<string> {
  if (config.llm.provider === "codex") return codexChat(prompt, opts, onDelta);
  const stream = await client!.chat.completions.create(
    {
      ...baseRequest(prompt, opts),
      stream: true,
      ...deepSeekOptions(opts),
    } as OpenAI.Chat.ChatCompletionCreateParamsStreaming & Record<string, unknown>,
    requestOptions(opts)
  );

  let full = "";
  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content ?? "";
    if (delta) {
      full += delta;
      onDelta(delta);
    }
  }
  return full;
}

/**
 * Probe model connectivity with a trivial prompt.
 *
 * @returns `{ ok, model, error? }` — `ok` is false if the call throws.
 */
export async function health(): Promise<{ ok: boolean; model: string; error?: string }> {
  const model = config.llm.provider === "codex" ? `codex:${config.llm.codex.model}` : config.llm.model;
  try {
    const reply = await chat("回复「ok」两个字即可。", { temperature: 0 });
    return { ok: true, model, error: reply ? undefined : "空回复" };
  } catch (e) {
    return { ok: false, model, error: (e as Error).message };
  }
}

/** Model, temperature and messages shared by streaming and non-streaming calls. */
function baseRequest(prompt: string, opts: ChatOptions) {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });
  return { model: config.llm.model, temperature: opts.temperature ?? config.llm.temperature, messages };
}

function requestOptions(opts: ChatOptions): { timeout?: number; signal?: AbortSignal } {
  return {
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
}

/** Values that omit an optional extra; local servers usually reject these params. */
const OMIT = new Set(["", "off", "none", "false", "0"]);

/**
 * Build provider-specific extra params (`thinking`, `reasoning_effort`).
 *
 * Each is included only when configured to a non-"off" value, so the same code
 * works against DeepSeek and against local OpenAI-compatible servers.
 *
 * @returns Extra request fields to spread into the completion call.
 */
function deepSeekOptions(opts: ChatOptions = {}): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  const { thinkingType, reasoningEffort } = config.llm;
  const normalizedThinking = thinkingType.trim().toLowerCase();
  const thinkingConfigured = Boolean(thinkingType) && !OMIT.has(normalizedThinking);
  if (opts.disableThinking) {
    // Only send this provider-specific override when thinking was explicitly
    // configured. Generic OpenAI-compatible servers otherwise see no extra.
    if (thinkingConfigured) extra.thinking = { type: "disabled" };
    return extra;
  }
  if (thinkingConfigured) extra.thinking = { type: thinkingType };
  // An explicit `disabled` must reach providers whose default is thinking-on.
  // It also makes a reasoning-effort hint contradictory, so omit that hint.
  if (
    normalizedThinking !== "disabled" &&
    reasoningEffort &&
    !OMIT.has(reasoningEffort.toLowerCase())
  ) {
    extra.reasoning_effort = reasoningEffort;
  }
  return extra;
}
