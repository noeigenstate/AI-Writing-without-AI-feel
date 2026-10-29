export { createConcurrencyGate } from "../../lib/concurrency.js";

const lastRunAt = new Map<string, number>();
const providerQueues = new Map<string, Promise<void>>();

/** Resolve after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize calls per provider so they are spaced at least `minSpacingMs` apart.
 *
 * Returns a promise that resolves when it is this caller's turn; chaining keeps
 * concurrent callers in a single ordered queue per provider.
 *
 * @param provider Provider key (e.g. "arxiv").
 * @param minSpacingMs Minimum spacing between consecutive calls.
 * @returns A promise that resolves when the caller may proceed.
 */
export function waitForProvider(provider: string, minSpacingMs: number): Promise<void> {
  const previous = providerQueues.get(provider) ?? Promise.resolve();

  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const now = Date.now();
      const lastRun = lastRunAt.get(provider) ?? 0;
      const waitMs = Math.max(0, lastRun + minSpacingMs - now);

      if (waitMs > 0) {
        await sleep(waitMs);
      }

      lastRunAt.set(provider, Date.now());
    });

  providerQueues.set(provider, next);
  return next;
}
