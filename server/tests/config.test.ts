import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createConfigStore } from "../config";

const temporaryDirectories: string[] = [];

function temporaryConfigPath() {
  const directory = mkdtempSync(path.join(tmpdir(), "orbit-config-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "config.json");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("saved settings survive creating a new config store", () => {
  const configPath = temporaryConfigPath();
  const store = createConfigStore(configPath);

  store.save({
    imap: {
      host: "imap.example.com",
      port: 993,
      secure: true,
      username: "candidate@example.com",
      password: "mail-secret",
      folder: "INBOX",
    },
    llm: {
      baseUrl: "https://llm.example.com/v1",
      model: "orbit-model",
      apiKey: "llm-secret",
    },
    ocr: {
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3.8-flash",
      apiKey: "ocr-secret",
    },
    syncIntervalMinutes: 30,
  });

  assert.deepEqual(createConfigStore(configPath).get(), {
    imap: {
      host: "imap.example.com",
      port: 993,
      secure: true,
      username: "candidate@example.com",
      password: "mail-secret",
      folder: "INBOX",
    },
    llm: {
      baseUrl: "https://llm.example.com/v1",
      model: "orbit-model",
      apiKey: "llm-secret",
    },
    ocr: {
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3.8-flash",
      apiKey: "ocr-secret",
    },
    syncIntervalMinutes: 30,
  });
});

test("public settings never expose stored secrets", () => {
  const store = createConfigStore(temporaryConfigPath());
  store.save({
    imap: {
      host: "imap.example.com",
      port: 993,
      secure: true,
      username: "candidate@example.com",
      password: "mail-secret",
      folder: "INBOX",
    },
    llm: {
      baseUrl: "https://llm.example.com/v1",
      model: "orbit-model",
      apiKey: "llm-secret",
    },
    ocr: {
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3.8-flash",
      apiKey: "ocr-secret",
    },
    syncIntervalMinutes: 60,
  });

  const publicSettings = store.getPublic();
  assert.equal("password" in publicSettings.imap, false);
  assert.equal("apiKey" in publicSettings.llm, false);
  assert.equal("apiKey" in publicSettings.ocr, false);
  assert.equal(publicSettings.imap.hasPassword, true);
  assert.equal(publicSettings.llm.hasApiKey, true);
  assert.equal(publicSettings.ocr.hasApiKey, true);
});
