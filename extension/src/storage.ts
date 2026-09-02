export const INTERVIEW_CAPTURE_STORAGE_KEY = "orbit.interviewCapture"

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(key: string): Promise<void>
}

interface StoredInterviewCaptureState {
  currentInterviewCaptureJobId?: string
}

export function createInterviewJobStorage(area?: StorageArea) {
  function storageArea(): StorageArea {
    return area ?? chrome.storage.local
  }

  return {
    async load() {
      const stored = await storageArea().get(INTERVIEW_CAPTURE_STORAGE_KEY)
      const value = stored[INTERVIEW_CAPTURE_STORAGE_KEY] as
        | StoredInterviewCaptureState
        | undefined
      return typeof value?.currentInterviewCaptureJobId === "string" &&
        value.currentInterviewCaptureJobId.trim()
        ? value.currentInterviewCaptureJobId
        : undefined
    },
    async save(id: string) {
      if (!id.trim()) throw new Error("Interview capture job id is required")
      await storageArea().set({
        [INTERVIEW_CAPTURE_STORAGE_KEY]: {
          currentInterviewCaptureJobId: id,
        } satisfies StoredInterviewCaptureState,
      })
    },
    async clear() {
      await storageArea().remove(INTERVIEW_CAPTURE_STORAGE_KEY)
    },
  }
}

export type InterviewJobStorage = ReturnType<typeof createInterviewJobStorage>

export const interviewJobStorage = createInterviewJobStorage()
