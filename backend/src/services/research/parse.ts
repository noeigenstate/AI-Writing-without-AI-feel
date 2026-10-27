import { XMLParser } from "fast-xml-parser";

/** Parsing helpers shared by the research source adapters. */

/** Feed parser shared by the RSS/Atom and arXiv adapters. */
export const xmlParser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true,
});

export type XmlValue = string | number | boolean | Record<string, unknown> | XmlValue[] | null | undefined;

/** Type guard for plain objects (not arrays/null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The value itself when it is a string, otherwise "". */
export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Wrap a value as an array (XML parser yields a scalar for single nodes). */
export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/** JSON.parse that yields undefined instead of throwing. */
export function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Normalize a date string to ISO-8601, or "" if missing/unparseable. */
export function normalizeDate(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** Coerce an XML node value to clean, whitespace-collapsed text. */
export function xmlText(value: XmlValue): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).replace(/\s+/g, " ").trim();
    return text || undefined;
  }
  if (Array.isArray(value)) {
    return value.map(xmlText).filter(Boolean).join(", ") || undefined;
  }
  return xmlText(value["#text"] as XmlValue);
}

/** Read a URL field without erasing embedded control characters before validation. */
export function xmlUrlText(value: XmlValue): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const raw = String(value);
    if (/\p{Cc}/u.test(raw)) return undefined;
    return raw.trim() || undefined;
  }
  if (Array.isArray(value)) return undefined;
  return xmlUrlText(value["#text"] as XmlValue);
}
