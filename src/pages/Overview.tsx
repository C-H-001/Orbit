import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { ArrowRight, Trash2, Undo2, ArrowUp, ArrowDown, ChevronsUpDown, AlertTriangle, Plus, Download, Pencil, ChevronLeft, ChevronRight } from "lucide-react";
import type { Application } from "../types";
import { CompanyCareerMemo } from "../components/CompanyCareerMemo";

interface Props {
  applications: Application[];
  searchQuery: string;
  onSelectApp: (app: Application) => void;
  onAddApplication: (app: Pick<Application, "company" | "position" | "appliedDate">) => Promise<boolean>;
  onUpdateApp: (app: Application) => Promise<boolean>;
  onDeleteApplication: (id: string) => Promise<boolean>;
  onRestoreApplication: (id: string) => Promise<boolean>;
  onExport: () => Promise<void>;
}

type SortKey = "company" | "position" | "currentProgress" | "appliedDate" | "updatedAt" | "status" | "interviewTime";
type SortDir = "asc" | "desc";

export function currentProgressLabel(progress: Application["currentProgress"], _status: Application["status"]) {
  return progress;
}

function progressToIndex(progress: Application["currentProgress"]): number {
  return ["已投递", "笔试中", "AI Coding中", "面试中", "阻塞（需要预约时间）", "已拒绝", "其它"].indexOf(progress);
}

function lastProgressDate(app: Application) {
  const dates = [app.appliedDate, ...app.timeline.map((entry) => entry.date)]
    .map((value) => ({ value, timestamp: new Date(value).getTime() }))
    .filter((item) => !Number.isNaN(item.timestamp));
  return dates.sort((left, right) => right.timestamp - left.timestamp)[0];
}

export function isLongInactiveApplication(app: Application, now = new Date()) {
  if (app.deletedAt || app.completed || app.status !== "ongoing" || app.currentProgress === "已拒绝") return false;
  const latest = lastProgressDate(app);
  if (!latest) return false;
  return now.getTime() - latest.timestamp > 7 * 24 * 60 * 60 * 1000;
}

function StagePills({ progress, status, faded, stale }: { progress: Application["currentProgress"]; status: Application["status"]; faded?: boolean; stale?: boolean }) {
  const label = currentProgressLabel(progress, status);
  let bg = "#eff6ff";
  let color = "#3b82f6";
  if (faded) {
    bg = "#f8fafc";
    color = "#cbd5e1";
  } else if (label === "笔试中") {
    bg = "#f5f3ff";
    color = "#7c3aed";
  } else if (label === "AI Coding中") {
    bg = "#ecfeff";
    color = "#0891b2";
  } else if (label === "阻塞（需要预约时间）") {
    bg = "#fffbeb";
    color = "#d97706";
  } else if (label === "已拒绝") {
    bg = "#fef2f2";
    color = "#dc2626";
  } else if (label === "其它") {
    bg = "#f1f5f9";
    color = "#64748b";
  }

  return (
    <div className="flex items-center gap-1.5" aria-label="当前招聘进度">
      <span
        className="text-xs font-medium px-2.5 py-1 rounded-md whitespace-nowrap"
        style={{ background: bg, color }}
      >
        {label}
      </span>
      {stale && !faded && (
        <span
          className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-50 text-amber-500"
          title="该记录已长时间未更新，建议去官网查看最新进度。"
          aria-label="该记录已长时间未更新，建议去官网查看最新进度。"
        >
          <AlertTriangle size={12} />
        </span>
      )}
    </div>
  );
}

function CompanyAvatar({ name, size = 36, faded }: { name: string; size?: number; faded?: boolean }) {
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
  const idx = name.charCodeAt(0) % palettes.length;
  const [bg, text] = palettes[idx];
  return (
    <div
      className="rounded-xl flex items-center justify-center font-bold flex-shrink-0"
      style={{
        width: size,
        height: size,
        background: faded ? "#f1f5f9" : text,
        color: faded ? "#94a3b8" : bg,
        fontSize: size * 0.38,
      }}
    >
      {name.slice(0, 2)}
    </div>
  );
}

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (sortKey !== col) return <ChevronsUpDown size={13} className="text-gray-300 ml-1" />;
  return sortDir === "asc"
    ? <ArrowUp size={13} className="text-blue-500 ml-1" />
    : <ArrowDown size={13} className="text-blue-500 ml-1" />;
}

function formatInterviewTime(iso?: string) {
  if (!iso) return null;
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// datetime-local inputs require "YYYY-MM-DDTHH:mm"
function toDatetimeLocal(iso?: string) {
  if (!iso) return "";
  return iso.slice(0, 16);
}

// Slightly wider default columns while keeping pixel-based resizing.
const INIT_WIDTHS = [225, 205, 150, 125, 125, 115];

export function Overview({ applications, searchQuery, onSelectApp, onAddApplication, onUpdateApp, onDeleteApplication, onRestoreApplication, onExport }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("appliedDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [activeTab, setActiveTab] = useState<"all" | "todo" | "completed" | "stale">("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newCompany, setNewCompany] = useState("");
  const [newPosition, setNewPosition] = useState("");
  const [editingTimeId, setEditingTimeId] = useState<string | null>(null);
  const timeInputRef = useRef<HTMLInputElement>(null);
  const [colWidths, setColWidths] = useState<number[]>(INIT_WIDTHS);
  const dragState = useRef<{ col: number; startX: number; widths: number[] } | null>(null);

  const startResize = useCallback((e: React.MouseEvent, colIdx: number) => {
    if (colIdx < 0 || colIdx >= colWidths.length - 1) return;
    e.preventDefault();
    dragState.current = { col: colIdx, startX: e.clientX, widths: [...colWidths] };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return;
      const delta = ev.clientX - dragState.current.startX;
      const index = dragState.current.col;
      const widths = dragState.current.widths;
      const boundedDelta = Math.max(70 - widths[index]!, Math.min(delta, widths[index + 1]! - 70));
      const next = [...widths];
      next[index] += boundedDelta;
      next[index + 1] -= boundedDelta;
      setColWidths(next);
    };
    const onUp = () => {
      dragState.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [colWidths]);

  function toggleSort(col: SortKey) {
    if (sortKey === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(col); setSortDir("asc"); }
  }

  function handleDeleteClick(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setConfirmId(id);
  }

  async function handleConfirmDelete() {
    if (confirmId) {
      if (await onDeleteApplication(confirmId)) setConfirmId(null);
    }
  }

  async function handleAddSubmit() {
    if (!newCompany.trim() || !newPosition.trim()) return;
    const saved = await onAddApplication({
      company: newCompany.trim(),
      position: newPosition.trim(),
      appliedDate: new Date().toISOString().split("T")[0],
    });
    if (!saved) return;
    setShowAddModal(false);
    setNewCompany("");
    setNewPosition("");
  }

  async function handleRestore(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await onRestoreApplication(id);
  }

  function handleTimeEdit(app: Application, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingTimeId(app.id);
    setTimeout(() => timeInputRef.current?.focus(), 0);
  }

  async function handleTimeSave(app: Application, value: string) {
    const updated: Application = app.trackType === "job"
      ? { ...app, interviewTime: value ? `${value}:00` : undefined }
      : { ...app, assessmentTime: value || undefined };
    if (await onUpdateApp(updated)) setEditingTimeId(null);
  }

  const tabLabels: Record<"all" | "todo" | "completed" | "stale", string> = {
    all: "全部",
    todo: "待办",
    completed: "已完成",
    stale: "长期未更新",
  };

  const tabFiltered = applications.filter((a) => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (query && ![a.company, a.position, a.currentProgress, a.nextAction].some((value) => value.toLocaleLowerCase().includes(query))) return false;
    if (activeTab === "todo") return !a.completed;
    if (activeTab === "completed") return a.completed;
    if (activeTab === "stale") return isLongInactiveApplication(a);
    return true;
  });

  const sorted = useMemo(() => {
    const active = tabFiltered.filter((a) => !a.deletedAt);
    const deleted = tabFiltered.filter((a) => a.deletedAt);

    function cmp(a: Application, b: Application) {
      let av: string | number = "";
      let bv: string | number = "";
      if (sortKey === "company") { av = a.company; bv = b.company; }
      else if (sortKey === "position") { av = a.position; bv = b.position; }
      else if (sortKey === "currentProgress") { av = progressToIndex(a.currentProgress); bv = progressToIndex(b.currentProgress); }
      else if (sortKey === "appliedDate") { av = a.appliedDate; bv = b.appliedDate; }
      else if (sortKey === "updatedAt") { av = lastProgressDate(a)?.timestamp ?? 0; bv = lastProgressDate(b)?.timestamp ?? 0; }
      else if (sortKey === "status") { av = a.completed ? 1 : 0; bv = b.completed ? 1 : 0; }
      else if (sortKey === "interviewTime") {
        av = (a.trackType === "job" ? a.interviewTime : a.assessmentTime) ?? "";
        bv = (b.trackType === "job" ? b.interviewTime : b.assessmentTime) ?? "";
        // undefined always sorts last regardless of direction
        if (!av && !bv) return 0;
        if (!av) return 1;
        if (!bv) return -1;
      }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    }

    return [...active.sort(cmp), ...deleted];
  }, [tabFiltered, sortKey, sortDir]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / 20));
  const page = Math.min(currentPage, totalPages);
  const paginatedApplications = sorted.slice((page - 1) * 20, page * 20);

  useEffect(() => { setCurrentPage(1); }, [activeTab, searchQuery, sortKey, sortDir]);
  useEffect(() => { if (currentPage > totalPages) setCurrentPage(totalPages); }, [currentPage, totalPages]);

  const headerCols: { key: SortKey; label: string }[] = [
    { key: "company", label: "公司 / 职位" },
    { key: "currentProgress", label: "招聘进度" },
    { key: "interviewTime", label: "笔试 / 面试时间" },
    { key: "appliedDate", label: "投递日期" },
    { key: "updatedAt", label: "最后更新" },
    { key: "status", label: "状态" },
  ];

  const gridTemplate = `${colWidths.map((width) => `${width}px`).join(" ")} 32px 32px`;

  return (
    <div className="p-6">
      {/* Toolbar */}
      <div className="flex items-center justify-end gap-2 mb-3">
        <button onClick={() => void onExport()} className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 hover:border-gray-300 hover:shadow-sm transition-all shadow-sm cursor-pointer">
          <Download size={13} />
          导出 CSV
        </button>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-white transition-all hover:shadow-md hover:opacity-90 active:scale-95 cursor-pointer"
          style={{ background: "linear-gradient(135deg,#8b5cf6,#ec4899)" }}
        >
          <Plus size={13} />
          新增申请
        </button>
      </div>

      <div className="card overflow-hidden">
        {/* Card header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-50">
          <div>
            <p className="text-sm font-bold text-gray-900">申请记录</p>
            <p className="text-xs text-gray-400 mt-0.5">
              共 {applications.length} 条{applications.some((item) => item.deletedAt) && ` · ${applications.filter((item) => item.deletedAt).length} 条已删除`}
            </p>
          </div>
          <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1">
            {(["all", "todo", "completed", "stale"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer hover:text-gray-600"
                style={
                  activeTab === t
                    ? { background: "white", color: "#1e293b", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" }
                    : { color: "#94a3b8" }
                }
              >
                {tabLabels[t]}
              </button>
            ))}
          </div>
        </div>

        {/* Column headers */}
        <div
          className="grid px-6 py-3 bg-gray-50 border-b border-gray-100 select-none"
          style={{ gridTemplateColumns: gridTemplate, justifyContent: "space-between" }}
        >
          {headerCols.map(({ key, label }, i) => (
            <div key={label} className="relative flex items-center min-w-0">
              <button
                onClick={() => toggleSort(key)}
                className="flex items-center text-xs font-semibold text-gray-400 hover:text-gray-600 transition-colors uppercase tracking-wider cursor-pointer truncate"
              >
                {label}
                <SortIcon col={key} sortKey={sortKey} sortDir={sortDir} />
              </button>
              {i < headerCols.length - 1 && (
                <div
                  onMouseDown={(e) => startResize(e, i)}
                  className="absolute right-0 top-0 h-full w-4 flex items-center justify-center cursor-col-resize z-10 group/rh"
                >
                  <div className="w-px h-4 bg-gray-200 group-hover/rh:bg-blue-400 group-hover/rh:w-0.5 transition-all rounded-full" />
                </div>
              )}
            </div>
          ))}
          <div />
          <div />
        </div>

        {/* Rows */}
        <div className="divide-y divide-gray-50">
          {sorted.length === 0 ? (
            <div className="py-16 text-center text-sm text-gray-400">暂无申请记录</div>
          ) : (
            paginatedApplications.map((app) => {
              const isDeleted = Boolean(app.deletedAt);
              const isEditingTime = editingTimeId === app.id;
              const eventTime = app.trackType === "job" ? app.interviewTime : app.assessmentTime;
              const formattedTime = app.trackType === "job"
                ? formatInterviewTime(eventTime)
                : eventTime
                  ? `${app.assessmentTimeType === "deadline" ? "截止：" : ""}${eventTime}`
                  : null;
              const stale = isLongInactiveApplication(app);
              const latestProgress = lastProgressDate(app)?.value ?? app.appliedDate;

              return (
                <div
                  key={app.id}
                  className={`grid px-6 py-4 items-center transition-all group ${!isDeleted ? "hover:bg-blue-50/40 hover:shadow-[inset_0_0_0_1px_#dbeafe]" : ""}`}
                  style={{
                    gridTemplateColumns: gridTemplate,
                    justifyContent: "space-between",
                    background: isDeleted ? "#fafafa" : undefined,
                    opacity: isDeleted ? 0.5 : 1,
                    cursor: isDeleted ? "default" : "pointer",
                  }}
                  onClick={() => !isDeleted && onSelectApp(app)}
                >
                  {/* Company / position */}
                  <div className="flex items-center gap-3">
                    <CompanyAvatar name={app.company} size={38} faded={isDeleted} />
                    <div>
                      <p className={`text-sm font-semibold ${isDeleted ? "text-gray-400 line-through" : "text-gray-900"}`}>
                        {app.company}
                      </p>
                      <p className="text-xs text-gray-400 truncate max-w-[160px]">{app.position || "—"}</p>
                    </div>
                  </div>

                  {/* Stage pills */}
                  <div className="pr-4">
                    <StagePills progress={app.currentProgress} status={app.status} faded={isDeleted} stale={stale} />
                  </div>

                  {/* Interview time — inline editable */}
                  <div
                    className={`flex items-center gap-1.5 pr-4 rounded-lg px-2 py-1 -mx-2 -my-1 transition-all ${!isDeleted && !isEditingTime ? "hover:bg-blue-50 cursor-pointer" : ""}`}
                    onClick={(e) => {
                      if (!isDeleted && !isEditingTime) {
                        e.stopPropagation();
                        handleTimeEdit(app, e);
                      }
                    }}
                  >
                    {isEditingTime ? (
                      <input
                        ref={timeInputRef}
                        type={app.trackType === "job" ? "datetime-local" : "date"}
                        defaultValue={app.trackType === "job" ? toDatetimeLocal(app.interviewTime) : app.assessmentTime?.slice(0, 10) ?? ""}
                        className="text-xs border border-blue-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-100 bg-white"
                        style={{ fontFamily: "JetBrains Mono, monospace" }}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => handleTimeSave(app, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          if (e.key === "Escape") setEditingTimeId(null);
                        }}
                      />
                    ) : (
                      <>
                        <span
                          className="text-xs font-mono"
                          style={{ color: formattedTime ? (isDeleted ? "#cbd5e1" : "#475569") : "#cbd5e1" }}
                        >
                          {formattedTime ?? "—"}
                        </span>
                        {!isDeleted && (
                          <Pencil size={11} className="text-gray-200 group-hover:text-gray-400 transition-colors flex-shrink-0" />
                        )}
                      </>
                    )}
                  </div>

                  {/* Applied date */}
                  <p className={`text-xs font-mono ${isDeleted ? "text-gray-300" : "text-gray-400"}`}>
                    {app.appliedDate}
                  </p>

                  {/* Last progress update */}
                  <p className={`text-xs font-mono ${isDeleted ? "text-gray-300" : "text-gray-400"}`}>
                    {latestProgress.slice(0, 10)}
                  </p>

                  {/* Status */}
                  {isDeleted ? (
                    <span className="text-xs text-gray-300">已删除</span>
                  ) : (
                    <label
                      className="flex items-center gap-2 cursor-pointer select-none w-fit"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={app.completed}
                        onChange={(e) => void onUpdateApp({ ...app, completed: e.target.checked })}
                        className="w-4 h-4 rounded border-gray-300 accent-blue-600 cursor-pointer"
                      />
                      <span className={`text-xs font-medium ${app.completed ? "text-green-600" : "text-gray-500"}`}>
                        已完成
                      </span>
                    </label>
                  )}

                  {/* Detail arrow */}
                  <button
                    className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-blue-50 transition-all cursor-pointer"
                    onClick={(e) => { e.stopPropagation(); if (!isDeleted) onSelectApp(app); }}
                  >
                    {!isDeleted && (
                      <ArrowRight size={14} className="text-gray-300 group-hover:text-blue-500 transition-colors" />
                    )}
                  </button>

                  {/* Trash / Restore */}
                  {isDeleted ? (
                    <button
                      className="w-8 h-8 flex items-center justify-center rounded-lg bg-blue-50 hover:bg-blue-100 transition-all cursor-pointer"
                      onClick={(e) => handleRestore(app.id, e)}
                      title="撤回删除"
                    >
                      <Undo2 size={14} className="text-blue-400 hover:text-blue-600 transition-colors" />
                    </button>
                  ) : (
                    <button
                      className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-50 transition-all cursor-pointer"
                      onClick={(e) => handleDeleteClick(app.id, e)}
                      title="删除"
                    >
                      <Trash2 size={15} className="text-gray-300 group-hover:text-red-400 transition-colors" />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
        <div className="flex items-center justify-between border-t border-gray-100 bg-gray-50/60 px-6 py-3">
          <p className="text-xs text-gray-400">每页 20 条 · 共 {sorted.length} 条</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setCurrentPage((value) => Math.max(1, value - 1))} disabled={page === 1} className="flex cursor-pointer items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"><ChevronLeft size={13} />上一页</button>
            <span className="min-w-14 text-center text-xs font-semibold text-gray-500">{page} / {totalPages}</span>
            <button type="button" onClick={() => setCurrentPage((value) => Math.min(totalPages, value + 1))} disabled={page === totalPages} className="flex cursor-pointer items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40">下一页<ChevronRight size={13} /></button>
          </div>
        </div>
      </div>

      <CompanyCareerMemo />

      {/* Add Application Modal */}
      {showAddModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(15,23,42,0.4)", backdropFilter: "blur(4px)" }}
        >
          <div className="w-[400px] rounded-2xl overflow-hidden" style={{ background: "white", boxShadow: "0 25px 60px rgba(0,0,0,0.18)" }}>
            <div className="h-1 w-full" style={{ background: "linear-gradient(90deg,#8b5cf6,#ec4899)" }} />
            <div className="p-6">
              <div className="flex items-start gap-4 mb-5">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#f5f3ff" }}>
                  <Plus size={18} style={{ color: "#8b5cf6" }} />
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900">新增申请记录</p>
                  <p className="text-xs text-gray-400 mt-1">手动添加一条新的求职申请。</p>
                </div>
              </div>
              <div className="space-y-3 mb-5">
                <div>
                  <label className="text-xs font-semibold text-gray-500 mb-1.5 block">公司名称</label>
                  <input
                    value={newCompany}
                    onChange={(e) => setNewCompany(e.target.value)}
                    placeholder="例：字节跳动"
                    autoFocus
                    className="w-full text-sm border border-gray-200 rounded-xl px-4 py-2.5 focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100 transition-all"
                    onKeyDown={(e) => e.key === "Enter" && handleAddSubmit()}
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 mb-1.5 block">职位名称</label>
                  <input
                    value={newPosition}
                    onChange={(e) => setNewPosition(e.target.value)}
                    placeholder="例：高级前端工程师"
                    className="w-full text-sm border border-gray-200 rounded-xl px-4 py-2.5 focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100 transition-all"
                    onKeyDown={(e) => e.key === "Enter" && handleAddSubmit()}
                  />
                </div>
              </div>
              <div className="flex gap-2.5">
                <button
                  onClick={() => { setShowAddModal(false); setNewCompany(""); setNewPosition(""); }}
                  className="flex-1 py-2.5 rounded-xl text-xs font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleAddSubmit}
                  disabled={!newCompany.trim() || !newPosition.trim()}
                  className="flex-1 py-2.5 rounded-xl text-xs font-semibold text-white transition-all hover:shadow-md disabled:opacity-40"
                  style={{ background: "linear-gradient(135deg,#8b5cf6,#ec4899)" }}
                >
                  添加
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Delete Modal */}
      {confirmId && (() => {
        const target = applications.find((a) => a.id === confirmId);
        if (!target) return null;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{ background: "rgba(15,23,42,0.4)", backdropFilter: "blur(4px)" }}
          >
            <div className="w-[380px] rounded-2xl overflow-hidden" style={{ background: "white", boxShadow: "0 25px 60px rgba(0,0,0,0.18)" }}>
              <div className="h-1 w-full" style={{ background: "linear-gradient(90deg,#ef4444,#f97316)" }} />
              <div className="p-6">
                <div className="flex items-start gap-4 mb-5">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#fef2f2" }}>
                    <AlertTriangle size={18} style={{ color: "#ef4444" }} />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-gray-900">确认删除申请</p>
                    <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                      删除后该记录将置底并变灰，你可以随时通过撤回按钮恢复。
                    </p>
                  </div>
                </div>
                <div className="rounded-xl px-4 py-3 mb-5" style={{ background: "#f8fafc", border: "1px solid #f1f5f9" }}>
                  <p className="text-sm font-semibold text-gray-800">{target.company}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{target.position}</p>
                  <p className="text-xs font-mono text-gray-300 mt-1">{target.appliedDate}</p>
                </div>
                <div className="flex gap-2.5">
                  <button
                    onClick={() => setConfirmId(null)}
                    className="flex-1 py-2.5 rounded-xl text-xs font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleConfirmDelete}
                    className="flex-1 py-2.5 rounded-xl text-xs font-semibold text-white transition-all hover:shadow-md"
                    style={{ background: "linear-gradient(135deg,#ef4444,#f97316)" }}
                  >
                    确认删除
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
