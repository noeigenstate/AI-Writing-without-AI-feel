import OpenAI from "openai";
import { config } from "../core/config.js";

const client = new OpenAI({
  baseURL: config.llm.baseURL,
  apiKey: config.llm.apiKey,
});

/** Options for a single chat completion. */
export interface ChatOptions {
  system?: string;
  temperature?: number;
  /** Per-request transport timeout; omit to use the SDK default. */
  timeoutMs?: number;
  /**
   * Disable provider-side reasoning for strict structured-output calls.
   *
   * Some providers count hidden reasoning and visible content against the same
   * token cap. A reasoning-heavy request can therefore finish with an empty
   * `content` field even though the completion itself succeeded.
   */
  disableThinking?: boolean;
}

/**
 * Send one prompt and return the full completion text.
 *
 * @param prompt The user prompt.
 * @param opts Optional system prompt and temperature.
 * @returns The model's reply, or "" if empty.
 */
export async function chat(prompt: string, opts: ChatOptions = {}): Promise<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });

  const res = await client.chat.completions.create(
    {
      model: config.llm.model,
      temperature: opts.temperature ?? config.llm.temperature,
      messages,
      stream: false,
      ...deepSeekOptions(opts),
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & Record<string, unknown>,
    opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined
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
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });

  const stream = await client.chat.completions.create(
    {
      model: config.llm.model,
      temperature: opts.temperature ?? config.llm.temperature,
      messages,
      stream: true,
      ...deepSeekOptions(opts),
    } as OpenAI.Chat.ChatCompletionCreateParamsStreaming & Record<string, unknown>,
    opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined
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
  try {
    const reply = await chat("回复「ok」两个字即可。", { temperature: 0 });
    return { ok: true, model: config.llm.model, error: reply ? undefined : "空回复" };
  } catch (e) {
    return { ok: false, model: config.llm.model, error: (e as Error).message };
  }
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
  if (opts.disableThinking) {
    // Only send this provider-specific override when thinking was explicitly
    // configured. Generic OpenAI-compatible servers otherwise see no extra.
    if (thinkingType && !OMIT.has(normalizedThinking)) {
      extra.thinking = { type: "disabled" };
    }
    return extra;
  }
  if (thinkingType && !OMIT.has(normalizedThinking)) extra.thinking = { type: thinkingType };
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
