import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { PNG } from "pngjs";
import { createAgentService } from "../agent";
import { createApiApp, createOcrConnectionTester, startInterviewCaptureMaintenance } from "../api";
import { createConfigStore } from "../config";
import { createRepository } from "../repository";
import { SyncAlreadyRunningError } from "../sync";

const cleanupDirectories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "orbit-api-"));
  cleanupDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function withApi(
  run: (baseUrl: string, repository: ReturnType<typeof createRepository>) => Promise<void>,
  overrides?: { syncStart?: () => { id: string } },
) {
  const directory = temporaryDirectory();
  const repository = createRepository(path.join(directory, "orbit.sqlite"));
  const configStore = createConfigStore(path.join(directory, "config.json"));
  const agentService = createAgentService({
    repository,
    answerQuestion: async () => ({
      content: "当前有一条申请。",
      usage: { inputTokens: 20, outputTokens: 8 },
      model: "orbit-model",
    }),
  });
  const app = createApiApp({
    repository,
    configStore,
    agentService,
    syncService: {
      start: (input) => overrides?.syncStart?.() ?? repository.createSyncRun(input),
    },
    testImapConnection: async () => true,
    testLlmConnection: async () => true,
    testOcrConnection: async () => true,
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`, repository);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
}

async function jsonRequest(baseUrl: string, pathname: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  return { response, body };
}

test("application CRUD persists and bootstrap reflects soft-delete state", async () => {
  await withApi(async (baseUrl) => {
    const created = await jsonRequest(baseUrl, "/api/applications", {
      method: "POST",
      body: JSON.stringify({ company: "星河科技", position: "后端工程师", appliedDate: "2026-08-01" }),
    });
    assert.equal(created.response.status, 201);
    const id = created.body.application.id as string;

    const updated = await jsonRequest(baseUrl, `/api/applications/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ nextAction: "准备面试", interviewTime: "2026-08-29T14:00:00.000Z", completed: true }),
    });
    assert.equal(updated.body.application.nextAction, "准备面试");
    assert.equal(updated.body.application.completed, true);

    await jsonRequest(baseUrl, `/api/applications/${id}`, { method: "DELETE" });
    const deletedBootstrap = await jsonRequest(baseUrl, "/api/bootstrap");
    assert.ok(deletedBootstrap.body.applications[0].deletedAt);

    await jsonRequest(baseUrl, `/api/applications/${id}/restore`, { method: "POST" });
    const restoredBootstrap = await jsonRequest(baseUrl, "/api/bootstrap");
    assert.equal(restoredBootstrap.body.applications[0].deletedAt, undefined);
  });
});

test("bulk application deletion requires the explicit confirmation token", async () => {
  await withApi(async (baseUrl, repository) => {
    repository.createApplication({ company: "星河科技", position: "后端工程师", appliedDate: "2026-08-01" });

    const response = await fetch(`${baseUrl}/api/applications`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "wrong-token" }),
    });

    assert.equal(response.status, 400);
    assert.equal(repository.listApplications().length, 1);
  });
});

test("confirmed bulk deletion removes application storage and keeps original emails unlinked", async () => {
  await withApi(async (baseUrl, repository) => {
    const linkedApplication = repository.createApplication({
      company: "华为",
      position: "Agent基础设施工程",
      appliedDate: "2026-08-01",
    });
    const deletedApplication = repository.createApplication({
      company: "星河科技",
      position: "后端工程师",
      appliedDate: "2026-07-01",
    });
    repository.softDeleteApplication(deletedApplication.id);
    const { email } = repository.saveEmail({
      accountId: "primary",
      folder: "INBOX",
      uidValidity: "1",
      uid: 889,
      messageId: "<bulk-delete@example.com>",
      subject: "投递成功",
      fromAddress: "recruiting@huawei.com",
      toAddress: "candidate@example.com",
      receivedAt: "2026-08-21T09:00:00.000Z",
      textBody: "感谢投递 Agent基础设施工程",
      htmlBody: "",
      rawHeaders: "Message-ID: <bulk-delete@example.com>",
      rawSource: "raw source",
    });
    repository.applyEmailAnalysis(email.id, {
      relevant: true,
      company: linkedApplication.company,
      position: linkedApplication.position,
      intent: "投递确认",
      status: "ongoing",
      currentProgress: "已投递",
      nextAction: null,
      appliedDate: "2026-08-01",
      interviewTime: null,
      eventDate: "2026-08-21",
      detail: "投递成功",
    });
    const proposal = repository.createAgentProposal(
      linkedApplication.id,
      { currentProgress: "已投递" },
      { currentProgress: "笔试中" },
    );

    const response = await fetch(`${baseUrl}/api/applications`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE_ALL_APPLICATIONS" }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deletedApplications: 2 });
    assert.equal(repository.listApplications().length, 0);
    assert.equal(repository.listAuditEntries().length, 0);
    assert.equal(repository.getAgentProposal(proposal.id), undefined);
    assert.equal(repository.getEmail(email.id)?.applicationId, undefined);
    assert.equal(repository.getEmail(email.id)?.status, "processed");
  });
});

test("bulk application deletion is rejected while mail processing is active", async () => {
  await withApi(async (baseUrl, repository) => {
    repository.createApplication({ company: "星河科技", position: "后端工程师", appliedDate: "2026-08-01" });
    repository.acquireOperationLock("mail-processing", "sync-run");
    try {
      const response = await fetch(`${baseUrl}/api/applications`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "DELETE_ALL_APPLICATIONS" }),
      });

      assert.equal(response.status, 409);
      assert.equal(repository.listApplications().length, 1);
    } finally {
      repository.releaseOperationLock("mail-processing", "sync-run");
    }
  });
});

test("settings persist secrets while API responses stay redacted", async () => {
  await withApi(async (baseUrl) => {
    const saved = await jsonRequest(baseUrl, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        imap: { host: "imap.example.com", port: 993, secure: true, username: "candidate@example.com", password: "mail-secret", folder: "INBOX" },
        llm: { baseUrl: "https://llm.example.com/v1", model: "orbit-model", apiKey: "llm-secret" },
        ocr: { baseUrl: "https://ocr.example.com/v1", model: "ocr-model", apiKey: "ocr-secret" },
        syncIntervalMinutes: 30,
      }),
    });

    assert.equal(saved.body.settings.imap.hasPassword, true);
    assert.equal("password" in saved.body.settings.imap, false);
    assert.equal("apiKey" in saved.body.settings.llm, false);
    assert.equal("apiKey" in saved.body.settings.ocr, false);

    const preserved = await jsonRequest(baseUrl, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        imap: { host: "imap.example.com", port: 993, secure: true, username: "candidate@example.com", password: "", folder: "INBOX" },
        llm: { baseUrl: "https://llm.example.com/v1", model: "new-model", apiKey: "" },
        ocr: { baseUrl: "https://ocr.example.com/v1/", model: "ocr-model", apiKey: "" },
        syncIntervalMinutes: 60,
      }),
    });
    assert.equal(preserved.body.settings.imap.hasPassword, true);
    assert.equal(preserved.body.settings.llm.hasApiKey, true);
    assert.equal(preserved.body.settings.ocr.hasApiKey, true);
  });
});

test("settings preserve omitted OCR config but clear its key when URL or model changes", async () => {
  await withApi(async (baseUrl) => {
    await jsonRequest(baseUrl, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        imap: { host: "", port: 993, secure: true, username: "", password: "", folder: "INBOX" },
        llm: { baseUrl: "", model: "", apiKey: "" },
        ocr: { baseUrl: "https://ocr.example.com/v1", model: "ocr-model", apiKey: "ocr-secret" },
        syncIntervalMinutes: 60,
      }),
    });

    const omitted = await jsonRequest(baseUrl, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        imap: { host: "", port: 993, secure: true, username: "", password: "", folder: "INBOX" },
        llm: { baseUrl: "", model: "", apiKey: "" },
        syncIntervalMinutes: 60,
      }),
    });
    assert.equal(omitted.body.settings.ocr.baseUrl, "https://ocr.example.com/v1");
    assert.equal(omitted.body.settings.ocr.hasApiKey, true);

    const changedModel = await jsonRequest(baseUrl, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        imap: { host: "", port: 993, secure: true, username: "", password: "", folder: "INBOX" },
        llm: { baseUrl: "", model: "", apiKey: "" },
        ocr: { baseUrl: "https://ocr.example.com/v1/", model: "other-model", apiKey: "" },
        syncIntervalMinutes: 60,
      }),
    });
    assert.equal(changedModel.body.settings.ocr.hasApiKey, false);
  });
});

test("OCR settings connection route uses its dedicated visual test dependency", async () => {
  let ocrTests = 0;
  const directory = temporaryDirectory();
  const repository = createRepository(path.join(directory, "orbit.sqlite"));
  const configStore = createConfigStore(path.join(directory, "config.json"));
  const agentService = createAgentService({
    repository,
    answerQuestion: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 }, model: "test" }),
  });
  const app = createApiApp({
    repository,
    configStore,
    agentService,
    syncService: { start: (input) => repository.createSyncRun(input) },
    testImapConnection: async () => true,
    testLlmConnection: async () => { throw new Error("email LLM test must not run"); },
    testOcrConnection: async () => { ocrTests += 1; },
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const rejected = await fetch(`${baseUrl}/api/settings/test/ocr`, { method: "POST" });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error.code, "WEB_REQUEST_REQUIRED");
    assert.equal(ocrTests, 0);

    const response = await fetch(`${baseUrl}/api/settings/test/ocr`, {
      method: "POST",
      headers: { "X-Orbit-Web": "1" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { connected: true });
    assert.equal(ocrTests, 1);
    assert.notEqual(response.headers.get("access-control-allow-origin"), "*");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
});

test("malformed JSON on an interview endpoint returns INVALID_JSON", async () => {
  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/interview-experiences/missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: '{"company":',
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_JSON");
    assert.equal(body.error.retryable, false);
    assert.equal(typeof body.error.requestId, "string");
  });
});

test("JSON above one megabyte on an interview endpoint returns PAYLOAD_TOO_LARGE", async () => {
  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/interview-experiences/missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
    });
    const body = await response.json();

    assert.equal(response.status, 413);
    assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
    assert.equal(body.error.retryable, false);
    assert.equal(typeof body.error.requestId, "string");
  });
});

test("unsupported JSON content encoding returns UNSUPPORTED_ENCODING", async () => {
  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/interview-experiences/missing`, {
      method: "PATCH",
      headers: {
        "content-encoding": "compress",
        "content-type": "application/json",
      },
      body: "{}",
    });
    const body = await response.json();

    assert.equal(response.status, 415);
    assert.equal(body.error.code, "UNSUPPORTED_ENCODING");
    assert.equal(body.error.retryable, false);
    assert.equal(typeof body.error.requestId, "string");
  });
});

test("OCR connection tester requires the unrevealed digit rendered in a valid PNG", async () => {
  let requestUrl = "";
  let authorization = "";
  const requestBodies: Record<string, unknown>[] = [];
  const responses = ['{"connected":true}', '{"digit":"7"}'];
  const testConnection = createOcrConnectionTester({
    getSettings: () => ({ baseUrl: "https://ocr.example.com/v1/", model: "ocr-model", apiKey: "ocr-secret" }),
    selectChallengeDigit: () => "7",
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: responses.shift() } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await assert.rejects(testConnection(), /visual challenge|digit/i);
  assert.deepEqual(await testConnection(), { digit: "7" });

  assert.equal(requestUrl, "https://ocr.example.com/v1/chat/completions");
  assert.equal(authorization, "Bearer ocr-secret");
  const requestBody = requestBodies[1]!;
  assert.equal(requestBody.model, "ocr-model");
  assert.equal(requestBody.enable_thinking, false);
  const messages = requestBody.messages as Array<{ content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
  const content = messages[1]?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  const promptText = messages.flatMap((message) => typeof message.content === "string"
    ? [message.content]
    : message.content.filter((part) => part.type === "text").map((part) => part.text ?? "")).join("\n");
  assert.match(content[0]?.text ?? "", /single digit/i);
  assert.equal(promptText.includes("7"), false);
  const imageUrl = content[1]?.image_url?.url ?? "";
  assert.match(imageUrl, /^data:image\/png;base64,/);
  const image = PNG.sync.read(Buffer.from(imageUrl.split(",")[1]!, "base64"));
  assert.ok(image.width >= 3 && image.height >= 5);
  const pixelColors = new Set<string>();
  for (let offset = 0; offset < image.data.length; offset += 4) {
    pixelColors.add(image.data.subarray(offset, offset + 4).toString("hex"));
  }
  assert.ok(pixelColors.size > 1, "the challenge PNG must contain a visible glyph");
});

test("interview maintenance recovers and cleans at startup then cancels hourly cleanup", () => {
  let recoverCalls = 0;
  let cleanupCalls = 0;
  let scheduledMilliseconds = 0;
  let scheduledCallback: (() => void) | undefined;
  let clearedHandle: unknown;
  const handle = { name: "maintenance" };
  const stop = startInterviewCaptureMaintenance(
    {
      recover: () => { recoverCalls += 1; return 0; },
      cleanupExpired: () => { cleanupCalls += 1; return 0; },
    },
    (callback, milliseconds) => {
      scheduledCallback = callback;
      scheduledMilliseconds = milliseconds;
      return handle as unknown as NodeJS.Timeout;
    },
    (value) => { clearedHandle = value; },
  );

  assert.equal(recoverCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(scheduledMilliseconds, 60 * 60 * 1000);
  scheduledCallback?.();
  assert.equal(cleanupCalls, 2);
  stop();
  assert.equal(clearedHandle, handle);
});

test("changing a credential destination clears a secret that was not re-entered", async () => {
  await withApi(async (baseUrl) => {
    await jsonRequest(baseUrl, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        imap: { host: "imap.example.com", port: 993, secure: true, username: "candidate@example.com", password: "mail-secret", folder: "INBOX" },
        llm: { baseUrl: "https://llm.example.com/v1", model: "orbit-model", apiKey: "llm-secret" },
        syncIntervalMinutes: 60,
      }),
    });

    const changed = await jsonRequest(baseUrl, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        imap: { host: "imap.attacker.invalid", port: 993, secure: true, username: "candidate@example.com", password: "", folder: "INBOX" },
        llm: { baseUrl: "https://attacker.invalid/v1", model: "orbit-model", apiKey: "" },
        syncIntervalMinutes: 60,
      }),
    });

    assert.equal(changed.body.settings.imap.hasPassword, false);
    assert.equal(changed.body.settings.llm.hasApiKey, false);
  });
});

test("email detail exposes the stored original message only through its detail endpoint", async () => {
  await withApi(async (baseUrl, repository) => {
    const { email } = repository.saveEmail({
      accountId: "primary",
      folder: "INBOX",
      uid: 888,
      messageId: "<detail@example.com>",
      subject: "面试邀请",
      fromAddress: "jobs@example.com",
      toAddress: "candidate@example.com",
      receivedAt: "2026-08-21T09:00:00.000Z",
      textBody: "完整邮件正文",
      htmlBody: "<p>完整邮件正文</p>",
      rawHeaders: "Message-ID: <detail@example.com>",
      rawSource: "raw source",
    });

    const list = await jsonRequest(baseUrl, "/api/emails");
    assert.equal("rawSource" in list.body.emails[0], false);
    assert.equal("textBody" in list.body.emails[0], false);

    const detail = await jsonRequest(baseUrl, `/api/emails/${email.id}`);
    assert.equal(detail.body.email.textBody, "完整邮件正文");
    assert.equal(detail.body.email.rawSourceBase64, Buffer.from("raw source").toString("base64"));
  });
});

test("email detail reparses the stored MIME for original HTML and inline images", async () => {
  await withApi(async (baseUrl, repository) => {
    const rawSource = Buffer.from([
      "From: jobs@example.com",
      "To: candidate@example.com",
      "Subject: Rich email",
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="related"',
      "",
      "--related",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>完整 HTML</p><img src="cid:image-1"><img src="https://images.example.com/remote.png">',
      "--related",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "Content-ID: <image-1>",
      'Content-Disposition: inline; filename="image.png"',
      "",
      "aW1hZ2U=",
      "--related--",
      "",
    ].join("\r\n"));
    const { email } = repository.saveEmail({
      accountId: "primary",
      folder: "INBOX",
      uidValidity: "1",
      uid: 889,
      messageId: "<rich-detail@example.com>",
      subject: "Rich email",
      fromAddress: "jobs@example.com",
      toAddress: "candidate@example.com",
      receivedAt: "2026-08-21T09:00:00.000Z",
      textBody: "",
      htmlBody: '<p>完整 HTML</p><img src="cid:image-1">',
      rawHeaders: "Subject: Rich email",
      rawSource,
    });

    const detail = await jsonRequest(baseUrl, `/api/emails/${email.id}`);

    assert.match(detail.body.email.renderedHtml, /完整 HTML/);
    assert.match(detail.body.email.renderedHtml, /data:image\/png;base64,aW1hZ2U=/);
    assert.match(detail.body.email.renderedHtml, /https:\/\/images\.example\.com\/remote\.png/);
    assert.equal(detail.body.email.attachments[0].filename, "image.png");
  });
});

test("local email deletion requires the explicit confirmation token", async () => {
  await withApi(async (baseUrl, repository) => {
    const { email } = repository.saveEmail({
      accountId: "primary",
      folder: "INBOX",
      uidValidity: "1",
      uid: 890,
      messageId: "<delete-confirmation@example.com>",
      subject: "投递成功",
      fromAddress: "jobs@example.com",
      toAddress: "candidate@example.com",
      receivedAt: "2026-08-21T09:00:00.000Z",
      textBody: "完整邮件正文",
      htmlBody: "",
      rawHeaders: "Message-ID: <delete-confirmation@example.com>",
      rawSource: "raw source",
    });

    const response = await fetch(`${baseUrl}/api/emails`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [email.id], confirmation: "wrong-token" }),
    });

    assert.equal(response.status, 400);
    assert.ok(repository.getEmail(email.id));
  });
});

test("confirmed local email deletion removes source data but keeps the application", async () => {
  await withApi(async (baseUrl, repository) => {
    const application = repository.createApplication({
      company: "华为",
      position: "Agent基础设施工程",
      appliedDate: "2026-08-01",
    });
    const { email } = repository.saveEmail({
      accountId: "primary",
      folder: "INBOX",
      uidValidity: "1",
      uid: 891,
      messageId: "<delete-linked@example.com>",
      subject: "面试邀请",
      fromAddress: "jobs@example.com",
      toAddress: "candidate@example.com",
      receivedAt: "2026-08-21T09:00:00.000Z",
      textBody: "邀请参加面试",
      htmlBody: "",
      rawHeaders: "Message-ID: <delete-linked@example.com>",
      rawSource: "raw source",
    });
    repository.applyEmailAnalysis(email.id, {
      relevant: true,
      company: application.company,
      position: application.position,
      intent: "面试邀请",
      status: "ongoing",
      currentProgress: "面试中",
      nextAction: "参加面试",
      appliedDate: "2026-08-01",
      interviewTime: null,
      eventDate: "2026-08-21",
      detail: "面试邀请",
    });

    const response = await fetch(`${baseUrl}/api/emails`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [email.id], confirmation: "DELETE_EMAILS" }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deletedEmails: 1 });
    assert.equal(repository.getEmail(email.id), undefined);
    assert.ok(repository.getApplication(application.id));
    assert.equal(repository.getApplication(application.id)?.timeline.some((entry) => entry.sourceEmailId === email.id), false);
    assert.equal(repository.listAuditEntries().some((entry) => entry.sourceId === email.id), false);
  });
});

test("local email deletion is rejected while mail processing is active", async () => {
  await withApi(async (baseUrl, repository) => {
    const { email } = repository.saveEmail({
      accountId: "primary",
      folder: "INBOX",
      uidValidity: "1",
      uid: 892,
      messageId: "<delete-lock@example.com>",
      subject: "投递成功",
      fromAddress: "jobs@example.com",
      toAddress: "candidate@example.com",
      receivedAt: "2026-08-21T09:00:00.000Z",
      textBody: "完整邮件正文",
      htmlBody: "",
      rawHeaders: "Message-ID: <delete-lock@example.com>",
      rawSource: "raw source",
    });
    repository.acquireOperationLock("mail-processing", "sync-run");
    try {
      const response = await fetch(`${baseUrl}/api/emails`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [email.id], confirmation: "DELETE_EMAILS" }),
      });

      assert.equal(response.status, 409);
      assert.ok(repository.getEmail(email.id));
    } finally {
      repository.releaseOperationLock("mail-processing", "sync-run");
    }
  });
});

test("agent proposal route requires confirmation before updating an application", async () => {
  await withApi(async (baseUrl) => {
    const created = await jsonRequest(baseUrl, "/api/applications", {
      method: "POST",
      body: JSON.stringify({ company: "星河科技", position: "后端工程师", appliedDate: "2026-08-01" }),
    });
    const id = created.body.application.id as string;
    const chat = await jsonRequest(baseUrl, "/api/agent/chat", {
      method: "POST",
      body: JSON.stringify({ message: "将星河科技标记为二面" }),
    });
    assert.equal(chat.body.proposal.after.currentProgress, "面试中");

    const before = await jsonRequest(baseUrl, "/api/bootstrap");
    assert.equal(before.body.applications.find((item: { id: string }) => item.id === id).currentProgress, "已投递");

    await jsonRequest(baseUrl, `/api/agent/proposals/${chat.body.proposal.id}/confirm`, {
      method: "POST",
      body: JSON.stringify({ confirmed: true }),
    });
    const after = await jsonRequest(baseUrl, "/api/bootstrap");
    assert.equal(after.body.applications.find((item: { id: string }) => item.id === id).currentProgress, "面试中");
  });
});

test("export endpoint returns real application rows as CSV", async () => {
  await withApi(async (baseUrl, repository) => {
    repository.createApplication({ company: "星河,科技", position: "后端工程师", appliedDate: "2026-08-01" });
    const response = await fetch(`${baseUrl}/api/export.csv`);
    const csv = await response.text();
    assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.match(csv, /"星河,科技"/);
    assert.match(csv, /后端工程师/);
  });
});

test("expected sync conflicts and missing proposals use non-500 API errors", async () => {
  await withApi(async (baseUrl) => {
    const sync = await jsonRequest(baseUrl, "/api/sync", {
      method: "POST",
      body: JSON.stringify({ mode: "incremental" }),
    });
    assert.equal(sync.response.status, 409);
    assert.equal(sync.body.error.code, "SYNC_IN_PROGRESS");

    const proposal = await jsonRequest(baseUrl, "/api/agent/proposals/missing/confirm", {
      method: "POST",
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(proposal.response.status, 404);
    assert.equal(proposal.body.error.code, "NOT_FOUND");
  }, { syncStart: () => { throw new SyncAlreadyRunningError("active-run"); } });
});
