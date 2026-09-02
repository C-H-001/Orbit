import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHtmlEmailReprocessor } from "../reprocess";
import { createRepository } from "../repository";

test("HTML email reprocessor backfills readable text and repairs the placeholder application", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "orbit-reprocess-"));
  try {
    const repository = createRepository(path.join(directory, "orbit.sqlite"));
    const { email } = repository.saveEmail({
      accountId: "primary",
      folder: "INBOX",
      uidValidity: "1",
      uid: 901,
      messageId: "<reprocess@example.com>",
      subject: "面试邀请",
      fromAddress: "jobs@example.com",
      toAddress: "candidate@example.com",
      receivedAt: "2026-08-21T09:00:00.000Z",
      textBody: "",
      htmlBody: "<h1>星河科技</h1><p>岗位：后端工程师</p>",
      rawHeaders: "Content-Type: text/html",
      rawSource: Buffer.from("raw html mail"),
    });
    repository.applyEmailAnalysis(email.id, {
      relevant: true,
      company: "星河科技",
      position: "",
      intent: "面试邀请",
      status: "ongoing",
      currentProgress: "面试中",
      nextAction: null,
      appliedDate: null,
      interviewTime: null,
      eventDate: "2026-08-21",
      detail: "",
    });

    const reprocessor = createHtmlEmailReprocessor({
      repository,
      classifier: {
        classifyEmail: async () => ({
          analysis: {
            relevant: true,
            company: "星河科技",
            position: "后端工程师",
            intent: "面试邀请",
            status: "ongoing",
            currentProgress: "面试中",
            nextAction: "准备面试",
            appliedDate: null,
            interviewTime: null,
            eventDate: "2026-08-21",
            detail: "岗位已识别",
          },
          usage: { inputTokens: 20, outputTokens: 10 },
          model: "orbit-model",
        }),
      },
    });

    const result = await reprocessor.run();

    assert.deepEqual(result, { candidates: 1, reprocessed: 1, ignored: 0, failed: 0 });
    assert.match(repository.getEmail(email.id)?.textBody ?? "", /岗位：后端工程师/);
    assert.equal(repository.listApplications().filter((item) => !item.deletedAt).length, 1);
    assert.equal(repository.listApplications().find((item) => !item.deletedAt)?.position, "后端工程师");
    repository.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reprocessor resumes a pending HTML email that already has converted text", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "orbit-reprocess-pending-"));
  let repository: ReturnType<typeof createRepository> | undefined;
  try {
    repository = createRepository(path.join(directory, "orbit.sqlite"));
    repository.saveEmail({
      accountId: "primary",
      folder: "INBOX",
      uidValidity: "1",
      uid: 902,
      messageId: "<pending@example.com>",
      subject: "普通通知",
      fromAddress: "notice@example.com",
      toAddress: "candidate@example.com",
      receivedAt: "2026-08-21T09:00:00.000Z",
      textBody: "已经转换出的正文",
      htmlBody: "<p>已经转换出的正文</p>",
      rawHeaders: "Content-Type: text/html",
      rawSource: Buffer.from("raw pending mail"),
    });
    const reprocessor = createHtmlEmailReprocessor({
      repository,
      classifier: {
        classifyEmail: async () => ({
          analysis: {
            relevant: false,
            company: "",
            position: "",
            intent: "其他",
            status: null,
            currentProgress: null,
            nextAction: null,
            appliedDate: null,
            interviewTime: null,
            eventDate: "2026-08-21",
            detail: "",
          },
          usage: { inputTokens: 5, outputTokens: 5 },
          model: "orbit-model",
        }),
      },
    });

    const result = await reprocessor.run();

    assert.deepEqual(result, { candidates: 1, reprocessed: 0, ignored: 1, failed: 0 });
    assert.equal(repository.listEmails()[0]?.status, "ignored");
  } finally {
    repository?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTML reprocessor refuses to run while sync holds the mail-processing lock", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "orbit-reprocess-lock-"));
  const repository = createRepository(path.join(directory, "orbit.sqlite"));
  try {
    repository.acquireOperationLock("mail-processing", "sync-run");
    const reprocessor = createHtmlEmailReprocessor({
      repository,
      classifier: { classifyEmail: async () => { throw new Error("must not run"); } },
    });
    await assert.rejects(reprocessor.run(), /already active/i);
  } finally {
    repository.releaseOperationLock("mail-processing", "sync-run");
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTML reprocessor aborts without per-email mutation after losing the operation lease", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "orbit-reprocess-lease-"));
  const repository = createRepository(path.join(directory, "orbit.sqlite"));
  try {
    const { email } = repository.saveEmail({
      accountId: "primary",
      folder: "INBOX",
      uidValidity: "1",
      uid: 906,
      messageId: "<lease-loss@example.com>",
      subject: "面试通知",
      fromAddress: "jobs@example.com",
      toAddress: "candidate@example.com",
      receivedAt: "2026-08-21T09:00:00.000Z",
      textBody: "",
      htmlBody: "<p>岗位：后端工程师</p>",
      rawHeaders: "Content-Type: text/html",
      rawSource: Buffer.from("raw lease-loss mail"),
    });
    let renewals = 0;
    let applied = false;
    const leaseLosingRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "renewOperationLock") return () => { renewals += 1; return renewals === 1; };
        if (property === "applyEmailAnalysis") return () => { applied = true; throw new Error("must not apply"); };
        return Reflect.get(target, property, receiver);
      },
    });
    const reprocessor = createHtmlEmailReprocessor({
      repository: leaseLosingRepository,
      classifier: {
        classifyEmail: async () => ({
          analysis: {
            relevant: true,
            company: "星河科技",
            position: "后端工程师",
            intent: "面试邀请",
            status: "ongoing",
            currentProgress: "面试中",
            nextAction: null,
            appliedDate: null,
            interviewTime: null,
            eventDate: "2026-08-21",
            detail: "",
          },
          usage: { inputTokens: 10, outputTokens: 5 },
          model: "orbit-model",
        }),
      },
    });

    await assert.rejects(reprocessor.run(), /lock was lost/i);
    assert.equal(applied, false);
    assert.equal(repository.getUsageSummary(7).totalCalls, 0);
    assert.equal(repository.getEmail(email.id)?.status, "pending");
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
