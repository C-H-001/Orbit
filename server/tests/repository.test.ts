import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import Database from "better-sqlite3";
import type { EmailAnalysis } from "../domain";
import { createRepository } from "../repository";

const cleanupDirectories: string[] = [];

function temporaryDatabasePath() {
  const directory = mkdtempSync(path.join(tmpdir(), "orbit-db-"));
  cleanupDirectories.push(directory);
  return path.join(directory, "orbit.sqlite");
}

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an application can be soft-deleted and restored without losing its timeline", () => {
  const repository = createRepository(temporaryDatabasePath());
  const application = repository.createApplication({
    company: "星河科技",
    position: "后端工程师",
    appliedDate: "2026-08-01",
  });

  repository.softDeleteApplication(application.id);
  const deleted = repository.getApplication(application.id);
  assert.ok(deleted?.deletedAt);
  assert.equal(deleted?.timeline.length, 1);

  repository.restoreApplication(application.id);
  const restored = repository.getApplication(application.id);
  assert.equal(restored?.deletedAt, undefined);
  assert.equal(restored?.timeline[0]?.stage, "已投递");
  assert.deepEqual(repository.listAuditEntries().map((entry) => entry.action), ["create", "delete", "restore"]);
  repository.close();
});

test("saving the same IMAP message twice returns one stored email", () => {
  const repository = createRepository(temporaryDatabasePath());
  const message = {
    accountId: "primary",
    folder: "INBOX",
    uid: 42,
    messageId: "<same-message@example.com>",
    subject: "面试安排",
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    receivedAt: "2026-08-20T09:00:00.000Z",
    textBody: "请参加面试",
    htmlBody: "<p>请参加面试</p>",
    rawHeaders: "Message-ID: <same-message@example.com>",
    rawSource: "raw message",
  };

  const first = repository.saveEmail(message);
  const second = repository.saveEmail(message);

  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(second.email.id, first.email.id);
  assert.equal(repository.listEmails().length, 1);
  repository.close();
});

test("reading a legacy stored intent returns the canonical mailbox intent", () => {
  const databasePath = temporaryDatabasePath();
  const repository = createRepository(databasePath);
  const { email } = repository.saveEmail({
    accountId: "primary",
    folder: "INBOX",
    uid: 420,
    messageId: "<legacy-intent@example.com>",
    subject: "请完成 AI Coding 测评",
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    receivedAt: "2026-08-20T09:00:00.000Z",
    textBody: "在线测评邀请",
    htmlBody: "",
    rawHeaders: "Message-ID: <legacy-intent@example.com>",
    rawSource: "raw message",
  });
  repository.close();

  const database = new Database(databasePath);
  database.prepare("UPDATE emails SET intent = ?, analysis_json = ? WHERE id = ?").run(
    "求职进展",
    JSON.stringify({ currentProgress: "AI Coding 测评" }),
    email.id,
  );
  database.close();

  const reopened = createRepository(databasePath);
  assert.equal(reopened.getEmail(email.id)?.intent, "AI Coding邀请");
  reopened.close();
});

test("applying a relevant email updates the application once and records provenance", () => {
  const repository = createRepository(temporaryDatabasePath());
  const application = repository.createApplication({
    company: "星河科技",
    position: "后端工程师",
    appliedDate: "2026-08-01",
  });
  const { email } = repository.saveEmail({
    accountId: "primary",
    folder: "INBOX",
    uid: 43,
    messageId: "<interview@example.com>",
    subject: "二面邀请",
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    receivedAt: "2026-08-21T09:00:00.000Z",
    textBody: "8月29日进行二面",
    htmlBody: "",
    rawHeaders: "Message-ID: <interview@example.com>",
    rawSource: "raw interview message",
  });

  repository.applyEmailAnalysis(email.id, {
    relevant: true,
    company: "星河科技",
    position: "后端工程师",
    intent: "面试邀请",
    status: "ongoing",
    currentProgress: "面试中",
    nextAction: "准备 8 月 29 日二面",
    appliedDate: "2026-08-01",
    interviewTime: "2026-08-29T14:00:00.000Z",
    eventDate: "2026-08-21",
    detail: "技术面试邀请",
  });
  repository.applyEmailAnalysis(email.id, {
    relevant: true,
    company: "星河科技",
    position: "后端工程师",
    intent: "面试邀请",
    status: "ongoing",
    currentProgress: "面试中",
    nextAction: "准备 8 月 29 日二面",
    appliedDate: "2026-08-01",
    interviewTime: "2026-08-29T14:00:00.000Z",
    eventDate: "2026-08-21",
    detail: "技术面试邀请",
  });

  const updated = repository.getApplication(application.id);
  assert.equal(updated?.currentProgress, "面试中");
  assert.equal(updated?.interviewTime, "2026-08-29T14:00:00.000Z");
  assert.equal(updated?.timeline.length, 2);
  assert.equal(updated?.timeline[1]?.sourceEmailId, email.id);
  assert.deepEqual(repository.listAuditEntries().map((entry) => entry.action), ["create", "update"]);
  assert.equal(repository.getEmail(email.id)?.applicationId, application.id);
  repository.close();
});

test("successive interview invitations advance the same application from first to third round", () => {
  const repository = createRepository(temporaryDatabasePath());
  const application = repository.createApplication({
    company: "星河科技",
    position: "后端工程师",
    appliedDate: "2026-08-01",
  });
  const expectedRounds = ["面试中", "面试中", "面试中"];

  for (let index = 0; index < expectedRounds.length; index += 1) {
    const { email } = repository.saveEmail({
      accountId: "primary",
      folder: "INBOX",
      uidValidity: "1",
      uid: 500 + index,
      messageId: `<interview-round-${index + 1}@example.com>`,
      subject: "面试邀请",
      fromAddress: "jobs@example.com",
      toAddress: "candidate@example.com",
      receivedAt: `2026-08-${21 + index}T09:00:00.000Z`,
      textBody: "邀请参加下一轮面试",
      htmlBody: "",
      rawHeaders: `Message-ID: <interview-round-${index + 1}@example.com>`,
      rawSource: `raw interview ${index + 1}`,
    });
    repository.applyEmailAnalysis(email.id, {
      relevant: true,
      company: application.company,
      position: application.position,
      intent: "面试邀请",
      status: "ongoing",
      currentProgress: "面试中",
      nextAction: "参加面试",
      appliedDate: application.appliedDate,
      interviewTime: `2026-08-${25 + index}T14:00:00.000Z`,
      eventDate: `2026-08-${21 + index}`,
      detail: "新一轮技术面试邀请",
    });

    assert.equal(repository.getApplication(application.id)?.currentProgress, expectedRounds[index]);
  }

  assert.deepEqual(
    repository.getApplication(application.id)?.timeline.filter((entry) => entry.source === "email").map((entry) => entry.stage),
    expectedRounds,
  );
  repository.close();
});

test("reprocessing the same interview email keeps its original round", () => {
  const repository = createRepository(temporaryDatabasePath());
  const application = repository.createApplication({ company: "星河科技", position: "后端工程师", appliedDate: "2026-08-01" });
  const { email } = repository.saveEmail({
    accountId: "primary",
    folder: "INBOX",
    uidValidity: "1",
    uid: 510,
    messageId: "<same-interview-round@example.com>",
    subject: "面试安排",
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    receivedAt: "2026-08-21T09:00:00.000Z",
    textBody: "邀请参加面试",
    htmlBody: "",
    rawHeaders: "Message-ID: <same-interview-round@example.com>",
    rawSource: "raw interview",
  });
  const analysis: EmailAnalysis = {
    relevant: true,
    company: application.company,
    position: application.position,
    intent: "面试邀请",
    status: "ongoing",
    currentProgress: "面试中",
    nextAction: "参加面试",
    appliedDate: application.appliedDate,
    interviewTime: "2026-08-25T14:00:00.000Z",
    eventDate: "2026-08-21",
    detail: "技术面试邀请",
  };

  repository.applyEmailAnalysis(email.id, analysis);
  repository.prepareEmailForReprocessing(email.id, "更新后的面试正文");
  repository.applyEmailAnalysis(email.id, analysis);

  assert.equal(repository.getApplication(application.id)?.currentProgress, "面试中");
  assert.deepEqual(
    repository.getApplication(application.id)?.timeline.filter((entry) => entry.sourceEmailId === email.id).map((entry) => entry.stage),
    ["面试中"],
  );
  repository.close();
});

test("interview result and feedback mail does not advance the interview round", () => {
  const repository = createRepository(temporaryDatabasePath());
  const application = repository.createApplication({
    company: "星河科技",
    position: "后端工程师",
    appliedDate: "2026-08-01",
    currentProgress: "面试中",
  });
  const { email } = repository.saveEmail({
    accountId: "primary",
    folder: "INBOX",
    uidValidity: "1",
    uid: 511,
    messageId: "<interview-feedback@example.com>",
    subject: "面试结果与反馈",
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    receivedAt: "2026-08-22T09:00:00.000Z",
    textBody: "本轮面试未通过，欢迎填写反馈问卷",
    htmlBody: "",
    rawHeaders: "Message-ID: <interview-feedback@example.com>",
    rawSource: "raw feedback",
  });

  repository.applyEmailAnalysis(email.id, {
    relevant: true,
    company: application.company,
    position: application.position,
    intent: "拒绝信",
    status: "rejected",
    currentProgress: "其它",
    nextAction: null,
    appliedDate: application.appliedDate,
    interviewTime: null,
    eventDate: "2026-08-22",
    detail: "面试结果和体验反馈问卷",
  });

  assert.equal(repository.getApplication(application.id)?.currentProgress, "其它");
  assert.equal(repository.getApplication(application.id)?.status, "rejected");
  assert.notEqual(repository.getApplication(application.id)?.timeline.at(-1)?.stage, "二面");
  repository.close();
});

test("a relevant unmatched email creates a new application", () => {
  const repository = createRepository(temporaryDatabasePath());
  const { email } = repository.saveEmail({
    accountId: "primary",
    folder: "INBOX",
    uid: 44,
    messageId: "<offer@example.com>",
    subject: "录用通知",
    fromAddress: "jobs@newco.example",
    toAddress: "candidate@example.com",
    receivedAt: "2026-08-22T09:00:00.000Z",
    textBody: "恭喜获得录用",
    htmlBody: "",
    rawHeaders: "Message-ID: <offer@example.com>",
    rawSource: "raw offer message",
  });

  const result = repository.applyEmailAnalysis(email.id, {
    relevant: true,
    company: "新公司",
    position: "平台工程师",
    intent: "录用通知",
    status: "offer",
    currentProgress: "其它",
    nextAction: "确认 Offer",
    appliedDate: "2026-08-22",
    interviewTime: null,
    eventDate: "2026-08-22",
    detail: "录用通知",
  });

  assert.equal(result.createdApplication, true);
  assert.equal(repository.listApplications().length, 1);
  assert.equal(repository.listApplications()[0]?.status, "offer");
  assert.equal(repository.listApplications()[0]?.timeline[0]?.sourceEmailId, email.id);
  repository.close();
});

test("unknown fields from an email do not erase stable application facts", () => {
  const repository = createRepository(temporaryDatabasePath());
  const application = repository.createApplication({
    company: "星河科技",
    position: "后端工程师",
    appliedDate: "2026-08-01",
    status: "ongoing",
    currentProgress: "面试中",
    nextAction: "准备系统设计",
    interviewTime: "2026-08-29T14:00:00.000Z",
  });
  const { email } = repository.saveEmail({
    accountId: "primary",
    folder: "INBOX",
    uid: 45,
    messageId: "<followup@example.com>",
    subject: "补充说明",
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    receivedAt: "2026-08-22T09:00:00.000Z",
    textBody: "请携带身份证件",
    htmlBody: "",
    rawHeaders: "Message-ID: <followup@example.com>",
    rawSource: "raw followup",
  });

  repository.applyEmailAnalysis(email.id, {
    relevant: true,
    company: "星河科技",
    position: "后端工程师",
    intent: "其他",
    status: null,
    currentProgress: null,
    nextAction: null,
    appliedDate: null,
    interviewTime: null,
    eventDate: "2026-08-22",
    detail: "携带身份证件",
  } as unknown as EmailAnalysis);

  const updated = repository.getApplication(application.id);
  assert.equal(updated?.status, "ongoing");
  assert.equal(updated?.currentProgress, "面试中");
  assert.equal(updated?.nextAction, "准备系统设计");
  assert.equal(updated?.appliedDate, "2026-08-01");
  assert.equal(updated?.interviewTime, "2026-08-29T14:00:00.000Z");
  assert.equal(updated?.timeline.at(-1)?.stage, "其它");
  repository.close();
});

test("startup recovery marks queued or running syncs as interrupted", () => {
  const databasePath = temporaryDatabasePath();
  const firstRepository = createRepository(databasePath);
  const queued = firstRepository.createSyncRun({ mode: "incremental" });
  const running = firstRepository.createSyncRun({ mode: "backfill", from: "2026-08-01" });
  firstRepository.updateSyncRun(running.id, { status: "running", phase: "fetching", progress: 20 });
  firstRepository.close();

  const recoveredRepository = createRepository(databasePath);
  const recoveredCount = recoveredRepository.recoverInterruptedSyncRuns();

  assert.equal(recoveredCount, 2);
  assert.equal(recoveredRepository.getSyncRun(queued.id)?.status, "failed");
  assert.equal(recoveredRepository.getSyncRun(running.id)?.status, "failed");
  assert.match(recoveredRepository.getSyncRun(running.id)?.errorMessage ?? "", /服务重启/);
  recoveredRepository.close();
});

test("IMAP UIDs are scoped by UIDVALIDITY and raw source remains byte-exact", () => {
  const repository = createRepository(temporaryDatabasePath());
  const rawBytes = Buffer.from([0xff, 0x00, 0x41, 0x42]);
  const baseMessage = {
    accountId: "primary",
    folder: "INBOX",
    uid: 7,
    messageId: undefined,
    subject: "无 Message-ID 邮件",
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    receivedAt: "2026-08-22T09:00:00.000Z",
    textBody: "正文",
    htmlBody: "",
    rawHeaders: "Subject: test",
    rawSource: rawBytes as unknown as string,
  };

  const first = repository.saveEmail({ ...baseMessage, uidValidity: "100" } as Parameters<typeof repository.saveEmail>[0]);
  const reusedUid = repository.saveEmail({ ...baseMessage, uidValidity: "200" } as Parameters<typeof repository.saveEmail>[0]);

  assert.equal(first.inserted, true);
  assert.equal(reusedUid.inserted, true);
  assert.equal(repository.listEmails().length, 2);
  assert.equal(repository.getEmail(first.email.id)?.uidValidity, "100");
  assert.deepEqual(repository.getEmail(first.email.id)?.rawSource, rawBytes);
  repository.close();
});

test("legacy email schema migrates without retaining the old UID-only uniqueness", () => {
  const databasePath = temporaryDatabasePath();
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      uid INTEGER NOT NULL,
      message_id TEXT,
      subject TEXT NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      position TEXT NOT NULL DEFAULT '',
      intent TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      received_at TEXT NOT NULL,
      application_id TEXT,
      text_body TEXT NOT NULL,
      html_body TEXT NOT NULL,
      raw_headers TEXT NOT NULL,
      raw_source TEXT NOT NULL,
      analysis_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(account_id, folder, uid)
    );
    INSERT INTO emails (
      id, account_id, folder, uid, subject, from_address, to_address,
      received_at, text_body, html_body, raw_headers, raw_source,
      created_at, updated_at
    ) VALUES (
      'legacy-email', 'primary', 'INBOX', 9, '旧邮件', 'jobs@example.com',
      'candidate@example.com', '2026-08-20T00:00:00.000Z', '正文', '',
      'Subject: 旧邮件', 'legacy raw', '2026-08-20T00:00:00.000Z',
      '2026-08-20T00:00:00.000Z'
    );
  `);
  legacy.close();

  const repository = createRepository(databasePath);
  assert.equal(repository.getEmail("legacy-email")?.uidValidity, "legacy");
  const reused = repository.saveEmail({
    accountId: "primary",
    folder: "INBOX",
    uidValidity: "new-validity",
    uid: 9,
    subject: "新邮件",
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    receivedAt: "2026-08-21T00:00:00.000Z",
    textBody: "新正文",
    htmlBody: "",
    rawHeaders: "Subject: 新邮件",
    rawSource: Buffer.from("new raw"),
  });
  assert.equal(reused.inserted, true);
  assert.equal(repository.listEmails().length, 2);
  repository.close();
});

test("application completion is persisted independently from recruitment status", () => {
  const databasePath = temporaryDatabasePath();
  const repository = createRepository(databasePath);
  const application = repository.createApplication({
    company: "星河科技",
    position: "后端工程师",
    appliedDate: "2026-08-01",
    status: "ongoing",
  });
  assert.equal((application as { completed?: boolean }).completed, false);

  const completed = repository.updateApplication(application.id, { completed: true } as never);
  assert.equal((completed as { completed?: boolean } | undefined)?.completed, true);
  assert.equal(completed?.status, "ongoing");
  repository.close();

  const reopened = createRepository(databasePath);
  assert.equal((reopened.getApplication(application.id) as { completed?: boolean } | undefined)?.completed, true);
  const reopenedApplication = reopened.getApplication(application.id)!;
  const pending = reopened.updateApplication(application.id, { completed: false } as never);
  assert.equal((pending as { completed?: boolean } | undefined)?.completed, false);
  assert.equal(pending?.status, reopenedApplication.status);
  reopened.close();
});

test("reprocessing an HTML-only email creates an application after the position is identified", () => {
  const repository = createRepository(temporaryDatabasePath());
  const { email } = repository.saveEmail({
    accountId: "primary",
    folder: "INBOX",
    uidValidity: "1",
    uid: 900,
    messageId: "<html-only@example.com>",
    subject: "面试邀请",
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    receivedAt: "2026-08-21T09:00:00.000Z",
    textBody: "",
    htmlBody: "<p>岗位：后端工程师</p>",
    rawHeaders: "Content-Type: text/html",
    rawSource: Buffer.from("raw html mail"),
  });
  const initial = repository.applyEmailAnalysis(email.id, {
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
    detail: "收到面试邀请",
  });
  assert.equal(initial.application, undefined);
  assert.equal(repository.getEmail(email.id)?.applicationId, undefined);

  repository.prepareEmailForReprocessing(email.id, "岗位：后端工程师");
  const repaired = repository.applyEmailAnalysis(email.id, {
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
    detail: "岗位已从 HTML 正文识别",
  });

  assert.equal(repaired.application?.position, "后端工程师");
  assert.equal(repository.getEmail(email.id)?.textBody, "岗位：后端工程师");
  assert.equal(repository.getEmail(email.id)?.applicationId, repaired.application?.id);
  assert.equal(repaired.application?.timeline.length, 1);
  assert.equal(repaired.application?.timeline[0]?.sourceEmailId, email.id);
  assert.equal(repository.listApplications().filter((item) => !item.deletedAt).length, 1);
  repository.close();
});

test("reprocessing never automatically moves an email between two real positions", () => {
  const repository = createRepository(temporaryDatabasePath());
  const { email } = repository.saveEmail({
    accountId: "primary",
    folder: "INBOX",
    uidValidity: "1",
    uid: 903,
    messageId: "<real-position@example.com>",
    subject: "面试通知",
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    receivedAt: "2026-08-21T09:00:00.000Z",
    textBody: "岗位甲",
    htmlBody: "<p>岗位甲</p>",
    rawHeaders: "Content-Type: text/html",
    rawSource: Buffer.from("raw real position mail"),
  });
  const original = repository.applyEmailAnalysis(email.id, {
    relevant: true,
    company: "星河科技",
    position: "岗位甲",
    intent: "面试邀请",
    status: "ongoing",
    currentProgress: "面试中",
    nextAction: "准备岗位甲面试",
    appliedDate: null,
    interviewTime: null,
    eventDate: "2026-08-21",
    detail: "岗位甲",
  }).application!;
  repository.prepareEmailForReprocessing(email.id, "岗位乙");

  assert.throws(() => repository.applyEmailAnalysis(email.id, {
    relevant: true,
    company: "星河科技",
    position: "岗位乙",
    intent: "面试邀请",
    status: "ongoing",
    currentProgress: "面试中",
    nextAction: "准备岗位乙面试",
    appliedDate: null,
    interviewTime: null,
    eventDate: "2026-08-21",
    detail: "岗位乙",
  }), /cannot automatically relink/i);

  assert.equal(repository.getEmail(email.id)?.applicationId, original.id);
  assert.equal(repository.getApplication(original.id)?.currentProgress, "面试中");
  assert.equal(repository.getApplication(original.id)?.timeline.length, 1);
  repository.close();
});

test("irrelevant reprocessing keeps an unlinked email out of applications", () => {
  const repository = createRepository(temporaryDatabasePath());
  const { email } = repository.saveEmail({
    accountId: "primary",
    folder: "INBOX",
    uidValidity: "1",
    uid: 904,
    messageId: "<irrelevant-reprocess@example.com>",
    subject: "招聘宣传",
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    receivedAt: "2026-08-21T09:00:00.000Z",
    textBody: "招聘宣传",
    htmlBody: "<p>招聘宣传</p>",
    rawHeaders: "Content-Type: text/html",
    rawSource: Buffer.from("raw irrelevant mail"),
  });
  repository.applyEmailAnalysis(email.id, {
    relevant: true,
    company: "星河科技",
    position: "",
    intent: "岗位推荐",
    status: "ongoing",
    currentProgress: "其它",
    nextAction: null,
    appliedDate: null,
    interviewTime: null,
    eventDate: "2026-08-21",
    detail: "",
  });
  repository.prepareEmailForReprocessing(email.id, "普通宣传邮件");
  repository.applyEmailAnalysis(email.id, {
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
  });

  assert.equal(repository.getEmail(email.id)?.status, "ignored");
  assert.equal(repository.getEmail(email.id)?.applicationId, undefined);
  assert.equal(repository.listApplications().length, 0);
  assert.equal(repository.listAuditEntries().length, 0);
  repository.close();
});

test("operation lock excludes concurrent mail processing and backup is readable", async () => {
  const databasePath = temporaryDatabasePath();
  const repository = createRepository(databasePath);
  repository.createApplication({ company: "星河科技", position: "后端工程师", appliedDate: "2026-08-01" });

  assert.equal(repository.acquireOperationLock("mail-processing", "owner-a"), true);
  assert.equal(repository.acquireOperationLock("mail-processing", "owner-b"), false);
  assert.equal(repository.renewOperationLock("mail-processing", "owner-a"), true);
  assert.equal(repository.renewOperationLock("mail-processing", "owner-b"), false);
  repository.releaseOperationLock("mail-processing", "owner-a");
  assert.equal(repository.acquireOperationLock("mail-processing", "owner-b"), true);
  repository.releaseOperationLock("mail-processing", "owner-b");

  const backupPath = path.join(path.dirname(databasePath), "backup.sqlite");
  await repository.createBackup(backupPath);
  const backup = new Database(backupPath, { readonly: true });
  assert.equal((backup.prepare("SELECT count(*) AS count FROM applications").get() as { count: number }).count, 1);
  backup.close();
  repository.close();
});

test("blank-position reprocessing cannot move an email between identified applications", () => {
  const repository = createRepository(temporaryDatabasePath());
  const target = repository.createApplication({ company: "新公司", position: "岗位乙", appliedDate: "2026-08-01" });
  const { email } = repository.saveEmail({
    accountId: "primary",
    folder: "INBOX",
    uidValidity: "1",
    uid: 905,
    messageId: "<blank-position-relink@example.com>",
    subject: "面试通知",
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    receivedAt: "2026-08-21T09:00:00.000Z",
    textBody: "旧公司岗位甲",
    htmlBody: "<p>旧公司岗位甲</p>",
    rawHeaders: "Content-Type: text/html",
    rawSource: Buffer.from("raw blank-position mail"),
  });
  const original = repository.applyEmailAnalysis(email.id, {
    relevant: true,
    company: "旧公司",
    position: "岗位甲",
    intent: "面试邀请",
    status: "ongoing",
    currentProgress: "面试中",
    nextAction: null,
    appliedDate: null,
    interviewTime: null,
    eventDate: "2026-08-21",
    detail: "",
  }).application!;
  repository.prepareEmailForReprocessing(email.id, "公司名称变化但岗位缺失");

  assert.throws(() => repository.applyEmailAnalysis(email.id, {
    relevant: true,
    company: "新公司",
    position: "",
    intent: "面试邀请",
    status: "ongoing",
    currentProgress: "面试中",
    nextAction: null,
    appliedDate: null,
    interviewTime: null,
    eventDate: "2026-08-21",
    detail: "",
  }), /cannot automatically relink/i);
  assert.equal(repository.getEmail(email.id)?.applicationId, original.id);
  assert.equal(repository.getApplication(original.id)?.currentProgress, "面试中");
  assert.equal(repository.getApplication(target.id)?.timeline.length, 1);
  repository.close();
});

test("LLM usage persists OCR token details and keeps legacy caller defaults", () => {
  const databasePath = temporaryDatabasePath();
  const repository = createRepository(databasePath);
  repository.recordLlmUsage({
    model: "qwen3.8-flash",
    prompt: "面经 OCR",
    inputTokens: 1200,
    imageTokens: 1000,
    outputTokens: 200,
    reasoningTokens: 15,
    durationMs: 4321,
    sourceId: "capture-1",
    status: "success",
  });
  repository.recordLlmUsage({
    model: "email-model",
    prompt: "邮件意图分类",
    inputTokens: 20,
    outputTokens: 5,
    status: "success",
  });

  const summary = repository.getUsageSummary(1);
  const ocrCall = summary.recentCalls.find((call) => call.prompt === "面经 OCR");
  assert.deepEqual(ocrCall && {
    imageTokens: ocrCall.imageTokens,
    reasoningTokens: ocrCall.reasoningTokens,
    durationMs: ocrCall.durationMs,
    sourceId: ocrCall.sourceId,
  }, { imageTokens: 1000, reasoningTokens: 15, durationMs: 4321, sourceId: "capture-1" });
  const legacyCall = summary.recentCalls.find((call) => call.prompt === "邮件意图分类");
  assert.deepEqual(legacyCall && {
    imageTokens: legacyCall.imageTokens,
    reasoningTokens: legacyCall.reasoningTokens,
    durationMs: legacyCall.durationMs,
    sourceId: legacyCall.sourceId,
  }, { imageTokens: 0, reasoningTokens: 0, durationMs: 0, sourceId: undefined });
  repository.close();

  const reopened = createRepository(databasePath);
  assert.equal(reopened.getUsageSummary(1).recentCalls.length, 2);
  reopened.close();
});
