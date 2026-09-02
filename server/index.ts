import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { createAgentService } from "./agent";
import { createApplicationAwareClassifier } from "./application-aware-classifier";
import { createApiApp, createOcrConnectionTester, startInterviewCaptureMaintenance } from "./api";
import { createConfigStore, resolveDataDirectory } from "./config";
import { createImapMailSource } from "./imap";
import { createInterviewCaptureService } from "./interview-capture";
import { createInterviewFileStore } from "./interview-files";
import { createInterviewOcrClient } from "./interview-ocr";
import { createLlmClient } from "./llm";
import { createRepository } from "./repository";
import { createScheduler } from "./scheduler";
import { createSyncService } from "./sync";

const dataDirectory = resolveDataDirectory();
const configStore = createConfigStore(path.join(dataDirectory, "config.json"));
const repository = createRepository(path.join(dataDirectory, "orbit.sqlite"));
repository.recoverInterruptedSyncRuns();
const imapSource = createImapMailSource({ getSettings: () => configStore.get().imap });
const llmClient = createLlmClient({ getSettings: () => configStore.get().llm });
const applicationAwareClassifier = createApplicationAwareClassifier({
  repository,
  llmClient,
  getModel: () => configStore.get().llm.model,
});
const interviewCaptureDirectory = path.join(dataDirectory, "interview-captures");
const interviewOcr = createInterviewOcrClient({ getSettings: () => configStore.get().ocr });
const interviewFileStore = createInterviewFileStore(interviewCaptureDirectory);
const interviewCaptureService = createInterviewCaptureService({
  repository,
  ocr: interviewOcr,
  fileStore: interviewFileStore,
});
const stopInterviewCaptureMaintenance = startInterviewCaptureMaintenance(interviewCaptureService);
const syncService = createSyncService({
  repository,
  mailSource: imapSource,
  classifier: {
    classifyEmail: applicationAwareClassifier.classifyEmail,
  },
});
const agentService = createAgentService({
  repository,
  answerQuestion: async ({ message, context }) => {
    const result = await llmClient.request([
      {
        role: "system",
        content: "你是 Orbit 求职进度助手。只根据提供的申请与邮件上下文回答；信息不足时明确说明，不要编造。",
      },
      { role: "user", content: `上下文：${context}\n\n用户问题：${message}` },
    ]);
    return { ...result, model: configStore.get().llm.model };
  },
});

const app = createApiApp({
  repository,
  configStore,
  agentService,
  syncService,
  interviewCaptureService,
  interviewCaptureDirectory,
  testImapConnection: () => imapSource.testConnection(),
  testLlmConnection: () => llmClient.request([
    { role: "system", content: "只回复 OK。" },
    { role: "user", content: "连接测试" },
  ]),
  testOcrConnection: createOcrConnectionTester({ getSettings: () => configStore.get().ocr }),
});

const distDirectory = path.resolve("dist");
const indexPath = path.join(distDirectory, "index.html");
if (existsSync(indexPath)) {
  app.use(express.static(distDirectory));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api/")) return next();
    return response.sendFile(indexPath);
  });
}

const scheduler = createScheduler({
  getSettings: () => configStore.get(),
  getLatestSyncRun: () => repository.getLatestSyncRun(),
  startSync: () => syncService.start({ mode: "incremental" }),
});
scheduler.start();

const port = Number(process.env.ORBIT_API_PORT || 8787);
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Orbit API listening on http://127.0.0.1:${port}`);
});

function shutdown() {
  scheduler.stop();
  stopInterviewCaptureMaintenance();
  server.close(() => {
    repository.close();
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
