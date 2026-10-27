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

/**
 * Create a process-wide FIFO gate that runs at most `limit` tasks at once.
 * A queued caller takes its slot only when an earlier task releases one.
 */
export function createConcurrencyGate(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: (() => void)[] = [];

  const acquire = (): Promise<void> => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });
  };
  const release = (): void => {
    active = Math.max(0, active - 1);
    waiters.shift()?.();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}
