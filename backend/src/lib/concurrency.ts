/** FIFO gate; cancellation removes a waiter without taking a running task's slot. */
export function createConcurrencyGate(limit: number) {
  let active = 0;
  const waiters: (() => void)[] = [];

  const acquire = (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const enter = () => {
        signal?.removeEventListener("abort", abort);
        active += 1;
        resolve();
      };
      const abort = () => {
        const index = waiters.indexOf(enter);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal!.reason);
      };
      waiters.push(enter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  };

  return async <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    await acquire(signal);
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      active = Math.max(0, active - 1);
      waiters.shift()?.();
    }
  };
}
