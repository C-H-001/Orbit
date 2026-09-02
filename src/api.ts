import type {
  AgentProposal,
  Application,
  BootstrapResponse,
  Email,
  EmailDetail,
  InterviewExperience,
  InterviewExperienceDraft,
  InterviewExperienceList,
  InterviewExperienceListQuery,
  PublicSettings,
  SyncRun,
  UsageSummary,
  InterviewPracticeQuestion,
  CompanyCareerPage,
} from "./types";

interface ErrorPayload {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    requestId?: string;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code = "API_ERROR",
    public readonly retryable = false,
    public readonly requestId?: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export function createApiClient(fetchImpl: typeof fetch = fetch) {
  async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const response = await fetchImpl(pathname, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      let payload: ErrorPayload = {};
      try {
        payload = await response.json() as ErrorPayload;
      } catch {
        payload = {};
      }
      throw new ApiError(
        payload.error?.message || `API request failed (${response.status})`,
        payload.error?.code,
        payload.error?.retryable,
        payload.error?.requestId,
        response.status,
      );
    }
    return await response.json() as T;
  }

  return {
    getBootstrap: () => request<BootstrapResponse>("/api/bootstrap"),
    createApplication: (input: Pick<Application, "company" | "position" | "appliedDate">) =>
      request<{ application: Application }>("/api/applications", { method: "POST", body: JSON.stringify(input) }),
    updateApplication: (id: string, patch: Partial<Pick<Application, "company" | "position" | "status" | "currentProgress" | "nextAction" | "appliedDate" | "completed">> & { interviewTime?: string | null; assessmentTime?: string | null; assessmentTimeType?: "scheduled" | "deadline" | null }) =>
      request<{ application: Application }>(`/api/applications/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    deleteApplication: (id: string) =>
      request<{ application: Application }>(`/api/applications/${id}`, { method: "DELETE" }),
    deleteAllApplications: () =>
      request<{ deletedApplications: number }>("/api/applications", {
        method: "DELETE",
        body: JSON.stringify({ confirmation: "DELETE_ALL_APPLICATIONS" }),
      }),
    restoreApplication: (id: string) =>
      request<{ application: Application }>(`/api/applications/${id}/restore`, { method: "POST" }),
    listEmails: (query = "") => request<{ emails: Email[] }>(`/api/emails${query}`),
    getEmail: (id: string) => request<{ email: EmailDetail }>(`/api/emails/${id}`),
    deleteEmails: (ids: string[]) => request<{ deletedEmails: number }>("/api/emails", {
      method: "DELETE",
      body: JSON.stringify({ ids, confirmation: "DELETE_EMAILS" }),
    }),
    startSync: (input: { mode: "incremental" | "backfill"; from?: string }) =>
      request<{ runId: string; run: SyncRun }>("/api/sync", { method: "POST", body: JSON.stringify(input) }),
    getSyncRun: (id: string) => request<{ run: SyncRun }>(`/api/sync/${id}`),
    getSettings: () => request<{ settings: PublicSettings }>("/api/settings"),
    updateSettings: (settings: {
      imap: Omit<PublicSettings["imap"], "hasPassword"> & { password?: string };
      llm: Omit<PublicSettings["llm"], "hasApiKey"> & { apiKey?: string };
      ocr: Omit<PublicSettings["ocr"], "hasApiKey"> & { apiKey?: string };
      syncIntervalMinutes: number;
    }) => request<{ settings: PublicSettings }>("/api/settings", { method: "PUT", body: JSON.stringify(settings) }),
    testImap: () => request<{ connected: boolean }>("/api/settings/test/imap", { method: "POST" }),
    testLlm: () => request<{ connected: boolean }>("/api/settings/test/llm", { method: "POST" }),
    testOcr: () => request<{ connected: boolean }>("/api/settings/test/ocr", {
      method: "POST",
      headers: { "X-Orbit-Web": "1" },
    }),
    chat: (message: string) => request<{ message: string; proposal?: AgentProposal }>("/api/agent/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
    confirmProposal: (id: string, confirmed: boolean) => request<{ proposal: AgentProposal }>(`/api/agent/proposals/${id}/confirm`, {
      method: "POST",
      body: JSON.stringify({ confirmed }),
    }),
    getUsage: (days = 7) => request<{ usage: UsageSummary }>(`/api/usage?days=${days}`),
    listInterviewExperiences: (query: InterviewExperienceListQuery) => {
      const params = new URLSearchParams({ page: String(query.page), pageSize: "20" });
      if (query.search?.trim()) params.set("search", query.search.trim());
      if (query.platform) params.set("platform", query.platform);
      if (query.interviewRound?.trim()) params.set("interviewRound", query.interviewRound.trim());
      return request<InterviewExperienceList>(`/api/interview-experiences?${params}`);
    },
    getRandomInterviewQuestions: () =>
      request<{ questions: InterviewPracticeQuestion[] }>("/api/interview-experiences/random-questions"),
    listCompanyCareerPages: () => request<{ pages: CompanyCareerPage[] }>("/api/company-career-pages"),
    createCompanyCareerPage: (input: { company: string; url: string }) =>
      request<{ page: CompanyCareerPage }>("/api/company-career-pages", { method: "POST", body: JSON.stringify(input) }),
    updateCompanyCareerPage: (id: string, input: { company: string; url: string }) =>
      request<{ page: CompanyCareerPage }>(`/api/company-career-pages/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
    deleteCompanyCareerPage: (id: string) =>
      request<{ deletedCareerPages: number }>(`/api/company-career-pages/${id}`, { method: "DELETE" }),
    getInterviewExperience: (id: string) =>
      request<{ experience: InterviewExperience }>(`/api/interview-experiences/${id}`),
    updateInterviewExperience: (id: string, draft: InterviewExperienceDraft) =>
      request<{ experience: InterviewExperience }>(`/api/interview-experiences/${id}`, {
        method: "PATCH",
        body: JSON.stringify(draft),
      }),
    deleteInterviewExperience: (id: string) =>
      request<{ deletedExperiences: number }>(`/api/interview-experiences/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmation: "DELETE_INTERVIEW_EXPERIENCE" }),
      }),
  };
}

export const api = createApiClient();

export async function downloadApplicationCsv() {
  const response = await fetch("/api/export.csv");
  if (!response.ok) throw new ApiError(`CSV export failed (${response.status})`, "EXPORT_FAILED", true, undefined, response.status);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "orbit-applications.csv";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
