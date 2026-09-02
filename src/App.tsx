import { useCallback, useEffect, useState } from "react";
import {
  LayoutDashboard,
  Mail,
  MessageSquare,
  BarChart3,
  Settings,
  Search,
  ChevronRight,
  BookOpen,
} from "lucide-react";
import type { Page, Application, Email, EmailDetail, SyncRun } from "./types";
import { api, downloadApplicationCsv } from "./api";
import { createSyncPoller } from "./syncPolling";
import { Overview } from "./pages/Overview";
import { Mailbox } from "./pages/Mailbox";
import { AgentConversations } from "./pages/AgentConversations";
import { UsageStatistics } from "./pages/UsageStatistics";
import { SystemSettings } from "./pages/SystemSettings";
import { InterviewExperiences } from "./pages/InterviewExperiences";
import { ApplicationDrawer } from "./components/ApplicationDrawer";
import { EmailDrawer } from "./components/EmailDrawer";
import { SyncModal } from "./components/SyncModal";

export const INTERVIEW_EXPERIENCE_NAV = {
  id: "experiences" as const,
  label: "面经收集",
  icon: BookOpen,
};

export function getInterviewBackgroundProps(drawerOpen: boolean) {
  return drawerOpen ? { inert: true, "aria-hidden": "true" as const } : {};
}

const NAV_ITEMS: { id: Page; label: string; icon: React.ElementType }[] = [
  { id: "overview", label: "概览", icon: LayoutDashboard },
  { id: "mailbox", label: "邮箱", icon: Mail },
  INTERVIEW_EXPERIENCE_NAV,
  { id: "agent", label: "智能对话", icon: MessageSquare },
  { id: "usage", label: "用量统计", icon: BarChart3 },
  { id: "settings", label: "系统设置", icon: Settings },
];

const PAGE_TITLES: Record<Page, string> = {
  overview: "概览",
  mailbox: "邮箱",
  experiences: "面经收集",
  agent: "智能对话",
  usage: "用量统计",
  settings: "系统设置",
};

const PAGE_SUB: Record<Page, string> = {
  overview: "追踪你的求职申请进度",
  mailbox: "邮件分类与自动同步",
  experiences: "整理和回顾面试经验",
  agent: "随时询问求职相关问题",
  usage: "API 调用与 Token 消耗",
  settings: "邮箱、LLM 与同步配置",
};

function syncStatus(run?: SyncRun) {
  if (!run) return { label: "尚未同步", bg: "#f8fafc", color: "#64748b", dot: "#94a3b8" };
  if (run.status === "queued" || run.status === "running") return { label: "正在同步…", bg: "#fffbeb", color: "#b45309", dot: "#f59e0b" };
  if (run.status === "failed") return { label: "同步失败", bg: "#fef2f2", color: "#dc2626", dot: "#ef4444" };
  const time = run.finishedAt ? new Date(run.finishedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "刚刚";
  return { label: `${time} 已同步`, bg: "#ecfdf5", color: "#047857", dot: "#10b981" };
}

export default function App() {
  const [activePage, setActivePage] = useState<Page>("overview");
  const [applications, setApplications] = useState<Application[]>([]);
  const [emails, setEmails] = useState<Email[]>([]);
  const [drawerApp, setDrawerApp] = useState<Application | null>(null);
  const [drawerEmail, setDrawerEmail] = useState<EmailDetail | null>(null);
  const [syncRun, setSyncRun] = useState<SyncRun | undefined>();
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [syncError, setSyncError] = useState<string>();
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState<string>();
  const [experienceDrawerOpen, setExperienceDrawerOpen] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const data = await api.getBootstrap();
      setApplications(data.applications);
      setEmails(data.emails);
      setSyncRun(data.syncRun);
      setApiError(undefined);
      setDrawerApp((current) => current ? data.applications.find((item) => item.id === current.id) ?? null : null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "无法连接 Orbit API");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  useEffect(() => {
    if (!syncRun || (syncRun.status !== "queued" && syncRun.status !== "running")) return;
    return createSyncPoller({
      getRun: async () => (await api.getSyncRun(syncRun.id)).run,
      onRun: (run) => { setSyncRun(run); setSyncError(undefined); },
      onComplete: (run) => { setSyncRun(run); void loadData(); },
      onError: (error) => setSyncError(error instanceof Error ? error.message : "无法获取同步状态"),
    });
  }, [loadData, syncRun?.id, syncRun?.status]);

  function replaceApplication(application: Application) {
    setApplications((previous) => previous.map((item) => item.id === application.id ? application : item));
    if (drawerApp?.id === application.id) setDrawerApp(application);
  }

  async function handleAddApplication(input: Pick<Application, "company" | "position" | "appliedDate">) {
    try {
      const { application } = await api.createApplication(input);
      setApplications((previous) => [application, ...previous]);
      setApiError(undefined);
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "新增申请失败");
      return false;
    }
  }

  async function handleUpdateApp(application: Application) {
    try {
      const result = await api.updateApplication(application.id, {
        company: application.company,
        ...(application.position ? { position: application.position } : {}),
        status: application.status,
        currentProgress: application.currentProgress,
        nextAction: application.nextAction,
        appliedDate: application.appliedDate,
        interviewTime: application.interviewTime ?? null,
        assessmentTime: application.assessmentTime ?? null,
        assessmentTimeType: application.assessmentTimeType ?? null,
        completed: application.completed,
      });
      replaceApplication(result.application);
      setApiError(undefined);
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "更新申请失败");
      return false;
    }
  }

  async function handleDeleteApplication(id: string) {
    try {
      const { application } = await api.deleteApplication(id);
      replaceApplication(application);
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "删除申请失败");
      return false;
    }
  }

  async function handleRestoreApplication(id: string) {
    try {
      const { application } = await api.restoreApplication(id);
      replaceApplication(application);
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "恢复申请失败");
      return false;
    }
  }

  async function handleExport() {
    try {
      await downloadApplicationCsv();
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "导出失败");
    }
  }

  async function handleOpenEmail(emailOrId: Email | string) {
    const id = typeof emailOrId === "string" ? emailOrId : emailOrId.id;
    try {
      const { email } = await api.getEmail(id);
      setDrawerEmail(email);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "无法读取原邮件");
    }
  }

  async function handleDeleteEmails(ids: string[]) {
    try {
      await api.deleteEmails(ids);
      if (drawerEmail && ids.includes(drawerEmail.id)) setDrawerEmail(null);
      await loadData();
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "删除本地邮件失败");
      return false;
    }
  }

  async function handleStartSync(mode: "incremental" | "backfill" = "incremental", from?: string) {
    setSyncModalOpen(true);
    setSyncError(undefined);
    try {
      const result = await api.startSync({ mode, from });
      setSyncRun(result.run);
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "无法启动同步");
    }
  }

  const pendingCount = emails.filter((email) => email.status === "pending" || email.status === "failed").length;
  const currentSyncStatus = syncStatus(syncRun);
  const experienceBackgroundProps = getInterviewBackgroundProps(experienceDrawerOpen);

  return (
    <div className="h-full flex overflow-hidden" style={{ background: "#f1f5f9" }}>
      <nav {...experienceBackgroundProps} className="flex-shrink-0 flex flex-col" style={{ width: 240, background: "white", borderRight: "1px solid #e8edf5", boxShadow: "2px 0 8px rgba(0,0,0,0.04)" }}>
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg,#3b82f6,#6366f1)" }}>
            <LayoutDashboard size={18} color="white" />
          </div>
          <div><p className="text-sm font-bold text-gray-900 tracking-tight">Orbit</p><p className="text-xs text-gray-400">求职追踪</p></div>
        </div>
        <div className="px-4 mb-3">
          <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
            <Search size={14} className="text-gray-400 flex-shrink-0" />
            <input value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); if (event.target.value) setActivePage("overview"); }} placeholder="Search…" className="bg-transparent text-xs text-gray-600 placeholder-gray-400 outline-none w-full" />
          </div>
        </div>
        <p className="px-5 text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">菜单</p>
        <div className="flex-1 px-3 space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const active = activePage === item.id;
            const Icon = item.icon;
            return (
              <button key={item.id} onClick={() => setActivePage(item.id)} className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-150 group relative cursor-pointer hover:bg-gray-50" style={active ? { background: "linear-gradient(135deg,#eff6ff,#eef2ff)", color: "#3b82f6" } : { color: "#64748b" }}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-all" style={active ? { background: "linear-gradient(135deg,#3b82f6,#6366f1)" } : { background: "#f8fafc" }}><Icon size={16} color={active ? "white" : "#94a3b8"} /></div>
                <span className={`text-sm font-medium ${active ? "text-blue-600" : "text-gray-600 group-hover:text-gray-900"}`}>{item.label}</span>
                {item.id === "mailbox" && pendingCount > 0 && <span className="ml-auto text-xs font-semibold bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center">{pendingCount}</span>}
                {active && <ChevronRight size={14} className="ml-auto text-blue-400" />}
              </button>
            );
          })}
        </div>
        <div className="mx-4 mb-4 p-3 rounded-xl" style={{ background: "#f8fafc", border: "1px solid #e8edf5" }}>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold gradient-blue flex-shrink-0">LO</div>
            <div className="min-w-0"><p className="text-xs font-semibold text-gray-800 truncate">本地用户</p><p className="text-xs text-gray-400 truncate">单机模式</p></div>
          </div>
        </div>
      </nav>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header {...experienceBackgroundProps} className="flex-shrink-0 flex items-center justify-between px-6" style={{ height: 64, background: "white", borderBottom: "1px solid #e8edf5", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
          <div><h1 className="text-base font-bold text-gray-900">{PAGE_TITLES[activePage]}</h1><p className="text-xs text-gray-400 mt-0.5">{PAGE_SUB[activePage]}</p></div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full" style={{ background: currentSyncStatus.bg, color: currentSyncStatus.color }}>
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: currentSyncStatus.dot }} />
            <span className="text-xs font-medium">{currentSyncStatus.label}</span>
          </div>
        </header>

        <main {...experienceBackgroundProps} className="flex-1 overflow-y-auto">
          {apiError && (
            <div className="mx-6 mt-5 rounded-xl border border-red-100 bg-red-50 px-4 py-3 flex items-center justify-between gap-4">
              <p className="text-sm text-red-700">{apiError}</p>
              <button onClick={() => void loadData()} className="text-xs font-semibold text-red-600 hover:text-red-800">重试</button>
            </div>
          )}
          {loading ? (
            <div className="py-24 text-center text-sm text-gray-400">正在加载数据…</div>
          ) : (
            <>
              {activePage === "overview" && (
                <Overview
                  applications={applications}
                  searchQuery={searchQuery}
                  onSelectApp={setDrawerApp}
                  onAddApplication={handleAddApplication}
                  onUpdateApp={handleUpdateApp}
                  onDeleteApplication={handleDeleteApplication}
                  onRestoreApplication={handleRestoreApplication}
                  onExport={handleExport}
                />
              )}
              {activePage === "mailbox" && (
                <Mailbox
                  emails={emails}
                  syncing={syncRun?.status === "queued" || syncRun?.status === "running"}
                  onSelectEmail={handleOpenEmail}
                  onDeleteEmails={handleDeleteEmails}
                  onSyncNow={() => handleStartSync("incremental")}
                  onBackfill={(from) => handleStartSync("backfill", from)}
                />
              )}
              {activePage === "experiences" && <InterviewExperiences onDrawerOpenChange={setExperienceDrawerOpen} />}
              <div className={activePage === "agent" ? "h-full" : "hidden"} aria-hidden={activePage !== "agent"}>
                <AgentConversations applications={applications} onDataChanged={loadData} />
              </div>
              {activePage === "usage" && <UsageStatistics />}
              {activePage === "settings" && <SystemSettings onApplicationsDeleted={loadData} />}
            </>
          )}
        </main>
      </div>

      <ApplicationDrawer app={drawerApp} onClose={() => setDrawerApp(null)} onOpenEmail={handleOpenEmail} />
      <EmailDrawer
        email={drawerEmail}
        application={drawerEmail?.applicationId ? applications.find((item) => item.id === drawerEmail.applicationId) : undefined}
        onClose={() => setDrawerEmail(null)}
        onSelectApp={(application) => { setDrawerEmail(null); setDrawerApp(application); }}
      />
      <SyncModal open={syncModalOpen} run={syncRun} error={syncError} onClose={() => setSyncModalOpen(false)} />
    </div>
  );
}
