import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { EmailDrawer } from "../../src/components/EmailDrawer";
import type { EmailDetail } from "../../src/types";

test("email drawer renders original HTML in a sandbox and lists attachments", () => {
  const email = {
    id: "email-1",
    accountId: "primary",
    folder: "INBOX",
    uidValidity: "1",
    uid: 1,
    subject: "面试邀请",
    fromAddress: "jobs@example.com",
    toAddress: "candidate@example.com",
    company: "星河科技",
    position: "后端工程师",
    intent: "面试邀请",
    status: "processed",
    receivedAt: "2026-08-21T09:00:00.000Z",
    createdAt: "2026-08-21T09:00:00.000Z",
    updatedAt: "2026-08-21T09:00:00.000Z",
    textBody: "纯文本回退不应在有 HTML 时显示",
    htmlBody: "<p>旧 HTML</p>",
    rawHeaders: "Subject: 面试邀请",
    rawSourceBase64: "cmF3",
    renderedHtml: "<!doctype html><html><body><p>真实 HTML 正文</p></body></html>",
    attachments: [{
      filename: "offer.pdf",
      contentType: "application/pdf",
      contentBase64: "cGRm",
      size: 3,
      inline: false,
    }],
  } as EmailDetail;

  const markup = renderToStaticMarkup(createElement(EmailDrawer, {
    email,
    onClose: () => undefined,
    onSelectApp: () => undefined,
  }));

  assert.match(markup, /title="原邮件正文"/);
  assert.match(markup, /sandbox=""/);
  assert.match(markup, /srcDoc=/);
  assert.match(markup, /offer\.pdf/);
  assert.doesNotMatch(markup, /纯文本回退不应在有 HTML 时显示/);
});
