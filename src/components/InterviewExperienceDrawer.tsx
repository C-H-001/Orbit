import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ExternalLink,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api";
import type {
  InterviewExperience,
  InterviewExperienceDraft,
  InterviewQuestionDraft,
} from "../types";

interface Props {
  experience: InterviewExperience | null;
  returnFocusTo?: FocusTarget | null;
  fallbackFocusTo?: FocusTarget | null;
  onClose: () => void;
  onChanged: (experience: InterviewExperience) => Promise<void> | void;
  onDeleted: (id: string) => Promise<void> | void;
}

interface FocusTarget {
  focus: () => void;
  isConnected?: boolean;
  disabled?: boolean;
  matches?: (selector: string) => boolean;
  closest?: (selector: string) => Element | null;
  getAttribute?: (name: string) => string | null;
}

function canRestoreFocus(target: FocusTarget | null | undefined) {
  if (!target || target.isConnected !== true || target.disabled) return false;
  if (target.getAttribute?.("aria-disabled") === "true" || target.closest?.("[inert]")) return false;
  return target.matches ? target.matches(FOCUSABLE_SELECTOR) : true;
}

export function createFocusReturnManager(
  schedule: (restore: () => void) => void = (restore) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(restore);
    else setTimeout(restore, 0);
  },
) {
  let trigger: FocusTarget | null = null;
  return {
    capture(nextTrigger: FocusTarget | null) {
      trigger = nextTrigger;
    },
    restore(fallback?: FocusTarget | null) {
      const previousTrigger = trigger;
      trigger = null;
      if (!previousTrigger) return;
      schedule(() => {
        const target = canRestoreFocus(previousTrigger) ? previousTrigger : canRestoreFocus(fallback) ? fallback : null;
        target?.focus();
      });
    },
  };
}

export function getTrappedFocusIndex(activeIndex: number, count: number, shiftKey: boolean) {
  if (count <= 0) return -1;
  if (shiftKey) return activeIndex <= 0 ? count - 1 : activeIndex - 1;
  return activeIndex < 0 || activeIndex >= count - 1 ? 0 : activeIndex + 1;
}

export function getInterviewModalSemantics(open: boolean, deleteAlertOpen: boolean) {
  const drawerIsTopmost = open && !deleteAlertOpen;
  return {
    drawerRole: drawerIsTopmost ? "dialog" as const : undefined,
    drawerAriaModal: drawerIsTopmost ? "true" as const : undefined,
    drawerAriaHidden: !drawerIsTopmost,
    drawerInert: open && deleteAlertOpen,
  };
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableControls(container: HTMLElement | null) {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.closest("[inert]") && element.getAttribute("aria-hidden") !== "true");
}

function focusFirstControl(container: HTMLElement | null) {
  focusableControls(container)[0]?.focus();
}

function trapModalFocus(event: KeyboardEvent, container: HTMLElement | null) {
  const controls = focusableControls(container);
  if (controls.length === 0) return;
  const activeIndex = controls.indexOf(document.activeElement as HTMLElement);
  const nextIndex = getTrappedFocusIndex(activeIndex, controls.length, event.shiftKey);
  event.preventDefault();
  controls[nextIndex]?.focus();
}

function draftFromExperience(experience: InterviewExperience): InterviewExperienceDraft {
  return {
    company: experience.company,
    position: experience.position,
    interviewRound: experience.interviewRound,
    interviewTime: experience.interviewTime,
    interviewEvaluation: experience.interviewEvaluation,
    questions: experience.questions.map(({ order, question, answer }) => ({
      order,
      question,
      answer,
    })),
  };
}

function emptyDraft(): InterviewExperienceDraft {
  return {
    company: "",
    position: "",
    interviewRound: null,
    interviewTime: null,
    interviewEvaluation: null,
    questions: [],
  };
}

export function normalizeInterviewQuestionOrder(questions: InterviewQuestionDraft[]) {
  return questions.map((question, index) => ({ ...question, order: index + 1 }));
}

export function moveInterviewQuestion(
  questions: InterviewQuestionDraft[],
  index: number,
  direction: -1 | 1,
) {
  const destination = index + direction;
  if (index < 0 || index >= questions.length || destination < 0 || destination >= questions.length) {
    return normalizeInterviewQuestionOrder(questions);
  }
  const next = [...questions];
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  return normalizeInterviewQuestionOrder(next);
}

export function removeInterviewQuestion(questions: InterviewQuestionDraft[], index: number) {
  if (questions.length <= 1) return normalizeInterviewQuestionOrder(questions);
  return normalizeInterviewQuestionOrder(questions.filter((_, questionIndex) => questionIndex !== index));
}

export function validateInterviewExperienceDraft(draft: InterviewExperienceDraft) {
  if (!draft.company.trim()) return "公司不能为空。";
  if (!draft.position.trim()) return "岗位不能为空。";
  if (draft.questions.length === 0) return "至少保留一道面试题目。";
  for (const [index, question] of draft.questions.entries()) {
    if (!question.question.trim()) return `题目 ${index + 1} 的问题不能为空。`;
  }
  return undefined;
}

export function describeInterviewExperienceDeletion(company: string, position: string) {
  return `将永久删除「${company} · ${position}」面经及其全部题目，此操作无法恢复。`;
}

function platformLabel(platform: InterviewExperience["source"]["platform"]) {
  return platform === "nowcoder" ? "牛客" : "小红书";
}

function FormInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  min,
  step,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  min?: number;
  step?: number;
}) {
  return (
    <label className="block min-w-0">
      <span className="block text-xs font-semibold text-gray-500 mb-1.5">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        min={min}
        step={step}
        className="w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-700 placeholder-gray-400 outline-none transition-all hover:border-gray-300 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
      />
    </label>
  );
}

export function InterviewExperienceDeleteDialog({
  experience,
  deleting,
  error,
  onCancel,
  onConfirm,
  dialogRef,
}: {
  experience: InterviewExperience;
  deleting: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
  dialogRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 px-4" role="presentation">
      <div ref={dialogRef} className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" role="alertdialog" aria-modal="true" aria-labelledby="delete-experience-title" aria-describedby="delete-experience-description">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-red-50">
            <AlertTriangle size={19} className="text-red-600" aria-hidden="true" />
          </div>
          <div>
            <h2 id="delete-experience-title" className="text-base font-bold text-gray-900">确认删除面经？</h2>
            <p id="delete-experience-description" className="mt-1.5 text-sm leading-relaxed text-gray-500">
              {describeInterviewExperienceDeletion(experience.company, experience.position)}
            </p>
          </div>
        </div>
        {error && (
          <p id="delete-experience-error" className="mt-4 rounded-xl border border-red-100 bg-red-50 px-3.5 py-2.5 text-xs text-red-700" role="alert">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="cursor-pointer rounded-xl bg-gray-100 px-4 py-2 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="cursor-pointer rounded-xl bg-red-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {deleting ? "正在删除…" : "确认永久删除"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function InterviewExperienceDrawer({ experience, returnFocusTo, fallbackFocusTo, onClose, onChanged, onDeleted }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<InterviewExperienceDraft>(() => experience ? draftFromExperience(experience) : emptyDraft());
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string>();
  const drawerRef = useRef<HTMLElement>(null);
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const drawerFocusReturn = useRef(createFocusReturnManager()).current;
  const alertFocusReturn = useRef(createFocusReturnManager()).current;
  const wasOpen = useRef(false);
  const wasDeleteAlertOpen = useRef(false);
  const open = experience !== null;
  const modalSemantics = getInterviewModalSemantics(open, confirmingDelete);

  useEffect(() => {
    if (!experience) return;
    setDraft(draftFromExperience(experience));
    setEditing(false);
    setConfirmingDelete(false);
    setError(undefined);
  }, [experience]);

  useEffect(() => {
    if (open && !wasOpen.current) {
      drawerFocusReturn.capture(returnFocusTo ?? document.activeElement as HTMLElement | null);
      const focus = () => focusFirstControl(drawerRef.current);
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
      else setTimeout(focus, 0);
    } else if (!open && wasOpen.current) {
      drawerFocusReturn.restore(fallbackFocusTo);
    }
    wasOpen.current = open;
  }, [drawerFocusReturn, fallbackFocusTo, open, returnFocusTo]);

  useEffect(() => {
    if (confirmingDelete && !wasDeleteAlertOpen.current) {
      const focus = () => focusFirstControl(deleteDialogRef.current);
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
      else setTimeout(focus, 0);
    } else if (!confirmingDelete && wasDeleteAlertOpen.current && open) {
      alertFocusReturn.restore();
    }
    wasDeleteAlertOpen.current = confirmingDelete;
  }, [alertFocusReturn, confirmingDelete, open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Tab") {
        trapModalFocus(event, confirmingDelete ? deleteDialogRef.current : drawerRef.current);
        return;
      }
      if (event.key !== "Escape" || saving || deleting) return;
      if (confirmingDelete) setConfirmingDelete(false);
      else onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmingDelete, deleting, onClose, open, saving]);

  function updateQuestion(index: number, patch: Partial<InterviewQuestionDraft>) {
    setDraft((current) => ({
      ...current,
      questions: current.questions.map((question, questionIndex) => questionIndex === index ? { ...question, ...patch } : question),
    }));
  }

  function addQuestion() {
    setDraft((current) => ({
      ...current,
      questions: normalizeInterviewQuestionOrder([
        ...current.questions,
        {
          order: current.questions.length + 1,
          question: "",
          answer: null,
        },
      ]),
    }));
  }

  function openDeleteConfirmation() {
    alertFocusReturn.capture(document.activeElement as HTMLElement | null);
    setError(undefined);
    setConfirmingDelete(true);
  }

  async function saveExperience() {
    if (!experience) return;
    const normalizedDraft: InterviewExperienceDraft = {
      company: draft.company.trim(),
      position: draft.position.trim(),
      interviewRound: draft.interviewRound?.trim() || null,
      interviewTime: draft.interviewTime?.trim() || null,
      interviewEvaluation: draft.interviewEvaluation?.trim() || null,
      questions: normalizeInterviewQuestionOrder(draft.questions).map((question) => ({
        ...question,
        question: question.question.trim(),
        answer: question.answer?.trim() || null,
      })),
    };
    const validationError = validateInterviewExperienceDraft(normalizedDraft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const { experience: savedExperience } = await api.updateInterviewExperience(experience.id, normalizedDraft);
      setDraft(draftFromExperience(savedExperience));
      setEditing(false);
      await onChanged(savedExperience);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存面经失败");
    } finally {
      setSaving(false);
    }
  }

  async function deleteExperience() {
    if (!experience) return;
    setDeleting(true);
    setError(undefined);
    try {
      await api.deleteInterviewExperience(experience.id);
      setConfirmingDelete(false);
      await onDeleted(experience.id);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除面经失败");
    } finally {
      setDeleting(false);
    }
  }

  function cancelEditing() {
    if (!experience) return;
    setDraft(draftFromExperience(experience));
    setEditing(false);
    setError(undefined);
  }

  const draftValidationError = validateInterviewExperienceDraft(draft);
  const draftValid = draftValidationError === undefined;

  const drawerContent = (
    <>
      <div
        className={`fixed inset-0 z-30 transition-opacity duration-300 ${open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
        style={{ background: "rgba(15,23,42,0.25)", backdropFilter: "blur(2px)" }}
        onClick={() => { if (!saving && !deleting) onClose(); }}
        aria-hidden="true"
      />

      <aside
        ref={drawerRef}
        className="fixed top-0 right-0 z-40 flex h-full flex-col bg-white transition-transform duration-300 ease-in-out"
        style={{
          width: "min(620px, calc(100vw - 24px))",
          boxShadow: "-4px 0 24px rgba(0,0,0,0.1)",
          transform: open ? "translateX(0)" : "translateX(100%)",
        }}
        role={modalSemantics.drawerRole}
        aria-modal={modalSemantics.drawerAriaModal}
        aria-labelledby={experience ? "interview-experience-title" : undefined}
        aria-hidden={modalSemantics.drawerAriaHidden}
        inert={modalSemantics.drawerInert ? true : undefined}
      >
        {!experience ? null : (
          <>
            <div className="flex-shrink-0 px-6 py-5" style={{ borderBottom: "1px solid #f1f5f9" }}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="rounded-lg bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-600">
                      {platformLabel(experience.source.platform)}
                    </span>
                    {experience.interviewRound && (
                      <span className="rounded-lg bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-600">
                        {experience.interviewRound}
                      </span>
                    )}
                  </div>
                  <h2 id="interview-experience-title" className="mt-3 truncate text-base font-bold text-gray-900" title={`${experience.company} · ${experience.position}`}>
                    {experience.company} · {experience.position}
                  </h2>
                  <p className="mt-1 text-xs text-gray-400">共 {experience.questions.length} 道题目</p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={saving || deleting}
                  aria-label="关闭面经详情"
                  className="flex h-8 w-8 flex-shrink-0 cursor-pointer items-center justify-center rounded-xl bg-gray-100 text-gray-500 transition-colors hover:bg-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {error && <div className="mb-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-700" role="alert">{error}</div>}

              {editing ? (
                <div className="space-y-6">
                  <section aria-labelledby="experience-basics-title">
                    <h3 id="experience-basics-title" className="mb-3 text-xs font-bold uppercase tracking-widest text-gray-400">基本信息</h3>
                    <div className="grid grid-cols-2 gap-3">
                      <FormInput label="公司" value={draft.company} onChange={(company) => setDraft((current) => ({ ...current, company }))} />
                      <FormInput label="岗位" value={draft.position} onChange={(position) => setDraft((current) => ({ ...current, position }))} />
                      <FormInput label="面试轮次" value={draft.interviewRound ?? ""} onChange={(interviewRound) => setDraft((current) => ({ ...current, interviewRound: interviewRound || null }))} placeholder="例如：一面" />
                      <FormInput label="面试时间" value={draft.interviewTime ?? ""} onChange={(interviewTime) => setDraft((current) => ({ ...current, interviewTime: interviewTime || null }))} placeholder="例如：2026-08-18 14:00" />
                    </div>
                    <label className="block mt-3">
                      <span className="block text-xs font-semibold text-gray-500 mb-1.5">面试评价</span>
                      <textarea
                        value={draft.interviewEvaluation ?? ""}
                        onChange={(event) => setDraft((current) => ({ ...current, interviewEvaluation: event.target.value || null }))}
                        rows={3}
                        className="w-full resize-y rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm leading-relaxed text-gray-700 outline-none transition-all hover:border-gray-300 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                      />
                    </label>
                  </section>

                  <section aria-labelledby="experience-questions-title">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 id="experience-questions-title" className="text-xs font-bold uppercase tracking-widest text-gray-400">题目列表</h3>
                      <button
                        type="button"
                        onClick={addQuestion}
                        className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-600 transition-colors hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                      >
                        <Plus size={13} aria-hidden="true" />添加问题
                      </button>
                    </div>
                    <div className="space-y-3">
                      {draft.questions.map((question, index) => (
                        <div key={`question-${index}`} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                          <div className="mb-3 flex items-center justify-between">
                            <p className="text-xs font-bold text-gray-700">题目 {index + 1}</p>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => setDraft((current) => ({ ...current, questions: moveInterviewQuestion(current.questions, index, -1) }))}
                                disabled={index === 0}
                                aria-label={`上移题目 ${index + 1}`}
                                title="上移"
                                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-white hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-30"
                              >
                                <ArrowUp size={14} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setDraft((current) => ({ ...current, questions: moveInterviewQuestion(current.questions, index, 1) }))}
                                disabled={index === draft.questions.length - 1}
                                aria-label={`下移题目 ${index + 1}`}
                                title="下移"
                                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-white hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-30"
                              >
                                <ArrowDown size={14} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                              onClick={() => setDraft((current) => ({ ...current, questions: removeInterviewQuestion(current.questions, index) }))}
                                disabled={draft.questions.length <= 1}
                                aria-label={`删除题目 ${index + 1}`}
                                title={draft.questions.length <= 1 ? "至少保留一道面试题目" : "删除题目"}
                                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-red-500 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-not-allowed disabled:opacity-30"
                              >
                                <Trash2 size={14} aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                          <label className="block">
                            <span className="block text-xs font-semibold text-gray-500 mb-1.5">问题</span>
                            <textarea
                              value={question.question}
                              onChange={(event) => updateQuestion(index, { question: event.target.value })}
                              rows={2}
                              className="w-full resize-y rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm leading-relaxed text-gray-700 outline-none transition-all hover:border-gray-300 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                            />
                          </label>
                          <label className="block mt-3">
                            <span className="block text-xs font-semibold text-gray-500 mb-1.5">答案（可选）</span>
                            <textarea
                              value={question.answer ?? ""}
                              onChange={(event) => updateQuestion(index, { answer: event.target.value || null })}
                              rows={3}
                              className="w-full resize-y rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm leading-relaxed text-gray-700 outline-none transition-all hover:border-gray-300 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                            />
                          </label>
                        </div>
                      ))}
                    </div>
                  </section>
                  {draftValidationError && <p className="text-xs text-red-600" role="alert">{draftValidationError}</p>}
                </div>
              ) : (
                <div className="space-y-6">
                  <section aria-labelledby="experience-source-title">
                    <h3 id="experience-source-title" className="mb-3 text-xs font-bold uppercase tracking-widest text-gray-400">来源内容</h3>
                    <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                      <p className="text-sm font-semibold leading-relaxed text-gray-800">{experience.source.title}</p>
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <div className="space-y-1 text-xs text-gray-400">
                          <p>发布时间：{experience.source.publishedAt
                            ? new Date(experience.source.publishedAt).toLocaleString("zh-CN")
                            : "未标注"}</p>
                          <p>面试时间：{experience.interviewTime ?? "未标注"}</p>
                        </div>
                        <a
                          href={experience.source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-blue-600 transition-colors hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                        >
                          查看原页面<ExternalLink size={12} aria-hidden="true" />
                        </a>
                      </div>
                    </div>
                    {experience.interviewEvaluation && (
                      <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3">
                        <p className="text-xs font-semibold text-blue-600">面试评价</p>
                        <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{experience.interviewEvaluation}</p>
                      </div>
                    )}
                  </section>

                  <section aria-labelledby="experience-question-list-title">
                    <h3 id="experience-question-list-title" className="mb-3 text-xs font-bold uppercase tracking-widest text-gray-400">面试题目</h3>
                    <div className="space-y-3">
                      {experience.questions.map((question, index) => (
                        <article key={question.id} className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
                          <div className="flex items-start gap-3">
                            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-xs font-bold text-blue-600">
                              {index + 1}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="whitespace-pre-wrap text-sm font-semibold leading-relaxed text-gray-800">{question.question}</p>
                              {question.answer && (
                                <div className="mt-3 rounded-xl bg-gray-50 px-3.5 py-3">
                                  <p className="text-xs font-semibold text-gray-500">参考回答</p>
                                  <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{question.answer}</p>
                                </div>
                              )}
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                </div>
              )}
            </div>

            <div className="flex flex-shrink-0 items-center justify-between gap-3 px-6 py-4" style={{ borderTop: "1px solid #f1f5f9" }}>
              {editing ? (
                <>
                  <button
                    type="button"
                    onClick={cancelEditing}
                    disabled={saving}
                    className="cursor-pointer rounded-xl bg-gray-100 px-4 py-2 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    取消编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveExperience()}
                    disabled={saving || !draftValid}
                    className="flex cursor-pointer items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold text-white transition-all hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ background: "linear-gradient(135deg,#3b82f6,#6366f1)" }}
                  >
                    <Check size={13} aria-hidden="true" />{saving ? "正在保存…" : "保存面经"}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={openDeleteConfirmation}
                    className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-red-100 bg-red-50 px-4 py-2 text-xs font-semibold text-red-600 transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                  >
                    <Trash2 size={13} aria-hidden="true" />删除面经
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="flex cursor-pointer items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold text-white transition-all hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                    style={{ background: "linear-gradient(135deg,#3b82f6,#6366f1)" }}
                  >
                    <Pencil size={13} aria-hidden="true" />编辑面经
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </aside>

      {experience && confirmingDelete && (
        <InterviewExperienceDeleteDialog
          experience={experience}
          deleting={deleting}
          error={error}
          onCancel={() => {
            if (!deleting) {
              setError(undefined);
              setConfirmingDelete(false);
            }
          }}
          onConfirm={() => void deleteExperience()}
          dialogRef={deleteDialogRef}
        />
      )}
    </>
  );

  return typeof document === "undefined" ? drawerContent : createPortal(drawerContent, document.body);
}
