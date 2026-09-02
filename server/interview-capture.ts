import type {
  InterviewExperienceDraft,
  InterviewPlatform,
} from "../shared/interview-experience"
import type { LlmUsage } from "./llm"
import type { InterviewCaptureImageFile } from "./interview-files"
import { interviewOcrProviderSemaphore } from "./interview-ocr-semaphore"
import type { OrbitRepository } from "./repository"

interface InterviewOcrResult {
  draft: InterviewExperienceDraft
  usage: LlmUsage
  model: string
  durationMs: number
}

interface InterviewOcrImage {
  index: number
  mimeType: string
  bytes: Buffer
}

interface ReadInterviewImage {
  mimeType: string
  bytes: Buffer
}

interface InterviewOcrClient {
  extractInterviewExperience(input: {
    platform: InterviewPlatform
    pageTitle: string
    publishedAt: string | null
    pageText: string
    images: InterviewOcrImage[]
  }): Promise<InterviewOcrResult>
}

interface InterviewFileStore {
  adopt(
    jobId: string,
    images: InterviewCaptureImageFile[],
  ): Array<Omit<InterviewCaptureImageFile, "originalName">>
  cleanupJob(jobId: string): void
  listJobDirectoryIds(): string[]
  readCaptureInput<T>(jobId: string): T | undefined
  readImage(
    filePath: string,
    declaredMimeType?: InterviewCaptureImageFile["mimeType"],
  ): ReadInterviewImage
  saveCaptureInput(jobId: string, input: unknown): void
}

export interface CreateInterviewCaptureInput {
  platform: InterviewPlatform
  sourceUrl: string
  pageTitle: string
  publishedAt: string | null
  contentCompleteness: "complete" | "partial"
  pageText: string
  images: InterviewCaptureImageFile[]
  failedImageIndexes: number[]
}

interface StoredCaptureInput
  extends Omit<CreateInterviewCaptureInput, "images"> {
  images: Array<Omit<InterviewCaptureImageFile, "originalName">>
}

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function createInterviewCaptureService(options: {
  repository: OrbitRepository
  ocr: InterviewOcrClient
  fileStore: InterviewFileStore
  now?: () => Date
}) {
  const queue: string[] = []
  const inputs = new Map<string, StoredCaptureInput>()
  const now = options.now ?? (() => new Date())
  let running = false
  let idleResolvers: Array<() => void> = []

  function resolveIdleWaiters() {
    if (running || queue.length) return
    const resolvers = idleResolvers
    idleResolvers = []
    for (const resolve of resolvers) resolve()
  }

  function create(input: CreateInterviewCaptureInput) {
    const job = options.repository.createInterviewCaptureJob({
      platform: input.platform,
      sourceUrl: input.sourceUrl,
      pageTitle: input.pageTitle,
      publishedAt: input.publishedAt,
      contentCompleteness: input.contentCompleteness,
      rawInput: { pageText: input.pageText },
      imageManifest: input.images.map(({ index, mimeType }) => ({
        index,
        mimeType,
      })),
      failedImageIndexes: input.failedImageIndexes,
    })
    try {
      const images = options.fileStore.adopt(job.id, input.images)
      const storedInput = { ...input, images }
      options.fileStore.saveCaptureInput(job.id, storedInput)
      inputs.set(job.id, storedInput)
      return job
    } catch (error) {
      options.repository.cancelInterviewCaptureJob(job.id)
      try {
        options.fileStore.cleanupJob(job.id)
      } catch (cleanupError) {
        console.error(
          "Unable to clean rolled back interview capture files",
          cleanupError,
        )
      }
      throw error
    }
  }

  function enqueue(id: string) {
    if (
      !queue.includes(id) &&
      options.repository.getInterviewCaptureJob(id)?.status === "queued"
    ) {
      queue.push(id)
      void processNext()
    }
  }

  function recordUsage(
    result: InterviewOcrResult,
    status: "success" | "failure",
    sourceId: string,
    errorMessage?: string,
  ) {
    options.repository.recordLlmUsage({
      model: result.model,
      prompt: "interview-capture",
      inputTokens: result.usage.inputTokens,
      imageTokens: result.usage.imageTokens,
      outputTokens: result.usage.outputTokens,
      reasoningTokens: result.usage.reasoningTokens,
      durationMs: result.durationMs,
      sourceId,
      status,
      errorMessage,
    })
  }

  async function processNext(): Promise<void> {
    if (running) return
    const id = queue.shift()
    if (!id) {
      resolveIdleWaiters()
      return
    }
    running = true
    const startedAt = Date.now()
    let model = "unknown"
    let usageRecorded = false
    try {
      const job = options.repository.getInterviewCaptureJob(id)
      const input = inputs.get(id)
      if (!job || job.status !== "queued" || !input) return
      options.repository.markInterviewCaptureProcessing(id)
      const images = input.images.map((image) => ({
        index: image.index,
        ...options.fileStore.readImage(image.path, image.mimeType),
      }))
      const result = await interviewOcrProviderSemaphore.runExclusive(() =>
        options.ocr.extractInterviewExperience({
          platform: input.platform,
          pageTitle: input.pageTitle,
          publishedAt: input.publishedAt,
          pageText: input.pageText,
          images,
        }))
      model = result.model
      recordUsage(result, "success", id)
      usageRecorded = true
      options.repository.markInterviewCaptureReady(id, result.draft, {
        textTokens: result.usage.inputTokens,
        imageTokens: result.usage.imageTokens,
        outputTokens: result.usage.outputTokens,
        reasoningTokens: result.usage.reasoningTokens,
        durationMs: result.durationMs,
      }, result.model)
    } catch (error) {
      const message = asErrorMessage(error)
      if (!usageRecorded) {
        options.repository.recordLlmUsage({
          model,
          prompt: "interview-capture",
          inputTokens: 0,
          imageTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          durationMs: Date.now() - startedAt,
          sourceId: id,
          status: "failure",
          errorMessage: message,
        })
      }
      try {
        options.repository.markInterviewCaptureFailed(id, {
          code: "OCR_FAILED",
          message,
          usage: { durationMs: Date.now() - startedAt },
        })
      } catch {
        // A concurrent cancellation or terminal transition already owns the job state.
      }
    } finally {
      running = false
      if (queue.length) void processNext()
      else resolveIdleWaiters()
    }
  }

  function retry(id: string) {
    const job = options.repository.getInterviewCaptureJob(id)
    const input =
      inputs.get(id) ??
      options.fileStore.readCaptureInput<StoredCaptureInput>(id)
    if (!job || !input)
      throw new Error("Interview capture job cannot be retried")
    if (job.status !== "failed")
      throw new Error("Only failed interview capture jobs can be retried")
    const retried = options.repository.retryInterviewCaptureJob(id)
    inputs.set(id, input)
    enqueue(retried.id)
    return retried
  }

  function cancel(id: string) {
    const job = options.repository.cancelInterviewCaptureJob(id)
    if (!job) return undefined
    queue.splice(
      0,
      queue.length,
      ...queue.filter((queuedId) => queuedId !== id),
    )
    try {
      options.fileStore.cleanupJob(id)
    } catch (error) {
      console.error("Unable to clean cancelled interview capture files", error)
    }
    inputs.delete(id)
    resolveIdleWaiters()
    return job
  }

  function confirm(id: string, draft: InterviewExperienceDraft) {
    const experience = options.repository.confirmInterviewCaptureJob(id, draft)
    try {
      options.fileStore.cleanupJob(id)
    } catch (error) {
      console.error("Unable to clean confirmed interview capture files", error)
    }
    inputs.delete(id)
    return experience
  }

  function saveDraft(
    id: string,
    draft: InterviewExperienceDraft,
    revision: number,
  ) {
    return options.repository.saveInterviewCaptureDraft(id, draft, revision)
  }

  function recover() {
    return options.repository.recoverInterruptedInterviewCaptureJobs()
  }

  function cleanupExpired() {
    const before = new Date(now().getTime() - 24 * 60 * 60 * 1000).toISOString()
    const expired = options.repository.listExpiredInterviewCaptureJobs(before)
    let deletedJobs = 0
    for (const job of expired) {
      try {
        options.fileStore.cleanupJob(job.id)
        options.repository.deleteInterviewCaptureJob(job.id)
        inputs.delete(job.id)
        deletedJobs += 1
      } catch (error) {
        console.error("Unable to clean expired interview capture files", error)
      }
    }
    for (const jobId of options.fileStore.listJobDirectoryIds()) {
      const job = options.repository.getInterviewCaptureJob(jobId)
      if (job && job.status !== "confirmed" && job.status !== "cancelled")
        continue
      try {
        options.fileStore.cleanupJob(jobId)
        inputs.delete(jobId)
      } catch (error) {
        console.error("Unable to sweep interview capture files", error)
      }
    }
    return deletedJobs
  }

  function waitForIdle() {
    if (!running && !queue.length) return Promise.resolve()
    return new Promise<void>((resolve) => idleResolvers.push(resolve))
  }

  return {
    cancel,
    cleanupExpired,
    confirm,
    create,
    enqueue,
    recover,
    retry,
    saveDraft,
    waitForIdle,
  }
}
