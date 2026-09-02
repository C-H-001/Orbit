import assert from "node:assert/strict";
import { test } from "node:test";
import { createScheduler } from "../scheduler";

test("scheduler starts a configured sync only after the interval has elapsed", () => {
  let starts = 0;
  let latestFinishedAt = "2026-08-26T09:30:00.000Z";
  const scheduler = createScheduler({
    getSettings: () => ({
      imap: { host: "imap.example.com", username: "candidate@example.com", password: "secret" },
      llm: { baseUrl: "https://llm.example.com/v1", model: "orbit-model", apiKey: "secret" },
      syncIntervalMinutes: 60,
    }),
    getLatestSyncRun: () => ({ status: "succeeded", finishedAt: latestFinishedAt }),
    startSync: () => { starts += 1; },
    now: () => new Date("2026-08-26T10:00:00.000Z"),
  });

  scheduler.tick();
  assert.equal(starts, 0);

  latestFinishedAt = "2026-08-26T08:00:00.000Z";
  scheduler.tick();
  assert.equal(starts, 1);
});

test("scheduler does not start when credentials are incomplete", () => {
  let starts = 0;
  const scheduler = createScheduler({
    getSettings: () => ({
      imap: { host: "", username: "", password: "" },
      llm: { baseUrl: "", model: "", apiKey: "" },
      syncIntervalMinutes: 60,
    }),
    getLatestSyncRun: () => undefined,
    startSync: () => { starts += 1; },
  });

  scheduler.tick();
  assert.equal(starts, 0);
});
