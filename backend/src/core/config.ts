import "dotenv/config";

const baseURL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com";
const provider = (process.env.LLM_PROVIDER ?? "openai").trim().toLowerCase();
if (provider !== "openai" && provider !== "codex") {
  throw new Error("Unsupported LLM_PROVIDER; expected openai or codex.");
}

/** Safe local-development network defaults. */
export const DEFAULT_BIND_HOST = "127.0.0.1";
export const DEFAULT_CORS_ORIGINS = ["http://localhost:51773", "http://127.0.0.1:51773"] as const;

export function configuredCorsOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [...DEFAULT_CORS_ORIGINS];

  const origins = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => {
      if (!value || value === "*") return false;
      try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
      } catch {
        return false;
      }
    });
  return origins.length ? [...new Set(origins)] : [...DEFAULT_CORS_ORIGINS];
}

/**
 * Runtime configuration, resolved once from environment variables.
 *
 * `LLM_API_KEY` takes precedence over `DEEPSEEK_API_KEY`. The `thinkingType`
 * and `reasoningEffort` fields are cloud-only extras; set them to "off" for
 * local OpenAI-compatible servers (see {@link ../services/llm.ts}).
 * `provider` selects `LLM_PROVIDER` (default "openai"); "codex" uses the local
 * CLI login without an API key. `codex` reads `CODEX_MODEL` ("gpt-6.1-sol"),
 * `CODEX_REASONING_EFFORT` ("medium"), `CODEX_CONCURRENCY` (2), `CODEX_BIN`
 * (optional executable or JS entry), `CODEX_TIMEOUT_MS` (600000), and
 * `CODEX_MIN_TIMEOUT_MS` (180000, including queue wait).
 */
export const config = {
  llm: {
    provider,
    baseURL,
    apiKey: process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "deepseek-v4-pro",
    temperature: Number(process.env.LLM_TEMPERATURE ?? "0.7"),
    thinkingType: process.env.LLM_THINKING_TYPE ?? "enabled",
    reasoningEffort: process.env.LLM_REASONING_EFFORT ?? "high",
    codex: {
      model: process.env.CODEX_MODEL ?? "gpt-6.1-sol",
      reasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "medium",
      concurrency: Number(process.env.CODEX_CONCURRENCY ?? "2"),
      bin: process.env.CODEX_BIN,
      timeoutMs: Number(process.env.CODEX_TIMEOUT_MS ?? "600000"),
      minTimeoutMs: Number(process.env.CODEX_MIN_TIMEOUT_MS ?? "180000"),
    },
  },
  port: Number(process.env.PORT ?? "8787"),
  host: process.env.HOST?.trim() || DEFAULT_BIND_HOST,
  corsOrigins: configuredCorsOrigins(process.env.CORS_ORIGINS),
};
