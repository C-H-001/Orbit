import type { SyncRun } from "./types";

type ScheduledHandle = unknown;

export function createSyncPoller(options: {
  getRun: () => Promise<SyncRun>;
  onRun: (run: SyncRun) => void;
  onComplete: (run: SyncRun) => void;
  onError: (error: unknown) => void;
  schedule?: (callback: () => Promise<void>, delayMs: number) => ScheduledHandle;
  cancelScheduled?: (handle: ScheduledHandle) => void;
}) {
  const schedule = options.schedule ?? ((callback, delayMs) => window.setTimeout(() => { void callback(); }, delayMs));
  const cancelScheduled = options.cancelScheduled ?? ((handle) => window.clearTimeout(handle as number));
  let stopped = false;
  let failureCount = 0;
  let handle: ScheduledHandle;

  function scheduleNext(delayMs: number) {
    if (stopped) return;
    handle = schedule(poll, delayMs);
  }

  async function poll() {
    if (stopped) return;
    try {
      const run = await options.getRun();
      failureCount = 0;
      options.onRun(run);
      if (run.status === "succeeded" || run.status === "failed") {
        options.onComplete(run);
        return;
      }
      scheduleNext(600);
    } catch (error) {
      failureCount += 1;
      options.onError(error);
      scheduleNext(Math.min(5_000, 600 * 2 ** failureCount));
    }
  }

  scheduleNext(0);
  return () => {
    stopped = true;
    if (handle !== undefined) cancelScheduled(handle);
  };
}
