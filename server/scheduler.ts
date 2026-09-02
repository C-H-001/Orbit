interface SchedulerSettings {
  imap: { host: string; username: string; password: string };
  llm: { baseUrl: string; model: string; apiKey: string };
  syncIntervalMinutes: number;
}

interface LatestRun {
  status: string;
  finishedAt?: string;
}

export function createScheduler(options: {
  getSettings: () => SchedulerSettings;
  getLatestSyncRun: () => LatestRun | undefined;
  startSync: () => unknown;
  now?: () => Date;
}) {
  let timer: NodeJS.Timeout | undefined;
  const now = options.now ?? (() => new Date());

  function tick() {
    const settings = options.getSettings();
    const configured = Boolean(
      settings.imap.host && settings.imap.username && settings.imap.password
      && settings.llm.baseUrl && settings.llm.model && settings.llm.apiKey,
    );
    if (!configured) return;

    const latest = options.getLatestSyncRun();
    if (latest?.status === "running" || latest?.status === "queued") return;
    if (latest?.finishedAt) {
      const elapsed = now().getTime() - new Date(latest.finishedAt).getTime();
      if (elapsed < settings.syncIntervalMinutes * 60_000) return;
    }

    try {
      options.startSync();
    } catch {
      // A manual sync may have acquired the in-process lock between checks.
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, 60_000);
    timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  }

  return { start, stop, tick };
}

export type OrbitScheduler = ReturnType<typeof createScheduler>;
