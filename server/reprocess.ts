import { randomUUID } from "node:crypto";
import type { EmailAnalysis } from "./domain";
import { extractReadableEmailText } from "./email-content";
import { OperationLockLostError } from "./operation-lock";
import type { OrbitRepository } from "./repository";

interface ClassifierResult {
  analysis: EmailAnalysis;
  usage?: { inputTokens: number; outputTokens: number };
  model?: string;
}

export function createHtmlEmailReprocessor(options: {
  repository: OrbitRepository;
  classifier: {
    classifyEmail(email: { subject: string; fromAddress: string; receivedAt: string; textBody: string }): Promise<ClassifierResult>;
  };
}) {
  async function run(runOptions?: { beforeMutate?: () => Promise<unknown> }) {
    const lockOwner = `reprocess:${randomUUID()}`;
    if (!options.repository.acquireOperationLock("mail-processing", lockOwner)) {
      throw new Error("Mail processing is already active");
    }
    try {
      await runOptions?.beforeMutate?.();
      const candidates = options.repository.listEmails().filter((email) =>
        Boolean(email.htmlBody.trim()) && (!email.textBody.trim() || email.status === "failed" || email.status === "pending"),
      );
      const result = { candidates: candidates.length, reprocessed: 0, ignored: 0, failed: 0 };

      for (const email of candidates) {
        if (!options.repository.renewOperationLock("mail-processing", lockOwner)) {
          throw new OperationLockLostError();
        }
        const textBody = extractReadableEmailText(email);
        if (!textBody) {
          result.failed += 1;
          options.repository.markEmailFailed(email.id, "HTML email did not contain readable text");
          continue;
        }
        options.repository.prepareEmailForReprocessing(email.id, textBody);
        try {
          const classified = await options.classifier.classifyEmail({
            subject: email.subject,
            fromAddress: email.fromAddress,
            receivedAt: email.receivedAt,
            textBody,
          });
          if (!options.repository.renewOperationLock("mail-processing", lockOwner)) {
            throw new OperationLockLostError();
          }
          options.repository.applyEmailAnalysis(email.id, classified.analysis);
          options.repository.recordLlmUsage({
            model: classified.model ?? "configured-model",
            prompt: "HTML 邮件重新分类",
            inputTokens: classified.usage?.inputTokens ?? 0,
            outputTokens: classified.usage?.outputTokens ?? 0,
            status: "success",
          });
          if (classified.analysis.relevant) result.reprocessed += 1;
          else result.ignored += 1;
        } catch (error) {
          if (error instanceof OperationLockLostError) throw error;
          if (!options.repository.renewOperationLock("mail-processing", lockOwner)) {
            throw new OperationLockLostError();
          }
          const message = error instanceof Error ? error.message : String(error);
          result.failed += 1;
          options.repository.markEmailFailed(email.id, message);
          options.repository.recordLlmUsage({
            model: "configured-model",
            prompt: "HTML 邮件重新分类",
            inputTokens: 0,
            outputTokens: 0,
            status: "failure",
            errorMessage: message,
          });
        }
      }
      return result;
    } finally {
      options.repository.releaseOperationLock("mail-processing", lockOwner);
    }
  }

  return { run };
}

export type HtmlEmailReprocessor = ReturnType<typeof createHtmlEmailReprocessor>;
