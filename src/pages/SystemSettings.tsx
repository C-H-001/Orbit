import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Cpu, Mail, RefreshCw, Shield } from "lucide-react";
import { api, downloadApplicationCsv } from "../api";

type Status = "connected" | "disconnected" | "testing";

interface Props {
  onApplicationsDeleted?: () => Promise<void> | void;
}

export function createSettingsMutationGuard() {
  let loaded = false;
  let busy = false;
  return {
    markLoaded() {
      loaded = true;
    },
    async run(action: () => Promise<void>, onBusyChange: (busy: boolean) => void = () => undefined) {
      if (!loaded || busy) return false;
      busy = true;
      onBusyChange(true);
      try {
        await action();
        return true;
      } finally {
        busy = false;
        onBusyChange(false);
      }
    },
  };
}

export function StatusBadge({ status }: { status: Status }) {
  if (status === "connected") return <div className="flex items-center gap-1.5 bg-green-50 text-green-700 px-3 py-1.5 rounded-full"><Check size={12} /><span className="text-xs font-semibold">已配置</span></div>;
  if (status === "disconnected") return <div className="flex items-center gap-1.5 bg-red-50 text-red-600 px-3 py-1.5 rounded-full"><AlertTriangle size={12} /><span className="text-xs font-semibold">未配置</span></div>;
  return <div className="flex items-center gap-1.5 bg-amber-50 text-amber-700 px-3 py-1.5 rounded-full animate-pulse"><RefreshCw size={12} className="animate-spin" /><span className="text-xs font-semibold">测试中…</span></div>;
}

export async function runOcrConnectionTest(options: {
  persistSettings: (options: { preserveOcrStatus: boolean }) => Promise<void>;
  testConnection: () => Promise<unknown>;
  setStatus: (status: Status) => void;
  setMessage: (message: string | undefined) => void;
}) {
  options.setStatus("testing");
  options.setMessage(undefined);
  try {
    await options.persistSettings({ preserveOcrStatus: true });
    await options.testConnection();
    options.setStatus("connected");
    options.setMessage("OCR 视觉连接测试成功。");
  } catch (error) {
    options.setStatus("disconnected");
    options.setMessage(error instanceof Error ? error.message : "OCR 视觉连接失败");
  }
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-3 gap-6 items-start"><div className="pt-2.5"><p className="text-sm font-semibold text-gray-700">{label}</p>{hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}</div><div className="col-span-2">{children}</div></div>;
}

function Input({ type = "text", value, onChange, placeholder, mono = false, ariaLabel }: { type?: string; value: string; onChange: (value: string) => void; placeholder?: string; mono?: boolean; ariaLabel?: string }) {
  return <input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={ariaLabel} className="w-full text-sm border border-gray-200 rounded-xl px-4 py-2.5 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400 transition-all" style={mono ? { fontFamily: "JetBrains Mono, monospace" } : {}} />;
}

export function SystemSettings({ onApplicationsDeleted }: Props = {}) {
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapSecure, setImapSecure] = useState(true);
  const [imapUsername, setImapUsername] = useState("");
  const [imapPassword, setImapPassword] = useState("");
  const [imapFolder, setImapFolder] = useState("INBOX");
  const [hasPassword, setHasPassword] = useState(false);
  const [syncInterval, setSyncInterval] = useState("60");
  const [emailStatus, setEmailStatus] = useState<Status>("disconnected");

  const [baseUrl, setBaseUrl] = useState("");
  const [modelName, setModelName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [llmStatus, setLlmStatus] = useState<Status>("disconnected");
  const [ocrBaseUrl, setOcrBaseUrl] = useState("");
  const [ocrModel, setOcrModel] = useState("");
  const [ocrApiKey, setOcrApiKey] = useState("");
  const [hasOcrApiKey, setHasOcrApiKey] = useState(false);
  const [ocrStatus, setOcrStatus] = useState<Status>("disconnected");
  const [message, setMessage] = useState<string>();
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [deletingApplications, setDeletingApplications] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const mutationGuard = useRef(createSettingsMutationGuard()).current;

  useEffect(() => {
    let mounted = true;
    void api.getSettings().then(({ settings }) => {
      if (!mounted) return;
      setImapHost(settings.imap.host);
      setImapPort(String(settings.imap.port));
      setImapSecure(settings.imap.secure);
      setImapUsername(settings.imap.username);
      setImapFolder(settings.imap.folder);
      setHasPassword(settings.imap.hasPassword);
      setSyncInterval(String(settings.syncIntervalMinutes));
      setBaseUrl(settings.llm.baseUrl);
      setModelName(settings.llm.model);
      setHasApiKey(settings.llm.hasApiKey);
      setOcrBaseUrl(settings.ocr.baseUrl);
      setOcrModel(settings.ocr.model);
      setHasOcrApiKey(settings.ocr.hasApiKey);
      setEmailStatus(settings.imap.host && settings.imap.username && settings.imap.hasPassword ? "connected" : "disconnected");
      setLlmStatus(settings.llm.baseUrl && settings.llm.model && settings.llm.hasApiKey ? "connected" : "disconnected");
      setOcrStatus(settings.ocr.baseUrl && settings.ocr.model && settings.ocr.hasApiKey ? "connected" : "disconnected");
      mutationGuard.markLoaded();
      setSettingsLoaded(true);
    }).catch((error) => {
      if (mounted) setMessage(error instanceof Error ? error.message : "无法读取设置");
    });
    return () => { mounted = false; };
  }, [mutationGuard]);

  async function persistSettings(options: { preserveOcrStatus?: boolean } = {}) {
    const { settings } = await api.updateSettings({
      imap: { host: imapHost.trim(), port: Number(imapPort), secure: imapSecure, username: imapUsername.trim(), password: imapPassword, folder: imapFolder.trim() || "INBOX" },
      llm: { baseUrl: baseUrl.trim(), model: modelName.trim(), apiKey },
      ocr: { baseUrl: ocrBaseUrl.trim(), model: ocrModel.trim(), apiKey: ocrApiKey },
      syncIntervalMinutes: Number(syncInterval),
    });
    setHasPassword(settings.imap.hasPassword);
    setHasApiKey(settings.llm.hasApiKey);
    setHasOcrApiKey(settings.ocr.hasApiKey);
    setImapPassword("");
    setApiKey("");
    setOcrApiKey("");
    setEmailStatus(settings.imap.host && settings.imap.username && settings.imap.hasPassword ? "connected" : "disconnected");
    setLlmStatus(settings.llm.baseUrl && settings.llm.model && settings.llm.hasApiKey ? "connected" : "disconnected");
    if (!options.preserveOcrStatus) {
      setOcrStatus(settings.ocr.baseUrl && settings.ocr.model && settings.ocr.hasApiKey ? "connected" : "disconnected");
      setMessage("设置已保存到本机。");
    }
  }

  async function runSettingsMutation(action: () => Promise<void>) {
    return mutationGuard.run(action, setSettingsBusy);
  }

  async function saveSettings() {
    await runSettingsMutation(async () => {
      try {
        await persistSettings();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "保存失败");
      }
    });
  }

  async function testEmail() {
    await runSettingsMutation(async () => {
      setEmailStatus("testing");
      setMessage(undefined);
      try {
        await persistSettings();
        await api.testImap();
        setEmailStatus("connected");
        setMessage("IMAP 只读连接测试成功。");
      } catch (error) {
        setEmailStatus("disconnected");
        setMessage(error instanceof Error ? error.message : "IMAP 连接失败");
      }
    });
  }

  async function testLlm() {
    await runSettingsMutation(async () => {
      setLlmStatus("testing");
      setMessage(undefined);
      try {
        await persistSettings();
        await api.testLlm();
        setLlmStatus("connected");
        setMessage("模型连接测试成功。");
      } catch (error) {
        setLlmStatus("disconnected");
        setMessage(error instanceof Error ? error.message : "模型连接失败");
      }
    });
  }

  async function testOcr() {
    await runSettingsMutation(async () => {
      await runOcrConnectionTest({
        persistSettings,
        testConnection: api.testOcr,
        setStatus: setOcrStatus,
        setMessage,
      });
    });
  }

  async function deleteAllApplications() {
    await runSettingsMutation(async () => {
      setDeletingApplications(true);
      setMessage(undefined);
      try {
        const { deletedApplications } = await api.deleteAllApplications();
        await onApplicationsDeleted?.();
        setShowDeleteConfirmation(false);
        setMessage(`已永久删除 ${deletedApplications} 条申请记录。`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "删除申请记录失败");
      } finally {
        setDeletingApplications(false);
      }
    });
  }

  const settingsDisabled = !settingsLoaded || settingsBusy;

  return (
    <div className="p-6 max-w-2xl space-y-5" aria-busy={settingsBusy}>
      {message && <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-700">{message}</div>}

      <fieldset disabled={settingsDisabled} className="contents">

      <div className="card overflow-hidden">
        <div className="px-6 py-5 flex items-center justify-between" style={{ borderBottom: "1px solid #f1f5f9" }}>
          <div className="flex items-center gap-3"><div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg,#3b82f6,#6366f1)" }}><Mail size={18} color="white" /></div><div><p className="text-sm font-bold text-gray-900">邮箱设置</p><p className="text-xs text-gray-400 mt-0.5">使用通用 IMAP 只读同步申请邮件。</p></div></div>
          <StatusBadge status={emailStatus} />
        </div>
        <div className="px-6 py-5 space-y-5">
          <Field label="IMAP 用户名" hint="通常为完整邮箱地址"><Input value={imapUsername} onChange={setImapUsername} type="email" /></Field>
          <Field label="IMAP 服务器"><Input value={imapHost} onChange={setImapHost} placeholder="imap.example.com" mono /></Field>
          <Field label="端口 / TLS">
            <div className="flex items-center gap-3"><div className="w-32"><Input value={imapPort} onChange={setImapPort} type="number" mono /></div><label className="flex items-center gap-2 text-xs text-gray-600"><input type="checkbox" checked={imapSecure} onChange={(event) => setImapSecure(event.target.checked)} className="accent-blue-500" />启用 TLS</label></div>
          </Field>
          <Field label="IMAP 密码" hint={hasPassword ? "已保存；留空表示保持不变" : "建议使用邮箱应用专用密码"}><Input value={imapPassword} onChange={setImapPassword} type="password" placeholder={hasPassword ? "已保存" : "输入应用专用密码"} /></Field>
          <Field label="同步文件夹"><Input value={imapFolder} onChange={setImapFolder} placeholder="INBOX" mono /></Field>
          <Field label="自动同步间隔" hint="本地服务运行时生效">
            <select value={syncInterval} onChange={(event) => setSyncInterval(event.target.value)} className="text-sm border border-gray-200 rounded-xl px-4 py-2.5 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 bg-white disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400 transition-all">
              <option value="15">每 15 分钟</option><option value="30">每 30 分钟</option><option value="60">每小时（默认）</option><option value="180">每 3 小时</option><option value="360">每 6 小时</option><option value="1440">每天</option>
            </select>
          </Field>
        </div>
        <div className="px-6 py-4 bg-gray-50 flex items-center gap-2.5" style={{ borderTop: "1px solid #f1f5f9" }}>
          <button onClick={() => void testEmail()} disabled={emailStatus === "testing"} className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-60 transition-colors"><RefreshCw size={13} className={emailStatus === "testing" ? "animate-spin" : ""} />测试连接</button>
          <button onClick={() => void saveSettings()} className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white transition-all hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60" style={{ background: "linear-gradient(135deg,#3b82f6,#6366f1)" }}><Check size={13} />保存邮箱设置</button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-6 py-5 flex items-center justify-between" style={{ borderBottom: "1px solid #f1f5f9" }}>
          <div className="flex items-center gap-3"><div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg,#8b5cf6,#ec4899)" }}><Cpu size={18} color="white" /></div><div><p className="text-sm font-bold text-gray-900">大模型设置</p><p className="text-xs text-gray-400 mt-0.5">用于邮件分类、进度推断和智能对话。</p></div></div>
          <StatusBadge status={llmStatus} />
        </div>
        <div className="px-6 py-5 space-y-5">
          <Field label="接口地址" hint="OpenAI-compatible API 基础地址"><Input value={baseUrl} onChange={setBaseUrl} placeholder="https://api.example.com/v1" mono /></Field>
          <Field label="模型名称"><Input value={modelName} onChange={setModelName} placeholder="model-name" mono /></Field>
          <Field label="API 密钥" hint={hasApiKey ? "已保存；留空表示保持不变" : "仅保存在本机配置文件"}><Input value={apiKey} onChange={setApiKey} type="password" placeholder={hasApiKey ? "已保存" : "输入 API 密钥"} mono /></Field>
          <div className="pt-5 border-t border-gray-100">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-gray-900">面经 OCR 视觉模型</p>
                <p className="text-xs text-gray-400 mt-0.5">用于识别扩展采集的面经图片与题目。</p>
              </div>
              <StatusBadge status={ocrStatus} />
            </div>
            <div className="space-y-5">
              <Field label="OCR 接口地址" hint="OpenAI-compatible 视觉 API 基础地址"><Input value={ocrBaseUrl} onChange={setOcrBaseUrl} placeholder="https://api.example.com/v1" mono ariaLabel="OCR 接口地址" /></Field>
              <Field label="OCR 模型名称"><Input value={ocrModel} onChange={setOcrModel} placeholder="vision-model" mono ariaLabel="OCR 模型名称" /></Field>
              <Field label="OCR API 密钥" hint={hasOcrApiKey ? "已保存；留空表示保持不变" : "仅保存在本机配置文件"}><Input value={ocrApiKey} onChange={setOcrApiKey} type="password" placeholder={hasOcrApiKey ? "已保存" : "输入 OCR API 密钥"} mono ariaLabel="OCR API 密钥" /></Field>
            </div>
          </div>
        </div>
        <div className="px-6 py-4 bg-gray-50 flex flex-wrap items-center gap-2.5" style={{ borderTop: "1px solid #f1f5f9" }}>
          <button onClick={() => void testLlm()} disabled={llmStatus === "testing"} className="flex cursor-pointer items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"><RefreshCw size={13} className={llmStatus === "testing" ? "animate-spin" : ""} />测试连接</button>
          <button onClick={() => void testOcr()} disabled={ocrStatus === "testing"} className="flex cursor-pointer items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"><RefreshCw size={13} className={ocrStatus === "testing" ? "animate-spin" : ""} />测试 OCR 连接</button>
          <button onClick={() => void saveSettings()} className="flex cursor-pointer items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white transition-all hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-60" style={{ background: "linear-gradient(135deg,#8b5cf6,#ec4899)" }}><Check size={13} />保存模型设置</button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-6 py-5 flex items-center gap-3" style={{ borderBottom: "1px solid #f1f5f9" }}><div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg,#f59e0b,#ef4444)" }}><Shield size={18} color="white" /></div><div><p className="text-sm font-bold text-gray-900">数据管理</p><p className="text-xs text-gray-400 mt-0.5">配置与完整邮件保存在本机，请勿共享 data 目录。</p></div></div>
        <div className="px-6 py-5 space-y-3">
          <div className="flex items-center justify-between p-4 rounded-xl bg-gray-50 border border-gray-100"><div><p className="text-sm font-semibold text-gray-800">导出申请数据</p><p className="text-xs text-gray-400 mt-0.5">以 CSV 格式下载所有未删除申请。</p></div><button onClick={() => void downloadApplicationCsv()} className="px-4 py-2 rounded-xl text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors flex-shrink-0 ml-4">导出 CSV</button></div>
          <div className="flex items-center justify-between p-4 rounded-xl bg-red-50 border border-red-100">
            <div className="pr-4"><p className="text-sm font-semibold text-red-800">删除所有申请记录</p><p className="text-xs text-red-500 mt-0.5">永久清空概览中的申请及进展数据，删除后无法恢复。</p></div>
            <button onClick={() => setShowDeleteConfirmation(true)} className="px-4 py-2 rounded-xl text-xs font-semibold text-red-600 bg-white border border-red-200 hover:bg-red-100 transition-colors flex-shrink-0">删除所有申请记录</button>
          </div>
        </div>
      </div>

      {showDeleteConfirmation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 px-4" role="presentation">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="delete-applications-title">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0"><AlertTriangle size={19} className="text-red-600" /></div>
              <div>
                <h2 id="delete-applications-title" className="text-base font-bold text-gray-900">确认删除所有申请记录？</h2>
                <p className="text-sm text-gray-500 mt-1.5 leading-relaxed">此操作不可恢复。所有申请、进展时间线和相关审计数据都会被永久删除。</p>
                <p className="text-xs text-gray-400 mt-2">原始邮件、同步历史和系统设置会继续保留。</p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2.5">
              <button onClick={() => setShowDeleteConfirmation(false)} disabled={deletingApplications} className="px-4 py-2 rounded-xl text-xs font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 disabled:opacity-60 transition-colors">取消</button>
              <button onClick={() => void deleteAllApplications()} disabled={deletingApplications} className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 transition-colors">{deletingApplications ? "正在删除…" : "确认永久删除"}</button>
            </div>
          </div>
        </div>
      )}
      </fieldset>
    </div>
  );
}
