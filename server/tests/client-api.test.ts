import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, createApiClient } from "../../src/api";

test("frontend API client exposes the server error contract", async () => {
  const client = createApiClient(async () => new Response(JSON.stringify({
    error: {
      code: "VALIDATION_ERROR",
      message: "Invalid request",
      retryable: false,
      requestId: "request-123",
    },
  }), { status: 400, headers: { "content-type": "application/json" } }));

  await assert.rejects(
    client.getBootstrap(),
    (error: unknown) => error instanceof ApiError
      && error.code === "VALIDATION_ERROR"
      && error.requestId === "request-123"
      && error.retryable === false,
  );
});

test("frontend API client sends application updates as JSON patches", async () => {
  let method = "";
  let body = "";
  const client = createApiClient(async (_url, init) => {
    method = init?.method ?? "GET";
    body = String(init?.body ?? "");
    return new Response(JSON.stringify({ application: { id: "app-1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await client.updateApplication("app-1", { nextAction: "准备面试" });

  assert.equal(method, "PATCH");
  assert.deepEqual(JSON.parse(body), { nextAction: "准备面试" });
});

test("frontend API client sends the required bulk-delete confirmation", async () => {
  let pathname = "";
  let method = "";
  let body = "";
  const client = createApiClient(async (url, init) => {
    pathname = String(url);
    method = init?.method ?? "GET";
    body = String(init?.body ?? "");
    return new Response(JSON.stringify({ deletedApplications: 2 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const deleteAllApplications = (client as unknown as {
    deleteAllApplications?: () => Promise<{ deletedApplications: number }>;
  }).deleteAllApplications;

  assert.equal(typeof deleteAllApplications, "function");
  const result = await deleteAllApplications!();

  assert.equal(pathname, "/api/applications");
  assert.equal(method, "DELETE");
  assert.deepEqual(JSON.parse(body), { confirmation: "DELETE_ALL_APPLICATIONS" });
  assert.deepEqual(result, { deletedApplications: 2 });
});

test("frontend API client sends selected email ids with deletion confirmation", async () => {
  let pathname = "";
  let method = "";
  let body = "";
  const client = createApiClient(async (url, init) => {
    pathname = String(url);
    method = init?.method ?? "GET";
    body = String(init?.body ?? "");
    return new Response(JSON.stringify({ deletedEmails: 2 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const deleteEmails = (client as unknown as {
    deleteEmails?: (ids: string[]) => Promise<{ deletedEmails: number }>;
  }).deleteEmails;

  assert.equal(typeof deleteEmails, "function");
  const result = await deleteEmails!(["email-1", "email-2"]);

  assert.equal(pathname, "/api/emails");
  assert.equal(method, "DELETE");
  assert.deepEqual(JSON.parse(body), { ids: ["email-1", "email-2"], confirmation: "DELETE_EMAILS" });
  assert.deepEqual(result, { deletedEmails: 2 });
});

test("frontend API client sends OCR settings and tests the visual endpoint", async () => {
  const requests: Array<{ pathname: string; method: string; body: string; webHeader: string | null }> = [];
  const client = createApiClient(async (url, init) => {
    requests.push({
      pathname: String(url),
      method: init?.method ?? "GET",
      body: String(init?.body ?? ""),
      webHeader: new Headers(init?.headers).get("X-Orbit-Web"),
    });
    return new Response(JSON.stringify(
      String(url).endsWith("/test/ocr")
        ? { connected: true }
        : {
            settings: {
              imap: { host: "", port: 993, secure: true, username: "", folder: "INBOX", hasPassword: false },
              llm: { baseUrl: "", model: "", hasApiKey: false },
              ocr: { baseUrl: "https://ocr.example.com/v1", model: "vision-model", hasApiKey: true },
              syncIntervalMinutes: 60,
            },
          },
    ), { status: 200, headers: { "content-type": "application/json" } });
  });
  const updateSettings = client.updateSettings as unknown as (settings: unknown) => Promise<unknown>;
  const testOcr = (client as unknown as { testOcr?: () => Promise<{ connected: boolean }> }).testOcr;

  await updateSettings({
    imap: { host: "", port: 993, secure: true, username: "", password: "", folder: "INBOX" },
    llm: { baseUrl: "", model: "", apiKey: "" },
    ocr: { baseUrl: "https://ocr.example.com/v1", model: "vision-model", apiKey: "ocr-secret" },
    syncIntervalMinutes: 60,
  });
  assert.equal(typeof testOcr, "function");
  await testOcr!();

  assert.deepEqual(JSON.parse(requests[0]!.body).ocr, {
    baseUrl: "https://ocr.example.com/v1",
    model: "vision-model",
    apiKey: "ocr-secret",
  });
  assert.deepEqual(requests[1], {
    pathname: "/api/settings/test/ocr",
    method: "POST",
    body: "",
    webHeader: "1",
  });
});
