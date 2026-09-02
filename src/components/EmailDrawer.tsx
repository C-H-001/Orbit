import { FileText, Link2, Paperclip, X } from "lucide-react";
import type { Application, EmailDetail } from "../types";

interface Props {
  email: EmailDetail | null;
  application?: Application;
  onClose: () => void;
  onSelectApp: (application: Application) => void;
}

export function EmailDrawer({ email, application, onClose, onSelectApp }: Props) {
  const open = email !== null;
  return (
    <>
      <div
        className={`fixed inset-0 z-50 transition-all duration-300 ${open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
        style={{ background: "rgba(15,23,42,0.25)", backdropFilter: "blur(2px)" }}
        onClick={onClose}
      />
      <div
        className="fixed top-0 right-0 h-full z-[60] flex flex-col transition-transform duration-300 ease-in-out"
        style={{
          width: 540,
          background: "white",
          boxShadow: "-4px 0 24px rgba(0,0,0,0.1)",
          transform: open ? "translateX(0)" : "translateX(100%)",
        }}
      >
        {!email ? null : (
          <>
            <div className="px-6 py-5 flex-shrink-0" style={{ borderBottom: "1px solid #f1f5f9" }}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0">
                    <FileText size={17} className="text-blue-500" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-base font-bold text-gray-900 leading-snug">{email.subject}</h2>
                    <p className="text-xs text-gray-400 mt-1 font-mono">{new Date(email.receivedAt).toLocaleString("zh-CN")}</p>
                  </div>
                </div>
                <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-xl bg-gray-100 hover:bg-gray-200 transition-colors">
                  <X size={16} className="text-gray-500" />
                </button>
              </div>
              <div className="flex items-center gap-2 mt-4 flex-wrap">
                <span className="text-xs font-semibold px-2.5 py-1 rounded-lg bg-blue-50 text-blue-600">{email.intent || "待分类"}</span>
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-lg ${email.status === "failed" ? "bg-red-50 text-red-600" : email.status === "processed" ? "bg-green-50 text-green-600" : "bg-amber-50 text-amber-600"}`}>
                  {email.status === "processed" ? "已处理" : email.status === "failed" ? "处理失败" : email.status === "ignored" ? "已忽略" : "待处理"}
                </span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              <div className="rounded-xl bg-gray-50 border border-gray-100 px-4 py-3 space-y-2">
                <p className="text-xs text-gray-500"><span className="font-semibold text-gray-700">发件人：</span>{email.fromAddress || "—"}</p>
                <p className="text-xs text-gray-500"><span className="font-semibold text-gray-700">收件人：</span>{email.toAddress || "—"}</p>
                <p className="text-xs text-gray-500"><span className="font-semibold text-gray-700">公司 / 职位：</span>{email.company || "待识别"} · {email.position || "待识别"}</p>
              </div>

              {email.errorMessage && (
                <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3">
                  <p className="text-xs font-semibold text-red-700">处理失败</p>
                  <p className="text-xs text-red-600 mt-1 leading-relaxed">{email.errorMessage}</p>
                </div>
              )}

              <div>
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">原邮件正文</p>
                <div className="rounded-xl border border-gray-100 bg-white px-4 py-4">
                  {email.renderedHtml ? (
                    <iframe
                      title="原邮件正文"
                      sandbox=""
                      srcDoc={email.renderedHtml}
                      referrerPolicy="no-referrer"
                      loading="eager"
                      className="w-full border-0 bg-white"
                      style={{ height: 560 }}
                    />
                  ) : (
                    <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap break-words">{email.textBody || "该邮件没有可显示的正文。"}</p>
                  )}
                </div>
              </div>

              {email.attachments.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">附件</p>
                  <div className="space-y-2">
                    {email.attachments.map((attachment, index) => (
                      <a
                        key={`${attachment.filename}-${index}`}
                        href={`data:${attachment.contentType};base64,${attachment.contentBase64}`}
                        download={attachment.filename}
                        className="flex items-center gap-3 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 hover:bg-blue-50 hover:border-blue-100 transition-colors"
                      >
                        <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center flex-shrink-0"><Paperclip size={14} className="text-blue-500" /></div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-700 truncate">{attachment.filename}</p>
                          <p className="text-xs text-gray-400 mt-0.5">{attachment.contentType} · {Math.max(1, Math.ceil(attachment.size / 1024))} KB</p>
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <details className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
                <summary className="text-xs font-semibold text-gray-500 cursor-pointer">原始邮件头</summary>
                <pre className="text-[11px] text-gray-500 whitespace-pre-wrap break-all mt-3 font-mono">{email.rawHeaders}</pre>
              </details>
            </div>

            <div className="px-6 py-4 flex items-center justify-between gap-2 flex-shrink-0" style={{ borderTop: "1px solid #f1f5f9" }}>
              {application ? (
                <button
                  onClick={() => onSelectApp(application)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors"
                >
                  <Link2 size={13} /> 查看关联申请
                </button>
              ) : <span />}
              <button onClick={onClose} className="px-4 py-2 rounded-xl text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors">关闭</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
