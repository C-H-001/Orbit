/// <reference types="chrome" />

import {
  AlertCircle,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CloudUpload,
  FileSearch,
  Plus,
  RefreshCw,
  Trash2,
  WifiOff,
  X,
} from "lucide-react"
import {
  default as React,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react"
import type {
  InterviewCaptureJob,
  InterviewExperience,
  InterviewExperienceDraft,
  InterviewQuestionDraft,
} from "../../../shared/interview-experience"
import {
  createExtensionApi,
  ExtensionApiError,
  type ExtensionApi,
  type DraftSaveRequestOptions,
  type InterviewCaptureMetadata,
  type InterviewCaptureUpload,
  type SupportedImageMime,
} from "../api"
import { extractNowcoderPage } from "../extractors/nowcoder"
import { extractXiaohongshuPage } from "../extractors/xiaohongshu"
import { detectInterviewPlatform } from "../platform"
import {
  createInterviewJobStorage,
  type InterviewJobStorage,
} from "../storage"
import {
  addInterviewQuestion,
  initialSidePanelState,
  moveInterviewQuestion,
  normalizeInterviewDraft,
  removeInterviewQuestion,
  sidePanelReducer,
  stateFromInterviewCaptureJob,
  validateInterviewDraft,
  type InterviewDraftValidationErrors,
  type SidePanelState,
} from "./state"

type ExtractorFunction =
  | typeof extractNowcoderPage
  | typeof extractXiaohongshuPage

interface ActiveTab {
  id?: number
  url?: string
  title?: string
}

export interface BrowserCaptureAdapter {
  queryActiveTab(): Promise<ActiveTab | undefined>
  executeScript(tabId: number, func: ExtractorFunction): Promise<unknown>
}

export function createChromeBrowserCapture(
  chromeApi: Pick<typeof chrome, "scripting" | "tabs">,
): BrowserCaptureAdapter {
  return {
    async queryActiveTab() {
      const tabs = await chromeApi.tabs.query({
        active: true,
        currentWindow: true,
      })
      return tabs[0]
    },
    async executeScript(tabId, func) {
      const results = await chromeApi.scripting.executeScript({
        target: { tabId },
        func: func as () => unknown,
      })
      if (results.length === 0) throw new Error("EXTRACTION_RETURNED_NO_RESULT")
      return results[0]?.result
    },
  }
}

export class SidePanelWorkflowError extends Error {
  constructor(
    readonly code: string,
    message = code,
    readonly retryable = true,
  ) {
    super(message)
    this.name = "SidePanelWorkflowError"
  }
}

function errorMessage(error: unknown) {
  if (error instanceof ExtensionApiError || error instanceof Error) {
    return error.message
  }
  return "发生未知错误，请重试。"
}

export function errorRetryable(error: unknown) {
  if (error instanceof ExtensionApiError) return error.retryable
  if (error instanceof SidePanelWorkflowError) return error.retryable
  return true
}

export class CaptureJobStorageFinalizationError extends Error {
  readonly code = "STORAGE_FINALIZATION_REQUIRED"

  constructor(
    readonly job: InterviewCaptureJob,
    readonly storageError: unknown,
  ) {
    super("任务已由 Orbit 接收，但本地任务标记尚未保存。")
    this.name = "CaptureJobStorageFinalizationError"
  }
}

export async function persistReturnedCaptureJob(
  storage: Pick<InterviewJobStorage, "save">,
  job: InterviewCaptureJob,
) {
  try {
    await storage.save(job.id)
    return job
  } catch (error) {
    throw new CaptureJobStorageFinalizationError(job, error)
  }
}

function isXiaohongshuImageUrl(value: string) {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port
    ) {
      return false
    }
    return ["xiaohongshu.com", "xhscdn.com"].some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    )
  } catch {
    return false
  }
}

const SUPPORTED_IMAGE_MIMES = new Set<SupportedImageMime>([
  "image/jpeg",
  "image/png",
  "image/webp",
])
const MAX_CAPTURE_IMAGE_BYTES = 7 * 1024 * 1024
const MAX_CAPTURE_TOTAL_BYTES = 80 * 1024 * 1024

function supportedImageMime(value: string): value is SupportedImageMime {
  return SUPPORTED_IMAGE_MIMES.has(value as SupportedImageMime)
}

async function normalizeCapturedImage(blob: Blob) {
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  let mimeType: SupportedImageMime | undefined
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) mimeType = "image/jpeg"
  if (header.slice(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])) mimeType = "image/png"
  if (
    String.fromCharCode(...header.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...header.slice(8, 12)) === "WEBP"
  ) mimeType = "image/webp"
  if (!mimeType && supportedImageMime(blob.type)) mimeType = blob.type
  if (!mimeType) throw new Error("UNSUPPORTED_IMAGE_MIME")
  return blob.type === mimeType ? blob : new Blob([blob], { type: mimeType })
}

function uniqueSortedIndexes(indexes: number[]) {
  return Array.from(
    new Set(indexes.filter((index) => Number.isInteger(index) && index > 0)),
  ).sort((left, right) => left - right)
}

function pageTextFromNowcoder(
  sections: ReturnType<typeof extractNowcoderPage>["sections"],
) {
  return sections
    .map(({ heading, blocks }) => [heading, ...blocks].join("\n"))
    .join("\n\n")
}

export async function restoreSidePanel(options: {
  api: Pick<ExtensionApi, "getJob" | "health"> & Partial<Pick<ExtensionApi, "getActiveJob">>
  storage: Pick<InterviewJobStorage, "clear" | "load"> & Partial<Pick<InterviewJobStorage, "save">>
  browser: Pick<BrowserCaptureAdapter, "queryActiveTab">
}): Promise<SidePanelState> {
  try {
    await options.api.health()
  } catch {
    return {
      kind: "orbit-offline",
      message: "无法连接 Orbit，请确认桌面应用已启动。",
    }
  }

  async function detectCurrentTab(): Promise<SidePanelState> {
    const tab = await options.browser.queryActiveTab()
    const url = tab?.url ?? ""
    const platform = detectInterviewPlatform(url)
    if (!platform || tab?.id === undefined) {
      return { kind: "unsupported", url }
    }
    return {
      kind: "collectable",
      platform,
      title: tab.title?.trim() || url,
    }
  }

  try {
    const currentJobId = await options.storage.load()
    if (!currentJobId) {
      const activeJob = await options.api.getActiveJob?.()
      if (!activeJob) return detectCurrentTab()
      if (!options.storage.save) throw new Error("Interview job storage is not configured")
      try {
        await persistReturnedCaptureJob({ save: options.storage.save }, activeJob)
      } catch (error) {
        if (error instanceof CaptureJobStorageFinalizationError) {
          return {
            kind: "storage-finalization",
            job: error.job,
            message: error.message,
          }
        }
        throw error
      }
      return stateFromInterviewCaptureJob(activeJob)
    }
    try {
      const restoredJob = await options.api.getJob(currentJobId)
      if (restoredJob.status === "confirmed") {
        try {
          await options.storage.clear()
        } catch {
          return {
            kind: "cleanup-required",
            job: restoredJob,
            message: "面经已确认，但本地任务标记尚未清除。",
          }
        }
        return detectCurrentTab()
      }
      return stateFromInterviewCaptureJob(restoredJob)
    } catch (error) {
      if (error instanceof ExtensionApiError && error.status === 404) {
        await options.storage.clear()
        return detectCurrentTab()
      }
      throw error
    }
  } catch (error) {
    return {
      kind: "failed",
      message: errorMessage(error),
      retryable: errorRetryable(error),
    }
  }
}

export async function collectCurrentTab(options: {
  api: Pick<ExtensionApi, "createCaptureJob" | "health">
  browser: BrowserCaptureAdapter
  fetchImage: typeof fetch
  onPhase?: (phase: "extracting" | "uploading") => void
}) {
  try {
    await options.api.health()
  } catch (error) {
    throw new SidePanelWorkflowError(
      "ORBIT_OFFLINE",
      "无法连接 Orbit，请确认桌面应用已启动。",
      true,
    )
  }

  const tab = await options.browser.queryActiveTab()
  const sourceUrl = tab?.url ?? ""
  const platform = detectInterviewPlatform(sourceUrl)
  if (!platform || tab?.id === undefined) {
    throw new SidePanelWorkflowError(
      "UNSUPPORTED_PAGE",
      "UNSUPPORTED_PAGE",
      false,
    )
  }

  options.onPhase?.("extracting")
  let upload: InterviewCaptureUpload
  if (platform === "nowcoder") {
    const result = (await options.browser.executeScript(
      tab.id,
      extractNowcoderPage,
    )) as ReturnType<typeof extractNowcoderPage>
    if (!result?.title || !Array.isArray(result.sections)) {
      throw new SidePanelWorkflowError("INVALID_EXTRACTION_RESULT")
    }
    upload = {
      metadata: {
        platform,
        sourceUrl,
        pageTitle: result.title,
        publishedAt: result.publishedAt,
        contentCompleteness: result.contentCompleteness,
        pageText: pageTextFromNowcoder(result.sections),
        imageIndexes: [],
        imageUrls: [],
        failedImageIndexes: [],
      },
      images: [],
    }
  } else {
    const result = (await options.browser.executeScript(
      tab.id,
      extractXiaohongshuPage,
    )) as Awaited<ReturnType<typeof extractXiaohongshuPage>>
    if (!result?.title || !Array.isArray(result.images)) {
      throw new SidePanelWorkflowError("INVALID_EXTRACTION_RESULT")
    }
    if (result.images.length > 20 || result.imageCount > 20) {
      throw new SidePanelWorkflowError(
        "TOO_MANY_IMAGES",
        "页面图片超过 20 张，无法采集。",
        false,
      )
    }

    const images: InterviewCaptureUpload["images"] = []
    const imageUrls: Array<{ index: number; url: string }> = []
    const failedIndexes = [...result.failedImageIndexes]
    let acceptedBytes = 0
    const orderedImages = [...result.images].sort(
      (left, right) => left.index - right.index,
    )
    const seenIndexes = new Set<number>()
    for (const image of orderedImages) {
      if (
        !Number.isInteger(image.index) ||
        image.index < 1 ||
        seenIndexes.has(image.index) ||
        !isXiaohongshuImageUrl(image.url)
      ) {
        if (Number.isInteger(image.index) && image.index > 0) {
          failedIndexes.push(image.index)
        }
        continue
      }
      seenIndexes.add(image.index)
      try {
        const response = await options.fetchImage(image.url, {
          credentials: "omit",
        })
        if (!response.ok) throw new Error(`IMAGE_FETCH_${response.status}`)
        const contentLength = Number(response.headers.get("content-length"))
        if (
          Number.isFinite(contentLength) &&
          contentLength > MAX_CAPTURE_IMAGE_BYTES
        ) {
          throw new Error("IMAGE_TOO_LARGE")
        }
        const blob = await normalizeCapturedImage(await response.blob())
        if (blob.size > MAX_CAPTURE_IMAGE_BYTES) {
          throw new Error("IMAGE_TOO_LARGE")
        }
        if (acceptedBytes + blob.size > MAX_CAPTURE_TOTAL_BYTES) {
          throw new Error("CAPTURE_TOTAL_TOO_LARGE")
        }
        images.push({ index: image.index, blob })
        acceptedBytes += blob.size
      } catch {
        imageUrls.push({ index: image.index, url: image.url })
      }
    }
    if (images.length === 0 && imageUrls.length === 0) {
      throw new SidePanelWorkflowError(
        "NO_SUPPORTED_IMAGES",
        "NO_SUPPORTED_IMAGES",
        true,
      )
    }
    const normalizedFailedIndexes = uniqueSortedIndexes(failedIndexes)
    const metadata: InterviewCaptureMetadata = {
      platform,
      sourceUrl,
      pageTitle: result.title,
      publishedAt: result.publishedAt,
      contentCompleteness:
        normalizedFailedIndexes.length > 0 || images.length < result.imageCount
          ? "partial"
          : "complete",
      pageText: "",
      imageIndexes: images.map(({ index }) => index),
      imageUrls,
      failedImageIndexes: normalizedFailedIndexes,
    }
    upload = { metadata, images }
  }

  options.onPhase?.("uploading")
  return options.api.createCaptureJob(upload)
}

interface IntervalTimers {
  setInterval(callback: () => void, delay: number): unknown
  clearInterval(handle: unknown): void
}

export function startProcessingJobPolling(options: {
  jobId: string
  poll: (jobId: string) => Promise<InterviewCaptureJob>
  onJob: (job: InterviewCaptureJob) => void
  onError: (error: unknown) => void
  timers?: IntervalTimers
}) {
  const timers: IntervalTimers = options.timers ?? {
    setInterval: (callback, delay) => globalThis.setInterval(callback, delay),
    clearInterval: (handle) =>
      globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  }
  let active = true
  let inFlight = false
  const handle = timers.setInterval(() => {
    if (!active || inFlight) return
    inFlight = true
    void options
      .poll(options.jobId)
      .then((nextJob) => {
        if (active) options.onJob(nextJob)
      })
      .catch((error: unknown) => {
        if (active) options.onError(error)
      })
      .finally(() => {
        inFlight = false
      })
  }, 2_000)

  return () => {
    active = false
    timers.clearInterval(handle)
  }
}

interface TimeoutTimers {
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(handle: unknown): void
}

export function createDraftSaveDebouncer(options: {
  save: (
    jobId: string,
    draft: InterviewExperienceDraft,
    revision: number,
    requestOptions?: DraftSaveRequestOptions,
  ) => Promise<InterviewCaptureJob>
  timers?: TimeoutTimers
}) {
  const timers: TimeoutTimers = options.timers ?? {
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  let handle: unknown
  let generation = 0
  let settledGeneration = 0
  const latestRevisionByJob = new Map<string, number>()
  let latest: {
    jobId: string
    draft: InterviewExperienceDraft
    generation: number
    draftRevision: number
    onSaved: (
      job: InterviewCaptureJob,
      savedDraft: InterviewExperienceDraft,
    ) => void
    onError: (error: unknown) => void
  } | undefined

  function clearScheduledSave() {
    if (handle === undefined) return
    timers.clearTimeout(handle)
    handle = undefined
  }

  function persist(
    scheduled: NonNullable<typeof latest>,
    requestOptions: DraftSaveRequestOptions = {},
  ) {
    return options
      .save(
        scheduled.jobId,
        scheduled.draft,
        scheduled.draftRevision,
        requestOptions,
      )
      .then((savedJob) => {
        latestRevisionByJob.set(
          scheduled.jobId,
          Math.max(
            latestRevisionByJob.get(scheduled.jobId) ?? 0,
            savedJob.draftRevision,
          ),
        )
        if (
          scheduled.generation !== generation ||
          scheduled.generation <= settledGeneration
        ) {
          return
        }
        settledGeneration = scheduled.generation
        scheduled.onSaved(savedJob, scheduled.draft)
      })
      .catch((error: unknown) => {
        if (
          scheduled.generation === generation &&
          scheduled.generation > settledGeneration
        ) {
          scheduled.onError(error)
        }
      })
  }

  const debouncer = {
    schedule(
      jobId: string,
      draft: InterviewExperienceDraft,
      serverRevision: number,
      onSaved: (
        job: InterviewCaptureJob,
        savedDraft: InterviewExperienceDraft,
      ) => void,
      onError: (error: unknown) => void,
    ) {
      generation += 1
      const previousRevision = latest?.jobId === jobId
        ? latest.draftRevision
        : latestRevisionByJob.get(jobId) ?? serverRevision
      const draftRevision = Math.max(serverRevision, previousRevision) + 1
      latestRevisionByJob.set(jobId, draftRevision)
      latest = {
        jobId,
        draft,
        generation,
        draftRevision,
        onSaved,
        onError,
      }
      clearScheduledSave()
      handle = timers.setTimeout(() => {
        handle = undefined
        if (latest) void persist(latest)
      }, 500)
    },
    flush(requestOptions: DraftSaveRequestOptions = { keepalive: true }) {
      clearScheduledSave()
      if (!latest || latest.generation <= settledGeneration) {
        return Promise.resolve()
      }
      return persist(latest, requestOptions)
    },
    listenForClose(target: {
      addEventListener(type: "pagehide", listener: () => void): void
      removeEventListener(type: "pagehide", listener: () => void): void
    }) {
      const flushLatest = () => {
        void debouncer.flush({ keepalive: true })
      }
      target.addEventListener("pagehide", flushLatest)
      return () => {
        target.removeEventListener("pagehide", flushLatest)
        flushLatest()
      }
    },
    cancel() {
      generation += 1
      clearScheduledSave()
      latest = undefined
    },
  }
  return debouncer
}

export async function retryCaptureJob(
  api: Pick<ExtensionApi, "retry">,
  storage: Pick<InterviewJobStorage, "save">,
  jobId: string,
) {
  const retried = await api.retry(jobId)
  return persistReturnedCaptureJob(storage, retried)
}

export async function cancelCaptureJob(
  api: Pick<ExtensionApi, "cancel">,
  storage: Pick<InterviewJobStorage, "clear">,
  jobId: string,
) {
  const cancelled = await api.cancel(jobId)
  await storage.clear()
  return cancelled
}

export class PostConfirmStorageCleanupError extends Error {
  readonly code = "STORAGE_CLEANUP_REQUIRED"

  constructor(
    readonly experience: InterviewExperience,
    readonly storageError: unknown,
  ) {
    super("面经已确认，但本地任务标记尚未清除。")
    this.name = "PostConfirmStorageCleanupError"
  }
}

export function createConfirmationAction(
  api: Pick<ExtensionApi, "confirm">,
  storage: Pick<InterviewJobStorage, "clear">,
) {
  const confirmed = new Map<
    string,
    { experience: InterviewExperience; storageCleared: boolean }
  >()
  const pending = new Map<string, Promise<InterviewExperience>>()

  return function confirm(jobId: string, draft: InterviewExperienceDraft) {
    const existing = pending.get(jobId)
    if (existing) return existing
    const completed = confirmed.get(jobId)
    if (completed) {
      if (completed.storageCleared) return Promise.resolve(completed.experience)
      const clearing = storage
        .clear()
        .then(() => {
          completed.storageCleared = true
          return completed.experience
        })
        .catch((error: unknown) => {
          throw new PostConfirmStorageCleanupError(
            completed.experience,
            error,
          )
        })
      pending.set(jobId, clearing)
      return clearing.finally(() => pending.delete(jobId))
    }
    const request = api
      .confirm(jobId, draft)
      .then(async (experience) => {
        const completedConfirmation = {
          experience,
          storageCleared: false,
        }
        confirmed.set(jobId, completedConfirmation)
        try {
          await storage.clear()
        } catch (error) {
          throw new PostConfirmStorageCleanupError(experience, error)
        }
        completedConfirmation.storageCleared = true
        return experience
      })
      .finally(() => pending.delete(jobId))
    pending.set(jobId, request)
    return request
  }
}

interface SidePanelDependencies {
  api: ExtensionApi
  storage: InterviewJobStorage
  browser: BrowserCaptureAdapter
  fetchImage: typeof fetch
}

interface SidePanelAppProps {
  initialState?: SidePanelState
  autoStart?: boolean
  dependencies?: SidePanelDependencies
}

function createProductionDependencies(): SidePanelDependencies {
  return {
    api: createExtensionApi(fetch),
    storage: createInterviewJobStorage(),
    browser: createChromeBrowserCapture(chrome),
    fetchImage: fetch,
  }
}

function platformLabel(platform: "nowcoder" | "xiaohongshu") {
  return platform === "nowcoder" ? "牛客" : "小红书"
}

function statusIcon(state: SidePanelState) {
  const iconProps = { size: 15, strokeWidth: 2, "aria-hidden": true }
  switch (state.kind) {
    case "orbit-offline":
      return <WifiOff {...iconProps} />
    case "unsupported":
    case "failed":
    case "cleanup-required":
    case "storage-finalization":
      return <AlertCircle {...iconProps} />
    case "confirmed":
      return <CircleCheck {...iconProps} />
    case "uploading":
      return <CloudUpload {...iconProps} />
    case "extracting":
    case "processing":
      return <FileSearch {...iconProps} />
    default:
      return <BookOpen {...iconProps} />
  }
}

function statusLabel(state: SidePanelState) {
  switch (state.kind) {
    case "checking":
      return "正在检查当前页面"
    case "orbit-offline":
      return "Orbit 未连接"
    case "unsupported":
      return "当前页面不受支持"
    case "collectable":
      return "当前页面可以采集"
    case "extracting":
      return "正在提取页面内容"
    case "uploading":
      return "正在上传到 Orbit"
    case "processing":
      return "Orbit 正在识别"
    case "review":
      return state.dirty ? "草稿等待保存" : "草稿已同步"
    case "failed":
      return "采集未完成"
    case "cleanup-required":
      return "等待本地清理"
    case "storage-finalization":
      return "等待保存本地任务标记"
    case "confirmed":
      return "面经已确认"
  }
}

function firstValidationTarget(errors: InterviewDraftValidationErrors) {
  if (errors.company) return "company"
  if (errors.position) return "position"
  if (errors.questions) return "add-question"
  const firstQuestion = Object.keys(errors.questionErrors ?? {})[0]
  return firstQuestion === undefined ? undefined : `question-${firstQuestion}-text`
}

export function SidePanelApp({
  initialState = initialSidePanelState,
  autoStart = true,
  dependencies,
}: SidePanelAppProps) {
  const [state, dispatch] = useReducer(sidePanelReducer, initialState)
  const [pendingAction, setPendingAction] = useState<
    "cancel" | "cleanup" | "collect" | "confirm" | "retry" | "save-job" | undefined
  >()
  const [validationErrors, setValidationErrors] =
    useState<InterviewDraftValidationErrors>({})
  const [draftSaveError, setDraftSaveError] = useState<string>()
  const dependenciesRef = useRef<SidePanelDependencies | undefined>(dependencies)
  const confirmationRef = useRef<
    ReturnType<typeof createConfirmationAction> | undefined
  >(undefined)
  const draftSaverRef = useRef<
    ReturnType<typeof createDraftSaveDebouncer> | undefined
  >(undefined)
  const questionSequence = useRef(0)
  const [questionKeys, setQuestionKeys] = useState<string[]>(() =>
    initialState.kind === "review"
      ? initialState.draft.questions.map(
          (_, index) => `${initialState.job.id}-question-${index + 1}`,
        )
      : [],
  )

  if (dependencies) dependenciesRef.current = dependencies
  const getDependencies = useCallback(() => {
    dependenciesRef.current ??= createProductionDependencies()
    return dependenciesRef.current
  }, [])
  const getDraftSaver = useCallback(() => {
    draftSaverRef.current ??= createDraftSaveDebouncer({
      save: getDependencies().api.saveDraft,
    })
    return draftSaverRef.current
  }, [getDependencies])

  const checkCurrentContext = useCallback(async () => {
    dispatch({ type: "page.checking" })
    dispatch({
      type: "state.restored",
      state: await restoreSidePanel(getDependencies()),
    })
  }, [getDependencies])

  useEffect(() => {
    if (!autoStart) return
    let active = true
    void (async () => {
      const restored = await restoreSidePanel(getDependencies())
      if (!active) return
      dispatch({ type: "state.restored", state: restored })
    })()
    return () => {
      active = false
    }
  }, [autoStart, getDependencies])

  useEffect(() => {
    if (state.kind !== "processing") return
    const current = getDependencies()
    return startProcessingJobPolling({
      jobId: state.job.id,
      poll: current.api.getJob,
      onJob: (nextJob) => dispatch({ type: "capture.job", job: nextJob }),
      onError: (error) =>
        dispatch({
          type: "capture.failed",
          job: state.job,
          message: errorMessage(error),
          retryable: errorRetryable(error),
        }),
    })
  }, [getDependencies, state])

  useEffect(() => {
    if (!autoStart) return
    return getDraftSaver().listenForClose(window)
  }, [autoStart, getDraftSaver])

  useEffect(() => {
    if (state.kind !== "review" || !state.dirty) return
    getDraftSaver().schedule(
      state.job.id,
      state.draft,
      state.job.draftRevision,
      (savedJob, savedDraft) => {
        setDraftSaveError(undefined)
        dispatch({ type: "draft.saved", job: savedJob, savedDraft })
      },
      (error) => setDraftSaveError(errorMessage(error)),
    )
  }, [getDraftSaver, state])

  useEffect(() => {
    if (state.kind !== "review") draftSaverRef.current?.cancel()
  }, [state.kind])

  useEffect(() => {
    if (state.kind !== "review") return
    setQuestionKeys((current) =>
      state.draft.questions.map(
        (_, index) =>
          current[index] ??
          `${state.job.id}-question-${++questionSequence.current}`,
      ),
    )
  }, [
    state.kind,
    state.kind === "review" ? state.job.id : "",
    state.kind === "review" ? state.draft.questions.length : 0,
  ])

  async function handleCollect() {
    if (pendingAction) return
    setPendingAction("collect")
    const current = getDependencies()
    try {
      const captured = await collectCurrentTab({
        ...current,
        onPhase: (phase) =>
          dispatch({
            type:
              phase === "extracting"
                ? "capture.extracting"
                : "capture.uploading",
          }),
      })
      await persistReturnedCaptureJob(current.storage, captured)
      dispatch({ type: "capture.job", job: captured })
    } catch (error) {
      if (error instanceof CaptureJobStorageFinalizationError) {
        dispatch({
          type: "capture.storage-finalization",
          job: error.job,
          message: error.message,
        })
      } else if (
        error instanceof SidePanelWorkflowError &&
        error.code === "ORBIT_OFFLINE"
      ) {
        dispatch({ type: "orbit.offline", message: error.message })
      } else if (
        error instanceof SidePanelWorkflowError &&
        error.code === "UNSUPPORTED_PAGE"
      ) {
        const tab = await current.browser.queryActiveTab()
        dispatch({ type: "page.unsupported", url: tab?.url ?? "" })
      } else {
        dispatch({
          type: "capture.failed",
          message: errorMessage(error),
          retryable: errorRetryable(error),
        })
      }
    } finally {
      setPendingAction(undefined)
    }
  }

  async function handleRetry() {
    if (pendingAction) return
    setPendingAction("retry")
    const current = getDependencies()
    try {
      if (state.kind === "failed" && state.job?.status === "failed") {
        dispatch({
          type: "capture.job",
          job: await retryCaptureJob(
            current.api,
            current.storage,
            state.job.id,
          ),
        })
      } else if (state.kind === "failed" && state.job) {
        dispatch({
          type: "capture.job",
          job: await current.api.getJob(state.job.id),
        })
      } else {
        await checkCurrentContext()
      }
    } catch (error) {
      if (error instanceof CaptureJobStorageFinalizationError) {
        dispatch({
          type: "capture.storage-finalization",
          job: error.job,
          message: error.message,
        })
      } else {
        dispatch({
          type: "capture.failed",
          ...(state.kind === "failed" && state.job ? { job: state.job } : {}),
          message: errorMessage(error),
          retryable: errorRetryable(error),
        })
      }
    } finally {
      setPendingAction(undefined)
    }
  }

  async function handleCancel(jobId: string) {
    if (pendingAction) return
    setPendingAction("cancel")
    const current = getDependencies()
    try {
      await cancelCaptureJob(current.api, current.storage, jobId)
      await checkCurrentContext()
    } catch (error) {
      dispatch({
        type: "capture.failed",
        ...(state.kind === "processing" ||
        state.kind === "review" ||
        state.kind === "storage-finalization" ||
        (state.kind === "failed" && state.job)
          ? { job: state.job }
          : {}),
        message: errorMessage(error),
        retryable: errorRetryable(error),
      })
    } finally {
      setPendingAction(undefined)
    }
  }

  async function handleStorageSaveRetry() {
    if (state.kind !== "storage-finalization" || pendingAction) return
    setPendingAction("save-job")
    try {
      const saved = await persistReturnedCaptureJob(
        getDependencies().storage,
        state.job,
      )
      dispatch({ type: "capture.job", job: saved })
    } catch (error) {
      if (error instanceof CaptureJobStorageFinalizationError) {
        dispatch({
          type: "capture.storage-finalization",
          job: error.job,
          message: error.message,
        })
      } else {
        dispatch({
          type: "capture.storage-finalization",
          job: state.job,
          message: errorMessage(error),
        })
      }
    } finally {
      setPendingAction(undefined)
    }
  }

  async function handleConfirm() {
    if (state.kind !== "review" || pendingAction) return
    const errors = validateInterviewDraft(state.draft)
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors)
      const target = firstValidationTarget(errors)
      if (target) document.getElementById(target)?.focus()
      return
    }
    setPendingAction("confirm")
    const current = getDependencies()
    confirmationRef.current ??= createConfirmationAction(
      current.api,
      current.storage,
    )
    try {
      const confirmedExperience = await confirmationRef.current(
        state.job.id,
        normalizeInterviewDraft(state.draft),
      )
      dispatch({
        type: "capture.confirmed",
        experience: confirmedExperience,
      })
    } catch (error) {
      if (error instanceof PostConfirmStorageCleanupError) {
        dispatch({
          type: "capture.cleanup-required",
          experience: error.experience,
          message: error.message,
        })
      } else {
        dispatch({
          type: "capture.failed",
          job: state.job,
          message: errorMessage(error),
          retryable: errorRetryable(error),
        })
      }
    } finally {
      setPendingAction(undefined)
    }
  }

  async function handleCleanupRetry() {
    if (state.kind !== "cleanup-required" || pendingAction) return
    setPendingAction("cleanup")
    try {
      await getDependencies().storage.clear()
      if (state.experience) {
        dispatch({
          type: "capture.confirmed",
          experience: state.experience,
        })
      } else {
        await checkCurrentContext()
      }
    } catch (error) {
      dispatch({
        type: "capture.cleanup-required",
        ...(state.experience ? { experience: state.experience } : {}),
        ...(state.job ? { job: state.job } : {}),
        message: errorMessage(error),
      })
    } finally {
      setPendingAction(undefined)
    }
  }

  function updateDraft(nextDraft: InterviewExperienceDraft) {
    setValidationErrors({})
    setDraftSaveError(undefined)
    dispatch({ type: "draft.changed", draft: nextDraft })
  }

  function updateQuestion(
    draft: InterviewExperienceDraft,
    index: number,
    patch: Partial<InterviewQuestionDraft>,
  ) {
    updateDraft({
      ...draft,
      questions: draft.questions.map((question, position) =>
        position === index ? { ...question, ...patch } : question,
      ),
    })
  }

  function addQuestion(draft: InterviewExperienceDraft) {
    setQuestionKeys((current) => [
      ...current,
      `new-question-${++questionSequence.current}`,
    ])
    updateDraft({
      ...draft,
      questions: addInterviewQuestion(draft.questions),
    })
  }

  function deleteQuestion(draft: InterviewExperienceDraft, index: number) {
    setQuestionKeys((current) =>
      current.filter((_, position) => position !== index),
    )
    updateDraft({
      ...draft,
      questions: removeInterviewQuestion(draft.questions, index),
    })
  }

  function moveQuestion(
    draft: InterviewExperienceDraft,
    index: number,
    direction: -1 | 1,
  ) {
    const destination = index + direction
    if (destination < 0 || destination >= draft.questions.length) return
    setQuestionKeys((current) => {
      const next = [...current]
      const moving = next[index]
      if (moving === undefined) return current
      next.splice(index, 1)
      next.splice(destination, 0, moving)
      return next
    })
    updateDraft({
      ...draft,
      questions: moveInterviewQuestion(draft.questions, index, direction),
    })
  }

  const statusTone =
    state.kind === "failed" ||
    state.kind === "cleanup-required" ||
    state.kind === "storage-finalization" ||
    state.kind === "orbit-offline" ||
    state.kind === "unsupported"
      ? "error"
      : state.kind === "confirmed"
        ? "success"
        : "info"

  return (
    <main className="panel-shell">
      <header className="panel-header">
        <div className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path
              d="M4.5 5.5c2.8-.6 5.1.1 7.5 2.1v10c-2.4-2-4.7-2.7-7.5-2.1v-10Z"
              fill="currentColor"
              opacity=".92"
            />
            <path
              d="M19.5 5.5c-2.8-.6-5.1.1-7.5 2.1v10c2.4-2 4.7-2.7 7.5-2.1v-10Z"
              fill="currentColor"
              opacity=".92"
            />
            <path
              d="M12 7.6v10"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div>
          <p className="brand-name">Orbit</p>
          <p className="brand-subtitle">面经采集</p>
        </div>
      </header>

      <section className="panel-content" aria-labelledby="panel-title">
        <div
          className={`status-card status-card--${statusTone}`}
          role={statusTone === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {statusIcon(state)}
          <span>{statusLabel(state)}</span>
        </div>

        {state.kind === "checking" && (
          <div className="intro-copy">
            <p className="eyebrow">当前页面</p>
            <h1 id="panel-title">正在准备面经采集</h1>
            <p>正在确认 Orbit 连接和当前标签页。</p>
          </div>
        )}

        {state.kind === "orbit-offline" && (
          <div className="intro-copy">
            <p className="eyebrow">需要 Orbit</p>
            <h1 id="panel-title">无法开始采集</h1>
            <p>{state.message}</p>
          </div>
        )}

        {state.kind === "unsupported" && (
          <div className="intro-copy">
            <p className="eyebrow">当前页面</p>
            <h1 id="panel-title">此页面暂不支持</h1>
            <p>请打开牛客面经详情或小红书图文详情页。</p>
            {state.url && <p className="source-url">{state.url}</p>}
          </div>
        )}

        {state.kind === "collectable" && (
          <div className="intro-copy">
            <p className="eyebrow">{platformLabel(state.platform)}面经</p>
            <h1 id="panel-title">准备采集当前页面</h1>
            <p>{state.title}</p>
          </div>
        )}

        {(state.kind === "extracting" || state.kind === "uploading") && (
          <div className="intro-copy">
            <p className="eyebrow">采集进行中</p>
            <h1 id="panel-title">
              {state.kind === "extracting" ? "正在读取页面" : "正在发送内容"}
            </h1>
            <p>请保持当前标签页打开，完成前不要切换页面。</p>
          </div>
        )}

        {state.kind === "processing" && (
          <div className="intro-copy">
            <p className="eyebrow">Orbit 识别中</p>
            <h1 id="panel-title">正在整理面经草稿</h1>
            <p>面经草稿完成后会自动进入复核页面。</p>
            <SourceMetadata job={state.job} />
          </div>
        )}

        {state.kind === "failed" && (
          <div className="intro-copy">
            <p className="eyebrow">需要处理</p>
            <h1 id="panel-title">这次采集没有完成</h1>
            <p>{state.message}</p>
            {state.job && <SourceMetadata job={state.job} />}
          </div>
        )}

        {state.kind === "cleanup-required" && (
          <div className="intro-copy">
            <p className="eyebrow">面经已由 Orbit 确认</p>
            <h1 id="panel-title">还需完成本地清理</h1>
            <p>{state.message}</p>
            {state.experience && (
              <p>
                {state.experience.company} · {state.experience.position}
              </p>
            )}
            {state.job && <SourceMetadata job={state.job} />}
          </div>
        )}

        {state.kind === "storage-finalization" && (
          <div className="intro-copy">
            <p className="eyebrow">Orbit 已接收任务</p>
            <h1 id="panel-title">还需保存本地任务标记</h1>
            <p>{state.message}</p>
            <SourceMetadata job={state.job} />
          </div>
        )}

        {state.kind === "confirmed" && (
          <div className="intro-copy confirmed-copy">
            <CircleCheck size={32} strokeWidth={1.75} aria-hidden="true" />
            <p className="eyebrow">已保存到 Orbit</p>
            <h1 id="panel-title">
              {state.experience.company} · {state.experience.position}
            </h1>
            <p>面经与题目已确认，可以在 Orbit 的面经收集中查看。</p>
          </div>
        )}

        {state.kind === "review" && (
          <form
            className="review-form"
            aria-labelledby="panel-title"
            onSubmit={(event) => {
              event.preventDefault()
              void handleConfirm()
            }}
          >
            <div className="review-heading">
              <div>
                <p className="eyebrow">逐项复核</p>
                <h1 id="panel-title">确认面经内容</h1>
              </div>
              <span className="save-state" aria-live="polite">
                {draftSaveError
                  ? "自动保存失败"
                  : state.dirty
                    ? "保存中…"
                    : "已保存"}
              </span>
            </div>
            {draftSaveError && (
              <p className="form-error form-error--standalone" role="alert">
                {draftSaveError}
              </p>
            )}
            <SourceMetadata job={state.job} />

            <fieldset className="form-section">
              <legend>基本信息</legend>
              <div className="field-grid">
                <Field
                  id="company"
                  label="公司"
                  required
                  error={validationErrors.company}
                >
                  <input
                    id="company"
                    required
                    value={state.draft.company}
                    aria-invalid={Boolean(validationErrors.company)}
                    aria-describedby={validationErrors.company ? "company-error" : undefined}
                    onChange={(event) =>
                      updateDraft({
                        ...state.draft,
                        company: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field
                  id="position"
                  label="岗位"
                  required
                  error={validationErrors.position}
                >
                  <input
                    id="position"
                    required
                    value={state.draft.position}
                    aria-invalid={Boolean(validationErrors.position)}
                    aria-describedby={validationErrors.position ? "position-error" : undefined}
                    onChange={(event) =>
                      updateDraft({
                        ...state.draft,
                        position: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field id="interview-round" label="面试轮次">
                  <input
                    id="interview-round"
                    value={state.draft.interviewRound ?? ""}
                    onChange={(event) =>
                      updateDraft({
                        ...state.draft,
                        interviewRound: event.target.value || null,
                      })
                    }
                  />
                </Field>
                <Field id="interview-time" label="面试时间">
                  <input
                    id="interview-time"
                    value={state.draft.interviewTime ?? ""}
                    placeholder="例如：2026-08-18 14:00"
                    onChange={(event) =>
                      updateDraft({
                        ...state.draft,
                        interviewTime: event.target.value || null,
                      })
                    }
                  />
                </Field>
              </div>
              <Field id="interview-evaluation" label="面试评价">
                <textarea
                  id="interview-evaluation"
                  rows={3}
                  value={state.draft.interviewEvaluation ?? ""}
                  onChange={(event) =>
                    updateDraft({
                      ...state.draft,
                      interviewEvaluation: event.target.value || null,
                    })
                  }
                />
              </Field>
            </fieldset>

            <fieldset className="form-section question-section">
              <legend>面试题目</legend>
              {validationErrors.questions && (
                <p className="form-error" role="alert">
                  {validationErrors.questions}
                </p>
              )}
              <div className="question-list">
                {state.draft.questions.map((question, index) => {
                  const questionError = validationErrors.questionErrors?.[index]
                  return (
                    <article
                      className="question-card"
                      key={questionKeys[index] ?? `${state.job.id}-${index}`}
                    >
                      <header className="question-card__header">
                        <h2>题目 {index + 1}</h2>
                        <div className="question-actions">
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`上移题目 ${index + 1}`}
                            title="上移"
                            disabled={index === 0}
                            onClick={() => moveQuestion(state.draft, index, -1)}
                          >
                            <ChevronUp size={16} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`下移题目 ${index + 1}`}
                            title="下移"
                            disabled={index === state.draft.questions.length - 1}
                            onClick={() => moveQuestion(state.draft, index, 1)}
                          >
                            <ChevronDown size={16} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="icon-button icon-button--danger"
                            aria-label={`删除题目 ${index + 1}`}
                            title="删除题目"
                            onClick={() => deleteQuestion(state.draft, index)}
                          >
                            <Trash2 size={15} aria-hidden="true" />
                          </button>
                        </div>
                      </header>
                      <Field
                        id={`question-${index}-text`}
                        label="题目内容"
                        required
                        error={questionError}
                      >
                        <textarea
                          id={`question-${index}-text`}
                          required
                          rows={2}
                          value={question.question}
                          aria-invalid={Boolean(questionError)}
                          aria-describedby={questionError ? `question-${index}-text-error` : undefined}
                          onChange={(event) =>
                            updateQuestion(state.draft, index, {
                              question: event.target.value,
                            })
                          }
                        />
                      </Field>
                      <Field id={`question-${index}-answer`} label="参考答案">
                        <textarea
                          id={`question-${index}-answer`}
                          rows={3}
                          value={question.answer ?? ""}
                          onChange={(event) =>
                            updateQuestion(state.draft, index, {
                              answer: event.target.value || null,
                            })
                          }
                        />
                      </Field>
                    </article>
                  )
                })}
              </div>
              <button
                id="add-question"
                type="button"
                className="secondary-button add-question-button"
                onClick={() => addQuestion(state.draft)}
              >
                <Plus size={16} aria-hidden="true" />
                新增题目
              </button>
            </fieldset>

            <div className="review-actions">
              <button
                type="button"
                className="secondary-button danger-button"
                disabled={Boolean(pendingAction)}
                onClick={() => void handleCancel(state.job.id)}
              >
                <X size={16} aria-hidden="true" />
                {pendingAction === "cancel" ? "取消中…" : "取消采集"}
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={Boolean(pendingAction)}
              >
                <Check size={16} aria-hidden="true" />
                {pendingAction === "confirm" ? "确认中…" : "确认保存"}
              </button>
            </div>
          </form>
        )}
      </section>

      {state.kind !== "review" && (
        <footer className="panel-footer">
          {state.kind === "collectable" && (
            <button
              type="button"
              className="primary-button"
              disabled={Boolean(pendingAction)}
              onClick={() => void handleCollect()}
            >
              <CloudUpload size={16} aria-hidden="true" />
              {pendingAction === "collect" ? "准备中…" : "开始采集"}
            </button>
          )}
          {(state.kind === "orbit-offline" ||
            state.kind === "unsupported") && (
            <button
              type="button"
              className="secondary-button"
              disabled={Boolean(pendingAction)}
              onClick={() => void handleRetry()}
            >
              <RefreshCw size={16} aria-hidden="true" />
              重新检查
            </button>
          )}
          {state.kind === "processing" && (
            <button
              type="button"
              className="secondary-button danger-button"
              disabled={Boolean(pendingAction)}
              onClick={() => void handleCancel(state.job.id)}
            >
              <X size={16} aria-hidden="true" />
              {pendingAction === "cancel" ? "取消中…" : "取消采集"}
            </button>
          )}
          {state.kind === "failed" && (
            <div className="footer-actions">
              {state.retryable && (
                <button
                  type="button"
                  className="primary-button"
                  disabled={Boolean(pendingAction)}
                  onClick={() => void handleRetry()}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                  {pendingAction === "retry" ? "重试中…" : "重试"}
                </button>
              )}
              {state.job && (
                <button
                  type="button"
                  className="secondary-button danger-button"
                  disabled={Boolean(pendingAction)}
                  onClick={() => void handleCancel(state.job!.id)}
                >
                  <X size={16} aria-hidden="true" />
                  {state.job.status === "ready" ? "丢弃空结果" : "取消采集"}
                </button>
              )}
            </div>
          )}
          {state.kind === "cleanup-required" && (
            <button
              type="button"
              className="primary-button"
              disabled={Boolean(pendingAction)}
              onClick={() => void handleCleanupRetry()}
            >
              <RefreshCw size={16} aria-hidden="true" />
              {pendingAction === "cleanup" ? "清理中…" : "重试本地清理"}
            </button>
          )}
          {state.kind === "storage-finalization" && (
            <div className="footer-actions">
              <button
                type="button"
                className="primary-button"
                disabled={Boolean(pendingAction)}
                onClick={() => void handleStorageSaveRetry()}
              >
                <RefreshCw size={16} aria-hidden="true" />
                {pendingAction === "save-job" ? "保存中…" : "重试保存任务"}
              </button>
              <button
                type="button"
                className="secondary-button danger-button"
                disabled={Boolean(pendingAction)}
                onClick={() => void handleCancel(state.job.id)}
              >
                <X size={16} aria-hidden="true" />
                {pendingAction === "cancel" ? "取消中…" : "取消采集"}
              </button>
            </div>
          )}
          {state.kind === "checking" && (
            <button type="button" className="primary-button" disabled>
              <FileSearch size={16} aria-hidden="true" />
              正在检查
            </button>
          )}
          {(state.kind === "extracting" || state.kind === "uploading") && (
            <button type="button" className="primary-button" disabled>
              <CloudUpload size={16} aria-hidden="true" />
              采集中
            </button>
          )}
          {state.kind === "confirmed" && (
            <button
              type="button"
              className="primary-button"
              disabled={Boolean(pendingAction)}
              onClick={() => void checkCurrentContext()}
            >
              <Check size={16} aria-hidden="true" />
              完成
            </button>
          )}
        </footer>
      )}
    </main>
  )
}

function Field({
  id,
  label,
  required = false,
  error,
  children,
}: {
  id: string
  label: string
  required?: boolean
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function SourceMetadata({ job }: { job: InterviewCaptureJob }) {
  return (
    <dl className="source-metadata" aria-label="来源信息">
      <div>
        <dt>来源</dt>
        <dd>{platformLabel(job.platform)}</dd>
      </div>
      <div>
        <dt>页面标题</dt>
        <dd>{job.pageTitle}</dd>
      </div>
      <div>
        <dt>页面地址</dt>
        <dd>{job.sourceUrl}</dd>
      </div>
      <div>
        <dt>内容状态</dt>
        <dd>{job.contentCompleteness === "complete" ? "完整" : "部分内容"}</dd>
      </div>
      {job.publishedAt && (
        <div>
          <dt>发布时间</dt>
          <dd>{job.publishedAt}</dd>
        </div>
      )}
      {job.failedImageIndexes.length > 0 && (
        <div>
          <dt>未获取图片</dt>
          <dd>{job.failedImageIndexes.join("、")}</dd>
        </div>
      )}
    </dl>
  )
}

export default SidePanelApp
