import assert from "node:assert/strict";
import { test } from "node:test";
import * as MailboxModule from "../../src/pages/Mailbox";
import type { Email, EmailStatus } from "../../src/types";

function email(index: number, status: EmailStatus = "processed"): Email {
  return {
    id: `email-${index}`,
    accountId: "primary",
    folder: "INBOX",
    uidValidity: "1",
    uid: index,
    subject: `邮件主题 ${index}`,
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    company: "星河科技",
    position: "后端工程师",
    intent: "其他",
    status,
    receivedAt: "2026-08-21T00:00:00.000Z",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

type MailboxPageSelector = (
  emails: Email[],
  options: { search: string; filter: "all" | EmailStatus; hideIgnored: boolean; page: number },
) => {
  items: Email[];
  filteredCount: number;
  page: number;
  totalPages: number;
  rangeStart: number;
  rangeEnd: number;
};

function selector() {
  const selectMailboxPage = (MailboxModule as unknown as { selectMailboxPage?: MailboxPageSelector }).selectMailboxPage;
  assert.equal(typeof selectMailboxPage, "function");
  return selectMailboxPage!;
}

function columnResizer() {
  const resizeMailboxColumns = (MailboxModule as unknown as {
    resizeMailboxColumns?: (widths: number[], boundaryIndex: number, delta: number) => number[];
  }).resizeMailboxColumns;
  assert.equal(typeof resizeMailboxColumns, "function");
  return resizeMailboxColumns!;
}

function deletionDescription() {
  const describeEmailDeletion = (MailboxModule as unknown as {
    describeEmailDeletion?: (count: number) => string;
  }).describeEmailDeletion;
  assert.equal(typeof describeEmailDeletion, "function");
  return describeEmailDeletion!;
}

function backfillCommitGuard() {
  const shouldCommitBackfillDate = (MailboxModule as unknown as {
    shouldCommitBackfillDate?: (value: string, pickerOpen: boolean) => boolean;
  }).shouldCommitBackfillDate;
  assert.equal(typeof shouldCommitBackfillDate, "function");
  return shouldCommitBackfillDate!;
}

test("mailbox pagination returns at most twenty emails per page", () => {
  const emails = Array.from({ length: 45 }, (_, index) => email(index + 1));

  const firstPage = selector()(emails, { search: "", filter: "all", hideIgnored: false, page: 1 });
  const thirdPage = selector()(emails, { search: "", filter: "all", hideIgnored: false, page: 3 });

  assert.deepEqual(firstPage.items.map((item) => item.id), Array.from({ length: 20 }, (_, index) => `email-${index + 1}`));
  assert.deepEqual(
    { count: firstPage.filteredCount, page: firstPage.page, pages: firstPage.totalPages, start: firstPage.rangeStart, end: firstPage.rangeEnd },
    { count: 45, page: 1, pages: 3, start: 1, end: 20 },
  );
  assert.deepEqual(thirdPage.items.map((item) => item.id), ["email-41", "email-42", "email-43", "email-44", "email-45"]);
  assert.deepEqual({ page: thirdPage.page, start: thirdPage.rangeStart, end: thirdPage.rangeEnd }, { page: 3, start: 41, end: 45 });
});

test("ignored emails are hidden before mailbox pages are calculated", () => {
  const emails = [
    ...Array.from({ length: 15 }, (_, index) => email(index + 1)),
    ...Array.from({ length: 10 }, (_, index) => email(index + 16, "ignored")),
  ];

  const visible = selector()(emails, { search: "", filter: "all", hideIgnored: true, page: 2 });

  assert.equal(visible.filteredCount, 15);
  assert.equal(visible.totalPages, 1);
  assert.equal(visible.page, 1);
  assert.equal(visible.items.length, 15);
  assert.equal(visible.items.some((item) => item.status === "ignored"), false);
});

test("mailbox column resizing preserves total width and enforces adjacent minimums", () => {
  const widths = [230, 110, 160, 110, 90, 80];

  assert.deepEqual(columnResizer()(widths, 0, 50), [250, 90, 160, 110, 90, 80]);
  assert.deepEqual(columnResizer()(widths, 1, -100), [230, 90, 180, 110, 90, 80]);
  assert.equal(columnResizer()(widths, 3, 15).reduce((sum, width) => sum + width, 0), 780);
});

test("mailbox time column can resize against the fixed actions column", () => {
  const widths = [230, 110, 160, 110, 90, 80];

  assert.deepEqual(columnResizer()(widths, 5, 30), [230, 110, 160, 110, 90, 110]);
  assert.deepEqual(columnResizer()(widths, 5, -100), [230, 110, 160, 110, 90, 65]);
});

test("mailbox deletion confirmation only states the selected email count", () => {
  assert.equal(deletionDescription()(1), "将永久删除1封已选择邮件的本地邮件");
  assert.equal(deletionDescription()(12), "将永久删除12封已选择邮件的本地邮件");
});

test("backfill waits for a complete date and a closed calendar", () => {
  assert.equal(backfillCommitGuard()("2026-07-26", true), false);
  assert.equal(backfillCommitGuard()("", false), false);
  assert.equal(backfillCommitGuard()("2026-07-26", false), true);
});
