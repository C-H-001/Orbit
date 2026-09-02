import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { EmailAnalysis } from "../domain";
import { createRepository } from "../repository";
import { createSyncService } from "../sync";
import { SyncAlreadyRunningError } from "../sync";

const cleanupDirectories: string[] = [];

function temporaryDatabasePath() {
  const directory = mkdtempSync(path.join(tmpdir(), "orbit-sync-"));
  cleanupDirectories.push(directory);
  return path.join(directory, "orbit.sqlite");
}

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const relevantAnalysis: EmailAnalysis = {
  relevant: true,
  company: "星河科技",
  position: "后端工程师",
  intent: "面试邀请",
  status: "ongoing",
  currentProgress: "面试中",
  nextAction: "准备一面",
  appliedDate: "2026-08-20",
  interviewTime: "2026-08-29T14:00:00.000Z",
  eventDate: "2026-08-21",
  detail: "技术面试邀请",
};

const messages = [
  {
    accountId: "primary",
    folder: "INBOX",
    uid: 101,
    messageId: "<job@example.com>",
    subject: "一面邀请",
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    receivedAt: "2026-08-21T09:00:00.000Z",
    textBody: "请参加一面",
    htmlBody: "",
    rawHeaders: "Message-ID: <job@example.com>",
    rawSource: "raw job message",
  },
  {
    accountId: "primary",
    folder: "INBOX",
    uid: 102,
    messageId: "<newsletter@example.com>",
    subject: "新闻简报",
    fromAddress: "news@example.com",
    toAddress: "candidate@example.com",
    receivedAt: "2026-08-21T10:00:00.000Z",
    textBody: "本周新闻",
    htmlBody: "",
    rawHeaders: "Message-ID: <newsletter@example.com>",
    rawSource: "raw newsletter",
  },
];

test("sync stores, classifies and applies each new message only once", async () => {
  const repository = createRepository(temporaryDatabasePath());
  let classifications = 0;
  const service = createSyncService({
    repository,
    mailSource: { fetchMessages: async () => messages },
    classifier: {
      classifyEmail: async ({ subject }) => {
        classifications += 1;
        return {
          analysis: subject === "一面邀请"
            ? relevantAnalysis
            : { ...relevantAnalysis, relevant: false, company: "", position: "", intent: "其他" },
          usage: { inputTokens: 100, outputTokens: 20 },
          model: "orbit-model",
        };
      },
    },
  });

  const first = await service.runNow({ mode: "incremental" });
  const second = await service.runNow({ mode: "incremental" });

  assert.equal(first.status, "succeeded");
  assert.deepEqual(first.counts, {
    fetched: 2,
    newEmails: 2,
    newApplications: 1,
    updatedApplications: 0,
    ignored: 1,
    failed: 0,
  });
  assert.equal(second.counts.newEmails, 0);
  assert.equal(classifications, 2);
  assert.equal(repository.listApplications().length, 1);
  assert.equal(repository.listEmails().length, 2);
  assert.equal(repository.getUsageSummary(7).totalCalls, 2);
  repository.close();
});

test("a classifier failure marks the email failed without creating an application", async () => {
  const repository = createRepository(temporaryDatabasePath());
  const service = createSyncService({
    repository,
    mailSource: { fetchMessages: async () => [messages[0]!] },
    classifier: { classifyEmail: async () => { throw new Error("invalid JSON"); } },
  });

  const run = await service.runNow({ mode: "incremental" });

  assert.equal(run.status, "succeeded");
  assert.equal(run.counts.failed, 1);
  assert.equal(repository.listApplications().length, 0);
  assert.equal(repository.listEmails()[0]?.status, "failed");
  assert.match(repository.listEmails()[0]?.errorMessage ?? "", /invalid JSON/);
  repository.close();
});

test("a mailbox failure marks the entire sync run failed", async () => {
  const repository = createRepository(temporaryDatabasePath());
  const service = createSyncService({
    repository,
    mailSource: { fetchMessages: async () => { throw new Error("IMAP unavailable"); } },
    classifier: { classifyEmail: async () => { throw new Error("must not run"); } },
  });

  const run = await service.runNow({ mode: "backfill", from: "2026-08-01" });

  assert.equal(run.status, "failed");
  assert.match(run.errorMessage ?? "", /IMAP unavailable/);
  assert.equal(repository.getSyncRun(run.id)?.status, "failed");
  repository.close();
});

test("a failed stored email is retried on the next sync without creating a duplicate", async () => {
  const repository = createRepository(temporaryDatabasePath());
  let attempts = 0;
  const service = createSyncService({
    repository,
    mailSource: { fetchMessages: async () => [messages[0]!] },
    classifier: {
      classifyEmail: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary outage");
        return { analysis: relevantAnalysis, usage: { inputTokens: 10, outputTokens: 5 }, model: "orbit-model" };
      },
    },
  });

  const first = await service.runNow({ mode: "incremental" });
  const second = await service.runNow({ mode: "incremental" });

  assert.equal(first.counts.failed, 1);
  assert.equal(second.counts.newEmails, 0);
  assert.equal(second.counts.newApplications, 1);
  assert.equal(attempts, 2);
  assert.equal(repository.listEmails().length, 1);
  assert.equal(repository.listEmails()[0]?.status, "processed");
  repository.close();
});

test("sync processes streamed IMAP messages before the full backfill is fetched", async () => {
  const repository = createRepository(temporaryDatabasePath());
  async function* streamedMessages() {
    yield messages[0]!;
    await Promise.resolve();
    assert.equal(repository.listEmails().length, 1);
    yield messages[1]!;
  }
  const service = createSyncService({
    repository,
    mailSource: { fetchMessages: () => streamedMessages() } as never,
    classifier: {
      classifyEmail: async ({ subject }) => ({
        analysis: subject === "一面邀请" ? relevantAnalysis : { ...relevantAnalysis, relevant: false },
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "orbit-model",
      }),
    },
  });

  const run = await service.runNow({ mode: "backfill", from: "2026-08-01" });

  assert.equal(run.counts.fetched, 2);
  assert.equal(repository.listEmails().length, 2);
  repository.close();
});

test("sync refuses to run while HTML reprocessing holds the mail-processing lock", async () => {
  const repository = createRepository(temporaryDatabasePath());
  repository.acquireOperationLock("mail-processing", "reprocessor");
  const service = createSyncService({
    repository,
    mailSource: { fetchMessages: async () => [] },
    classifier: { classifyEmail: async () => { throw new Error("must not run"); } },
  });

  await assert.rejects(
    service.runNow({ mode: "incremental" }),
    (error: unknown) => error instanceof SyncAlreadyRunningError,
  );
  repository.releaseOperationLock("mail-processing", "reprocessor");
  repository.close();
});

test("repository apply failure records one failed LLM call instead of success plus failure", async () => {
  const repository = createRepository(temporaryDatabasePath());
  const throwingRepository = new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "applyEmailAnalysis") return () => { throw new Error("database apply failed"); };
      return Reflect.get(target, property, receiver);
    },
  });
  const service = createSyncService({
    repository: throwingRepository,
    mailSource: { fetchMessages: async () => [messages[0]!] },
    classifier: {
      classifyEmail: async () => ({
        analysis: relevantAnalysis,
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "orbit-model",
      }),
    },
  });

  const run = await service.runNow({ mode: "incremental" });
  const usage = repository.getUsageSummary(7);

  assert.equal(run.counts.failed, 1);
  assert.equal(usage.totalCalls, 1);
  assert.equal(usage.recentCalls[0]?.status, "failure");
  repository.close();
});

test("sync does not apply classifier output after losing the operation lease", async () => {
  const repository = createRepository(temporaryDatabasePath());
  let renewals = 0;
  let applied = false;
  const leaseLosingRepository = new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "renewOperationLock") return () => { renewals += 1; return renewals === 1; };
      if (property === "applyEmailAnalysis") return () => { applied = true; throw new Error("must not apply"); };
      return Reflect.get(target, property, receiver);
    },
  });
  const service = createSyncService({
    repository: leaseLosingRepository,
    mailSource: { fetchMessages: async () => [messages[0]!] },
    classifier: {
      classifyEmail: async () => ({
        analysis: relevantAnalysis,
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "orbit-model",
      }),
    },
  });

  const run = await service.runNow({ mode: "incremental" });

  assert.equal(run.status, "failed");
  assert.equal(applied, false);
  assert.equal(repository.getUsageSummary(7).totalCalls, 0);
  assert.equal(repository.listEmails()[0]?.status, "pending");
  repository.close();
});
