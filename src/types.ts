export type Page = "overview" | "mailbox" | "experiences" | "agent" | "usage" | "settings";
export type { CompanyCareerPage } from "../shared/company-career-page";
export type { RecruitmentProgress } from "../shared/recruitment-progress";
import type { RecruitmentProgress } from "../shared/recruitment-progress";
export type {
  InterviewCaptureJob,
  InterviewCaptureStatus,
  InterviewExperience,
  InterviewExperienceDraft,
  InterviewExperienceList,
  InterviewExperienceListQuery,
  InterviewExperienceSummary,
  InterviewPlatform,
  InterviewPracticeQuestion,
  InterviewQuestion,
  InterviewQuestionDraft,
} from "../shared/interview-experience";
export { INTERVIEW_PLATFORMS, normalizeInterviewSourceUrl } from "../shared/interview-experience";
export type AppStatus = "ongoing" | "offer" | "rejected" | "withdrawn";
export type ProgressSource = "email" | "manual" | "ai";
export type EmailStatus = "pending" | "processed" | "failed" | "ignored";
export const EMAIL_INTENTS = [
  "投递确认",
  "面试邀请",
  "笔试邀请",
  "AI Coding邀请",
  "岗位推荐",
  "面试反馈",
  "录用通知",
  "拒绝信",
  "其他",
] as const;
export type EmailIntent = (typeof EMAIL_INTENTS)[number];

export interface TimelineEntry {
  id: string;
  stage: string;
  date: string;
  source: ProgressSource;
  notes?: string;
  tags?: string[];
  detail?: string;
  sourceEmailId?: string;
}

export interface Application {
  id: string;
  accountId: string;
  company: string;
  position: string;
  trackType: "job" | "written_test" | "ai_coding";
  status: AppStatus;
  currentProgress: RecruitmentProgress;
  nextAction: string;
  appliedDate: string;
  interviewTime?: string;
  assessmentTime?: string;
  assessmentTimeType?: "scheduled" | "deadline" | null;
  completed: boolean;
  completedAt?: string;
  timeline: TimelineEntry[];
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Email {
  id: string;
  accountId: string;
  folder: string;
  uidValidity: string;
  uid: number;
  messageId?: string;
  subject: string;
  fromAddress: string;
  toAddress: string;
  company: string;
  position: string;
  intent: EmailIntent;
  status: EmailStatus;
  receivedAt: string;
  applicationId?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmailDetail extends Email {
  textBody: string;
  htmlBody: string;
  rawHeaders: string;
  rawSourceBase64: string;
  renderedHtml: string;
  attachments: Array<{
    filename: string;
    contentType: string;
    contentBase64: string;
    size: number;
    inline: boolean;
  }>;
  analysis?: unknown;
}

export interface SyncCounts {
  fetched: number;
  newEmails: number;
  newApplications: number;
  updatedApplications: number;
  ignored: number;
  failed: number;
}

export interface SyncRun {
  id: string;
  mode: "incremental" | "backfill";
  from?: string;
  status: "queued" | "running" | "succeeded" | "failed";
  phase: "connecting" | "fetching" | "classifying" | "updating" | "finalizing" | "done";
  progress: number;
  counts: SyncCounts;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}

export interface AgentProposal {
  id: string;
  applicationId: string;
  before: Partial<Application>;
  after: Partial<Application>;
  status: "pending" | "applied" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export interface UsageSummary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost?: number;
  daily: Array<{ day: string; calls: number; tokens: number; cost?: number }>;
  recentCalls: Array<{
    id: string;
    time: string;
    model: string;
    prompt: string;
    inputTokens: number;
    outputTokens: number;
    cost?: number;
    status: "success" | "failure";
  }>;
}

export interface PublicSettings {
  imap: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    folder: string;
    hasPassword: boolean;
  };
  llm: {
    baseUrl: string;
    model: string;
    hasApiKey: boolean;
  };
  ocr: {
    baseUrl: string;
    model: string;
    hasApiKey: boolean;
  };
  syncIntervalMinutes: number;
}

export interface BootstrapResponse {
  applications: Application[];
  emails: Email[];
  syncRun?: SyncRun;
  settings: PublicSettings;
}
