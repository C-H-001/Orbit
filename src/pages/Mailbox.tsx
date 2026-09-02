import { useEffect, useRef, useState } from "react";
import { Search, RefreshCw, History, ArrowRight, AlertCircle, ChevronLeft, ChevronRight, EyeOff, Trash2 } from "lucide-react";
import type { Email, EmailIntent, EmailStatus } from "../types";

interface Props {
  emails: Email[];
  syncing: boolean;
  onSelectEmail: (email: Email) => Promise<void>;
  onDeleteEmails: (ids: string[]) => Promise<boolean>;
  onSyncNow: () => Promise<void>;
  onBackfill: (from: string) => Promise<void>;
}

const DEFAULT_MAILBOX_COLUMN_WIDTHS = [250, 125, 175, 120, 100, 95, 104];
const MIN_MAILBOX_COLUMN_WIDTHS = [140, 90, 110, 80, 70, 65, 88];
const MAILBOX_SELECTION_COLUMN_WIDTH = 32;
const MAILBOX_TABLE_HORIZONTAL_PADDING = 48;
const MAILBOX_PAGE_SIZE = 20;
type MailboxFilter = "all" | EmailStatus;

export function resizeMailboxColumns(widths: number[], boundaryIndex: number, delta: number) {
  if (boundaryIndex < 0 || boundaryIndex >= widths.length) return [...widths];
  const next = [...widths];
  // Backwards-compatible behavior for callers that provide only data columns.
  if (boundaryIndex === widths.length - 1) {
    next[boundaryIndex] = Math.max(MIN_MAILBOX_COLUMN_WIDTHS[boundaryIndex] ?? 0, next[boundaryIndex]! + delta);
    return next;
  }
  const minLeft = MIN_MAILBOX_COLUMN_WIDTHS[boundaryIndex] ?? 0;
  const minRight = MIN_MAILBOX_COLUMN_WIDTHS[boundaryIndex + 1] ?? 0;
  const boundedDelta = Math.max(minLeft - next[boundaryIndex]!, Math.min(delta, next[boundaryIndex + 1]! - minRight));
  next[boundaryIndex] += boundedDelta;
  next[boundaryIndex + 1] -= boundedDelta;
  return next;
}

function mailboxGridColumns(widths: number[]) {
  const dataColumns = widths.slice(0, 6);
  const actionsWidth = widths[6] ?? 104;
  return `${MAILBOX_SELECTION_COLUMN_WIDTH}px ${dataColumns.map((width) => `${width}px`).join(" ")} ${actionsWidth}px`;
}

export function describeEmailDeletion(count: number) {
  return `将永久删除${count}封已选择邮件的本地邮件`;
}

export function shouldCommitBackfillDate(value: string, pickerOpen: boolean) {
  return Boolean(value) && !pickerOpen;
}

export function selectMailboxPage(
  emails: Email[],
  options: { search: string; filter: MailboxFilter; hideIgnored: boolean; page: number },
) {
  const query = options.search.toLocaleLowerCase();
  const filtered = emails.filter((email) => {
    const matchesSearch =
      !query ||
      email.subject.toLocaleLowerCase().includes(query) ||
      email.company.toLocaleLowerCase().includes(query) ||
      email.position.toLocaleLowerCase().includes(query);
    const matchesStatus =
      options.filter === "all" ||
      email.status === options.filter ||
      (options.filter === "pending" && email.status === "failed");
    return matchesSearch && matchesStatus && (!options.hideIgnored || email.status !== "ignored");
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / MAILBOX_PAGE_SIZE));
  const page = Math.min(Math.max(1, options.page), totalPages);
  const startIndex = (page - 1) * MAILBOX_PAGE_SIZE;
  const items = filtered.slice(startIndex, startIndex + MAILBOX_PAGE_SIZE);
  return {
    items,
    filteredCount: filtered.length,
    page,
    totalPages,
    rangeStart: filtered.length === 0 ? 0 : startIndex + 1,
    rangeEnd: startIndex + items.length,
  };
}

function CompanyAvatar({ name }: { name: string }) {
  const displayName = name || "待识别";
  const palettes = [
    ["#3b82f6", "#eff6ff"],
    ["#8b5cf6", "#f5f3ff"],
    ["#14b8a6", "#f0fdf4"],
    ["#f59e0b", "#fffbeb"],
    ["#ef4444", "#fef2f2"],
    ["#6366f1", "#eef2ff"],
    ["#ec4899", "#fdf2f8"],
    ["#10b981", "#ecfdf5"],
  ];
  const idx = displayName.charCodeAt(0) % palettes.length;
  const [bg, text] = palettes[idx];
  return (
    <div
      className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-sm flex-shrink-0"
      style={{ background: text, color: bg }}
    >
      {displayName.slice(0, 2)}
    </div>
  );
}

function intentConfig(intent: EmailIntent) {
  const map: Record<EmailIntent, { bg: string; color: string }> = {
    "投递确认": { bg: "#eef2ff", color: "#6366f1" },
    "面试邀请": { bg: "#eff6ff", color: "#3b82f6" },
    "笔试邀请": { bg: "#f5f3ff", color: "#8b5cf6" },
    "AI Coding邀请": { bg: "#ecfeff", color: "#0891b2" },
    "岗位推荐": { bg: "#ecfeff", color: "#0891b2" },
    "面试反馈": { bg: "#fffbeb", color: "#f59e0b" },
    "录用通知": { bg: "#ecfdf5", color: "#10b981" },
    "拒绝信": { bg: "#fef2f2", color: "#ef4444" },
    "其他": { bg: "#f8fafc", color: "#64748b" },
  };
  return map[intent];
}

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (diff === 1) return "昨天";
  if (diff < 7) return `${diff} 天前`;
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export function Mailbox({ emails, syncing, onSelectEmail, onDeleteEmails, onSyncNow, onBackfill }: Props) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<MailboxFilter>("all");
  const [hideIgnored, setHideIgnored] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedEmailIds, setSelectedEmailIds] = useState<Set<string>>(new Set());
  const [pendingDeletion, setPendingDeletion] = useState<{ ids: string[] }>();
  const [deletingEmails, setDeletingEmails] = useState(false);
  const [columnWidths, setColumnWidths] = useState([...DEFAULT_MAILBOX_COLUMN_WIDTHS]);
  const resizing = useRef<{ boundaryIndex: number; startX: number; widths: number[] } | null>(null);
  const backfillInputRef = useRef<HTMLInputElement>(null);

  const mailboxPage = selectMailboxPage(emails, { search, filter, hideIgnored, page: currentPage });
  const gridTemplateColumns = mailboxGridColumns(columnWidths);
  const tableMinWidth = columnWidths.reduce((sum, width) => sum + width, 0)
    + MAILBOX_SELECTION_COLUMN_WIDTH
    + MAILBOX_TABLE_HORIZONTAL_PADDING;
  const allPageEmailsSelected = mailboxPage.items.length > 0
    && mailboxPage.items.every((email) => selectedEmailIds.has(email.id));

  useEffect(() => {
    if (currentPage !== mailboxPage.page) setCurrentPage(mailboxPage.page);
  }, [currentPage, mailboxPage.page]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (!resizing.current) return;
      setColumnWidths(resizeMailboxColumns(
        resizing.current.widths,
        resizing.current.boundaryIndex,
        event.clientX - resizing.current.startX,
      ));
    }
    function handlePointerUp() {
      resizing.current = null;
    }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  const pendingCount = emails.filter((e) => e.status === "pending" || e.status === "failed").length;
  const processedCount = emails.filter((e) => e.status === "processed").length;

  const filterLabels: Record<string, string> = {
    all: "全部",
    processed: "已处理",
    pending: "待处理",
  };

  function clearSelection() {
    setSelectedEmailIds(new Set());
  }

  function toggleEmailSelection(id: string) {
    setSelectedEmailIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleCurrentPageSelection() {
    setSelectedEmailIds(allPageEmailsSelected ? new Set() : new Set(mailboxPage.items.map((email) => email.id)));
  }

  async function confirmDeletion() {
    if (!pendingDeletion || deletingEmails) return;
    setDeletingEmails(true);
    try {
      const deleted = await onDeleteEmails(pendingDeletion.ids);
      if (deleted) {
        clearSelection();
      }
      setPendingDeletion(undefined);
    } finally {
      setDeletingEmails(false);
    }
  }

  return (
    <div className="p-6 space-y-4">
      {/* Summary pills */}
      <div className="flex items-center gap-3">
        <div className="card px-4 py-3 flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
            <span className="text-blue-600 text-sm font-bold">{emails.length}</span>
          </div>
          <p className="text-xs font-medium text-gray-600">邮件总数</p>
        </div>
        <div className="card px-4 py-3 flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center">
            <span className="text-green-600 text-sm font-bold">{processedCount}</span>
          </div>
          <p className="text-xs font-medium text-gray-600">已处理</p>
        </div>
        <div className="card px-4 py-3 flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center">
            <AlertCircle size={16} className="text-amber-500" />
          </div>
          <p className="text-xs font-medium text-gray-600">{pendingCount} 封待处理</p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="flex-1 flex items-center gap-2 bg-white rounded-xl px-3.5 py-2.5 shadow-sm border border-gray-100">
          <Search size={15} className="text-gray-400 flex-shrink-0" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCurrentPage(1);
              clearSelection();
            }}
            placeholder="搜索邮件主题、公司或职位…"
            className="flex-1 text-sm text-gray-700 placeholder-gray-400 outline-none bg-transparent"
          />
        </div>
        <div className="flex items-center gap-1 bg-white rounded-xl p-1 shadow-sm border border-gray-100">
          {(["all", "processed", "pending"] as const).map((f) => (
            <button
              key={f}
              onClick={() => {
                setFilter(f);
                setCurrentPage(1);
                clearSelection();
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={
                filter === f
                  ? { background: "linear-gradient(135deg,#3b82f6,#6366f1)", color: "white" }
                  : { color: "#94a3b8" }
              }
            >
              {filterLabels[f]}
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            setHideIgnored((previous) => !previous);
            setCurrentPage(1);
            clearSelection();
          }}
          aria-pressed={hideIgnored}
          className={`flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-medium border shadow-sm transition-colors ${hideIgnored ? "text-blue-600 bg-blue-50 border-blue-200" : "text-gray-600 bg-white border-gray-100 hover:bg-gray-50"}`}
        >
          <EyeOff size={14} />
          隐藏已忽略
        </button>
        <button
          onClick={() => setPendingDeletion({
            ids: [...selectedEmailIds],
          })}
          disabled={selectedEmailIds.size === 0}
          className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-medium text-red-600 bg-white border border-red-100 shadow-sm hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Trash2 size={14} />
          批量删除{selectedEmailIds.size > 0 ? ` (${selectedEmailIds.size})` : ""}
        </button>
        <div className="relative">
          <button
            onClick={() => {
              const input = backfillInputRef.current;
              if (!input) return;
              if (typeof input.showPicker === "function") input.showPicker();
              else input.click();
            }}
            className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-medium text-gray-600 bg-white border border-gray-100 shadow-sm hover:bg-gray-50 transition-colors"
          >
            <History size={14} />
            补录历史
          </button>
          <input
            ref={backfillInputRef}
            type="date"
            aria-label="选择补录起始日期"
            tabIndex={-1}
            className="absolute w-px h-px opacity-0 pointer-events-none"
            onChange={(event) => {
              const input = event.currentTarget;
              window.setTimeout(() => {
                let pickerOpen = false;
                try {
                  pickerOpen = input.matches(":open");
                } catch {
                  pickerOpen = false;
                }
                const from = input.value;
                if (!shouldCommitBackfillDate(from, pickerOpen)) return;
                void onBackfill(from);
                input.value = "";
              }, 0);
            }}
          />
        </div>
        <button
          onClick={() => void onSyncNow()}
          disabled={syncing}
          className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-semibold text-white transition-all disabled:opacity-60"
          style={{ background: "linear-gradient(135deg,#3b82f6,#6366f1)" }}
        >
          <RefreshCw size={13} className={syncing ? "animate-spin" : ""} />
          {syncing ? "同步中…" : "手动同步"}
        </button>
      </div>

      {/* Email list */}
      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
          <div>
            <p className="text-sm font-bold text-gray-900">收件箱</p>
            <p className="text-xs text-gray-400 mt-0.5">
              显示 {mailboxPage.rangeStart}-{mailboxPage.rangeEnd} / {mailboxPage.filteredCount} 封邮件
              {mailboxPage.filteredCount !== emails.length ? `（共 ${emails.length} 封）` : ""}
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <div style={{ width: tableMinWidth, minWidth: tableMinWidth, margin: "0 auto" }}>
            {/* Column headers */}
            <div
              className="grid px-6 py-2.5 bg-gray-50 border-b border-gray-100 items-center"
              style={{ gridTemplateColumns }}
            >
              <div className="flex items-center justify-center">
                <input
                  type="checkbox"
                  checked={allPageEmailsSelected}
                  onChange={toggleCurrentPageSelection}
                  aria-label="选择当前页邮件"
                  className="accent-blue-500"
                />
              </div>
              {["邮件主题", "公司", "职位", "意图", "状态", "时间"].map((header, index) => (
                <div key={header} className="relative min-w-0 pr-2">
                  <p className="text-center text-xs font-semibold text-gray-400 uppercase tracking-wider truncate">{header}</p>
                  {index < 6 && (
                    <div
                      role="separator"
                      aria-label={`调整${header}和${["公司", "职位", "意图", "状态", "时间", "操作"][index]}列宽`}
                      aria-orientation="vertical"
                      tabIndex={0}
                      className="absolute right-0 top-0 z-10 h-full w-4 flex items-center justify-center cursor-col-resize touch-none focus:outline-none group/rh"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        resizing.current = { boundaryIndex: index, startX: event.clientX, widths: columnWidths };
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                        event.preventDefault();
                        setColumnWidths((widths) => resizeMailboxColumns(widths, index, event.key === "ArrowRight" ? 10 : -10));
                      }}
                    >
                      <div className="w-px h-4 bg-gray-200 group-hover/rh:bg-blue-400 group-hover/rh:w-0.5 transition-all rounded-full" />
                    </div>
                  )}
                </div>
              ))}
              <p className="text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">操作</p>
            </div>

            <div className="divide-y divide-gray-50">
              {mailboxPage.filteredCount === 0 ? (
                <div className="py-12 text-center">
                  <p className="text-sm text-gray-400">没有符合条件的邮件。</p>
                </div>
              ) : (
                mailboxPage.items.map((email) => {
                  const intent = intentConfig(email.intent);
                  return (
                    <div
                      key={email.id}
                      className="grid px-6 py-4 items-center hover:bg-blue-50/30 cursor-pointer transition-colors group"
                      style={{ gridTemplateColumns }}
                      onClick={() => void onSelectEmail(email)}
                    >
                      <div className="flex items-center justify-center" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedEmailIds.has(email.id)}
                          onChange={() => toggleEmailSelection(email.id)}
                          aria-label={`选择邮件：${email.subject}`}
                          className="accent-blue-500"
                        />
                      </div>

                      {/* Subject */}
                      <div className="flex min-w-0 items-center justify-center gap-2 px-2">
                        {(email.status === "pending" || email.status === "failed") && (
                          <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${email.status === "failed" ? "bg-red-500" : "bg-amber-500"}`} />
                        )}
                        <p className="min-w-0 truncate text-center text-sm font-medium text-gray-900" title={email.subject}>
                          {email.subject}
                        </p>
                      </div>

                      {/* Company */}
                      <div className="flex min-w-0 items-center justify-center gap-2 px-2">
                        <CompanyAvatar name={email.company} />
                        <p className="min-w-0 text-sm font-semibold text-gray-900 truncate">{email.company || "待识别"}</p>
                      </div>

                      {/* Position */}
                      <p className="truncate px-2 text-center text-xs text-gray-500">{email.position || "待识别"}</p>

                      {/* Intent */}
                      <div className="min-w-0 text-center pr-2">
                        <span
                          className="max-w-full truncate text-xs font-semibold px-2.5 py-1 rounded-lg inline-block"
                          style={{ background: intent.bg, color: intent.color }}
                        >
                          {email.intent || "待分类"}
                        </span>
                      </div>

                      {/* Status */}
                      <div className="flex min-w-0 items-center justify-center gap-1.5 text-center">
                        <div
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ background: email.status === "processed" ? "#22c55e" : email.status === "failed" ? "#ef4444" : email.status === "ignored" ? "#94a3b8" : "#f59e0b" }}
                        />
                        <span className="text-xs text-gray-500 truncate">
                          {email.status === "processed" ? "已处理" : email.status === "failed" ? "失败" : email.status === "ignored" ? "已忽略" : "待处理"}
                        </span>
                      </div>

                      {/* Time */}
                      <p className="truncate text-center font-mono text-xs text-gray-400">{formatTime(email.receivedAt)}</p>

                      <div className="flex items-center justify-center gap-1.5" onClick={(event) => event.stopPropagation()}>
                        <button
                          onClick={() => setPendingDeletion({ ids: [email.id] })}
                          aria-label={`删除邮件：${email.subject}`}
                          className="h-8 px-2 flex items-center gap-1 justify-center rounded-lg text-xs font-medium text-red-500 bg-red-50 hover:bg-red-100 transition-colors"
                        >
                          <Trash2 size={12} />删除
                        </button>
                        <button
                          onClick={() => void onSelectEmail(email)}
                          aria-label={`查看邮件：${email.subject}`}
                          className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 group-hover:bg-blue-100 transition-colors"
                        >
                          <ArrowRight size={13} className="text-gray-400 group-hover:text-blue-500" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="px-6 py-3 border-t border-gray-100 bg-gray-50/60 flex items-center justify-between">
          <p className="text-xs text-gray-400">每页 20 封</p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setCurrentPage((page) => Math.max(1, page - 1));
                clearSelection();
              }}
              disabled={mailboxPage.page === 1}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft size={13} />上一页
            </button>
            <span className="min-w-14 text-center text-xs font-semibold text-gray-500">{mailboxPage.page} / {mailboxPage.totalPages}</span>
            <button
              onClick={() => {
                setCurrentPage((page) => Math.min(mailboxPage.totalPages, page + 1));
                clearSelection();
              }}
              disabled={mailboxPage.page === mailboxPage.totalPages}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              下一页<ChevronRight size={13} />
            </button>
          </div>
        </div>
      </div>

      {pendingDeletion && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 px-4" role="presentation">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="delete-emails-title">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0"><Trash2 size={18} className="text-red-600" /></div>
              <div className="min-w-0">
                <h2 id="delete-emails-title" className="text-base font-bold text-gray-900">确认删除本地邮件？</h2>
                <p className="text-sm text-gray-500 mt-1.5 leading-relaxed">{describeEmailDeletion(pendingDeletion.ids.length)}</p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2.5">
              <button onClick={() => setPendingDeletion(undefined)} disabled={deletingEmails} className="px-4 py-2 rounded-xl text-xs font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 disabled:opacity-60 transition-colors">取消</button>
              <button onClick={() => void confirmDeletion()} disabled={deletingEmails} className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 transition-colors">{deletingEmails ? "正在删除…" : "确认删除"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
