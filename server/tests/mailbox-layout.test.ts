import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { Mailbox } from "../../src/pages/Mailbox";
import type { Email } from "../../src/types";

test("mailbox keeps a long subject inside a shrinkable column", () => {
  const subject = "A very long subject that must not push the status and time columns away";
  const email: Email = {
    id: "email-1",
    accountId: "primary",
    folder: "INBOX",
    uidValidity: "1",
    uid: 1,
    subject,
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    company: "星河科技",
    position: "后端工程师",
    intent: "面试邀请",
    status: "processed",
    receivedAt: "2026-08-21T00:00:00.000Z",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };

  const markup = renderToStaticMarkup(createElement(Mailbox, {
    emails: [email],
    syncing: false,
    onSelectEmail: async () => undefined,
    onDeleteEmails: async () => true,
    onSyncNow: async () => undefined,
    onBackfill: async () => undefined,
  }));

  assert.match(markup, /grid-template-columns:32px 250px 125px 175px 120px 100px 95px 104px/);
  assert.match(markup, new RegExp(`title="${subject}"`));
  assert.match(markup, /class="[^"]*min-w-0[^"]*truncate[^"]*"/);
  assert.match(markup, /隐藏已忽略/);
  assert.match(markup, /批量删除/);
  assert.match(markup, /type="date"/);
  assert.match(markup, /aria-label="选择补录起始日期"/);
  assert.doesNotMatch(markup, /补录历史邮件|开始补录/);
  assert.match(markup, /删除邮件/);
  assert.match(markup, /aria-label="调整邮件主题和公司列宽"/);
  assert.match(markup, /aria-label="调整时间和操作列宽"/);
  assert.match(markup, /role="separator"[^>]*class="[^"]*z-10[^"]*"/);
  assert.match(markup, /role="separator"[^>]*class="[^"]*w-4[^"]*group\/rh[^"]*"/);
  assert.match(markup, /class="w-px h-4 bg-gray-200[^"]*group-hover\/rh:bg-blue-400/);
  assert.match(markup, /class="[^"]*text-center[^"]*">意图<\/p>/);
  assert.match(markup, /class="[^"]*text-center[^"]*">状态<\/p>/);
  assert.match(markup, /class="min-w-0 text-center pr-2"/);
  assert.match(markup, /class="flex min-w-0 items-center justify-center gap-1\.5/);
  assert.match(markup, /上一页/);
  assert.match(markup, /1 \/ 1/);
  assert.match(markup, /下一页/);
});
