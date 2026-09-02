import assert from "node:assert/strict";
import { test } from "node:test";
import { createImapMailSource } from "../imap";

const rawMessage = [
  "From: 招聘团队 <jobs@example.com>",
  "To: candidate@example.com",
  "Subject: =?UTF-8?B?5LiA6Z2i6YKA6K+3?=",
  "Message-ID: <imap-message@example.com>",
  "Date: Fri, 21 Aug 2026 09:00:00 +0800",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "请参加面试",
].join("\r\n");

test("IMAP source opens the configured folder read-only and parses messages", async () => {
  let lockOptions: unknown;
  let searchQuery: unknown;
  let released = false;
  let loggedOut = false;
  const fakeClient = {
    mailbox: { uidValidity: 9123n },
    connect: async () => undefined,
    getMailboxLock: async (_folder: string, options: unknown) => {
      lockOptions = options;
      return { release: () => { released = true; } };
    },
    search: async (query: unknown) => {
      searchQuery = query;
      return [501];
    },
    async *fetch() {
      yield { uid: 501, source: Buffer.from(rawMessage) };
    },
    logout: async () => { loggedOut = true; },
  };
  const source = createImapMailSource({
    getSettings: () => ({
      host: "imap.example.com",
      port: 993,
      secure: true,
      username: "candidate@example.com",
      password: "secret",
      folder: "INBOX",
    }),
    clientFactory: () => fakeClient,
  });

  const messages = [];
  for await (const message of source.fetchMessages({ mode: "backfill", from: "2026-08-01" })) messages.push(message);

  assert.deepEqual(lockOptions, { readOnly: true });
  assert.deepEqual(searchQuery, { since: "2026-08-01" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.uid, 501);
  assert.equal(messages[0]?.uidValidity, "9123");
  assert.equal(messages[0]?.messageId, "<imap-message@example.com>");
  assert.equal(messages[0]?.subject, "一面邀请");
  assert.equal(messages[0]?.fromAddress, "jobs@example.com");
  assert.match(messages[0]?.textBody ?? "", /请参加面试/);
  assert.equal(released, true);
  assert.equal(loggedOut, true);
});

test("IMAP HTML-only path uses the project converter instead of mailparser link expansion", async () => {
  const htmlMessage = [
    "From: jobs@example.com",
    "To: candidate@example.com",
    "Subject: HTML interview",
    "Message-ID: <html-imap@example.com>",
    "Date: Fri, 21 Aug 2026 09:00:00 +0800",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<html><body><p>岗位：后端工程师</p><a href="https://tracking.invalid/click">进入面试</a><img src="https://tracking.invalid/pixel" /></body></html>',
  ].join("\r\n");
  const fakeClient = {
    mailbox: { uidValidity: 9124n },
    connect: async () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    search: async () => [502],
    async *fetch() { yield { uid: 502, source: Buffer.from(htmlMessage) }; },
    logout: async () => undefined,
  };
  const source = createImapMailSource({
    getSettings: () => ({
      host: "imap.example.com",
      port: 993,
      secure: true,
      username: "candidate@example.com",
      password: "secret",
      folder: "INBOX",
    }),
    clientFactory: () => fakeClient,
  });

  const messages = [];
  for await (const message of source.fetchMessages({ mode: "backfill", from: "2026-08-01" })) messages.push(message);

  assert.match(messages[0]?.textBody ?? "", /岗位：后端工程师/);
  assert.match(messages[0]?.textBody ?? "", /进入面试/);
  assert.doesNotMatch(messages[0]?.textBody ?? "", /tracking\.invalid/);
});
