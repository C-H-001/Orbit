export const INTERVIEW_PLATFORMS = ["nowcoder", "xiaohongshu"] as const;
export type InterviewPlatform = (typeof INTERVIEW_PLATFORMS)[number];
export type InterviewCaptureStatus = "queued" | "processing" | "ready" | "failed" | "confirmed" | "cancelled";

export interface InterviewQuestionDraft {
  order: number;
  question: string;
  answer: string | null;
}

export interface InterviewExperienceDraft {
  company: string;
  position: string;
  interviewRound: string | null;
  interviewTime: string | null;
  interviewEvaluation: string | null;
  questions: InterviewQuestionDraft[];
}

export interface InterviewQuestion extends InterviewQuestionDraft {
  id: string;
  experienceId: string;
}

export interface InterviewPracticeQuestion {
  id: string;
  experienceId: string;
  company: string;
  position: string;
  interviewRound: string | null;
  question: string;
}

export interface InterviewExperience extends InterviewExperienceDraft {
  id: string;
  source: {
    platform: InterviewPlatform;
    url: string;
    title: string;
    publishedAt: string | null;
  };
  questions: InterviewQuestion[];
  createdAt: string;
  updatedAt: string;
}

export type InterviewExperienceSummary = Omit<InterviewExperience, "questions"> & {
  questionCount: number;
};

export interface InterviewCaptureJob {
  id: string;
  platform: InterviewPlatform;
  sourceUrl: string;
  pageTitle: string;
  publishedAt: string | null;
  status: InterviewCaptureStatus;
  contentCompleteness: "complete" | "partial";
  failedImageIndexes: number[];
  draft: InterviewExperienceDraft | null;
  draftRevision: number;
  errorCode: string | null;
  errorMessage: string | null;
  model: string | null;
  usage: {
    textTokens: number;
    imageTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    durationMs: number;
  };
  confirmedExperienceId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface InterviewExperienceListQuery {
  page: number;
  pageSize?: number;
  search?: string;
  platform?: InterviewPlatform;
  interviewRound?: string;
}

export interface InterviewExperienceList {
  items: InterviewExperienceSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export function normalizeInterviewSourceUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
  ) throw new Error("Unsupported interview source URL");
  const nowcoder = /^\/discuss\/(\d+)\/?$/.exec(url.pathname);
  if (url.hostname === "www.nowcoder.com" && nowcoder) return `https://www.nowcoder.com/discuss/${nowcoder[1]}`;
  if (url.hostname === "www.nowcoder.com") return `https://www.nowcoder.com${url.pathname}${url.search}`;
  const xiaohongshu = /^\/explore\/([a-zA-Z0-9]+)\/?$/.exec(url.pathname);
  if (url.hostname === "www.xiaohongshu.com" && xiaohongshu) return `https://www.xiaohongshu.com/explore/${xiaohongshu[1]}`;
  throw new Error("Unsupported interview source URL");
}
