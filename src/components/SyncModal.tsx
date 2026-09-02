import { AlertTriangle, Brain, CheckCircle, Database, Mail, X, Zap } from "lucide-react";
import type { SyncRun } from "../types";

interface Props {
  open: boolean;
  run?: SyncRun;
  error?: string;
  onClose: () => void;
}

const STEPS = [
  { label: "连接邮箱服务器", icon: Mail },
  { label: "获取新邮件", icon: Mail },
  { label: "AI 分类与意图识别", icon: Brain },
  { label: "更新申请记录", icon: Database },
  { label: "完成同步与审计", icon: Zap },
];

const PHASE_INDEX: Record<SyncRun["phase"], number> = {
  connecting: 0,
  fetching: 1,
  classifying: 2,
  updating: 3,
  finalizing: 4,
  done: 4,
};

export function SyncModal({ open, run, error, onClose }: Props) {
  if (!open) return null;
  const complete = Boolean(error) || run?.status === "succeeded" || run?.status === "failed";
  const failed = Boolean(error) || run?.status === "failed";
  const progress = Math.min(100, Math.max(0, run?.progress ?? (failed ? 100 : 5)));
  const activeStep = run ? PHASE_INDEX[run.phase] : 0;
  const result = run?.counts;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center" style={{ background: "rgba(15,23,42,0.4)", backdropFilter: "blur(4px)" }}>
      <div className="relative w-[440px] rounded-2xl overflow-hidden" style={{ background: "white", boxShadow: "0 25px 60px rgba(0,0,0,0.2)" }}>
        <div className="h-1.5 w-full" style={{ background: failed ? "linear-gradient(90deg,#ef4444,#f97316)" : "linear-gradient(90deg,#3b82f6,#6366f1,#8b5cf6)" }} />
        <div className="p-7">
          <div className="flex items-start justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: failed ? "linear-gradient(135deg,#ef4444,#f97316)" : "linear-gradient(135deg,#3b82f6,#6366f1)" }}>
                {failed ? <AlertTriangle size={18} color="white" /> : <Zap size={18} color="white" className={!complete ? "animate-pulse" : ""} />}
              </div>
              <div>
                <p className="text-sm font-bold text-gray-900">{failed ? "同步失败" : complete ? "同步完成" : "正在同步邮箱…"}</p>
                <p className="text-xs text-gray-400 mt-0.5">{failed ? "请检查配置后重试" : complete ? "以下是本次同步结果" : "正在扫描申请相关邮件"}</p>
              </div>
            </div>
            {complete && <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-xl bg-gray-100 hover:bg-gray-200 transition-colors"><X size={15} className="text-gray-500" /></button>}
          </div>

          <div className="mb-6">
            <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-300" style={{ width: `${progress}%`, background: failed ? "linear-gradient(90deg,#ef4444,#f97316)" : "linear-gradient(90deg,#3b82f6,#6366f1)" }} />
            </div>
            <div className="flex justify-between mt-1.5"><span className="text-xs text-gray-400">{complete ? "完成" : "处理中…"}</span><span className="text-xs font-mono font-medium text-gray-600">{Math.round(progress)}%</span></div>
          </div>

          <div className="space-y-2.5 mb-6">
            {STEPS.map((step, index) => {
              const done = !failed && (run?.status === "succeeded" || index < activeStep || (run?.phase === "done" && index === activeStep));
              const active = !complete && index === activeStep;
              const Icon = step.icon;
              return (
                <div key={step.label} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-all duration-300" style={done ? { background: "#ecfdf5" } : active ? { background: "#eff6ff" } : { background: "#f8fafc" }}>
                    {done ? <CheckCircle size={14} className="text-green-500" /> : <Icon size={14} style={{ color: active ? "#3b82f6" : "#cbd5e1" }} />}
                  </div>
                  <span className="text-sm transition-colors duration-300" style={{ color: done ? "#1e293b" : active ? "#3b82f6" : "#94a3b8", fontWeight: done || active ? 500 : 400 }}>{step.label}</span>
                  {active && <div className="flex gap-0.5 ml-auto">{[0, 1, 2].map((item) => <div key={item} className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: `${item * 0.15}s` }} />)}</div>}
                </div>
              );
            })}
          </div>

          {failed && <div className="mb-5 rounded-xl bg-red-50 border border-red-100 px-4 py-3"><p className="text-xs text-red-700 leading-relaxed">{error || run?.errorMessage || "未知同步错误"}</p></div>}

          {complete && result && (
            <div className="grid grid-cols-2 gap-3 mb-5">
              {[
                { label: "新邮件", value: result.newEmails, color: "#3b82f6", bg: "#eff6ff" },
                { label: "新申请", value: result.newApplications, color: "#10b981", bg: "#ecfdf5" },
                { label: "进展更新", value: result.updatedApplications, color: "#8b5cf6", bg: "#f5f3ff" },
                { label: "处理失败", value: result.failed, color: "#ef4444", bg: "#fef2f2" },
              ].map((item) => <div key={item.label} className="rounded-xl px-4 py-3" style={{ background: item.bg }}><p className="text-2xl font-extrabold" style={{ color: item.color }}>{item.value}</p><p className="text-xs font-medium mt-0.5" style={{ color: item.color, opacity: 0.8 }}>{item.label}</p></div>)}
            </div>
          )}

          {complete ? (
            <button onClick={onClose} className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-all hover:shadow-lg" style={{ background: failed ? "linear-gradient(135deg,#ef4444,#f97316)" : "linear-gradient(135deg,#3b82f6,#6366f1)" }}>完成</button>
          ) : <p className="text-center text-xs text-gray-400">同步期间请保持本地服务运行。</p>}
        </div>
      </div>
    </div>
  );
}
