import type {
  InterviewCaptureJob,
  InterviewExperience,
  InterviewExperienceDraft,
  InterviewQuestionDraft,
} from "../../../shared/interview-experience"
import type { InterviewPlatform } from "../platform"

export type SidePanelState =
  | { kind: "checking" }
  | { kind: "orbit-offline"; message: string }
  | { kind: "unsupported"; url: string }
  | {
      kind: "collectable"
      platform: InterviewPlatform
      title: string
    }
  | { kind: "extracting" }
  | { kind: "uploading" }
  | { kind: "processing"; job: InterviewCaptureJob }
  | {
      kind: "review"
      job: InterviewCaptureJob
      draft: InterviewExperienceDraft
      dirty: boolean
    }
  | {
      kind: "failed"
      job?: InterviewCaptureJob
      message: string
      retryable: boolean
    }
  | {
      kind: "cleanup-required"
      message: string
      experience?: InterviewExperience
      job?: InterviewCaptureJob
    }
  | {
      kind: "storage-finalization"
      job: InterviewCaptureJob
      message: string
    }
  | { kind: "confirmed"; experience: InterviewExperience }

export type SidePanelAction =
  | { type: "state.restored"; state: SidePanelState }
  | { type: "page.checking" }
  | { type: "orbit.offline"; message: string }
  | { type: "page.unsupported"; url: string }
  | {
      type: "page.collectable"
      platform: InterviewPlatform
      title: string
    }
  | { type: "capture.extracting" }
  | { type: "capture.uploading" }
  | { type: "capture.job"; job: InterviewCaptureJob }
  | { type: "draft.changed"; draft: InterviewExperienceDraft }
  | {
      type: "draft.saved"
      job: InterviewCaptureJob
      savedDraft: InterviewExperienceDraft
    }
  | {
      type: "capture.failed"
      job?: InterviewCaptureJob
      message: string
      retryable: boolean
    }
  | {
      type: "capture.cleanup-required"
      message: string
      experience?: InterviewExperience
      job?: InterviewCaptureJob
    }
  | {
      type: "capture.storage-finalization"
      job: InterviewCaptureJob
      message: string
    }
  | { type: "capture.confirmed"; experience: InterviewExperience }

export const initialSidePanelState: SidePanelState = { kind: "checking" }

export function stateFromInterviewCaptureJob(
  job: InterviewCaptureJob,
): SidePanelState {
  if (job.status === "queued" || job.status === "processing") {
    return { kind: "processing", job }
  }
  if (job.status === "ready" && job.draft && job.draft.questions.length > 0) {
    return { kind: "review", job, draft: job.draft, dirty: false }
  }
  if (job.status === "failed") {
    return {
      kind: "failed",
      job,
      message: job.errorMessage || "面经识别失败，请重试。",
      retryable: true,
    }
  }
  if (job.status === "ready") {
    return {
      kind: "failed",
      job,
      message: "没有识别到面试问题。请取消本次任务后重新采集。",
      retryable: false,
    }
  }
  return {
    kind: "failed",
    job,
    message:
      job.status === "confirmed"
        ? "这份面经已经确认。"
        : "这次面经采集已经取消。",
    retryable: false,
  }
}

function sameDraft(
  left: InterviewExperienceDraft,
  right: InterviewExperienceDraft,
) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function sidePanelReducer(
  state: SidePanelState,
  action: SidePanelAction,
): SidePanelState {
  switch (action.type) {
    case "state.restored":
      return action.state
    case "page.checking":
      return initialSidePanelState
    case "orbit.offline":
      return { kind: "orbit-offline", message: action.message }
    case "page.unsupported":
      return { kind: "unsupported", url: action.url }
    case "page.collectable":
      return {
        kind: "collectable",
        platform: action.platform,
        title: action.title,
      }
    case "capture.extracting":
      return { kind: "extracting" }
    case "capture.uploading":
      return { kind: "uploading" }
    case "capture.job":
      return stateFromInterviewCaptureJob(action.job)
    case "draft.changed":
      return state.kind === "review"
        ? { ...state, draft: action.draft, dirty: true }
        : state
    case "draft.saved": {
      if (state.kind !== "review") return state
      const unchanged = sameDraft(state.draft, action.savedDraft)
      return {
        ...state,
        job: action.job,
        draft:
          unchanged && action.job.draft ? action.job.draft : state.draft,
        dirty: !unchanged,
      }
    }
    case "capture.failed":
      return {
        kind: "failed",
        ...(action.job ? { job: action.job } : {}),
        message: action.message,
        retryable: action.retryable,
      }
    case "capture.cleanup-required":
      return {
        kind: "cleanup-required",
        message: action.message,
        ...(action.experience ? { experience: action.experience } : {}),
        ...(action.job ? { job: action.job } : {}),
      }
    case "capture.storage-finalization":
      return {
        kind: "storage-finalization",
        job: action.job,
        message: action.message,
      }
    case "capture.confirmed":
      return { kind: "confirmed", experience: action.experience }
  }
}

function normalizeQuestionOrder(questions: InterviewQuestionDraft[]) {
  return questions.map((question, index) => ({
    ...question,
    order: index + 1,
  }))
}

export function addInterviewQuestion(questions: InterviewQuestionDraft[]) {
  return normalizeQuestionOrder([
    ...questions,
    {
      order: questions.length + 1,
      question: "",
      answer: null,
    },
  ])
}

export function removeInterviewQuestion(
  questions: InterviewQuestionDraft[],
  index: number,
) {
  if (index < 0 || index >= questions.length) return questions
  return normalizeQuestionOrder(questions.filter((_, position) => position !== index))
}

export function moveInterviewQuestion(
  questions: InterviewQuestionDraft[],
  index: number,
  direction: -1 | 1,
) {
  const destination = index + direction
  if (
    index < 0 ||
    index >= questions.length ||
    destination < 0 ||
    destination >= questions.length
  ) {
    return normalizeQuestionOrder(questions)
  }
  const next = [...questions]
  const [moving] = next.splice(index, 1)
  if (!moving) return normalizeQuestionOrder(questions)
  next.splice(destination, 0, moving)
  return normalizeQuestionOrder(next)
}

export interface InterviewDraftValidationErrors {
  company?: string
  position?: string
  questions?: string
  questionErrors?: Record<number, string>
}

export function validateInterviewDraft(
  draft: InterviewExperienceDraft,
): InterviewDraftValidationErrors {
  const errors: InterviewDraftValidationErrors = {}
  if (!draft.company.trim()) errors.company = "请输入公司名称。"
  if (!draft.position.trim()) errors.position = "请输入岗位名称。"
  if (draft.questions.length === 0) {
    errors.questions = "至少保留一道面试题目。"
    return errors
  }
  const questionErrors: Record<number, string> = {}
  draft.questions.forEach((question, index) => {
    if (!question.question.trim()) {
      questionErrors[index] = "请输入题目内容。"
    }
  })
  if (Object.keys(questionErrors).length > 0) {
    errors.questionErrors = questionErrors
  }
  return errors
}

export function normalizeInterviewDraft(
  draft: InterviewExperienceDraft,
): InterviewExperienceDraft {
  return {
    company: draft.company.trim(),
    position: draft.position.trim(),
    interviewRound: draft.interviewRound?.trim() || null,
    interviewTime: draft.interviewTime?.trim() || null,
    interviewEvaluation: draft.interviewEvaluation?.trim() || null,
    questions: normalizeQuestionOrder(draft.questions).map((question) => ({
      ...question,
      question: question.question.trim(),
      answer: question.answer?.trim() || null,
    })),
  }
}
