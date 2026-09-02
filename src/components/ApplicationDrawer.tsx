import { useState } from "react";
import { X, ChevronDown, ChevronUp } from "lucide-react";
import type { Application, ProgressSource } from "../types";
import { getTimelineReference } from "../timelineReference";

interface Props {
  app: Application | null;
  onClose: () => void;
  onOpenEmail: (emailId: string) => Promise<void>;
}

function sourceConfig(source: ProgressSource) {
  const map: Record<ProgressSource, { color: string; bg: string; label: string }> = {
    email: { color: "#3b82f6", bg: "#eff6ff", label: "邮件" },
    manual: { color: "#64748b", bg: "#f8fafc", label: "手动" },
    ai: { color: "#8b5cf6", bg: "#f5f3ff", label: "AI" },
  };
  return map[source];
}

function statusConfig(status: string) {
  if (status === "ongoing") return { color: "#3b82f6", bg: "#eff6ff", label: "进行中" };
  if (status === "offer") return { color: "#10b981", bg: "#ecfdf5", label: "已获 Offer" };
  if (status === "rejected") return { color: "#ef4444", bg: "#fef2f2", label: "已拒绝" };
  return { color: "#64748b", bg: "#f8fafc", label: status };
}

function CompanyAvatar({ name, size = 48 }: { name: string; size?: number }) {
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
      className="rounded-2xl flex items-center justify-center font-bold flex-shrink-0"
      style={{ width: size, height: size, background: text, color: bg, fontSize: size * 0.35 }}
    >
      {name.slice(0, 2)}
    </div>
  );
}

export function ApplicationDrawer({ app, onClose, onOpenEmail }: Props) {
  const [expandedEntry, setExpandedEntry] = useState<string | null>(null);

  const open = app !== null;

  return (
    <>
      <div
        className={`fixed inset-0 z-30 transition-all duration-300 ${open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
        style={{ background: "rgba(15,23,42,0.25)", backdropFilter: "blur(2px)" }}
        onClick={onClose}
      />

      <div
        className="fixed top-0 right-0 h-full z-40 flex flex-col transition-transform duration-300 ease-in-out"
        style={{
          width: 500,
          background: "white",
          boxShadow: "-4px 0 24px rgba(0,0,0,0.1)",
          transform: open ? "translateX(0)" : "translateX(100%)",
        }}
      >
        {!app ? null : (
          <>
            {/* Header */}
            <div className="px-6 py-5 flex-shrink-0" style={{ borderBottom: "1px solid #f1f5f9" }}>
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <CompanyAvatar name={app.company} />
                  <div>
                    <h2 className="text-base font-bold text-gray-900">{app.company}</h2>
                    <p className="text-sm text-gray-500 mt-0.5">{app.position || "—"}</p>
                    <p className="text-xs text-gray-400 mt-1 font-mono">{app.trackType === "job" ? "投递日期" : "记录日期"}：{app.appliedDate}</p>
                    {app.trackType !== "job" && app.assessmentTime && (
                      <p className="text-xs text-gray-400 mt-1 font-mono">
                        {app.assessmentTimeType === "deadline" ? "截止时间" : "测评时间"}：{app.assessmentTime}
                      </p>
                    )}
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="w-8 h-8 flex items-center justify-center rounded-xl bg-gray-100 hover:bg-gray-200 transition-colors"
                >
                  <X size={16} className="text-gray-500" />
                </button>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {(() => {
                  const s = statusConfig(app.status);
                  return (
                    <span className="text-xs font-semibold px-3 py-1 rounded-full" style={{ background: s.bg, color: s.color }}>
                      {s.label}
                    </span>
                  );
                })()}
                <span className="text-xs font-semibold px-3 py-1 rounded-full" style={{ background: "#eff6ff", color: "#3b82f6" }}>
                  {app.currentProgress}
                </span>
                <span className="text-xs text-gray-400 ml-1">共 {app.timeline.length} 个阶段</span>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              {/* Timeline */}
              <div>
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">进展时间线</p>
                <div className="relative">
                  <div className="absolute left-[11px] top-2 bottom-2 w-0.5" style={{ background: "#e2e8f0" }} />
                  <div className="space-y-0">
                    {app.timeline.map((entry, idx) => {
                      const src = sourceConfig(entry.source);
                      const reference = getTimelineReference(entry.sourceEmailId);
                      const expanded = expandedEntry === entry.id;
                      const isLast = idx === app.timeline.length - 1;
                      return (
                        <div key={entry.id} className="flex gap-4 relative">
                          <div className="flex flex-col items-center z-10 flex-shrink-0">
                            <div
                              className="w-5 h-5 rounded-full border-2 border-white flex items-center justify-center mt-1"
                              style={{ background: isLast ? "#3b82f6" : "#e2e8f0", boxShadow: isLast ? "0 0 0 3px #bfdbfe" : "none" }}
                            >
                              {isLast && <div className="w-2 h-2 rounded-full bg-white" />}
                            </div>
                          </div>
                          <div className="flex-1 pb-5 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <button
                                className="text-sm font-semibold text-gray-900 hover:text-blue-600 transition-colors text-left flex items-center gap-1"
                                onClick={() => setExpandedEntry(expanded ? null : entry.id)}
                              >
                                {entry.stage}
                                {entry.detail && (expanded ? <ChevronUp size={13} className="text-gray-400" /> : <ChevronDown size={13} className="text-gray-400" />)}
                              </button>
                              <aside aria-label="进展日期和原邮件" className="flex flex-col items-end gap-2 flex-shrink-0">
                                <time dateTime={entry.date} className="text-xs font-mono text-gray-400">{entry.date}</time>
                                <button
                                  type="button"
                                  disabled={reference.disabled}
                                  onClick={() => reference.emailId && void onOpenEmail(reference.emailId)}
                                  title={reference.disabled ? "该进展没有对应邮件" : "打开对应邮件"}
                                  className="text-xs font-semibold px-2.5 py-1 rounded-lg border transition-all enabled:border-blue-100 enabled:bg-blue-50 enabled:text-blue-600 enabled:hover:bg-blue-100 enabled:hover:border-blue-200 enabled:hover:text-blue-700 enabled:cursor-pointer enabled:active:scale-95 disabled:border-gray-100 disabled:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
                                >
                                  {reference.label}
                                </button>
                              </aside>
                            </div>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              <span className="text-xs font-semibold px-2 py-0.5 rounded-lg" style={{ background: src.bg, color: src.color }}>
                                {src.label}
                              </span>
                              {entry.tags?.map((tag) => (
                                <span key={tag} className="text-xs px-2 py-0.5 rounded-lg" style={{ background: "#f5f3ff", color: "#8b5cf6" }}>
                                  {tag}
                                </span>
                              ))}
                            </div>
                            {entry.notes && <p className="text-xs text-gray-500 mt-1.5">{entry.notes}</p>}
                            {expanded && entry.detail && (
                              <div className="mt-2 p-3 rounded-xl bg-gray-50 border border-gray-100">
                                <p className="text-xs text-gray-700 leading-relaxed">{entry.detail}</p>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 flex items-center justify-end gap-2 flex-shrink-0" style={{ borderTop: "1px solid #f1f5f9" }}>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors"
              >
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
