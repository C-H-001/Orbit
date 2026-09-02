import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

const MAX_IMAGE_COUNT = 20
const MAX_IMAGE_BYTES = 7 * 1024 * 1024
const MAX_TOTAL_BYTES = 80 * 1024 * 1024
const INTERVIEW_JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type InterviewImageMime = "image/jpeg" | "image/png" | "image/webp"

export interface InterviewCaptureImageFile {
  index: number
  path: string
  mimeType: InterviewImageMime
  originalName?: string
}

export function detectImageMime(bytes: Buffer): InterviewImageMime {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return "image/jpeg"
  if (
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png"
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp"
  throw new Error("Unsupported interview image type")
}

export function detectInterviewImageType(filePath: string): InterviewImageMime {
  const descriptor = openSync(filePath, "r")
  try {
    const bytes = Buffer.alloc(12)
    readSync(descriptor, bytes, 0, bytes.length, 0)
    return detectImageMime(bytes)
  } finally {
    closeSync(descriptor)
  }
}

function extensionFor(mimeType: InterviewImageMime) {
  if (mimeType === "image/jpeg") return "jpg"
  if (mimeType === "image/png") return "png"
  return "webp"
}

export function createInterviewFileStore(rootDirectory: string) {
  const resolvedRoot = path.resolve(rootDirectory)
  mkdirSync(resolvedRoot, { recursive: true })

  function resolveContainedPath(candidate: string) {
    const resolved = path.resolve(candidate)
    if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error("Interview file path is outside interview capture root")
    }
    return resolved
  }

  function readImage(filePath: string, declaredMimeType?: InterviewImageMime) {
    const resolvedPath = resolveContainedPath(filePath)
    const mimeType = detectInterviewImageType(resolvedPath)
    if (declaredMimeType && declaredMimeType !== mimeType) {
      throw new Error("Interview image MIME type does not match file bytes")
    }
    return { mimeType, bytes: Buffer.from(readFileSync(resolvedPath)) }
  }

  function adopt(jobId: string, images: InterviewCaptureImageFile[]) {
    const jobDirectory = resolveContainedPath(path.join(resolvedRoot, jobId))
    if (images.length > MAX_IMAGE_COUNT)
      throw new Error("Interview capture accepts at most 20 images")
    if (
      new Set(images.map((image) => image.index)).size !== images.length ||
      images.some((image) => !Number.isInteger(image.index) || image.index < 1)
    ) {
      throw new Error(
        "Interview image indexes must be unique positive integers",
      )
    }

    let totalBytes = 0
    const inspected = images.map((image) => {
      const sourcePath = resolveContainedPath(image.path)
      const size = statSync(sourcePath).size
      if (size > MAX_IMAGE_BYTES)
        throw new Error("Interview image exceeds seven megabytes")
      totalBytes += size
      if (totalBytes > MAX_TOTAL_BYTES)
        throw new Error("Interview images exceed eighty megabytes in total")
      const mimeType = detectInterviewImageType(sourcePath)
      if (image.mimeType !== mimeType)
        throw new Error("Interview image MIME type does not match file bytes")
      return { index: image.index, sourcePath, mimeType }
    })

    mkdirSync(jobDirectory, { recursive: true })
    return inspected.map((image) => {
      const storedPath = path.join(
        jobDirectory,
        `${image.index}.${extensionFor(image.mimeType)}`,
      )
      renameSync(image.sourcePath, storedPath)
      return { index: image.index, path: storedPath, mimeType: image.mimeType }
    })
  }

  function cleanupJob(jobId: string) {
    const jobDirectory = resolveContainedPath(path.join(resolvedRoot, jobId))
    rmSync(jobDirectory, { recursive: true, force: true })
  }

  function listJobDirectoryIds() {
    return readdirSync(resolvedRoot, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && INTERVIEW_JOB_ID.test(entry.name),
      )
      .map((entry) => entry.name)
  }

  function saveCaptureInput(jobId: string, input: unknown) {
    const metadataPath = path.join(
      resolveContainedPath(path.join(resolvedRoot, jobId)),
      "capture.json",
    )
    writeFileSync(metadataPath, JSON.stringify(input), "utf8")
  }

  function readCaptureInput<T>(jobId: string) {
    const metadataPath = path.join(
      resolveContainedPath(path.join(resolvedRoot, jobId)),
      "capture.json",
    )
    if (!existsSync(metadataPath)) return undefined
    return JSON.parse(readFileSync(metadataPath, "utf8")) as T
  }

  return {
    adopt,
    cleanupJob,
    listJobDirectoryIds,
    readCaptureInput,
    readImage,
    rootDirectory: resolvedRoot,
    saveCaptureInput,
  }
}
