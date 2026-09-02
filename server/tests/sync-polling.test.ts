import assert from "node:assert/strict";
import { test } from "node:test";
import { createSyncPoller } from "../../src/syncPolling";
import type { SyncRun } from "../../src/types";

const runningRun: SyncRun = {
  id: "run-1",
  mode: "incremental",
  status: "running",
  phase: "fetching",
  progress: 20,
  counts: { fetched: 0, newEmails: 0, newApplications: 0, updatedApplications: 0, ignored: 0, failed: 0 },
  createdAt: "2026-08-26T00:00:00.000Z",
};

test("sync poller schedules another attempt after a transient failure", async () => {
  const scheduled: Array<() => Promise<void>> = [];
  let attempts = 0;
  let errors = 0;
  let completed = 0;
  createSyncPoller({
    getRun: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary network failure");
      if (attempts === 2) return runningRun;
      return { ...runningRun, status: "succeeded", phase: "done", progress: 100 };
    },
    onRun: () => undefined,
    onError: () => { errors += 1; },
    onComplete: () => { completed += 1; },
    schedule: (callback) => { scheduled.push(callback); return callback; },
    cancelScheduled: () => undefined,
  });

  await scheduled.shift()!();
  assert.equal(errors, 1);
  assert.equal(scheduled.length, 1);

  await scheduled.shift()!();
  assert.equal(scheduled.length, 1);

  await scheduled.shift()!();
  assert.equal(completed, 1);
  assert.equal(scheduled.length, 0);
});
