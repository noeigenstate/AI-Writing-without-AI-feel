export type ProtectedFragmentType =
  | "url"
  | "email"
  | "citation"
  | "inline-code"
  | "money"
  | "percent"
  | "date"
  | "version"
  | "number";

export interface ProtectedFragment {
  type: ProtectedFragmentType;
  text: string;
}

/** A protected fragment from the original that the rewrite no longer contains. */
export type ProtectionViolation = ProtectedFragment;

const FRAGMENT_PATTERNS: { type: ProtectedFragmentType; re: RegExp }[] = [
  { type: "url", re: /https?:\/\/[^\s"'<>）)]+/gi },
  { type: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { type: "citation", re: /\[[0-9]{1,3}\]/g },
  { type: "inline-code", re: /`[^`\n]+`/g },
  { type: "money", re: /(?:[$¥￥]\s*\d+(?:[.,]\d+)*|\d+(?:[.,]\d+)*\s*(?:元|万元|亿元|美元|人民币|USD|RMB))/gi },
  { type: "percent", re: /\d+(?:[.,]\d+)?\s*%/g },
  { type: "date", re: /\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?/g },
  { type: "date", re: /\d{1,2}月\d{1,2}日/g },
  { type: "version", re: /\bv?\d+\.\d+(?:\.\d+)?\b/gi },
  { type: "number", re: /\b\d{2,}(?:[.,]\d+)*\b/g },
];

export function extractProtectedFragments(text: string): ProtectedFragment[] {
  const seen = new Set<string>();
  const fragments: ProtectedFragment[] = [];
  for (const { type, re } of FRAGMENT_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const value = match[0].trim();
      const key = `${type}:${value}`;
      if (!value || seen.has(key)) continue;
      seen.add(key);
      fragments.push({ type, text: value });
    }
  }
  return fragments;
}

export function findProtectionViolations(original: string, rewritten: string): ProtectionViolation[] {
  const normalized = rewritten.normalize("NFKC");
  return extractProtectedFragments(original).filter((fragment) => !normalized.includes(fragment.text.normalize("NFKC")));
}

export function preservesProtectedFragments(original: string, rewritten: string): boolean {
  return findProtectionViolations(original, rewritten).length === 0;
}
