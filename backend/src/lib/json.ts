/**
 * Tolerant JSON parsing for LLM output, with an optional model-assisted repair pass.
 *
 * Models often wrap JSON in ```json fences or add stray prose; these helpers
 * recover the JSON payload and, on failure, ask the model to fix its own syntax.
 */

/** Type guard for plain objects (not arrays/null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** JSON.parse that yields undefined instead of throwing. */
export function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Minimal chat signature so this module need not depend on the LLM service. */
export type AskFn = (
  prompt: string,
  opts?: { temperature?: number; disableThinking?: boolean }
) => Promise<string>;

/**
 * Parse JSON that may be wrapped in code fences or padded with surrounding text.
 *
 * Strips a leading ```json fence, then clips to the outermost `[`/`{` … `]`/`}`
 * span before parsing.
 *
 * @param raw The raw model output.
 * @returns The parsed value.
 * @throws SyntaxError if the recovered payload is still not valid JSON.
 */
export function parseJson<T>(raw: string): T {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  if (start > 0) s = s.slice(start);
  const end = Math.max(s.lastIndexOf("]"), s.lastIndexOf("}"));
  if (end >= 0) s = s.slice(0, end + 1);
  return JSON.parse(s) as T;
}

/**
 * Parse JSON, and if that fails, ask the model to repair the syntax once and retry.
 *
 * @param raw The raw model output.
 * @param ask Chat function used to request a repaired payload.
 * @param expected Human-readable description of the expected shape (e.g. "topics JSON array").
 * @returns The parsed value.
 * @throws Error if both the initial parse and the repaired parse fail.
 */
export async function parseJsonWithRepair<T>(raw: string, ask: AskFn, expected: string): Promise<T> {
  try {
    return parseJson<T>(raw);
  } catch {
    const repaired = await ask(jsonRepairPrompt(raw, expected), {
      temperature: 0,
      disableThinking: true,
    });
    try {
      return parseJson<T>(repaired);
    } catch {
      throw new Error(`模型返回的${expected}不是有效 JSON，请重试`);
    }
  }
}

/**
 * Build the prompt that asks the model to fix invalid JSON without changing content.
 *
 * @param raw The invalid JSON output (clipped to 12k chars).
 * @param expected Description of the target format.
 * @returns The repair prompt.
 */
export function jsonRepairPrompt(raw: string, expected: string): string {
  return `下面是一段不合法的 JSON 输出。请只修复语法，保持原有信息，不要新增事实。
目标格式：${expected}
要求：
1. 只输出可被 JSON.parse 直接解析的 JSON。
2. 不要输出 Markdown、解释、注释或代码块。
3. 如果字段值里有换行、引号或特殊字符，请正确转义。

原始输出：
"""
${raw.slice(0, 12_000)}
"""`;
}
