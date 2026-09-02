import { randomInt, randomUUID } from "node:crypto";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { PNG } from "pngjs";
import { z } from "zod";
import type { AgentService } from "./agent";
import type { ConfigStore } from "./config";
import { renderOriginalEmail } from "./email-content";
import type { createInterviewCaptureService } from "./interview-capture";
import {
  cleanupInterviewUpload,
  createInterviewUploadMiddleware,
  decodeInterviewUpload,
  InterviewUploadError,
} from "./interview-upload";
import { interviewOcrProviderSemaphore } from "./interview-ocr-semaphore";
import { interviewCaptureDraftUpdateSchema, interviewExperienceUpdateSchema } from "./interview-schema";
import { createChatCompletionsClient } from "./llm";
import type { OrbitRepository } from "./repository";
import { SyncAlreadyRunningError } from "./sync";
import { RECRUITMENT_PROGRESS_VALUES } from "../shared/recruitment-progress";

interface ApiDependencies {
  repository: OrbitRepository;
  configStore: ConfigStore;
  agentService: AgentService;
  syncService: { start(input: { mode: "incremental" | "backfill"; from?: string }): { id: string } };
  testImapConnection: () => Promise<unknown>;
  testLlmConnection: () => Promise<unknown>;
  testOcrConnection: () => Promise<unknown>;
  interviewCaptureService?: Pick<
    ReturnType<typeof createInterviewCaptureService>,
    "cancel" | "confirm" | "create" | "enqueue" | "retry" | "saveDraft"
  >;
  interviewCaptureDirectory?: string;
}

const applicationCreateSchema = z.object({
  company: z.string().trim().min(1),
  position: z.string().trim().min(1),
  appliedDate: z.string().min(1),
  status: z.enum(["ongoing", "offer", "rejected", "withdrawn"]).optional(),
  trackType: z.enum(["job", "written_test", "ai_coding"]).optional(),
  currentProgress: z.enum(RECRUITMENT_PROGRESS_VALUES).optional(),
  nextAction: z.string().optional(),
  interviewTime: z.string().nullable().optional(),
  assessmentTime: z.string().nullable().optional(),
  assessmentTimeType: z.enum(["scheduled", "deadline"]).nullable().optional(),
  completed: z.boolean().optional(),
});

const applicationUpdateSchema = applicationCreateSchema.partial();
const companyCareerPageSchema = z.object({
  company: z.string().trim().min(1),
  url: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "Only HTTP(S) URLs are supported"),
}).strict();

const settingsInputSchema = z.object({
  imap: z.object({
    host: z.string(),
    port: z.coerce.number().int().min(1).max(65535),
    secure: z.boolean(),
    username: z.string(),
    password: z.string().optional().default(""),
    folder: z.string().min(1),
  }),
  llm: z.object({
    baseUrl: z.string(),
    model: z.string(),
    apiKey: z.string().optional().default(""),
  }),
  ocr: z.object({
    baseUrl: z.string(),
    model: z.string(),
    apiKey: z.string().optional().default(""),
  }).optional(),
  syncIntervalMinutes: z.coerce.number().int().min(1),
});

const interviewListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20).transform((value) => Math.min(20, value)),
  search: z.string().trim().optional(),
  platform: z.enum(["nowcoder", "xiaohongshu"]).optional(),
  interviewRound: z.string().trim().min(1).optional(),
});

const deleteInterviewExperienceSchema = z.object({
  confirmation: z.literal("DELETE_INTERVIEW_EXPERIENCE"),
});

const bodyParserErrors = {
  "entity.parse.failed": { status: 400, code: "INVALID_JSON" },
  "entity.too.large": { status: 413, code: "PAYLOAD_TOO_LARGE" },
  "encoding.unsupported": { status: 415, code: "UNSUPPORTED_ENCODING" },
} as const;

function bodyParserErrorDetails(error: unknown) {
  if (!error || typeof error !== "object" || !("type" in error)) return undefined;
  const type = (error as { type?: unknown }).type;
  return typeof type === "string" && type in bodyParserErrors
    ? bodyParserErrors[type as keyof typeof bodyParserErrors]
    : undefined;
}

const deleteAllApplicationsSchema = z.object({
  confirmation: z.literal("DELETE_ALL_APPLICATIONS"),
});

const deleteEmailsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  confirmation: z.literal("DELETE_EMAILS"),
});

function emailSummary(email: ReturnType<OrbitRepository["listEmails"]>[number]) {
  const { textBody: _textBody, htmlBody: _htmlBody, rawHeaders: _rawHeaders, rawSource: _rawSource, analysis: _analysis, ...summary } = email;
  return summary;
}

function csvCell(value: unknown) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const OCR_CHALLENGE_GLYPHS: Record<string, readonly string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

function renderOcrChallengePng(digit: string) {
  const glyph = OCR_CHALLENGE_GLYPHS[digit];
  if (!glyph) throw new Error("Invalid OCR visual challenge digit");
  const scale = 8;
  const padding = 4;
  const width = glyph[0]!.length * scale + padding * 2;
  const height = glyph.length * scale + padding * 2;
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = 255;
    png.data[offset + 1] = 255;
    png.data[offset + 2] = 255;
    png.data[offset + 3] = 255;
  }
  glyph.forEach((row, rowIndex) => {
    Array.from(row).forEach((pixel, columnIndex) => {
      if (pixel !== "1") return;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const offset = ((padding + rowIndex * scale + y) * width
            + padding + columnIndex * scale + x) * 4;
          png.data[offset] = 15;
          png.data[offset + 1] = 23;
          png.data[offset + 2] = 42;
          png.data[offset + 3] = 255;
        }
      }
    });
  });
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}

export function createOcrConnectionTester(options: {
  getSettings: () => { baseUrl: string; model: string; apiKey: string };
  fetchImpl?: typeof fetch;
  selectChallengeDigit?: () => string;
}) {
  const transport = createChatCompletionsClient(options);
  return async function testOcrConnection() {
    const digit = options.selectChallengeDigit?.() ?? String(randomInt(10));
    const imageUrl = renderOcrChallengePng(digit);
    const result = await interviewOcrProviderSemaphore.runExclusive(() =>
      transport.request(
        [
          { role: "system", content: "Read the image itself. Return only a strict one-field JSON object matching {\"digit\":\"?\"}." },
          {
            role: "user",
            content: [
              { type: "text", text: "Read the single digit in the image and replace ? with that visual value. Do not infer it from this text." },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        { extraBody: { enable_thinking: false, temperature: 0 } },
      ));
    const parsed = z.object({ digit: z.string().regex(/^\d$/) }).strict().parse(JSON.parse(result.content));
    if (parsed.digit !== digit) throw new Error("OCR visual challenge digit did not match the image");
    return parsed;
  };
}

export function startInterviewCaptureMaintenance(
  service: { recover: () => unknown; cleanupExpired: () => unknown },
  schedule: (callback: () => void, milliseconds: number) => NodeJS.Timeout = setInterval,
  unschedule: (handle: NodeJS.Timeout) => void = clearInterval,
) {
  service.recover();
  service.cleanupExpired();
  const interval = schedule(() => service.cleanupExpired(), 60 * 60 * 1000);
  return () => unschedule(interval);
}

export function createApiApp(dependencies: ApiDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  const interviewCaptureDirectory = dependencies.interviewCaptureDirectory ?? path.resolve("data/interview-captures");
  const uploadInterviewCapture = createInterviewUploadMiddleware(interviewCaptureDirectory);

  function interviewCaptureService() {
    if (!dependencies.interviewCaptureService) throw new Error("Interview capture service is not configured");
    return dependencies.interviewCaptureService;
  }

  function requireOrbitExtension(request: Request, response: Response, next: NextFunction) {
    if (request.get("X-Orbit-Extension") !== "1") {
      return response.status(403).json({
        error: {
          code: "EXTENSION_REQUIRED",
          message: "Orbit extension request required",
          retryable: false,
          requestId: randomUUID(),
        },
      });
    }
    return next();
  }

  function requireOrbitWeb(request: Request, response: Response, next: NextFunction) {
    if (request.get("X-Orbit-Web") !== "1") {
      return response.status(403).json({
        error: {
          code: "WEB_REQUEST_REQUIRED",
          message: "Orbit Web request required",
          retryable: false,
          requestId: randomUUID(),
        },
      });
    }
    return next();
  }

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/api/bootstrap", (_request, response) => {
    response.json({
      applications: dependencies.repository.listApplications(),
      emails: dependencies.repository.listEmails().map(emailSummary),
      syncRun: dependencies.repository.getLatestSyncRun(),
      settings: dependencies.configStore.getPublic(),
    });
  });

  app.post("/api/applications", (request, response) => {
    const input = applicationCreateSchema.parse(request.body);
    const application = dependencies.repository.createApplication(input);
    response.status(201).json({ application });
  });

  app.patch("/api/applications/:id", (request, response) => {
    const patch = applicationUpdateSchema.parse(request.body);
    const application = dependencies.repository.updateApplication(request.params.id, patch);
    if (!application) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return response.json({ application });
  });

  app.delete("/api/applications", (request, response) => {
    deleteAllApplicationsSchema.parse(request.body);
    const lockOwner = `bulk-delete:${randomUUID()}`;
    if (!dependencies.repository.acquireOperationLock("mail-processing", lockOwner)) {
      throw new SyncAlreadyRunningError("mail-processing");
    }
    try {
      return response.json(dependencies.repository.deleteAllApplications());
    } finally {
      dependencies.repository.releaseOperationLock("mail-processing", lockOwner);
    }
  });

  app.delete("/api/applications/:id", (request, response) => {
    const application = dependencies.repository.softDeleteApplication(request.params.id);
    if (!application) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return response.json({ application });
  });

  app.post("/api/applications/:id/restore", (request, response) => {
    const application = dependencies.repository.restoreApplication(request.params.id);
    if (!application) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return response.json({ application });
  });

  app.get("/api/company-career-pages", (_request, response) => {
    response.json({ pages: dependencies.repository.listCompanyCareerPages() });
  });

  app.post("/api/company-career-pages", (request, response) => {
    const page = dependencies.repository.createCompanyCareerPage(companyCareerPageSchema.parse(request.body));
    response.status(201).json({ page });
  });

  app.patch("/api/company-career-pages/:id", (request, response) => {
    const page = dependencies.repository.updateCompanyCareerPage(request.params.id, companyCareerPageSchema.parse(request.body));
    return page ? response.json({ page }) : response.status(404).json({ error: { code: "NOT_FOUND", message: "Company career page not found" } });
  });

  app.delete("/api/company-career-pages/:id", (request, response) => {
    const result = dependencies.repository.deleteCompanyCareerPage(request.params.id);
    return result.deletedCareerPages ? response.json(result) : response.status(404).json({ error: { code: "NOT_FOUND", message: "Company career page not found" } });
  });

  app.get("/api/emails", (request, response) => {
    const query = String(request.query.search ?? "").trim().toLocaleLowerCase();
    const status = String(request.query.status ?? "");
    const emails = dependencies.repository.listEmails().filter((email) => {
      const statusMatches = !status || status === "all" || email.status === status;
      const searchMatches = !query || [email.subject, email.company, email.position, email.fromAddress]
        .some((value) => value.toLocaleLowerCase().includes(query));
      return statusMatches && searchMatches;
    }).map(emailSummary);
    response.json({ emails });
  });

  app.delete("/api/emails", (request, response) => {
    const { ids } = deleteEmailsSchema.parse(request.body);
    const lockOwner = `email-delete:${randomUUID()}`;
    if (!dependencies.repository.acquireOperationLock("mail-processing", lockOwner)) {
      throw new SyncAlreadyRunningError("mail-processing");
    }
    try {
      return response.json(dependencies.repository.deleteEmails(ids));
    } finally {
      dependencies.repository.releaseOperationLock("mail-processing", lockOwner);
    }
  });

  app.get("/api/emails/:id", async (request, response) => {
    const email = dependencies.repository.getEmail(request.params.id);
    if (!email) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Email not found" } });
    const { rawSource, ...detail } = email;
    const rendered = await renderOriginalEmail(rawSource);
    return response.json({ email: { ...detail, ...rendered, rawSourceBase64: rawSource.toString("base64") } });
  });

  app.get("/api/settings", (_request, response) => {
    response.json({ settings: dependencies.configStore.getPublic() });
  });

  app.put("/api/settings", (request, response) => {
    const input = settingsInputSchema.parse(request.body);
    const current = dependencies.configStore.get();
    const sameImapDestination = input.imap.host === current.imap.host
      && input.imap.port === current.imap.port
      && input.imap.secure === current.imap.secure
      && input.imap.username === current.imap.username;
    const sameLlmDestination = input.llm.baseUrl.replace(/\/+$/, "") === current.llm.baseUrl.replace(/\/+$/, "");
    const nextOcr = input.ocr ?? current.ocr;
    const sameOcrDestination = nextOcr.baseUrl.trim().replace(/\/+$/, "") === current.ocr.baseUrl.trim().replace(/\/+$/, "")
      && nextOcr.model.trim() === current.ocr.model.trim();
    dependencies.configStore.save({
      imap: { ...input.imap, password: input.imap.password || (sameImapDestination ? current.imap.password : "") },
      llm: { ...input.llm, apiKey: input.llm.apiKey || (sameLlmDestination ? current.llm.apiKey : "") },
      ocr: { ...nextOcr, apiKey: nextOcr.apiKey || (sameOcrDestination ? current.ocr.apiKey : "") },
      syncIntervalMinutes: input.syncIntervalMinutes,
    });
    response.json({ settings: dependencies.configStore.getPublic() });
  });

  app.post("/api/settings/test/imap", async (_request, response) => {
    await dependencies.testImapConnection();
    response.json({ connected: true });
  });

  app.post("/api/settings/test/llm", async (_request, response) => {
    await dependencies.testLlmConnection();
    response.json({ connected: true });
  });

  app.post("/api/settings/test/ocr", requireOrbitWeb, async (_request, response) => {
    await dependencies.testOcrConnection();
    response.json({ connected: true });
  });

  app.post("/api/interview-capture-jobs", requireOrbitExtension, uploadInterviewCapture, async (request, response, next) => {
    try {
      const input = await decodeInterviewUpload(request, interviewCaptureDirectory);
      const ocr = dependencies.configStore.get().ocr;
      if (!ocr.baseUrl.trim() || !ocr.model.trim() || !ocr.apiKey.trim()) {
        throw new InterviewUploadError("Interview OCR is not configured", 409, "OCR_NOT_CONFIGURED");
      }
      if (dependencies.repository.getActiveInterviewCaptureJob()) {
        throw new InterviewUploadError("An interview capture job is already active", 409, "CAPTURE_IN_PROGRESS");
      }
      const service = interviewCaptureService();
      const job = service.create(input);
      cleanupInterviewUpload(request, interviewCaptureDirectory);
      service.enqueue(job.id);
      response.status(202).json({ jobId: job.id, job });
    } catch (error) {
      cleanupInterviewUpload(request, interviewCaptureDirectory);
      next(error);
    }
  });

  app.get("/api/interview-capture-jobs/active", requireOrbitExtension, (_request, response) => {
    const job = dependencies.repository.getActiveInterviewCaptureJob();
    if (!job) return response.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "No active interview capture job",
        retryable: false,
        requestId: randomUUID(),
      },
    });
    return response.json({ job });
  });

  app.get("/api/interview-capture-jobs/:id", requireOrbitExtension, (request, response) => {
    const job = dependencies.repository.getInterviewCaptureJob(request.params.id as string);
    if (!job) return response.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "Interview capture job not found",
        retryable: false,
        requestId: randomUUID(),
      },
    });
    return response.json({ job });
  });

  app.patch("/api/interview-capture-jobs/:id/draft", requireOrbitExtension, (request, response) => {
    const input = interviewCaptureDraftUpdateSchema.parse(request.body);
    return response.json({
      job: interviewCaptureService().saveDraft(
        request.params.id as string,
        input.draft,
        input.revision,
      ),
    });
  });

  app.post("/api/interview-capture-jobs/:id/retry", requireOrbitExtension, (request, response) =>
    response.status(202).json({ job: interviewCaptureService().retry(request.params.id as string) }));

  app.post("/api/interview-capture-jobs/:id/confirm", requireOrbitExtension, (request, response) =>
    response.json({ experience: interviewCaptureService().confirm(request.params.id as string, request.body) }));

  app.post("/api/interview-capture-jobs/:id/cancel", requireOrbitExtension, (request, response) => {
    const job = interviewCaptureService().cancel(request.params.id as string);
    if (!job) return response.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "Interview capture job not found",
        retryable: false,
        requestId: randomUUID(),
      },
    });
    return response.json(job);
  });

  app.get("/api/interview-experiences", (request, response) =>
    response.json(dependencies.repository.listInterviewExperiences(interviewListQuerySchema.parse(request.query))));

  app.get("/api/interview-experiences/random-questions", (_request, response) =>
    response.json({ questions: dependencies.repository.getRandomInterviewQuestions(3) }));

  app.get("/api/interview-experiences/:id", (request, response) => {
    const experience = dependencies.repository.getInterviewExperience(request.params.id);
    return experience ? response.json({ experience }) : response.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "Interview experience not found",
        retryable: false,
        requestId: randomUUID(),
      },
    });
  });

  app.patch("/api/interview-experiences/:id", (request, response) => {
    const experience = dependencies.repository.updateInterviewExperience(
      request.params.id,
      interviewExperienceUpdateSchema.parse(request.body),
    );
    if (!experience) return response.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "Interview experience not found",
        retryable: false,
        requestId: randomUUID(),
      },
    });
    return response.json({ experience });
  });

  app.delete("/api/interview-experiences/:id", (request, response) => {
    deleteInterviewExperienceSchema.parse(request.body);
    const result = dependencies.repository.deleteInterviewExperience(request.params.id);
    if (!result.deletedExperiences) return response.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "Interview experience not found",
        retryable: false,
        requestId: randomUUID(),
      },
    });
    return response.json(result);
  });

  app.post("/api/sync", (request, response) => {
    const input = z.object({
      mode: z.enum(["incremental", "backfill"]).default("incremental"),
      from: z.string().optional(),
    }).parse(request.body ?? {});
    const run = dependencies.syncService.start(input);
    response.status(202).json({ runId: run.id, run });
  });

  app.get("/api/sync/:id", (request, response) => {
    const run = dependencies.repository.getSyncRun(request.params.id);
    if (!run) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Sync run not found" } });
    return response.json({ run });
  });

  app.post("/api/agent/chat", async (request, response) => {
    const { message } = z.object({ message: z.string().trim().min(1) }).parse(request.body);
    response.json(await dependencies.agentService.chat(message));
  });

  app.post("/api/agent/proposals/:id/confirm", (request, response) => {
    const { confirmed } = z.object({ confirmed: z.boolean() }).parse(request.body);
    if (!dependencies.repository.getAgentProposal(request.params.id)) {
      return response.status(404).json({ error: { code: "NOT_FOUND", message: "Agent proposal not found", retryable: false, requestId: randomUUID() } });
    }
    const proposal = dependencies.agentService.confirmProposal(request.params.id, confirmed);
    return response.json({ proposal });
  });

  app.get("/api/usage", (request, response) => {
    const days = z.coerce.number().int().min(1).max(365).catch(7).parse(request.query.days);
    response.json({ usage: dependencies.repository.getUsageSummary(days) });
  });

  app.get("/api/export.csv", (_request, response) => {
    const header = ["公司", "职位", "状态", "当前进度", "下一步行动", "投递日期", "面试时间", "更新时间"];
    const rows = dependencies.repository.listApplications().filter((application) => !application.deletedAt).map((application) => [
      application.company,
      application.position,
      application.status,
      application.currentProgress,
      application.nextAction,
      application.appliedDate,
      application.interviewTime ?? "",
      application.updatedAt,
    ]);
    const csv = `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
    response.setHeader("content-type", "text/csv; charset=utf-8");
    response.setHeader("content-disposition", 'attachment; filename="orbit-applications.csv"');
    response.send(csv);
  });

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const requestId = randomUUID();
    const validationError = error instanceof z.ZodError;
    const syncConflict = error instanceof SyncAlreadyRunningError;
    const uploadError = error instanceof InterviewUploadError;
    const activeCaptureConflict = error instanceof Error
      && "code" in error
      && (error as { code?: unknown }).code === "CAPTURE_IN_PROGRESS";
    const staleDraft = error instanceof Error
      && "code" in error
      && (error as { code?: unknown }).code === "STALE_DRAFT";
    const bodyParserError = bodyParserErrorDetails(error);
    const message = error instanceof Error ? error.message : "Unexpected error";
    const lifecycleStatus = /cannot be retried|no longer exists/i.test(message)
      ? 410
      : /not ready|Only failed|Invalid interview capture job transition|cannot be cancelled/i.test(message)
        ? 409
        : /not found/i.test(message)
          ? 404
          : /exceeds|at most/i.test(message)
            ? 413
            : /Unsupported interview image|MIME type/i.test(message)
              ? 415
              : undefined;
    const status = uploadError
      ? error.status
      : activeCaptureConflict
        ? 409
      : staleDraft
        ? 409
      : bodyParserError
        ? bodyParserError.status
        : validationError
          ? 400
          : syncConflict
            ? 409
            : lifecycleStatus ?? 500;
    response.status(status).json({
      error: {
        code: uploadError
          ? error.code
          : activeCaptureConflict
            ? "CAPTURE_IN_PROGRESS"
          : staleDraft
            ? "STALE_DRAFT"
          : bodyParserError
            ? bodyParserError.code
            : validationError
              ? "VALIDATION_ERROR"
              : syncConflict
                ? "SYNC_IN_PROGRESS"
                : status === 404
                  ? "NOT_FOUND"
                  : status === 409
                    ? "CAPTURE_CONFLICT"
                    : status === 410
                      ? "CAPTURE_EXPIRED"
                      : status === 413
                        ? "CAPTURE_TOO_LARGE"
                        : status === 415
                          ? "UNSUPPORTED_MEDIA_TYPE"
                          : "INTERNAL_ERROR",
        message,
        retryable: uploadError
          ? error.retryable
          : activeCaptureConflict
            ? false
          : staleDraft
            ? false
          : bodyParserError
            ? false
            : syncConflict || (!validationError && status >= 500),
        requestId,
        ...(syncConflict ? { runId: error.runId } : {}),
      },
    });
    if (status === 500) console.error(`[${requestId}] ${request.method} ${request.path}`, error);
  });

  return app;
}
