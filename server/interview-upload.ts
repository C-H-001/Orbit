import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { NextFunction, Request, Response } from "express"
import multer from "multer"
import { z } from "zod"
import { normalizeInterviewSourceUrl } from "../shared/interview-experience"
import type { CreateInterviewCaptureInput } from "./interview-capture"
import {
  detectInterviewImageType,
  detectImageMime,
  type InterviewImageMime,
} from "./interview-files"

const MAX_TOTAL_BYTES = 80 * 1024 * 1024
const IMAGE_MIMES = new Set<InterviewImageMime>([
  "image/jpeg",
  "image/png",
  "image/webp",
])
const CLIENT_MULTIPART_PARSER_MESSAGES = new Set([
  "Malformed content type",
  "Multipart: Boundary not found",
  "Malformed part header",
  "Unexpected end of file",
  "Unexpected end of form",
  "Unexpected end of multipart",
])

const captureMetadataSchema = z.object({
  platform: z.enum(["nowcoder", "xiaohongshu"]),
  sourceUrl: z.string().url(),
  pageTitle: z.string().trim().min(1),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  contentCompleteness: z.enum(["complete", "partial"]),
  pageText: z
    .string()
    .max(2 * 1024 * 1024)
    .default(""),
  imageIndexes: z.array(z.number().int().min(1)).max(20).default([]),
  imageUrls: z.array(z.object({
    index: z.number().int().min(1),
    url: z.string().url(),
  })).max(20).default([]),
  failedImageIndexes: z.array(z.number().int().min(1)).max(20).default([]),
})

interface InterviewUploadRequest extends Request {
  interviewCaptureJobId?: string
  interviewCaptureUploadIndex?: number
  files?: Express.Multer.File[]
}

export class InterviewUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryable = false,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

function isClientMultipartParserError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    CLIENT_MULTIPART_PARSER_MESSAGES.has(error.message)
  )
}

function extensionFor(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg"
  if (mimeType === "image/png") return "png"
  if (mimeType === "image/webp") return "webp"
  return "bin"
}

export function cleanupInterviewUpload(
  request: Request,
  rootDirectory: string,
) {
  const jobId = (request as InterviewUploadRequest).interviewCaptureJobId
  if (!jobId) return
  try {
    rmSync(path.join(path.resolve(rootDirectory), jobId), {
      recursive: true,
      force: true,
    })
  } catch (error) {
    console.error("Unable to clean rejected interview upload", error)
  }
}

export function createInterviewUploadMiddleware(rootDirectory: string) {
  const resolvedRoot = path.resolve(rootDirectory)
  const storage = multer.diskStorage({
    destination(request, _file, callback) {
      const uploadRequest = request as InterviewUploadRequest
      const jobId = uploadRequest.interviewCaptureJobId ?? randomUUID()
      uploadRequest.interviewCaptureJobId = jobId
      const directory = path.join(resolvedRoot, jobId)
      try {
        mkdirSync(directory, { recursive: true })
        callback(null, directory)
      } catch (error) {
        callback(error as Error, directory)
      }
    },
    filename(request, file, callback) {
      const uploadRequest = request as InterviewUploadRequest
      const index = (uploadRequest.interviewCaptureUploadIndex ?? 0) + 1
      uploadRequest.interviewCaptureUploadIndex = index
      callback(null, `${index}.${extensionFor(file.mimetype)}`)
    },
  })
  const upload = multer({
    storage,
    fileFilter(_request, file, callback) {
      if (!IMAGE_MIMES.has(file.mimetype as InterviewImageMime)) {
        callback(
          new InterviewUploadError(
            "Unsupported interview image type",
            415,
            "UNSUPPORTED_MEDIA_TYPE",
          ),
        )
        return
      }
      callback(null, true)
    },
    limits: {
      files: 20,
      fileSize: 7 * 1024 * 1024,
      fields: 4,
      fieldSize: 2 * 1024 * 1024,
    },
  }).array("images", 20)

  return function uploadInterviewCapture(
    request: Request,
    response: Response,
    next: NextFunction,
  ) {
    const uploadRequest = request as InterviewUploadRequest
    uploadRequest.interviewCaptureJobId = randomUUID()
    upload(request, response, (error) => {
      if (!error) return next()
      cleanupInterviewUpload(request, resolvedRoot)
      if (error instanceof InterviewUploadError) return next(error)
      if (error instanceof multer.MulterError) {
        const tooLarge = [
          "LIMIT_FILE_SIZE",
          "LIMIT_FILE_COUNT",
          "LIMIT_FIELD_COUNT",
          "LIMIT_FIELD_VALUE",
          "LIMIT_PART_COUNT",
        ].includes(error.code)
        return next(
          new InterviewUploadError(
            error.message,
            tooLarge ? 413 : 400,
            tooLarge ? "CAPTURE_TOO_LARGE" : "INVALID_MULTIPART",
          ),
        )
      }
      if (isClientMultipartParserError(error)) {
        return next(
          new InterviewUploadError(
            error.message,
            400,
            "INVALID_MULTIPART",
            false,
            error,
          ),
        )
      }
      return next(error)
    })
  }
}

function isSupportedXiaohongshuImageUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && (url.hostname === "xhscdn.com" || url.hostname.endsWith(".xhscdn.com"))
  } catch {
    return false
  }
}

export async function decodeInterviewUpload(
  request: Request,
  rootDirectory: string,
): Promise<CreateInterviewCaptureInput> {
  const uploadRequest = request as InterviewUploadRequest
  let metadataValue: unknown
  try {
    metadataValue = JSON.parse(String(request.body?.metadata ?? ""))
  } catch {
    throw new InterviewUploadError(
      "Invalid interview capture metadata",
      400,
      "VALIDATION_ERROR",
    )
  }
  const metadata = captureMetadataSchema.parse(metadataValue)
  const files = uploadRequest.files ?? []
  if (files.length !== metadata.imageIndexes.length) {
    throw new InterviewUploadError(
      "Interview image indexes do not match uploaded files",
      400,
      "VALIDATION_ERROR",
    )
  }
  if (new Set(metadata.imageIndexes).size !== metadata.imageIndexes.length) {
    throw new InterviewUploadError(
      "Interview image indexes must be unique",
      400,
      "VALIDATION_ERROR",
    )
  }
  const allIndexes = [...metadata.imageIndexes, ...metadata.imageUrls.map((image) => image.index)]
  if (new Set(allIndexes).size !== allIndexes.length) {
    throw new InterviewUploadError(
      "Interview image indexes must be unique",
      400,
      "VALIDATION_ERROR",
    )
  }
  let totalBytes = files.reduce((total, file) => total + file.size, 0)
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new InterviewUploadError(
      "Interview images exceed eighty megabytes in total",
      413,
      "CAPTURE_TOO_LARGE",
    )
  }

  const images = files.map((file, position) => {
    let mimeType: InterviewImageMime
    try {
      mimeType = detectInterviewImageType(file.path)
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unsupported interview image type"
      throw new InterviewUploadError(message, 415, "UNSUPPORTED_MEDIA_TYPE")
    }
    if (mimeType !== file.mimetype) {
      throw new InterviewUploadError(
        "Interview image MIME type does not match file bytes",
        415,
        "UNSUPPORTED_MEDIA_TYPE",
      )
    }
    return {
      index: metadata.imageIndexes[position]!,
      path: file.path,
      mimeType,
      originalName: file.originalname,
    }
  })
  const failedImageIndexes = [...metadata.failedImageIndexes]
  const jobId = uploadRequest.interviewCaptureJobId!
  const uploadDirectory = path.join(path.resolve(rootDirectory), jobId)
  mkdirSync(uploadDirectory, { recursive: true })
  for (const remoteImage of metadata.imageUrls) {
    if (!isSupportedXiaohongshuImageUrl(remoteImage.url)) {
      failedImageIndexes.push(remoteImage.index)
      continue
    }
    try {
      const response = await fetch(remoteImage.url, {
        headers: { accept: "image/webp,image/jpeg,image/png" },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error(`Image request failed (${response.status})`)
      const declaredLength = Number(response.headers.get("content-length"))
      if (Number.isFinite(declaredLength) && declaredLength > 7 * 1024 * 1024) {
        throw new Error("Interview image exceeds seven megabytes")
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      totalBytes += bytes.length
      if (bytes.length > 7 * 1024 * 1024 || totalBytes > MAX_TOTAL_BYTES) {
        throw new Error("Interview images exceed upload limits")
      }
      const mimeType = detectImageMime(bytes)
      const storedPath = path.join(uploadDirectory, `remote-${remoteImage.index}.${extensionFor(mimeType)}`)
      writeFileSync(storedPath, bytes)
      images.push({
        index: remoteImage.index,
        path: storedPath,
        mimeType,
        originalName: `remote-${remoteImage.index}.${extensionFor(mimeType)}`,
      })
    } catch {
      failedImageIndexes.push(remoteImage.index)
    }
  }
  if (metadata.platform === "xiaohongshu" && images.length === 0) {
    throw new InterviewUploadError(
      "No supported interview images could be downloaded",
      422,
      "NO_SUPPORTED_IMAGES",
      true,
    )
  }

  let sourceUrl: string
  try {
    sourceUrl = normalizeInterviewSourceUrl(metadata.sourceUrl)
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unsupported interview source URL"
    throw new InterviewUploadError(message, 400, "VALIDATION_ERROR")
  }
  const sourcePlatform =
    new URL(sourceUrl).hostname === "www.nowcoder.com"
      ? "nowcoder"
      : "xiaohongshu"
  if (metadata.platform !== sourcePlatform) {
    throw new InterviewUploadError(
      "Interview platform does not match source URL",
      400,
      "VALIDATION_ERROR",
    )
  }

  return {
    platform: metadata.platform,
    sourceUrl,
    pageTitle: metadata.pageTitle,
    publishedAt: metadata.publishedAt,
    contentCompleteness: metadata.contentCompleteness,
    pageText: metadata.pageText,
    images: images.sort((left, right) => left.index - right.index),
    failedImageIndexes: Array.from(new Set(failedImageIndexes)).sort((left, right) => left - right),
  }
}
