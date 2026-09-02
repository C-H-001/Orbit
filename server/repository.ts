import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createInterviewRepository } from "./interview-repository";
import type {
  Application,
  AgentProposal,
  AuditEntry,
  EmailAnalysis,
  StoredEmail,
  SyncCounts,
  SyncPhase,
  SyncRun,
  SyncStatus,
  TimelineEntry,
  UsageSummary,
} from "./domain";
import { normalizeEmailIntent } from "./domain";
import { normalizeRecruitmentProgress } from "../shared/recruitment-progress";
import type { CompanyCareerPage } from "../shared/company-career-page";

type SqliteRow = Record<string, unknown>;

interface CreateApplicationInput {
  accountId?: string;
  company: string;
  position: string;
  trackType?: Application["trackType"];
  appliedDate: string;
  status?: Application["status"];
  currentProgress?: Application["currentProgress"];
  nextAction?: string;
  interviewTime?: string | null;
  assessmentTime?: string | null;
  assessmentTimeType?: Application["assessmentTimeType"];
}

interface SaveEmailInput {
  accountId: string;
  folder: string;
  uidValidity?: string;
  uid: number;
  messageId?: string;
  subject: string;
  fromAddress: string;
  toAddress: string;
  receivedAt: string;
  textBody: string;
  htmlBody: string;
  rawHeaders: string;
  rawSource: Buffer | string;
}

function nowIso() {
  return new Date().toISOString();
}

function optionalString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function compactMatchText(value: unknown) {
  return typeof value === "string"
    ? value.toLocaleLowerCase().replace(/[\s\-—_·|｜/\\（）()【】\[\]]+/g, "")
    : "";
}

export function createRepository(databasePath = path.resolve("data/orbit.sqlite")) {
  if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      company TEXT NOT NULL,
      position TEXT NOT NULL,
      track_type TEXT NOT NULL DEFAULT 'job',
      status TEXT NOT NULL,
      current_progress TEXT NOT NULL,
      next_action TEXT NOT NULL,
      applied_date TEXT NOT NULL,
      interview_time TEXT,
      assessment_time TEXT,
      assessment_time_type TEXT,
      completed_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS timeline_entries (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      event_date TEXT NOT NULL,
      source TEXT NOT NULL,
      notes TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      detail TEXT,
      source_email_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS timeline_source_email_unique
      ON timeline_entries(source_email_id) WHERE source_email_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      uid_validity TEXT NOT NULL,
      uid INTEGER NOT NULL,
      message_id TEXT,
      subject TEXT NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      position TEXT NOT NULL DEFAULT '',
      intent TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      received_at TEXT NOT NULL,
      application_id TEXT REFERENCES applications(id),
      text_body TEXT NOT NULL,
      html_body TEXT NOT NULL,
      raw_headers TEXT NOT NULL,
      raw_source BLOB NOT NULL,
      analysis_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_entries (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS audit_source_email_unique
      ON audit_entries(source_type, source_id) WHERE source_type = 'email' AND source_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      from_date TEXT,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      progress INTEGER NOT NULL,
      counts_json TEXT NOT NULL,
      error_message TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_usage (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      prompt_name TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost REAL,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_proposals (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id),
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operation_locks (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS company_career_pages (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS audit_agent_source_unique
      ON audit_entries(source_type, source_id) WHERE source_type = 'agent' AND source_id IS NOT NULL;
  `);
  const usageColumns = new Set(
    (database.pragma("table_info(llm_usage)") as Array<{ name: string }>).map((column) => column.name),
  );
  for (const [name, definition] of [
    ["image_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["reasoning_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["duration_ms", "INTEGER NOT NULL DEFAULT 0"],
    ["source_id", "TEXT"],
  ] as const) {
    if (!usageColumns.has(name)) database.exec(`ALTER TABLE llm_usage ADD COLUMN ${name} ${definition}`);
  }
  const interviewRepository = createInterviewRepository(database);

  const applicationColumns = database.pragma("table_info(applications)") as Array<{ name: string }>;
  if (!applicationColumns.some((column) => column.name === "completed_at")) {
    database.exec("ALTER TABLE applications ADD COLUMN completed_at TEXT");
  }
  if (!applicationColumns.some((column) => column.name === "track_type")) {
    database.exec("ALTER TABLE applications ADD COLUMN track_type TEXT NOT NULL DEFAULT 'job'");
  }
  if (!applicationColumns.some((column) => column.name === "assessment_time")) {
    database.exec("ALTER TABLE applications ADD COLUMN assessment_time TEXT");
  }
  if (!applicationColumns.some((column) => column.name === "assessment_time_type")) {
    database.exec("ALTER TABLE applications ADD COLUMN assessment_time_type TEXT");
  }
  database.exec(`
    UPDATE applications SET track_type = 'ai_coding', position = ''
    WHERE position = '待识别职位' AND EXISTS (
      SELECT 1 FROM timeline_entries JOIN emails ON emails.id = timeline_entries.source_email_id
      WHERE timeline_entries.application_id = applications.id
        AND (lower(emails.subject) LIKE '%ai coding%' OR lower(emails.subject) LIKE '%coding test%')
    );
    UPDATE applications SET track_type = 'written_test', position = ''
    WHERE position = '待识别职位' AND track_type = 'job'
      AND (current_progress LIKE '%笔试%' OR current_progress LIKE '%测评%');
  `);

  const emailColumns = database.pragma("table_info(emails)") as Array<{ name: string }>;
  if (!emailColumns.some((column) => column.name === "uid_validity")) {
    database.pragma("foreign_keys = OFF");
    try {
      database.exec(`
        BEGIN;
        DROP INDEX IF EXISTS email_message_id_unique;
        ALTER TABLE emails RENAME TO emails_legacy;
        CREATE TABLE emails (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          folder TEXT NOT NULL,
          uid_validity TEXT NOT NULL,
          uid INTEGER NOT NULL,
          message_id TEXT,
          subject TEXT NOT NULL,
          from_address TEXT NOT NULL,
          to_address TEXT NOT NULL,
          company TEXT NOT NULL DEFAULT '',
          position TEXT NOT NULL DEFAULT '',
          intent TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          received_at TEXT NOT NULL,
          application_id TEXT REFERENCES applications(id),
          text_body TEXT NOT NULL,
          html_body TEXT NOT NULL,
          raw_headers TEXT NOT NULL,
          raw_source BLOB NOT NULL,
          analysis_json TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO emails (
          id, account_id, folder, uid_validity, uid, message_id, subject,
          from_address, to_address, company, position, intent, status,
          received_at, application_id, text_body, html_body, raw_headers,
          raw_source, analysis_json, error_message, created_at, updated_at
        )
        SELECT
          id, account_id, folder, 'legacy', uid, message_id, subject,
          from_address, to_address, company, position, intent, status,
          received_at, application_id, text_body, html_body, raw_headers,
          raw_source, analysis_json, error_message, created_at, updated_at
        FROM emails_legacy;
        DROP TABLE emails_legacy;
        COMMIT;
      `);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.pragma("foreign_keys = ON");
    }
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS email_uid_identity_unique
      ON emails(account_id, folder, uid_validity, uid);
    CREATE UNIQUE INDEX IF NOT EXISTS email_message_id_unique
      ON emails(account_id, folder, message_id) WHERE message_id IS NOT NULL AND message_id <> '';
  `);

  function timelineForApplication(applicationId: string): TimelineEntry[] {
    const rows = database
      .prepare("SELECT * FROM timeline_entries WHERE application_id = ? ORDER BY event_date ASC, created_at ASC")
      .all(applicationId) as SqliteRow[];
    return rows.map((row) => ({
      id: String(row.id),
      stage: String(row.stage),
      date: String(row.event_date),
      source: String(row.source) as TimelineEntry["source"],
      notes: optionalString(row.notes),
      tags: parseJson<string[]>(row.tags_json, []),
      detail: optionalString(row.detail),
      sourceEmailId: optionalString(row.source_email_id),
    }));
  }

  function mapApplication(row: SqliteRow): Application {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      company: String(row.company),
      position: String(row.position),
      trackType: String(row.track_type ?? "job") as Application["trackType"],
      status: String(row.status) as Application["status"],
      currentProgress: normalizeRecruitmentProgress(row.current_progress, [row.next_action, row.status]),
      nextAction: String(row.next_action),
      appliedDate: String(row.applied_date),
      interviewTime: optionalString(row.interview_time),
      assessmentTime: optionalString(row.assessment_time),
      assessmentTimeType: optionalString(row.assessment_time_type) as Application["assessmentTimeType"],
      completed: Boolean(row.completed_at),
      completedAt: optionalString(row.completed_at),
      timeline: timelineForApplication(String(row.id)),
      deletedAt: optionalString(row.deleted_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  function mapEmail(row: SqliteRow): StoredEmail {
    const analysis = parseJson(row.analysis_json, undefined);
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      folder: String(row.folder),
      uidValidity: String(row.uid_validity),
      uid: Number(row.uid),
      messageId: optionalString(row.message_id),
      subject: String(row.subject),
      fromAddress: String(row.from_address),
      toAddress: String(row.to_address),
      company: String(row.company),
      position: String(row.position),
      intent: normalizeEmailIntent({ intent: row.intent, subject: row.subject, analysis }),
      status: String(row.status) as StoredEmail["status"],
      receivedAt: String(row.received_at),
      applicationId: optionalString(row.application_id),
      textBody: String(row.text_body),
      htmlBody: String(row.html_body),
      rawHeaders: String(row.raw_headers),
      rawSource: Buffer.isBuffer(row.raw_source) ? Buffer.from(row.raw_source) : Buffer.from(String(row.raw_source), "utf8"),
      analysis,
      errorMessage: optionalString(row.error_message),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  function getApplication(id: string) {
    const row = database.prepare("SELECT * FROM applications WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? mapApplication(row) : undefined;
  }

  function insertAudit(input: {
    entityId: string;
    action: string;
    sourceType: string;
    sourceId?: string;
    before?: unknown;
    after?: unknown;
    createdAt?: string;
  }) {
    database.prepare(`
      INSERT INTO audit_entries (
        id, entity_type, entity_id, action, source_type, source_id,
        before_json, after_json, created_at
      ) VALUES (?, 'application', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.entityId,
      input.action,
      input.sourceType,
      input.sourceId ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.createdAt ?? nowIso(),
    );
  }

  function listApplications() {
    return (database.prepare("SELECT * FROM applications ORDER BY deleted_at IS NOT NULL, applied_date DESC, created_at DESC").all() as SqliteRow[]).map(mapApplication);
  }

  function mapCompanyCareerPage(row: SqliteRow): CompanyCareerPage {
    return {
      id: String(row.id),
      company: String(row.company),
      url: String(row.url),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  function listCompanyCareerPages() {
    return (database.prepare("SELECT * FROM company_career_pages ORDER BY lower(company), created_at").all() as SqliteRow[])
      .map(mapCompanyCareerPage);
  }

  function createCompanyCareerPage(input: { company: string; url: string }) {
    const id = randomUUID();
    const timestamp = nowIso();
    database.prepare("INSERT INTO company_career_pages (id, company, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.company.trim(), input.url.trim(), timestamp, timestamp);
    return mapCompanyCareerPage(database.prepare("SELECT * FROM company_career_pages WHERE id = ?").get(id) as SqliteRow);
  }

  function updateCompanyCareerPage(id: string, input: { company: string; url: string }) {
    const timestamp = nowIso();
    const result = database.prepare("UPDATE company_career_pages SET company = ?, url = ?, updated_at = ? WHERE id = ?")
      .run(input.company.trim(), input.url.trim(), timestamp, id);
    if (result.changes === 0) return undefined;
    return mapCompanyCareerPage(database.prepare("SELECT * FROM company_career_pages WHERE id = ?").get(id) as SqliteRow);
  }

  function deleteCompanyCareerPage(id: string) {
    return { deletedCareerPages: database.prepare("DELETE FROM company_career_pages WHERE id = ?").run(id).changes };
  }

  function createApplication(input: CreateApplicationInput) {
    const id = randomUUID();
    const timestamp = nowIso();
    const status = input.status ?? "ongoing";
    const currentProgress = input.currentProgress ?? "已投递";
    const nextAction = input.nextAction ?? "等待回复";
    const accountId = input.accountId ?? "primary";
    database.prepare(`
      INSERT INTO applications (
        id, account_id, company, position, track_type, status, current_progress, next_action,
        applied_date, interview_time, assessment_time, assessment_time_type, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      accountId,
      input.company.trim(),
      input.position.trim(),
      input.trackType ?? "job",
      status,
      currentProgress,
      nextAction,
      input.appliedDate,
      input.interviewTime ?? null,
      input.assessmentTime ?? null,
      input.assessmentTimeType ?? null,
      timestamp,
      timestamp,
    );
    database.prepare(`
      INSERT INTO timeline_entries (
        id, application_id, stage, event_date, source, tags_json, created_at
      ) VALUES (?, ?, ?, ?, 'manual', '[]', ?)
    `).run(randomUUID(), id, currentProgress, input.appliedDate, timestamp);
    const application = getApplication(id)!;
    insertAudit({ entityId: id, action: "create", sourceType: "manual", after: application, createdAt: timestamp });
    return application;
  }

  function softDeleteApplication(id: string) {
    const before = getApplication(id);
    if (!before) return undefined;
    const timestamp = nowIso();
    database.prepare("UPDATE applications SET deleted_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, id);
    const after = getApplication(id)!;
    insertAudit({ entityId: id, action: "delete", sourceType: "manual", before, after, createdAt: timestamp });
    return after;
  }

  function restoreApplication(id: string) {
    const before = getApplication(id);
    if (!before) return undefined;
    const timestamp = nowIso();
    database.prepare("UPDATE applications SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(timestamp, id);
    const after = getApplication(id)!;
    insertAudit({ entityId: id, action: "restore", sourceType: "manual", before, after, createdAt: timestamp });
    return after;
  }

  const deleteAllApplicationsTransaction = database.transaction(() => {
    const deletedApplications = Number((database.prepare(
      "SELECT count(*) AS count FROM applications",
    ).get() as { count: number }).count);
    database.prepare("UPDATE emails SET application_id = NULL WHERE application_id IS NOT NULL").run();
    database.prepare("DELETE FROM agent_proposals").run();
    database.prepare("DELETE FROM timeline_entries").run();
    database.prepare("DELETE FROM audit_entries WHERE entity_type = 'application'").run();
    database.prepare("DELETE FROM applications").run();
    return { deletedApplications };
  });

  function deleteAllApplications() {
    return deleteAllApplicationsTransaction();
  }

  const updateApplicationTransaction = database.transaction((id: string, patch: Partial<Pick<
    Application,
    "company" | "position" | "status" | "currentProgress" | "nextAction" | "appliedDate" | "completed"
  >> & { interviewTime?: string | null; assessmentTime?: string | null; assessmentTimeType?: Application["assessmentTimeType"] }) => {
    const before = getApplication(id);
    if (!before) return undefined;
    const timestamp = nowIso();
    const nextProgress = patch.currentProgress ?? before.currentProgress;
    database.prepare(`
      UPDATE applications SET company = ?, position = ?, status = ?, current_progress = ?,
        next_action = ?, applied_date = ?, interview_time = ?, assessment_time = ?, assessment_time_type = ?, completed_at = ?, updated_at = ? WHERE id = ?
    `).run(
      patch.company?.trim() || before.company,
      patch.position?.trim() || before.position,
      patch.status ?? before.status,
      nextProgress,
      patch.nextAction ?? before.nextAction,
      patch.appliedDate ?? before.appliedDate,
      patch.interviewTime === undefined ? before.interviewTime ?? null : patch.interviewTime,
      patch.assessmentTime === undefined ? before.assessmentTime ?? null : patch.assessmentTime,
      patch.assessmentTimeType === undefined ? before.assessmentTimeType ?? null : patch.assessmentTimeType,
      patch.completed === undefined ? before.completedAt ?? null : patch.completed ? timestamp : null,
      timestamp,
      id,
    );
    if (nextProgress !== before.currentProgress) {
      database.prepare(`
        INSERT INTO timeline_entries (
          id, application_id, stage, event_date, source, notes, tags_json, created_at
        ) VALUES (?, ?, ?, ?, 'manual', '手动更新申请进度', '["用户修改"]', ?)
      `).run(randomUUID(), id, nextProgress, timestamp.slice(0, 10), timestamp);
    }
    const after = getApplication(id)!;
    insertAudit({ entityId: id, action: "update", sourceType: "manual", before, after, createdAt: timestamp });
    return after;
  });

  function updateApplication(id: string, patch: Parameters<typeof updateApplicationTransaction>[1]) {
    return updateApplicationTransaction(id, patch);
  }

  function getEmail(id: string) {
    const row = database.prepare("SELECT * FROM emails WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? mapEmail(row) : undefined;
  }

  function listEmails() {
    return (database.prepare("SELECT * FROM emails ORDER BY received_at DESC, created_at DESC").all() as SqliteRow[]).map(mapEmail);
  }

  const deleteEmailsTransaction = database.transaction((ids: string[]) => {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return { deletedEmails: 0 };
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const existingIds = (database.prepare(
      `SELECT id FROM emails WHERE id IN (${placeholders})`,
    ).all(...uniqueIds) as Array<{ id: string }>).map((row) => row.id);
    if (existingIds.length === 0) return { deletedEmails: 0 };
    const existingPlaceholders = existingIds.map(() => "?").join(", ");
    database.prepare(`DELETE FROM timeline_entries WHERE source_email_id IN (${existingPlaceholders})`).run(...existingIds);
    database.prepare(`DELETE FROM audit_entries WHERE source_id IN (${existingPlaceholders})`).run(...existingIds);
    database.prepare(`DELETE FROM emails WHERE id IN (${existingPlaceholders})`).run(...existingIds);
    return { deletedEmails: existingIds.length };
  });

  function deleteEmails(ids: string[]) {
    return deleteEmailsTransaction(ids);
  }

  function saveEmail(input: SaveEmailInput) {
    const existing = database
      .prepare("SELECT * FROM emails WHERE account_id = ? AND folder = ? AND ((uid_validity = ? AND uid = ?) OR (? <> '' AND message_id = ?)) LIMIT 1")
      .get(input.accountId, input.folder, input.uidValidity ?? "unknown", input.uid, input.messageId ?? "", input.messageId ?? "") as SqliteRow | undefined;
    if (existing) return { email: mapEmail(existing), inserted: false };

    const id = randomUUID();
    const timestamp = nowIso();
    database.prepare(`
      INSERT INTO emails (
        id, account_id, folder, uid_validity, uid, message_id, subject, from_address, to_address,
        received_at, text_body, html_body, raw_headers, raw_source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.accountId,
      input.folder,
      input.uidValidity ?? "unknown",
      input.uid,
      input.messageId ?? null,
      input.subject,
      input.fromAddress,
      input.toAddress,
      input.receivedAt,
      input.textBody,
      input.htmlBody,
      input.rawHeaders,
      Buffer.isBuffer(input.rawSource) ? input.rawSource : Buffer.from(input.rawSource, "utf8"),
      timestamp,
      timestamp,
    );
    return { email: getEmail(id)!, inserted: true };
  }

  function prepareEmailForReprocessing(id: string, textBody: string) {
    const timestamp = nowIso();
    database.prepare(`
      UPDATE emails SET text_body = ?, status = 'pending', error_message = NULL,
        updated_at = ? WHERE id = ?
    `).run(textBody, timestamp, id);
    return getEmail(id);
  }

  function cleanupOrphanPlaceholder(applicationId: string | undefined, sourceEmailId: string, timestamp: string) {
    if (!applicationId) return;
    const application = getApplication(applicationId);
    if (!application || application.position !== "待识别职位" || application.deletedAt) return;
    const timelineCount = Number((database.prepare(
      "SELECT count(*) AS count FROM timeline_entries WHERE application_id = ?",
    ).get(applicationId) as { count: number }).count);
    if (timelineCount > 0) return;
    database.prepare("UPDATE applications SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, applicationId);
    const deleted = getApplication(applicationId)!;
    insertAudit({
      entityId: applicationId,
      action: "delete",
      sourceType: "system",
      sourceId: sourceEmailId,
      before: application,
      after: deleted,
      createdAt: timestamp,
    });
  }

  const applyEmailAnalysisTransaction = database.transaction((emailId: string, analysis: EmailAnalysis) => {
    const email = getEmail(emailId);
    if (!email) throw new Error("Email not found");
    const previousApplication = email.applicationId ? getApplication(email.applicationId) : undefined;
    if (email.status === "processed" || email.status === "ignored") {
      const application = email.applicationId ? getApplication(email.applicationId) : undefined;
      return { application, createdApplication: false };
    }

    if (!analysis.relevant) {
      const timestamp = nowIso();
      if (previousApplication && previousApplication.position !== "待识别职位") {
        throw new Error("Cannot automatically unlink an email from an identified application");
      }
      const previousTimeline = database.prepare(
        "SELECT * FROM timeline_entries WHERE source_email_id = ?",
      ).get(emailId) as SqliteRow | undefined;
      database.prepare("DELETE FROM timeline_entries WHERE source_email_id = ?").run(emailId);
      database.prepare(`
        UPDATE emails SET company = '', position = '', intent = ?, status = 'ignored',
          application_id = NULL, analysis_json = ?, error_message = NULL, updated_at = ?
        WHERE id = ?
      `).run(analysis.intent, JSON.stringify(analysis), timestamp, emailId);
      cleanupOrphanPlaceholder(email.applicationId, emailId, timestamp);
      if (previousApplication) {
        insertAudit({
          entityId: previousApplication.id,
          action: "unlink",
          sourceType: "reprocess",
          sourceId: emailId,
          before: { application: previousApplication, timeline: previousTimeline },
          after: { application: getApplication(previousApplication.id), analysis },
          createdAt: timestamp,
        });
      }
      return { application: undefined, createdApplication: false };
    }

    if (analysis.intent === "面试反馈") {
      const timestamp = nowIso();
      database.prepare("DELETE FROM timeline_entries WHERE source_email_id = ?").run(emailId);
      database.prepare(`
        UPDATE emails SET company = ?, position = ?, intent = ?, status = 'processed',
          application_id = NULL, analysis_json = ?, error_message = NULL, updated_at = ?
        WHERE id = ?
      `).run(
        analysis.company,
        analysis.position,
        analysis.intent,
        JSON.stringify({ ...analysis, currentProgress: "其它" }),
        timestamp,
        emailId,
      );
      return { application: undefined, createdApplication: false };
    }

    const existingTimeline = database.prepare(
      "SELECT * FROM timeline_entries WHERE source_email_id = ?",
    ).get(emailId) as SqliteRow | undefined;

    const targetTrackType: Application["trackType"] = analysis.intent === "AI Coding邀请"
      ? "ai_coding"
      : analysis.intent === "笔试邀请"
        ? "written_test"
        : "job";
    const targetProgress = targetTrackType === "ai_coding"
      ? "AI Coding中" as const
      : targetTrackType === "written_test"
        ? "笔试中" as const
        : analysis.currentProgress;

    let existingRow: SqliteRow | undefined;
    if (targetTrackType === "job" && analysis.matchedApplicationId) {
      existingRow = database.prepare(`
        SELECT * FROM applications
        WHERE id = ? AND account_id = ? AND track_type = 'job'
          AND lower(trim(company)) = lower(trim(?)) AND deleted_at IS NULL
        LIMIT 1
      `).get(analysis.matchedApplicationId, email.accountId, analysis.company) as SqliteRow | undefined;
      if (existingRow) analysis = { ...analysis, position: String(existingRow.position) };
    }
    if (!existingRow && targetTrackType !== "job") {
      existingRow = database.prepare(`
        SELECT * FROM applications
        WHERE account_id = ? AND lower(trim(company)) = lower(trim(?))
          AND track_type = ? AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      `).get(email.accountId, analysis.company, targetTrackType) as SqliteRow | undefined;
    } else if (!existingRow && analysis.company.trim()) {
      const context = compactMatchText([email.subject, email.textBody, analysis.detail].filter(Boolean).join(" "));
      const explicitMatches = (database.prepare(`
        SELECT * FROM applications
        WHERE account_id = ? AND lower(trim(company)) = lower(trim(?))
          AND track_type = 'job' AND deleted_at IS NULL AND trim(position) <> ''
        ORDER BY created_at DESC
      `).all(email.accountId, analysis.company) as SqliteRow[])
        .filter((row) => context.includes(compactMatchText(row.position)))
        .sort((left, right) => compactMatchText(right.position).length - compactMatchText(left.position).length);
      if (
        explicitMatches[0]
        && (!explicitMatches[1]
          || compactMatchText(explicitMatches[0].position).length > compactMatchText(explicitMatches[1].position).length)
      ) {
        existingRow = explicitMatches[0];
        analysis = { ...analysis, position: String(existingRow.position) };
      }
    }
    if (!existingRow && analysis.position.trim()) {
      existingRow = database.prepare(`
        SELECT * FROM applications
        WHERE account_id = ? AND lower(trim(company)) = lower(trim(?))
          AND lower(trim(position)) = lower(trim(?)) AND track_type = 'job'
        ORDER BY deleted_at IS NOT NULL, created_at DESC LIMIT 1
      `).get(email.accountId, analysis.company, analysis.position) as SqliteRow | undefined;
    } else if (!existingRow && analysis.company.trim()) {
      const companyMatches = database.prepare(`
        SELECT * FROM applications
        WHERE account_id = ? AND lower(trim(company)) = lower(trim(?))
          AND track_type = 'job' AND deleted_at IS NULL
        ORDER BY created_at DESC
      `).all(email.accountId, analysis.company) as SqliteRow[];
      if (companyMatches.length === 1) existingRow = companyMatches[0];
    }

    if (
      previousApplication
      && previousApplication.position !== "待识别职位"
      && previousApplication.trackType === targetTrackType
      && (!existingRow || String(existingRow.id) !== previousApplication.id)
    ) {
      throw new Error("Cannot automatically relink an email between identified applications");
    }

    if (!existingRow && targetTrackType === "job" && !analysis.position.trim()) {
      const timestamp = nowIso();
      database.prepare("DELETE FROM timeline_entries WHERE source_email_id = ?").run(emailId);
      database.prepare(`
        UPDATE emails SET company = ?, position = '', intent = ?, status = 'processed',
          application_id = NULL, analysis_json = ?, error_message = NULL, updated_at = ?
        WHERE id = ?
      `).run(analysis.company, analysis.intent, JSON.stringify(analysis), timestamp, emailId);
      return { application: undefined, createdApplication: false };
    }

    const timestamp = nowIso();
    let applicationId: string;
    let before: Application | undefined;
    let createdApplication = false;

    if (existingRow) {
      applicationId = String(existingRow.id);
      before = mapApplication(existingRow);
      const nextStatus = analysis.status ?? before.status;
      const nextProgress = targetProgress ?? before.currentProgress;
      const nextAction = analysis.nextAction ?? before.nextAction;
      const nextAppliedDate = analysis.appliedDate ?? before.appliedDate;
      const nextInterviewTime = analysis.interviewTime ?? before.interviewTime ?? null;
      const nextAssessmentTime = analysis.assessmentTime ?? before.assessmentTime ?? null;
      const nextAssessmentTimeType = analysis.assessmentTimeType ?? before.assessmentTimeType ?? null;
      database.prepare(`
        UPDATE applications SET
          track_type = ?, status = ?, current_progress = ?, next_action = ?, applied_date = ?,
          interview_time = ?, assessment_time = ?, assessment_time_type = ?, deleted_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(
        targetTrackType,
        nextStatus,
        nextProgress,
        nextAction,
        nextAppliedDate,
        targetTrackType === "job" ? nextInterviewTime : null,
        targetTrackType === "job" ? null : nextAssessmentTime,
        targetTrackType === "job" ? null : nextAssessmentTimeType,
        timestamp,
        applicationId,
      );
    } else {
      applicationId = randomUUID();
      createdApplication = true;
      const company = analysis.company.trim() || "待识别公司";
      const position = targetTrackType === "job" ? analysis.position.trim() : "";
      const status = analysis.status ?? "ongoing";
      const progress = targetProgress ?? normalizeRecruitmentProgress(analysis.intent, [analysis.detail, analysis.nextAction]);
      const nextAction = analysis.nextAction ?? "查看原邮件并确认申请信息";
      const appliedDate = analysis.appliedDate ?? analysis.eventDate;
      database.prepare(`
        INSERT INTO applications (
          id, account_id, company, position, track_type, status, current_progress, next_action,
          applied_date, interview_time, assessment_time, assessment_time_type, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        applicationId,
        email.accountId,
        company,
        position,
        targetTrackType,
        status,
        progress,
        nextAction,
        appliedDate,
        targetTrackType === "job" ? analysis.interviewTime : null,
        targetTrackType === "job" ? null : analysis.assessmentTime ?? null,
        targetTrackType === "job" ? null : analysis.assessmentTimeType ?? null,
        timestamp,
        timestamp,
      );
    }

    const eventStage = targetProgress ?? "其它";
    if (existingTimeline) {
      database.prepare(`
        UPDATE timeline_entries SET application_id = ?, stage = ?, event_date = ?,
          source = 'email', notes = '由邮箱同步自动更新', tags_json = '["AI推断"]',
          detail = ? WHERE id = ?
      `).run(applicationId, eventStage, analysis.eventDate, analysis.detail, String(existingTimeline.id));
    } else {
      database.prepare(`
        INSERT INTO timeline_entries (
          id, application_id, stage, event_date, source, notes, tags_json,
          detail, source_email_id, created_at
        ) VALUES (?, ?, ?, ?, 'email', '由邮箱同步自动更新', '["AI推断"]', ?, ?, ?)
      `).run(randomUUID(), applicationId, eventStage, analysis.eventDate, analysis.detail, emailId, timestamp);
    }

    const after = getApplication(applicationId)!;
    const existingAudit = database.prepare(
      "SELECT id FROM audit_entries WHERE source_type = 'email' AND source_id = ?",
    ).get(emailId) as { id: string } | undefined;
    if (existingAudit) {
      insertAudit({
        entityId: applicationId,
        action: email.applicationId === applicationId ? "reprocess" : "relink",
        sourceType: "reprocess",
        sourceId: emailId,
        before: { application: previousApplication, timeline: existingTimeline },
        after: { application: after, analysis },
        createdAt: timestamp,
      });
    } else {
      database.prepare(`
        INSERT INTO audit_entries (
          id, entity_type, entity_id, action, source_type, source_id,
          before_json, after_json, created_at
        ) VALUES (?, 'application', ?, ?, 'email', ?, ?, ?, ?)
      `).run(
        randomUUID(),
        applicationId,
        createdApplication ? "create" : "update",
        emailId,
        before ? JSON.stringify(before) : null,
        JSON.stringify(after),
        timestamp,
      );
    }

    database.prepare(`
      UPDATE emails SET company = ?, position = ?, intent = ?, status = 'processed',
        application_id = ?, analysis_json = ?, error_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      analysis.company,
      analysis.position,
      analysis.intent,
      applicationId,
      JSON.stringify(analysis),
      timestamp,
      emailId,
    );
    if (email.applicationId !== applicationId) {
      cleanupOrphanPlaceholder(email.applicationId, emailId, timestamp);
    }
    return { application: after, createdApplication };
  });

  function applyEmailAnalysis(emailId: string, analysis: EmailAnalysis) {
    return applyEmailAnalysisTransaction(emailId, analysis);
  }

  function listAuditEntries(): AuditEntry[] {
    return (database.prepare("SELECT * FROM audit_entries ORDER BY created_at ASC, rowid ASC").all() as SqliteRow[]).map((row) => ({
      id: String(row.id),
      entityType: String(row.entity_type),
      entityId: String(row.entity_id),
      action: String(row.action),
      sourceType: String(row.source_type),
      sourceId: optionalString(row.source_id),
      before: parseJson(row.before_json, undefined),
      after: parseJson(row.after_json, undefined),
      createdAt: String(row.created_at),
    }));
  }

  const emptySyncCounts: SyncCounts = {
    fetched: 0,
    newEmails: 0,
    newApplications: 0,
    updatedApplications: 0,
    ignored: 0,
    failed: 0,
  };

  function mapSyncRun(row: SqliteRow): SyncRun {
    return {
      id: String(row.id),
      mode: String(row.mode) as SyncRun["mode"],
      from: optionalString(row.from_date),
      status: String(row.status) as SyncStatus,
      phase: String(row.phase) as SyncPhase,
      progress: Number(row.progress),
      counts: parseJson(row.counts_json, structuredClone(emptySyncCounts)),
      errorMessage: optionalString(row.error_message),
      startedAt: optionalString(row.started_at),
      finishedAt: optionalString(row.finished_at),
      createdAt: String(row.created_at),
    };
  }

  function createSyncRun(input: { mode: SyncRun["mode"]; from?: string }) {
    const id = randomUUID();
    const timestamp = nowIso();
    database.prepare(`
      INSERT INTO sync_runs (
        id, mode, from_date, status, phase, progress, counts_json, created_at
      ) VALUES (?, ?, ?, 'queued', 'connecting', 0, ?, ?)
    `).run(id, input.mode, input.from ?? null, JSON.stringify(emptySyncCounts), timestamp);
    return getSyncRun(id)!;
  }

  function getSyncRun(id: string) {
    const row = database.prepare("SELECT * FROM sync_runs WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? mapSyncRun(row) : undefined;
  }

  function getLatestSyncRun() {
    const row = database.prepare("SELECT * FROM sync_runs ORDER BY created_at DESC LIMIT 1").get() as SqliteRow | undefined;
    return row ? mapSyncRun(row) : undefined;
  }

  function updateSyncRun(id: string, patch: {
    status?: SyncStatus;
    phase?: SyncPhase;
    progress?: number;
    counts?: SyncCounts;
    errorMessage?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  }) {
    const current = getSyncRun(id);
    if (!current) throw new Error("Sync run not found");
    database.prepare(`
      UPDATE sync_runs SET status = ?, phase = ?, progress = ?, counts_json = ?,
        error_message = ?, started_at = ?, finished_at = ? WHERE id = ?
    `).run(
      patch.status ?? current.status,
      patch.phase ?? current.phase,
      patch.progress ?? current.progress,
      JSON.stringify(patch.counts ?? current.counts),
      patch.errorMessage === undefined ? current.errorMessage ?? null : patch.errorMessage,
      patch.startedAt === undefined ? current.startedAt ?? null : patch.startedAt,
      patch.finishedAt === undefined ? current.finishedAt ?? null : patch.finishedAt,
      id,
    );
    return getSyncRun(id)!;
  }

  function recoverInterruptedSyncRuns() {
    const timestamp = nowIso();
    const result = database.prepare(`
      UPDATE sync_runs SET status = 'failed', phase = 'done', progress = 100,
        error_message = '服务重启，中断未完成同步', finished_at = ?
      WHERE status IN ('queued', 'running')
    `).run(timestamp);
    return result.changes;
  }

  function markEmailFailed(id: string, message: string) {
    const timestamp = nowIso();
    database.prepare("UPDATE emails SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?")
      .run(message, timestamp, id);
    return getEmail(id);
  }

  function recordLlmUsage(input: {
    model: string;
    prompt: string;
    inputTokens: number;
    imageTokens?: number;
    outputTokens: number;
    reasoningTokens?: number;
    durationMs?: number;
    sourceId?: string;
    cost?: number;
    status: "success" | "failure";
    errorMessage?: string;
  }) {
    const id = randomUUID();
    const timestamp = nowIso();
    database.prepare(`
      INSERT INTO llm_usage (
        id, model, prompt_name, input_tokens, image_tokens, output_tokens,
        reasoning_tokens, duration_ms, source_id, cost, status, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.model,
      input.prompt,
      input.inputTokens,
      input.imageTokens ?? 0,
      input.outputTokens,
      input.reasoningTokens ?? 0,
      input.durationMs ?? 0,
      input.sourceId ?? null,
      input.cost ?? null,
      input.status,
      input.errorMessage ?? null,
      timestamp,
    );
    return id;
  }

  function getUsageSummary(days: number): UsageSummary {
    const since = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
    const rows = database.prepare("SELECT * FROM llm_usage WHERE created_at >= ? ORDER BY created_at DESC").all(since) as SqliteRow[];
    const dailyMap = new Map<string, { calls: number; tokens: number; cost: number; hasCost: boolean }>();
    for (const row of rows) {
      const day = String(row.created_at).slice(5, 10);
      const item = dailyMap.get(day) ?? { calls: 0, tokens: 0, cost: 0, hasCost: false };
      item.calls += 1;
      item.tokens += Number(row.input_tokens) + Number(row.output_tokens);
      if (typeof row.cost === "number") {
        item.cost += row.cost;
        item.hasCost = true;
      }
      dailyMap.set(day, item);
    }
    const totalCostRows = rows.filter((row) => typeof row.cost === "number");
    return {
      totalCalls: rows.length,
      totalInputTokens: rows.reduce((sum, row) => sum + Number(row.input_tokens), 0),
      totalOutputTokens: rows.reduce((sum, row) => sum + Number(row.output_tokens), 0),
      totalCost: totalCostRows.length ? totalCostRows.reduce((sum, row) => sum + Number(row.cost), 0) : undefined,
      daily: [...dailyMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, item]) => ({
        day,
        calls: item.calls,
        tokens: item.tokens,
        cost: item.hasCost ? item.cost : undefined,
      })),
      recentCalls: rows.slice(0, 25).map((row) => ({
        id: String(row.id),
        time: String(row.created_at),
        model: String(row.model),
        prompt: String(row.prompt_name),
        inputTokens: Number(row.input_tokens),
        imageTokens: Number(row.image_tokens),
        outputTokens: Number(row.output_tokens),
        reasoningTokens: Number(row.reasoning_tokens),
        durationMs: Number(row.duration_ms),
        sourceId: optionalString(row.source_id),
        cost: typeof row.cost === "number" ? row.cost : undefined,
        status: String(row.status) as "success" | "failure",
      })),
    };
  }

  function mapAgentProposal(row: SqliteRow): AgentProposal {
    return {
      id: String(row.id),
      applicationId: String(row.application_id),
      before: parseJson(row.before_json, {}),
      after: parseJson(row.after_json, {}),
      status: String(row.status) as AgentProposal["status"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  function createAgentProposal(applicationId: string, before: Partial<Application>, after: Partial<Application>) {
    const id = randomUUID();
    const timestamp = nowIso();
    database.prepare(`
      INSERT INTO agent_proposals (
        id, application_id, before_json, after_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, applicationId, JSON.stringify(before), JSON.stringify(after), timestamp, timestamp);
    return getAgentProposal(id)!;
  }

  function getAgentProposal(id: string) {
    const row = database.prepare("SELECT * FROM agent_proposals WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? mapAgentProposal(row) : undefined;
  }

  const confirmAgentProposalTransaction = database.transaction((id: string, confirmed: boolean) => {
    const proposal = getAgentProposal(id);
    if (!proposal) throw new Error("Agent proposal not found");
    if (proposal.status !== "pending") return proposal;
    const timestamp = nowIso();

    if (!confirmed) {
      database.prepare("UPDATE agent_proposals SET status = 'cancelled', updated_at = ? WHERE id = ?")
        .run(timestamp, id);
      return getAgentProposal(id)!;
    }

    const application = getApplication(proposal.applicationId);
    if (!application) throw new Error("Application not found");
    const after = proposal.after;
    const nextStatus = after.status ?? application.status;
    const nextProgress = after.currentProgress
      ? normalizeRecruitmentProgress(after.currentProgress)
      : application.currentProgress;
    const nextAction = after.nextAction ?? application.nextAction;
    const nextInterviewTime = after.interviewTime === undefined ? application.interviewTime ?? null : after.interviewTime;
    database.prepare(`
      UPDATE applications SET status = ?, current_progress = ?, next_action = ?,
        interview_time = ?, updated_at = ? WHERE id = ?
    `).run(nextStatus, nextProgress, nextAction, nextInterviewTime, timestamp, application.id);

    if (nextProgress !== application.currentProgress) {
      database.prepare(`
        INSERT INTO timeline_entries (
          id, application_id, stage, event_date, source, notes, tags_json, created_at
        ) VALUES (?, ?, ?, ?, 'manual', '通过智能对话更新', '["用户修改"]', ?)
      `).run(randomUUID(), application.id, nextProgress, timestamp.slice(0, 10), timestamp);
    }

    const updated = getApplication(application.id)!;
    database.prepare(`
      INSERT OR IGNORE INTO audit_entries (
        id, entity_type, entity_id, action, source_type, source_id,
        before_json, after_json, created_at
      ) VALUES (?, 'application', ?, 'update', 'agent', ?, ?, ?, ?)
    `).run(randomUUID(), application.id, id, JSON.stringify(application), JSON.stringify(updated), timestamp);
    database.prepare("UPDATE agent_proposals SET status = 'applied', updated_at = ? WHERE id = ?")
      .run(timestamp, id);
    return getAgentProposal(id)!;
  });

  function confirmAgentProposal(id: string, confirmed: boolean) {
    return confirmAgentProposalTransaction(id, confirmed);
  }

  const acquireOperationLockTransaction = database.transaction((name: string, owner: string, ttlMs: number) => {
    const timestamp = nowIso();
    database.prepare("DELETE FROM operation_locks WHERE expires_at <= ?").run(timestamp);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const result = database.prepare(
      "INSERT OR IGNORE INTO operation_locks (name, owner, expires_at) VALUES (?, ?, ?)",
    ).run(name, owner, expiresAt);
    return result.changes === 1;
  });

  function acquireOperationLock(name: string, owner: string, ttlMs = 6 * 60 * 60 * 1000) {
    return acquireOperationLockTransaction(name, owner, ttlMs);
  }

  function releaseOperationLock(name: string, owner: string) {
    database.prepare("DELETE FROM operation_locks WHERE name = ? AND owner = ?").run(name, owner);
  }

  function renewOperationLock(name: string, owner: string, ttlMs = 6 * 60 * 60 * 1000) {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const result = database.prepare(
      "UPDATE operation_locks SET expires_at = ? WHERE name = ? AND owner = ?",
    ).run(expiresAt, name, owner);
    return result.changes === 1;
  }

  async function createBackup(destination: string) {
    mkdirSync(path.dirname(destination), { recursive: true });
    await database.backup(destination);
    return destination;
  }

  return {
    ...interviewRepository,
    applyEmailAnalysis,
    acquireOperationLock,
    close: () => database.close(),
    confirmAgentProposal,
    createApplication,
    createBackup,
    createAgentProposal,
    createCompanyCareerPage,
    createSyncRun,
    deleteAllApplications,
    deleteEmails,
    deleteCompanyCareerPage,
    getApplication,
    getAgentProposal,
    getEmail,
    getLatestSyncRun,
    getSyncRun,
    getUsageSummary,
    listApplications,
    listCompanyCareerPages,
    listAuditEntries,
    listEmails,
    markEmailFailed,
    prepareEmailForReprocessing,
    recordLlmUsage,
    releaseOperationLock,
    renewOperationLock,
    recoverInterruptedSyncRuns,
    restoreApplication,
    saveEmail,
    softDeleteApplication,
    updateApplication,
    updateCompanyCareerPage,
    updateSyncRun,
  };
}

export type OrbitRepository = ReturnType<typeof createRepository>;
