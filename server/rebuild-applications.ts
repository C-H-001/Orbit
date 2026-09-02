import { randomUUID } from "node:crypto"
import path from "node:path"
import { createConfigStore, resolveDataDirectory } from "./config"
import { createApplicationAwareClassifier } from "./application-aware-classifier"
import { extractReadableEmailText } from "./email-content"
import { createLlmClient } from "./llm"
import { createRepository } from "./repository"

const dataDirectory = resolveDataDirectory()
const configStore = createConfigStore(path.join(dataDirectory, "config.json"))
const repository = createRepository(path.join(dataDirectory, "orbit.sqlite"))
const llmClient = createLlmClient({ getSettings: () => configStore.get().llm })
const classifier = createApplicationAwareClassifier({ repository, llmClient, getModel: () => configStore.get().llm.model })
const lockOwner = `rebuild-applications:${randomUUID()}`
const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
const backupPath = path.join(dataDirectory, "backups", `orbit-before-application-rebuild-${timestamp}.sqlite`)

if (!repository.acquireOperationLock("mail-processing", lockOwner)) {
  repository.close()
  throw new Error("Mail processing is already active")
}

const result = {
  total: 0,
  processed: 0,
  relevant: 0,
  ignored: 0,
  failed: 0,
  createdApplications: 0,
  updatedApplications: 0,
}

try {
  await repository.createBackup(backupPath)
  const deleted = repository.deleteAllApplications()
  const emails = repository.listEmails().sort((left, right) => left.receivedAt.localeCompare(right.receivedAt))
  result.total = emails.length
  console.log(JSON.stringify({ event: "started", backupPath, deletedApplications: deleted.deletedApplications, totalEmails: emails.length }))

  for (const [index, email] of emails.entries()) {
    if (!repository.renewOperationLock("mail-processing", lockOwner)) {
      throw new Error("Mail processing lock was lost")
    }
    const textBody = extractReadableEmailText(email)
    if (!textBody) {
      result.failed += 1
      repository.markEmailFailed(email.id, "Email did not contain readable text")
      continue
    }
    repository.prepareEmailForReprocessing(email.id, textBody)
    try {
      const classified = await classifier.classifyEmail({
        subject: email.subject,
        fromAddress: email.fromAddress,
        receivedAt: email.receivedAt,
        textBody,
      })
      const applied = repository.applyEmailAnalysis(email.id, classified.analysis)
      repository.recordLlmUsage({
        model: configStore.get().llm.model,
        prompt: "申请记录重建",
        inputTokens: classified.usage.inputTokens,
        outputTokens: classified.usage.outputTokens,
        status: "success",
      })
      result.processed += 1
      if (classified.analysis.relevant) {
        result.relevant += 1
        if (applied.createdApplication) result.createdApplications += 1
        else result.updatedApplications += 1
      } else {
        result.ignored += 1
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.failed += 1
      repository.markEmailFailed(email.id, message)
      repository.recordLlmUsage({
        model: configStore.get().llm.model,
        prompt: "申请记录重建",
        inputTokens: 0,
        outputTokens: 0,
        status: "failure",
        errorMessage: message,
      })
    }
    if ((index + 1) % 10 === 0 || index + 1 === emails.length) {
      console.log(JSON.stringify({ event: "progress", completed: index + 1, ...result }))
    }
  }
  console.log(JSON.stringify({ event: "complete", backupPath, ...result }))
} finally {
  repository.releaseOperationLock("mail-processing", lockOwner)
  repository.close()
}
