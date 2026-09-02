import { randomUUID } from "node:crypto";
import type { EmailAnalysis, SyncCounts, SyncMode, SyncRun } from "./domain";
import { OperationLockLostError } from "./operation-lock";
import type { OrbitRepository } from "./repository";

export interface RawMailMessage {
  accountId: string;
  folder: string;
  uidValidity?: string;
  uid: number;
  messageId?: string;
  subject: string;
  fromAddress: string;
  toAddress: string;
  receivedAt: string;
  textBody: string;
  htmlBody: string;
  rawHeaders: string;
  rawSource: Buffer | string;
}

interface MailSource {
  fetchMessages(input: { mode: SyncMode; from?: string }):
    | AsyncIterable<RawMailMessage>
    | Iterable<RawMailMessage>
    | Promise<AsyncIterable<RawMailMessage> | Iterable<RawMailMessage>>;
}

interface ClassifierResult {
  analysis: EmailAnalysis;
  usage?: { inputTokens: number; outputTokens: number };
  model?: string;
}

interface Classifier {
  classifyEmail(email: Pick<RawMailMessage, "subject" | "fromAddress" | "receivedAt" | "textBody">): Promise<ClassifierResult>;
}

const EMPTY_COUNTS: SyncCounts = {
  fetched: 0,
  newEmails: 0,
  newApplications: 0,
  updatedApplications: 0,
  ignored: 0,
  failed: 0,
};

export class SyncAlreadyRunningError extends Error {
  constructor(public readonly runId: string) {
    super("A sync run is already active");
  }
}

export function createSyncService(options: {
  repository: OrbitRepository;
  mailSource: MailSource;
  classifier: Classifier;
}) {
  let activeRunId: string | undefined;

  async function execute(run: SyncRun, lockOwner: string) {
    const counts = structuredClone(EMPTY_COUNTS);
    const startedAt = new Date().toISOString();
    options.repository.updateSyncRun(run.id, {
      status: "running",
      phase: "connecting",
      progress: 5,
      startedAt,
      errorMessage: null,
    });

    try {
      options.repository.updateSyncRun(run.id, { phase: "fetching", progress: 20 });
      const messages = await options.mailSource.fetchMessages({ mode: run.mode, from: run.from });
      options.repository.updateSyncRun(run.id, { phase: "classifying", progress: 40, counts });

      for await (const message of messages) {
        if (!options.repository.renewOperationLock("mail-processing", lockOwner)) {
          throw new OperationLockLostError();
        }
        counts.fetched += 1;
        const saved = options.repository.saveEmail(message);
        const shouldRetry = saved.email.status === "pending" || saved.email.status === "failed";
        if (!saved.inserted && !shouldRetry) continue;
        if (saved.inserted) counts.newEmails += 1;

        try {
          const classified = await options.classifier.classifyEmail(message);
          if (!options.repository.renewOperationLock("mail-processing", lockOwner)) {
            throw new OperationLockLostError();
          }
          const applied = options.repository.applyEmailAnalysis(saved.email.id, classified.analysis);
          options.repository.recordLlmUsage({
            model: classified.model ?? "configured-model",
            prompt: "邮件意图分类",
            inputTokens: classified.usage?.inputTokens ?? 0,
            outputTokens: classified.usage?.outputTokens ?? 0,
            status: "success",
          });
          if (!classified.analysis.relevant) counts.ignored += 1;
          else if (applied.createdApplication) counts.newApplications += 1;
          else counts.updatedApplications += 1;
        } catch (error) {
          if (error instanceof OperationLockLostError) throw error;
          if (!options.repository.renewOperationLock("mail-processing", lockOwner)) {
            throw new OperationLockLostError();
          }
          const messageText = error instanceof Error ? error.message : String(error);
          counts.failed += 1;
          options.repository.markEmailFailed(saved.email.id, messageText);
          options.repository.recordLlmUsage({
            model: "configured-model",
            prompt: "邮件意图分类",
            inputTokens: 0,
            outputTokens: 0,
            status: "failure",
            errorMessage: messageText,
          });
        }

        const progress = Math.min(90, 40 + counts.fetched * 2);
        options.repository.updateSyncRun(run.id, { phase: "updating", progress, counts });
      }

      return options.repository.updateSyncRun(run.id, {
        status: "succeeded",
        phase: "done",
        progress: 100,
        counts,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      return options.repository.updateSyncRun(run.id, {
        status: "failed",
        phase: "done",
        progress: 100,
        counts,
        errorMessage: messageText,
        finishedAt: new Date().toISOString(),
      });
    } finally {
      options.repository.releaseOperationLock("mail-processing", lockOwner);
      if (activeRunId === run.id) activeRunId = undefined;
    }
  }

  function acquireProcessingLock() {
    const owner = `sync:${randomUUID()}`;
    if (!options.repository.acquireOperationLock("mail-processing", owner)) {
      throw new SyncAlreadyRunningError(activeRunId ?? "mail-processing");
    }
    return owner;
  }

  async function runNow(input: { mode: SyncMode; from?: string }) {
    if (activeRunId) throw new SyncAlreadyRunningError(activeRunId);
    const lockOwner = acquireProcessingLock();
    let run: SyncRun;
    try {
      run = options.repository.createSyncRun(input);
    } catch (error) {
      options.repository.releaseOperationLock("mail-processing", lockOwner);
      throw error;
    }
    activeRunId = run.id;
    return execute(run, lockOwner);
  }

  function start(input: { mode: SyncMode; from?: string }) {
    if (activeRunId) throw new SyncAlreadyRunningError(activeRunId);
    const lockOwner = acquireProcessingLock();
    let run: SyncRun;
    try {
      run = options.repository.createSyncRun(input);
    } catch (error) {
      options.repository.releaseOperationLock("mail-processing", lockOwner);
      throw error;
    }
    activeRunId = run.id;
    void execute(run, lockOwner);
    return run;
  }

  return { runNow, start };
}

export type SyncService = ReturnType<typeof createSyncService>;
