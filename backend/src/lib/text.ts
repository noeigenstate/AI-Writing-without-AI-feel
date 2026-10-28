/**
 * Small, dependency-free string helpers shared across services.
 */

/**
 * Normalize a date-like string to `YYYY-MM-DD`.
 *
 * @param value An ISO date, a partial date, or any parseable date string.
 * @returns The ISO day portion, or the first 10 chars if unparseable, or "".
 */
export function shortDate(value: string): string {
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value.slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}

/**
 * Collapse whitespace and clip a string to a maximum length, adding an ellipsis.
 *
 * @param value The text to shorten.
 * @param maxLength Maximum length of the returned string (including the ellipsis).
 * @returns The trimmed, possibly ellipsized string.
 */
export function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  const text = replaceInvalidUnicode(value).replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  if (characters.length <= maxLength) {
    return text;
  }
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join("").trimEnd()}…`;
}

/**
 * Escape the five XML-significant characters for safe embedding in SVG/XML text.
 *
 * @param value Raw text.
 * @returns XML-escaped text.
 */
export function escapeSvg(value: string): string {
  return replaceInvalidUnicode(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Replace lone UTF-16 surrogates so URI/XML serialization cannot throw. */
function replaceInvalidUnicode(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] + value[index + 1];
        index += 1;
      } else {
        output += "�";
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      output += "�";
    } else {
      output += value[index];
    }
  }
  return output;
}

/**
 * Coerce an unknown value to a trimmed string, or "" if it is not a string.
 *
 * @param value Any value, typically from parsed JSON.
 * @returns The trimmed string, or "".
 */
export function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Type guard: whether an unknown request value is one of a fixed set of string literals.
 *
 * @param values The allowed values (typically an `as const` tuple).
 * @param value Any value, typically from a request body.
 * @returns True when `value` is a string equal to one of `values`.
 */
export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.some((allowed) => allowed === value);
}

/** True when the text contains at least one Han character. */
export function containsHan(value: string): boolean {
  return /[㐀-鿿]/u.test(value);
}

/**
 * Flatten control characters and whitespace in an untrusted value and clip it.
 *
 * @param value Any value, typically a field of model JSON output.
 * @param maxLength Maximum length of the result (no ellipsis).
 * @returns The single-line text, or "" if the value is not a string.
 */
export function cleanLine(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

/**
 * Clean each string of an untrusted array and keep the first spelling of each, ignoring case.
 *
 * @param value Any value; non-arrays yield [] and non-string entries are skipped.
 * @param limit Maximum number of lines returned.
 * @param maxLength Maximum length of each line.
 * @returns The unique, non-empty lines in their original order.
 */
export function uniqueLines(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const clean = cleanLine(entry, maxLength);
    const key = clean.toLocaleLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    output.push(clean);
    if (output.length >= limit) break;
  }
  return output;
}

/**
 * Build a short, URL/id-safe slug from arbitrary (incl. CJK) text.
 *
 * @param value Source text.
 * @returns A slug of at most 32 chars, or "untitled" when empty.
 */
export function slug(value: string): string {
  const cleaned = value.replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 32) || "untitled";
}
