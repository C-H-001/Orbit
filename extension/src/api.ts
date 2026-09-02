import type {
  InterviewCaptureJob,
  InterviewExperience,
  InterviewExperienceDraft,
  InterviewPlatform,
} from "../../shared/interview-experience"

const ORBIT_API_ORIGIN = "http://127.0.0.1:8787"
const EXTENSION_HEADER = "X-Orbit-Extension"
const IMAGE_MIME_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const

export type SupportedImageMime = keyof typeof IMAGE_MIME_EXTENSIONS

export interface InterviewCaptureMetadata {
  platform: InterviewPlatform
  sourceUrl: string
  pageTitle: string
  publishedAt: string | null
  contentCompleteness: "complete" | "partial"
  pageText: string
  imageIndexes: number[]
  imageUrls: Array<{ index: number; url: string }>
  failedImageIndexes: number[]
}

export interface CapturedInterviewImage {
  index: number
  blob: Blob
}

export interface InterviewCaptureUpload {
  metadata: InterviewCaptureMetadata
  images: CapturedInterviewImage[]
}

export interface DraftSaveRequestOptions {
  keepalive?: boolean
}

interface OrbitErrorEnvelope {
  error?: {
    code?: unknown
    message?: unknown
    retryable?: unknown
    requestId?: unknown
  }
}

export class ExtensionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = "ExtensionApiError"
  }
}

function supportedImageMime(value: string): value is SupportedImageMime {
  return value in IMAGE_MIME_EXTENSIONS
}

function imageFilename(index: number, mimeType: SupportedImageMime) {
  return `image-${index}.${IMAGE_MIME_EXTENSIONS[mimeType]}`
}

export function createCaptureFormData(input: InterviewCaptureUpload) {
  const images = [...input.images].sort((left, right) => left.index - right.index)
  const form = new FormData()
  form.append(
    "metadata",
    JSON.stringify({
      ...input.metadata,
      imageIndexes: images.map(({ index }) => index),
    }),
  )
  for (const image of images) {
    if (!supportedImageMime(image.blob.type)) {
      throw new Error("UNSUPPORTED_IMAGE_MIME")
    }
    form.append(
      "images",
      image.blob,
      imageFilename(image.index, image.blob.type),
    )
  }
  return form
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function errorFromResponse(response: Response, value: unknown) {
  const envelope = value as OrbitErrorEnvelope | undefined
  const details = envelope?.error
  const message =
    typeof details?.message === "string"
      ? details.message
      : `Orbit 请求失败（${response.status}）。`
  return new ExtensionApiError(
    message,
    response.status,
    typeof details?.code === "string" ? details.code : "HTTP_ERROR",
    typeof details?.retryable === "boolean"
      ? details.retryable
      : response.status >= 500,
    typeof details?.requestId === "string" ? details.requestId : undefined,
  )
}

export function createExtensionApi(fetchImpl: typeof fetch = fetch) {
  async function request<T>(pathname: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    headers.set(EXTENSION_HEADER, "1")
    const response = await fetchImpl(`${ORBIT_API_ORIGIN}${pathname}`, {
      ...init,
      credentials: "omit",
      headers,
    })
    const value = await readJson(response)
    if (!response.ok) throw errorFromResponse(response, value)
    return value as T
  }

  function jsonRequest<T>(
    pathname: string,
    method: "PATCH" | "POST",
    body?: unknown,
    requestOptions: DraftSaveRequestOptions = {},
  ) {
    const headers = new Headers()
    if (body !== undefined) headers.set("content-type", "application/json")
    return request<T>(pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive: requestOptions.keepalive,
    })
  }

  return {
    async health() {
      return request<{ status: "ok" }>("/api/health")
    },
    async createCaptureJob(input: InterviewCaptureUpload) {
      const response = await request<{
        jobId: string
        job: InterviewCaptureJob
      }>("/api/interview-capture-jobs", {
        method: "POST",
        body: createCaptureFormData(input),
      })
      return response.job
    },
    async getActiveJob() {
      try {
        const response = await request<{ job: InterviewCaptureJob }>(
          "/api/interview-capture-jobs/active",
        )
        return response.job
      } catch (error) {
        if (error instanceof ExtensionApiError && error.status === 404) {
          return undefined
        }
        throw error
      }
    },
    async getJob(id: string) {
      const response = await request<{ job: InterviewCaptureJob }>(
        `/api/interview-capture-jobs/${encodeURIComponent(id)}`,
      )
      return response.job
    },
    async saveDraft(
      id: string,
      draft: InterviewExperienceDraft,
      revision: number,
      requestOptions: DraftSaveRequestOptions = {},
    ) {
      const response = await jsonRequest<{ job: InterviewCaptureJob }>(
        `/api/interview-capture-jobs/${encodeURIComponent(id)}/draft`,
        "PATCH",
        { draft, revision },
        requestOptions,
      )
      return response.job
    },
    async retry(id: string) {
      const response = await jsonRequest<{ job: InterviewCaptureJob }>(
        `/api/interview-capture-jobs/${encodeURIComponent(id)}/retry`,
        "POST",
      )
      return response.job
    },
    async cancel(id: string) {
      return jsonRequest<InterviewCaptureJob>(
        `/api/interview-capture-jobs/${encodeURIComponent(id)}/cancel`,
        "POST",
      )
    },
    async confirm(id: string, draft: InterviewExperienceDraft) {
      const response = await jsonRequest<{ experience: InterviewExperience }>(
        `/api/interview-capture-jobs/${encodeURIComponent(id)}/confirm`,
        "POST",
        draft,
      )
      return response.experience
    },
  }
}

export type ExtensionApi = ReturnType<typeof createExtensionApi>
