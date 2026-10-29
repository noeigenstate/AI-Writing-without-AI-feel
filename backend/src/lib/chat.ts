/** Options shared by text-model providers. */
export interface ChatOptions {
  system?: string;
  temperature?: number;
  /** Per-request budget; Codex includes queue time and applies its configured floor. */
  timeoutMs?: number;
  /** Cancel queued work or terminate an active request. */
  signal?: AbortSignal;
  /** Disable API reasoning, or request low reasoning effort from Codex. */
  disableThinking?: boolean;
}

/** Injectable text-model call used by services and offline tests. */
export type ChatFn = (prompt: string, opts?: ChatOptions) => Promise<string>;
