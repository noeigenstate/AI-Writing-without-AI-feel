import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { cached } from "./cache.js";
import { inferPublisherName, inferPublisherRegion } from "./rss.js";
import { normalizePublicSourceUrl } from "./networkSafety.js";
import { asString, isRecord, normalizeDate, tryParseJson } from "./parse.js";
import type { ResearchItem, ResearchSourceKind } from "./types.js";

const execFileAsync = promisify(execFile);
const SOURCE_ID = "agent-reach-exa";

export interface McporterInvocation {
  executable: string;
  args: readonly string[];
  options: ExecFileOptionsWithStringEncoding;
}

export interface McporterRuntime {
  executable: string;
  cliPath?: string;
}

interface AgentReachRawResult {
  title?: unknown;
  url?: unknown;
  text?: unknown;
  summary?: unknown;
  snippet?: unknown;
  publishedDate?: unknown;
  publishedAt?: unknown;
  author?: unknown;
  authors?: unknown;
}

/** Parse Exa/MCP output collected through Agent-Reach's selected search backend. */
export function parseAgentReachSearchOutput(
  output: string,
  query: string,
  sourceKind: Extract<ResearchSourceKind, "article" | "comment"> = "article"
): ResearchItem[] {
  const parsed = tryParseJson(output);
  const results = findResultArray(parsed);
  if (!results) return parseTextResults(agentReachTextPayload(parsed) || output, query, sourceKind);

  return results
    .map((result) => normalizeResult(result, query, sourceKind))
    .filter((item): item is ResearchItem => Boolean(item));
}

/** Collect web search results via Agent-Reach's Exa/mcporter backend when available. */
export function fetchAgentReachSearch(
  query: string,
  limit = 6,
  sourceKind: Extract<ResearchSourceKind, "article" | "comment"> = "article"
): Promise<ResearchItem[]> {
  const cleanQuery = cleanText(query, 240);
  if (!cleanQuery) {
    return Promise.resolve([]);
  }
  const safeLimit = clampResultLimit(limit);

  return cached(`agent-reach:${sourceKind}:${cleanQuery}:${safeLimit}`, 20 * 60 * 1000, async () => {
    const invocation = buildMcporterInvocation(cleanQuery, safeLimit);
    if (!invocation) {
      return [];
    }
    const { stdout } = await execFileAsync(
      invocation.executable,
      [...invocation.args],
      invocation.options
    );

    return parseAgentReachSearchOutput(stdout, cleanQuery, sourceKind).slice(0, safeLimit);
  });
}

/** Build a shell-free mcporter invocation, using its JS entry point on Windows. */
export function buildMcporterInvocation(
  query: string,
  limit = 6,
  platform: NodeJS.Platform = process.platform,
  runtime?: McporterRuntime
): McporterInvocation | undefined {
  const cleanQuery = cleanText(query, 240);
  if (!cleanQuery) {
    return undefined;
  }
  const safeLimit = clampResultLimit(limit);
  const expression = `exa.web_search_exa(query: ${JSON.stringify(cleanQuery)}, numResults: ${safeLimit})`;
  const resolvedRuntime = runtime ?? (platform === "win32" ? resolveWindowsMcporterRuntime() : { executable: "mcporter" });
  if (!resolvedRuntime) return undefined;
  return {
    executable: resolvedRuntime.executable,
    args: [
      ...(resolvedRuntime.cliPath ? [resolvedRuntime.cliPath] : []),
      "call",
      expression,
      "--output",
      "json",
    ],
    options: mcporterExecOptions(platform),
  };
}

function clampResultLimit(limit: number): number {
  return Math.max(1, Math.min(20, Math.trunc(Number.isFinite(limit) ? limit : 6)));
}

export function mcporterExecOptions(_platform: NodeJS.Platform = process.platform): ExecFileOptionsWithStringEncoding {
  return {
    encoding: "utf8",
    timeout: 18_000,
    maxBuffer: 1_000_000,
    windowsHide: true,
    shell: false,
  };
}

function normalizeResult(
  raw: unknown,
  query: string,
  sourceKind: Extract<ResearchSourceKind, "article" | "comment">
): ResearchItem | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const result = raw as AgentReachRawResult;
  const title = cleanText(asString(result.title), 180);
  const url = normalizePublicSourceUrl(asString(result.url));
  if (!title || !url) {
    return undefined;
  }

  const content = cleanText(asString(result.text), 8_000);
  const excerpt = cleanText(content, 600);
  const summary =
    cleanText(asString(result.summary), 700) ||
    cleanText(asString(result.snippet), 700) ||
    excerpt ||
    "";
  const publishedAt = normalizeDate(asString(result.publishedDate) || asString(result.publishedAt));
  const sourceName = inferPublisherName(url);

  return {
    id: `${SOURCE_ID}:${url.trim().toLowerCase()}`,
    sourceKind,
    sourceName,
    sourceId: SOURCE_ID,
    region: inferPublisherRegion(url, sourceName, "global"),
    title,
    summary,
    excerpt: excerpt || undefined,
    content: content || undefined,
    url,
    publishedAt,
    authors: normalizeAuthors(result.author ?? result.authors),
    query,
  };
}

function parseTextResults(
  value: string,
  query: string,
  sourceKind: Extract<ResearchSourceKind, "article" | "comment">
): ResearchItem[] {
  if (!value.trim()) return [];
  return value
    .split(/\r?\n---\r?\n/gu)
    .map((block) => {
      const title = metadataValue(block.match(/^Title:\s*(.+)$/imu)?.[1]);
      const url = block.match(/^URL:\s*(\S+)$/imu)?.[1]?.trim() ?? "";
      const publishedDate = metadataValue(block.match(/^Published:\s*(.+)$/imu)?.[1]);
      const author = metadataValue(block.match(/^Author:\s*(.+)$/imu)?.[1]);
      const highlightsAt = block.search(/^Highlights:\s*$/imu);
      const text = highlightsAt >= 0
        ? block.slice(highlightsAt).replace(/^Highlights:\s*/iu, "").trim()
        : "";
      return normalizeResult({ title, url, publishedDate, author, text }, query, sourceKind);
    })
    .filter((item): item is ResearchItem => Boolean(item));
}

function metadataValue(value: string | undefined): string {
  const clean = value?.trim() ?? "";
  return /^(?:n\/?a|null|none|unknown)$/iu.test(clean) ? "" : clean;
}

function agentReachTextPayload(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) return "";
  return value.content
    .filter(isRecord)
    .map((entry) => asString(entry.text))
    .filter(Boolean)
    .join("\n---\n");
}

function resolveWindowsMcporterRuntime(): McporterRuntime | undefined {
  const candidateDirectories = new Set<string>([
    dirname(process.execPath),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    ...(process.env.APPDATA ? [join(process.env.APPDATA, "npm")] : []),
  ]);
  for (const directory of candidateDirectories) {
    const cliPath = join(directory, "node_modules", "mcporter", "dist", "cli.js");
    if (existsSync(cliPath)) return { executable: process.execPath, cliPath };
  }
  return undefined;
}

function findResultArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["results", "data", "items"]) {
    const direct = value[key];
    if (Array.isArray(direct)) {
      return direct;
    }
  }

  const content = value.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (!isRecord(entry)) {
        continue;
      }
      const text = asString(entry.text);
      if (!text) {
        continue;
      }
      const nested = findResultArray(tryParseJson(text));
      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function cleanText(value: string, maxLength: number): string {
  const text = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeAuthors(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).map((author) => cleanText(author, 120)).filter(Boolean);
  }

  const author = cleanText(asString(value), 120);
  return author ? [author] : [];
}
