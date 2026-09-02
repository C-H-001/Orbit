import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  normalizeInterviewSourceUrl,
  type InterviewCaptureJob,
  type InterviewCaptureStatus,
  type InterviewExperience,
  type InterviewExperienceDraft,
  type InterviewExperienceList,
  type InterviewExperienceListQuery,
  type InterviewExperienceSummary,
  type InterviewPlatform,
  type InterviewPracticeQuestion,
  type InterviewQuestion,
} from "../shared/interview-experience";
import {
  interviewCaptureDraftSchema,
  interviewExperienceDraftSchema,
} from "./interview-schema";

type SqliteRow = Record<string, unknown>;
type SqliteDatabase = Database.Database;

export interface CreateInterviewCaptureJobInput {
  platform: InterviewPlatform;
  sourceUrl: string;
  pageTitle: string;
  publishedAt: string | null;
  contentCompleteness: "complete" | "partial";
  rawInput: unknown;
  imageManifest: unknown[];
  failedImageIndexes: number[];
}

export interface InterviewCaptureUsage {
  textTokens?: number;
  imageTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  durationMs?: number;
}

export class ActiveInterviewCaptureError extends Error {
  readonly code = "CAPTURE_IN_PROGRESS";

  constructor() {
    super("An interview capture job is already active");
    this.name = "ActiveInterviewCaptureError";
  }
}

export class StaleInterviewDraftError extends Error {
  readonly code = "STALE_DRAFT";

  constructor() {
    super("Interview capture draft revision is stale");
    this.name = "StaleInterviewDraftError";
  }
}

const ACTIVE_CAPTURE_INDEX = "interview_capture_one_active_idx";

function translateActiveCaptureConflict(error: unknown): never {
  if (
    error instanceof Error
    && "code" in error
    && String((error as { code?: unknown }).code).startsWith("SQLITE_CONSTRAINT")
    && error.message.includes(ACTIVE_CAPTURE_INDEX)
  ) {
    throw new ActiveInterviewCaptureError();
  }
  throw error;
}

export function installInterviewSchema(database: SqliteDatabase) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS interview_capture_jobs (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      source_url TEXT NOT NULL,
      page_title TEXT NOT NULL,
      published_at TEXT,
      status TEXT NOT NULL,
      content_completeness TEXT NOT NULL,
      raw_input_json TEXT,
      image_manifest_json TEXT NOT NULL DEFAULT '[]',
      failed_image_indexes_json TEXT NOT NULL DEFAULT '[]',
      draft_json TEXT,
      draft_revision INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      model TEXT,
      text_tokens INTEGER NOT NULL DEFAULT 0,
      image_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      confirmed_experience_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS interview_capture_status_created_idx
      ON interview_capture_jobs(status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS interview_capture_one_active_idx
      ON interview_capture_jobs((1))
      WHERE status IN ('queued', 'processing', 'ready');

    CREATE TABLE IF NOT EXISTS interview_experiences (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      position TEXT NOT NULL,
      interview_round TEXT,
      interview_time TEXT,
      interview_evaluation TEXT,
      source_platform TEXT NOT NULL,
      source_url TEXT NOT NULL UNIQUE,
      source_title TEXT NOT NULL,
      source_published_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS interview_questions (
      id TEXT PRIMARY KEY,
      experience_id TEXT NOT NULL REFERENCES interview_experiences(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      original_number INTEGER,
      question TEXT NOT NULL,
      answer TEXT,
      source_image_index INTEGER,
      UNIQUE(experience_id, sort_order)
    );
    CREATE INDEX IF NOT EXISTS interview_questions_experience_idx
      ON interview_questions(experience_id, sort_order);
  `);
  const captureColumns = new Set(
    (database.pragma("table_info(interview_capture_jobs)") as Array<{ name: string }>).map((column) => column.name),
  );
  if (!captureColumns.has("draft_revision")) {
    database.exec("ALTER TABLE interview_capture_jobs ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0");
  }
  const experienceColumns = new Set(
    (database.pragma("table_info(interview_experiences)") as Array<{ name: string }>).map((column) => column.name),
  );
  if (!experienceColumns.has("interview_time")) {
    database.exec("ALTER TABLE interview_experiences ADD COLUMN interview_time TEXT");
  }
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

export function createInterviewRepository(database: SqliteDatabase) {
  installInterviewSchema(database);

  function mapJob(row: SqliteRow): InterviewCaptureJob {
    return {
      id: String(row.id),
      platform: String(row.platform) as InterviewPlatform,
      sourceUrl: String(row.source_url),
      pageTitle: String(row.page_title),
      publishedAt: nullableString(row.published_at),
      status: String(row.status) as InterviewCaptureStatus,
      contentCompleteness: String(row.content_completeness) as "complete" | "partial",
      failedImageIndexes: parseJson<number[]>(row.failed_image_indexes_json, []),
      draft: parseJson<InterviewExperienceDraft | null>(row.draft_json, null),
      draftRevision: Number(row.draft_revision ?? 0),
      errorCode: nullableString(row.error_code),
      errorMessage: nullableString(row.error_message),
      model: nullableString(row.model),
      usage: {
        textTokens: Number(row.text_tokens),
        imageTokens: Number(row.image_tokens),
        outputTokens: Number(row.output_tokens),
        reasoningTokens: Number(row.reasoning_tokens),
        durationMs: Number(row.duration_ms),
      },
      confirmedExperienceId: nullableString(row.confirmed_experience_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      finishedAt: nullableString(row.finished_at),
    };
  }

  function questionsForExperience(experienceId: string): InterviewQuestion[] {
    return (database.prepare("SELECT * FROM interview_questions WHERE experience_id = ? ORDER BY sort_order ASC").all(experienceId) as SqliteRow[])
      .map((row) => ({
        id: String(row.id),
        experienceId: String(row.experience_id),
        order: Number(row.sort_order),
        question: String(row.question),
        answer: nullableString(row.answer),
      }));
  }

  function mapExperience(row: SqliteRow): InterviewExperience {
    return {
      id: String(row.id),
      company: String(row.company),
      position: String(row.position),
      interviewRound: nullableString(row.interview_round),
      interviewTime: nullableString(row.interview_time),
      interviewEvaluation: nullableString(row.interview_evaluation),
      source: {
        platform: String(row.source_platform) as InterviewPlatform,
        url: String(row.source_url),
        title: String(row.source_title),
        publishedAt: nullableString(row.source_published_at),
      },
      questions: questionsForExperience(String(row.id)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  function mapSummary(row: SqliteRow): InterviewExperienceSummary {
    return {
      id: String(row.id),
      company: String(row.company),
      position: String(row.position),
      interviewRound: nullableString(row.interview_round),
      interviewTime: nullableString(row.interview_time),
      interviewEvaluation: nullableString(row.interview_evaluation),
      source: {
        platform: String(row.source_platform) as InterviewPlatform,
        url: String(row.source_url),
        title: String(row.source_title),
        publishedAt: nullableString(row.source_published_at),
      },
      questionCount: Number(row.question_count),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  function getInterviewCaptureJob(id: string) {
    const row = database.prepare("SELECT * FROM interview_capture_jobs WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  function getActiveInterviewCaptureJob() {
    const row = database.prepare(`SELECT * FROM interview_capture_jobs
      WHERE status IN ('queued', 'processing', 'ready') ORDER BY created_at ASC LIMIT 1`).get() as SqliteRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  function createInterviewCaptureJob(input: CreateInterviewCaptureJobInput) {
    const id = randomUUID();
    const timestamp = nowIso();
    const sourceUrl = normalizeInterviewSourceUrl(input.sourceUrl);
    try {
      database.prepare(`INSERT INTO interview_capture_jobs (
        id, platform, source_url, page_title, published_at, status, content_completeness,
        raw_input_json, image_manifest_json, failed_image_indexes_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`)
        .run(id, input.platform, sourceUrl, input.pageTitle, input.publishedAt, input.contentCompleteness,
          JSON.stringify(input.rawInput), JSON.stringify(input.imageManifest), JSON.stringify(input.failedImageIndexes), timestamp, timestamp);
    } catch (error) {
      translateActiveCaptureConflict(error);
    }
    return getInterviewCaptureJob(id)!;
  }

  const retryInterviewCaptureJobTransaction = database.transaction((id: string) => {
    const job = getInterviewCaptureJob(id);
    if (!job) throw new Error("Interview capture job cannot be retried");
    if (job.status !== "failed") throw new Error("Only failed interview capture jobs can be retried");
    try {
      const result = database.prepare(`UPDATE interview_capture_jobs SET
        status = 'queued', draft_json = NULL, draft_revision = 0, error_code = NULL, error_message = NULL,
        model = NULL, text_tokens = 0, image_tokens = 0, output_tokens = 0,
        reasoning_tokens = 0, duration_ms = 0, updated_at = ?, finished_at = NULL
        WHERE id = ? AND status = 'failed'`).run(nowIso(), id);
      if (result.changes !== 1) throw new Error("Only failed interview capture jobs can be retried");
    } catch (error) {
      translateActiveCaptureConflict(error);
    }
    return getInterviewCaptureJob(id)!;
  });

  function retryInterviewCaptureJob(id: string) {
    return retryInterviewCaptureJobTransaction(id);
  }

  function assertInterviewCaptureTransition(id: string, allowedSourceStatuses: InterviewCaptureStatus[]) {
    const job = getInterviewCaptureJob(id);
    if (!job || !allowedSourceStatuses.includes(job.status)) throw new Error("Invalid interview capture job transition");
  }

  function updateCaptureStatus(
    id: string,
    status: InterviewCaptureStatus,
    allowedSourceStatuses: InterviewCaptureStatus[],
    values: Record<string, unknown> = {},
  ) {
    const timestamp = nowIso();
    const columns = ["status = ?", "updated_at = ?"];
    const parameters: unknown[] = [status, timestamp];
    for (const [column, value] of Object.entries(values)) {
      columns.push(`${column} = ?`);
      parameters.push(value);
    }
    parameters.push(id, ...allowedSourceStatuses);
    const result = database.prepare(`UPDATE interview_capture_jobs SET ${columns.join(", ")}
      WHERE id = ? AND status IN (${allowedSourceStatuses.map(() => "?").join(", ")})`).run(...parameters);
    if (result.changes !== 1) throw new Error("Invalid interview capture job transition");
    return getInterviewCaptureJob(id);
  }

  function markInterviewCaptureProcessing(id: string, model: string | null = null) {
    return updateCaptureStatus(id, "processing", ["queued"], { model, error_code: null, error_message: null, finished_at: null });
  }

  function markInterviewCaptureReady(
    id: string,
    input: InterviewExperienceDraft,
    usage: InterviewCaptureUsage = {},
    model?: string,
  ) {
    assertInterviewCaptureTransition(id, ["queued", "processing"]);
    const draft = interviewCaptureDraftSchema.parse(input);
    const values: Record<string, unknown> = {
      draft_json: JSON.stringify(draft), draft_revision: 0, error_code: null, error_message: null, finished_at: null,
      text_tokens: usage.textTokens ?? 0, image_tokens: usage.imageTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0, reasoning_tokens: usage.reasoningTokens ?? 0, duration_ms: usage.durationMs ?? 0,
    };
    if (model !== undefined) values.model = model;
    return updateCaptureStatus(id, "ready", ["queued", "processing"], values);
  }

  function markInterviewCaptureFailed(id: string, error: { code: string; message: string; usage?: InterviewCaptureUsage }) {
    const timestamp = nowIso();
    return updateCaptureStatus(id, "failed", ["queued", "processing"], {
      error_code: error.code, error_message: error.message, finished_at: timestamp,
      text_tokens: error.usage?.textTokens ?? 0, image_tokens: error.usage?.imageTokens ?? 0,
      output_tokens: error.usage?.outputTokens ?? 0, reasoning_tokens: error.usage?.reasoningTokens ?? 0,
      duration_ms: error.usage?.durationMs ?? 0,
    });
  }

  const saveInterviewCaptureDraftTransaction = database.transaction((
    id: string,
    input: InterviewExperienceDraft,
    revision: number,
  ) => {
    const job = getInterviewCaptureJob(id);
    if (!job) throw new Error("Interview capture job not found");
    if (job.status !== "ready") throw new Error("Interview capture job is not ready");
    if (!Number.isInteger(revision) || revision < 0) throw new Error("Invalid interview capture draft revision");
    const draft = interviewCaptureDraftSchema.parse(input);
    if (revision < job.draftRevision) throw new StaleInterviewDraftError();
    if (revision === job.draftRevision) return job;
    const result = database.prepare(`UPDATE interview_capture_jobs SET
      draft_json = ?, draft_revision = ?, updated_at = ?
      WHERE id = ? AND status = 'ready' AND draft_revision < ?`)
      .run(JSON.stringify(draft), revision, nowIso(), id, revision);
    if (result.changes !== 1) {
      const current = getInterviewCaptureJob(id);
      if (current?.status !== "ready") throw new Error("Interview capture job is not ready");
      if (current.draftRevision > revision) throw new StaleInterviewDraftError();
      if (current.draftRevision === revision) return current;
      throw new Error("Interview capture draft could not be saved");
    }
    return getInterviewCaptureJob(id)!;
  });

  function saveInterviewCaptureDraft(id: string, input: InterviewExperienceDraft, revision: number) {
    return saveInterviewCaptureDraftTransaction(id, input, revision);
  }

  function getInterviewExperience(id: string) {
    const row = database.prepare("SELECT * FROM interview_experiences WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? mapExperience(row) : undefined;
  }

  const confirmInterviewCaptureJob = database.transaction((jobId: string, input: InterviewExperienceDraft) => {
    const job = getInterviewCaptureJob(jobId);
    if (!job) throw new Error("Interview capture job not found");
    if (job.status === "confirmed" && job.confirmedExperienceId) {
      const experience = getInterviewExperience(job.confirmedExperienceId);
      if (!experience) throw new Error("Confirmed interview experience no longer exists");
      return experience;
    }
    if (job.status !== "ready") throw new Error("Interview capture job is not ready");
    const draft = interviewExperienceDraftSchema.parse(input);
    const timestamp = nowIso();
    const existing = database.prepare("SELECT id, created_at FROM interview_experiences WHERE source_url = ?")
      .get(job.sourceUrl) as { id: string; created_at: string } | undefined;
    const experienceId = existing?.id ?? randomUUID();
    database.prepare(`INSERT INTO interview_experiences (
      id, company, position, interview_round, interview_time, interview_evaluation,
      source_platform, source_url, source_title, source_published_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_url) DO UPDATE SET
      company=excluded.company, position=excluded.position,
      interview_round=excluded.interview_round, interview_time=excluded.interview_time,
      interview_evaluation=excluded.interview_evaluation,
      source_platform=excluded.source_platform, source_title=excluded.source_title,
      source_published_at=excluded.source_published_at, updated_at=excluded.updated_at`)
      .run(experienceId, draft.company, draft.position, draft.interviewRound, draft.interviewTime, draft.interviewEvaluation,
        job.platform, job.sourceUrl, job.pageTitle, job.publishedAt, existing?.created_at ?? timestamp, timestamp);
    database.prepare("DELETE FROM interview_questions WHERE experience_id = ?").run(experienceId);
    const insert = database.prepare(`INSERT INTO interview_questions (
      id, experience_id, sort_order, question, answer
    ) VALUES (?, ?, ?, ?, ?)`);
    draft.questions.forEach((question, index) => insert.run(
      randomUUID(), experienceId, index + 1, question.question, question.answer,
    ));
    database.prepare(`UPDATE interview_capture_jobs SET
      status='confirmed', raw_input_json=NULL, image_manifest_json='[]', draft_json=NULL,
      confirmed_experience_id=?, updated_at=?, finished_at=? WHERE id=?`)
      .run(experienceId, timestamp, timestamp, jobId);
    return getInterviewExperience(experienceId)!;
  });

  function cancelInterviewCaptureJob(id: string) {
    const job = getInterviewCaptureJob(id);
    if (!job) return undefined;
    if (job.status === "confirmed") throw new Error("Confirmed interview capture jobs cannot be cancelled");
    const timestamp = nowIso();
    return updateCaptureStatus(id, "cancelled", ["queued", "processing", "ready", "failed", "cancelled"], {
      raw_input_json: null, image_manifest_json: "[]", draft_json: null, finished_at: timestamp,
    });
  }

  function recoverInterruptedInterviewCaptureJobs() {
    const timestamp = nowIso();
    return database.prepare(`UPDATE interview_capture_jobs SET status = 'failed', error_code = 'CAPTURE_INTERRUPTED',
      error_message = '服务重启导致任务中断', updated_at = ?, finished_at = ? WHERE status IN ('queued', 'processing')`)
      .run(timestamp, timestamp).changes;
  }

  function listExpiredInterviewCaptureJobs(before: string) {
    return (database.prepare("SELECT * FROM interview_capture_jobs WHERE status = 'failed' AND updated_at < ? ORDER BY updated_at ASC").all(before) as SqliteRow[])
      .map(mapJob);
  }

  function deleteInterviewCaptureJob(id: string) {
    return { deletedJobs: database.prepare("DELETE FROM interview_capture_jobs WHERE id = ?").run(id).changes };
  }

  function listInterviewExperiences(query: InterviewExperienceListQuery): InterviewExperienceList {
    const page = Math.max(1, query.page);
    const pageSize = Math.min(20, Math.max(1, query.pageSize ?? 20));
    const where: string[] = [];
    const parameters: unknown[] = [];
    if (query.platform) { where.push("interview_experiences.source_platform = ?"); parameters.push(query.platform); }
    if (query.interviewRound) { where.push("interview_experiences.interview_round = ?"); parameters.push(query.interviewRound); }
    if (query.search?.trim()) {
      where.push(`(interview_experiences.company LIKE ? OR interview_experiences.position LIKE ? OR EXISTS (
        SELECT 1 FROM interview_questions search_questions
        WHERE search_questions.experience_id = interview_experiences.id AND search_questions.question LIKE ?
      ))`);
      const pattern = `%${query.search.trim()}%`;
      parameters.push(pattern, pattern, pattern);
    }
    const predicate = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((database.prepare(`SELECT COUNT(*) AS total FROM interview_experiences ${predicate}`).get(...parameters) as { total: number }).total);
    const rows = database.prepare(`SELECT interview_experiences.*, COUNT(interview_questions.id) AS question_count
      FROM interview_experiences LEFT JOIN interview_questions ON interview_questions.experience_id = interview_experiences.id
      ${predicate} GROUP BY interview_experiences.id ORDER BY interview_experiences.updated_at DESC LIMIT ? OFFSET ?`)
      .all(...parameters, pageSize, (page - 1) * pageSize) as SqliteRow[];
    return { items: rows.map(mapSummary), total, page, pageSize };
  }

  function getRandomInterviewQuestions(limit = 3): InterviewPracticeQuestion[] {
    return (database.prepare(`
      SELECT questions.id, questions.experience_id, questions.question,
        experiences.company, experiences.position, experiences.interview_round
      FROM interview_questions questions
      JOIN interview_experiences experiences ON experiences.id = questions.experience_id
      ORDER BY RANDOM()
      LIMIT ?
    `).all(Math.max(1, Math.min(10, limit))) as SqliteRow[]).map((row) => ({
      id: String(row.id),
      experienceId: String(row.experience_id),
      company: String(row.company),
      position: String(row.position),
      interviewRound: nullableString(row.interview_round),
      question: String(row.question),
    }));
  }

  const updateInterviewExperience = database.transaction((id: string, input: InterviewExperienceDraft) => {
    const existing = getInterviewExperience(id);
    if (!existing) return undefined;
    const draft = interviewExperienceDraftSchema.parse(input);
    const timestamp = nowIso();
    database.prepare(`UPDATE interview_experiences SET company = ?, position = ?, interview_round = ?,
      interview_time = ?, interview_evaluation = ?, updated_at = ? WHERE id = ?`)
      .run(draft.company, draft.position, draft.interviewRound, draft.interviewTime, draft.interviewEvaluation, timestamp, id);
    database.prepare("DELETE FROM interview_questions WHERE experience_id = ?").run(id);
    const insert = database.prepare(`INSERT INTO interview_questions (
      id, experience_id, sort_order, question, answer
    ) VALUES (?, ?, ?, ?, ?)`);
    draft.questions.forEach((question, index) => insert.run(
      randomUUID(), id, index + 1, question.question, question.answer,
    ));
    return getInterviewExperience(id)!;
  });

  function deleteInterviewExperience(id: string) {
    return { deletedExperiences: database.prepare("DELETE FROM interview_experiences WHERE id = ?").run(id).changes };
  }

  return {
    cancelInterviewCaptureJob,
    confirmInterviewCaptureJob,
    createInterviewCaptureJob,
    deleteInterviewCaptureJob,
    deleteInterviewExperience,
    getActiveInterviewCaptureJob,
    getInterviewCaptureJob,
    getInterviewExperience,
    getRandomInterviewQuestions,
    listExpiredInterviewCaptureJobs,
    listInterviewExperiences,
    markInterviewCaptureFailed,
    markInterviewCaptureProcessing,
    markInterviewCaptureReady,
    recoverInterruptedInterviewCaptureJobs,
    retryInterviewCaptureJob,
    saveInterviewCaptureDraft,
    updateInterviewExperience,
  };
}
