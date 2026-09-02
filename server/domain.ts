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

export function normalizeEmailIntent(input: {
  intent?: unknown;
  subject?: unknown;
  analysis?: unknown;
}): EmailIntent {
  const existing = typeof input.intent === "string" ? input.intent.trim() : "";
  if ((EMAIL_INTENTS as readonly string[]).includes(existing)) return existing as EmailIntent;

  const analysis = input.analysis && typeof input.analysis === "object"
    ? input.analysis as Record<string, unknown>
    : {};
  const status = typeof analysis.status === "string" ? analysis.status : "";
  const context = [input.subject, existing, analysis.currentProgress, analysis.detail]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();

  if (status === "offer" || /(?:录用|聘用|入职|签约|offer)/i.test(context)) return "录用通知";
  if (status === "rejected" || /(?:拒绝|拒信|未通过|不通过|遗憾|流程终止|不再推进|rejection)/i.test(context)) return "拒绝信";
  if (/(?:面试.{0,10}(?:反馈|结果|评价|体验|问卷|调查)|(?:反馈|结果).{0,10}面试)/i.test(context)) return "面试反馈";
  if (/(?:面试|一面|二面|三面|终面).{0,10}(?:邀请|邀约|安排|通知|确认|时间)|(?:邀请|邀约|安排|通知).{0,10}(?:面试|一面|二面|三面|终面)/i.test(context)) return "面试邀请";
  if (/(?:ai\s*[- ]?coding|coding\s*(?:test|测试|测评))/i.test(context)) return "AI Coding邀请";
  if (/(?:笔试|测评|assessment|在线测试)/i.test(context)) return "笔试邀请";
  if (/(?:投递|申请|应聘).{0,10}(?:成功|确认|收到|已收悉|已提交|提交成功)|(?:已收到|已收悉).{0,10}(?:投递|申请|简历)/i.test(context)) return "投递确认";
  if (/(?:岗位|职位).{0,10}(?:推荐|邀您投递|邀请投递)|(?:推荐|邀请申请).{0,10}(?:岗位|职位)|校园招聘/i.test(context)) return "岗位推荐";
  return "其他";
}

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

export interface StoredEmail {
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
  textBody: string;
  htmlBody: string;
  rawHeaders: string;
  rawSource: Buffer;
  analysis?: unknown;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmailAnalysis {
  relevant: boolean;
  company: string;
  position: string;
  intent: EmailIntent;
  status: AppStatus | null;
  currentProgress: RecruitmentProgress | null;
  nextAction: string | null;
  appliedDate: string | null;
  interviewTime: string | null;
  assessmentTime?: string | null;
  assessmentTimeType?: "scheduled" | "deadline" | null;
  eventDate: string;
  detail: string;
  matchedApplicationId?: string | null;
}

export interface AuditEntry {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  sourceType: string;
  sourceId?: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export type SyncMode = "incremental" | "backfill";
export type SyncStatus = "queued" | "running" | "succeeded" | "failed";
export type SyncPhase = "connecting" | "fetching" | "classifying" | "updating" | "finalizing" | "done";

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
  mode: SyncMode;
  from?: string;
  status: SyncStatus;
  phase: SyncPhase;
  progress: number;
  counts: SyncCounts;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
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
    imageTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    durationMs: number;
    sourceId?: string;
    cost?: number;
    status: "success" | "failure";
  }>;
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
import type { RecruitmentProgress } from "../shared/recruitment-progress";
