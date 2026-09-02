import { randomUUID } from "node:crypto"
import path from "node:path"
import type { EmailAnalysis } from "./domain"
import { normalizeEmailIntent } from "./domain"
import { resolveDataDirectory } from "./config"
import { createRepository } from "./repository"
import { normalizeRecruitmentProgress } from "../shared/recruitment-progress"

const dataDirectory = resolveDataDirectory()
const repository = createRepository(path.join(dataDirectory, "orbit.sqlite"))
const owner = `replay-application-analyses:${randomUUID()}`
const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
const backupPath = path.join(dataDirectory, "backups", `orbit-before-analysis-replay-${timestamp}.sqlite`)

if (!repository.acquireOperationLock("mail-processing", owner)) {
  repository.close()
  throw new Error("Mail processing is already active")
}

try {
  await repository.createBackup(backupPath)
  const deleted = repository.deleteAllApplications()
  const emails = repository.listEmails().sort((left, right) => left.receivedAt.localeCompare(right.receivedAt))
  let replayed = 0
  let skipped = 0
  for (const email of emails) {
    if (!email.analysis || typeof email.analysis !== "object") {
      skipped += 1
      continue
    }
    const raw = email.analysis as EmailAnalysis
    const intent = /ai\s*[- ]?coding|coding\s*(?:test|测试|测评)/i.test([email.subject, raw.detail].filter(Boolean).join(" "))
      ? "AI Coding邀请" as const
      : normalizeEmailIntent({ intent: raw.intent, subject: email.subject, analysis: raw })
    const assessmentTrack = intent === "笔试邀请" || intent === "AI Coding邀请"
    const analysis: EmailAnalysis = {
      ...raw,
      intent,
      position: assessmentTrack ? "" : raw.position ?? "",
      currentProgress: raw.relevant
        ? intent === "AI Coding邀请"
          ? "AI Coding中"
          : intent === "笔试邀请"
            ? "笔试中"
            : normalizeRecruitmentProgress(raw.currentProgress, [email.subject, raw.detail, intent])
        : null,
      interviewTime: assessmentTrack ? null : raw.interviewTime ?? null,
      assessmentTime: assessmentTrack ? raw.assessmentTime ?? raw.interviewTime ?? null : null,
      assessmentTimeType: assessmentTrack ? raw.assessmentTimeType ?? null : null,
    }
    repository.prepareEmailForReprocessing(email.id, email.textBody)
    repository.applyEmailAnalysis(email.id, analysis)
    replayed += 1
  }
  console.log(JSON.stringify({ backupPath, deletedApplications: deleted.deletedApplications, replayed, skipped, applications: repository.listApplications().length }))
} finally {
  repository.releaseOperationLock("mail-processing", owner)
  repository.close()
}
