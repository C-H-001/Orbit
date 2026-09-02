import { Fragment, useEffect, useRef, useState } from "react";
import { CheckCircle, Send, Sparkles, XCircle } from "lucide-react";
import { api } from "../api";
import type { AgentProposal, Application } from "../types";

interface Props {
  applications: Application[];
  onDataChanged: () => Promise<void>;
}

interface TextMessage {
  id: string;
  role: "user" | "assistant";
  type: "text";
  content: string;
}

interface ConfirmMessage {
  id: string;
  role: "assistant";
  type: "confirm";
  proposal: AgentProposal;
  confirmed: boolean | null;
}

type Message = TextMessage | ConfirmMessage;

const QUICK_PROMPTS = [
  "我有哪些进行中的申请？",
  "最近有哪些进展更新？",
  "超过 7 天没有反馈的申请有哪些？",
  "近期有哪些面试安排？",
];

function renderText(text: string) {
  return text.split("\n").map((line, lineIndex) => {
    const parts = line.split(/(\*\*.*?\*\*)/g).filter(Boolean);
    const content = parts.map((part, partIndex) => part.startsWith("**") && part.endsWith("**")
      ? <strong key={partIndex}>{part.slice(2, -2)}</strong>
      : <Fragment key={partIndex}>{part}</Fragment>);
    return line ? <p key={lineIndex} className="text-sm leading-relaxed">{content}</p> : <div key={lineIndex} className="h-1" />;
  });
}

export function AgentConversations({ applications, onDataChanged }: Props) {
  const [messages, setMessages] = useState<Message[]>([
    { id: "welcome", role: "assistant", type: "text", content: "你好！我可以帮你查询申请进度、检索邮件，或在确认后修改申请记录。" },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  async function send(text: string) {
    if (!text.trim() || loading) return;
    setMessages((previous) => [...previous, { id: `u-${Date.now()}`, role: "user", type: "text", content: text }]);
    setInput("");
    setLoading(true);
    try {
      const response = await api.chat(text.trim());
      if (response.proposal) {
        setMessages((previous) => [...previous, {
          id: `proposal-${response.proposal!.id}`,
          role: "assistant",
          type: "confirm",
          proposal: response.proposal!,
          confirmed: null,
        }]);
      } else {
        setMessages((previous) => [...previous, { id: `a-${Date.now()}`, role: "assistant", type: "text", content: response.message }]);
      }
    } catch (error) {
      setMessages((previous) => [...previous, {
        id: `error-${Date.now()}`,
        role: "assistant",
        type: "text",
        content: `请求失败：${error instanceof Error ? error.message : "未知错误"}`,
      }]);
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm(messageId: string, proposal: AgentProposal, confirmed: boolean) {
    try {
      await api.confirmProposal(proposal.id, confirmed);
      setMessages((previous) => previous.map((message) => message.id === messageId ? { ...message, confirmed } : message));
      if (confirmed) await onDataChanged();
      const application = applications.find((item) => item.id === proposal.applicationId);
      setMessages((previous) => [...previous, {
        id: `result-${Date.now()}`,
        role: "assistant",
        type: "text",
        content: confirmed
          ? `已更新 **${application?.company ?? "该申请"}** 的申请进度。`
          : "已取消，没有做任何修改。",
      }]);
    } catch (error) {
      setMessages((previous) => [...previous, {
        id: `error-${Date.now()}`,
        role: "assistant",
        type: "text",
        content: `操作失败：${error instanceof Error ? error.message : "未知错误"}`,
      }]);
    }
  }

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="flex-shrink-0 bg-white border-b border-gray-100 px-6 py-3 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 mr-2"><Sparkles size={13} className="text-blue-500" /><span className="text-xs font-semibold text-gray-500">快捷提问</span></div>
        {QUICK_PROMPTS.map((prompt) => <button key={prompt} onClick={() => void send(prompt)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-blue-50 hover:border-blue-200 hover:text-blue-600 transition-colors bg-white">{prompt}</button>)}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
        {messages.map((message) => {
          if (message.type === "text") {
            const isUser = message.role === "user";
            return (
              <div key={message.id} className={`flex ${isUser ? "justify-end" : "justify-start"} items-end gap-2.5`}>
                {!isUser && <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 mb-0.5" style={{ background: "linear-gradient(135deg,#3b82f6,#6366f1)" }}><Sparkles size={14} color="white" /></div>}
                <div className="max-w-[620px] px-5 py-3.5 rounded-2xl space-y-1" style={isUser ? { background: "linear-gradient(135deg,#3b82f6,#6366f1)", color: "white" } : { background: "white", boxShadow: "0 1px 3px rgba(0,0,0,0.06)", border: "1px solid #f1f5f9", color: "#1e293b" }}>
                  {isUser ? <p className="text-sm text-white">{message.content}</p> : renderText(message.content)}
                </div>
              </div>
            );
          }

          const application = applications.find((item) => item.id === message.proposal.applicationId);
          const beforeStage = String(message.proposal.before.currentProgress ?? application?.currentProgress ?? "—");
          const afterStage = String(message.proposal.after.currentProgress ?? beforeStage);
          return (
            <div key={message.id} className="flex items-end gap-2.5">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "linear-gradient(135deg,#3b82f6,#6366f1)" }}><Sparkles size={14} color="white" /></div>
              <div className="rounded-2xl overflow-hidden" style={{ background: "white", boxShadow: "0 1px 3px rgba(0,0,0,0.06)", border: "1px solid #f1f5f9", minWidth: 320 }}>
                <div className="px-5 py-3 border-b border-gray-50"><p className="text-sm font-bold text-gray-900">确认进度更新</p><p className="text-xs text-gray-400 mt-0.5">请确认后再执行修改。</p></div>
                <div className="px-5 py-4 space-y-3">
                  {[
                    { label: "公司", value: application?.company ?? "—" },
                    { label: "职位", value: application?.position ?? "—" },
                    { label: "当前阶段", value: beforeStage, muted: true },
                    { label: "修改为", value: afterStage, accent: true },
                  ].map((row) => <div key={row.label} className="flex items-center gap-3"><span className="text-xs text-gray-400 w-20 flex-shrink-0">{row.label}</span><span className={`text-sm font-semibold px-2.5 py-0.5 rounded-lg ${row.accent ? "text-blue-600 bg-blue-50" : row.muted ? "text-gray-400 bg-gray-50" : "text-gray-900"}`}>{row.value}</span></div>)}
                </div>
                {message.confirmed === null ? (
                  <div className="px-5 py-3 border-t border-gray-50 flex gap-2">
                    <button onClick={() => void handleConfirm(message.id, message.proposal, true)} className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white" style={{ background: "linear-gradient(135deg,#3b82f6,#6366f1)" }}><CheckCircle size={13} /> 确认修改</button>
                    <button onClick={() => void handleConfirm(message.id, message.proposal, false)} className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors"><XCircle size={13} /> 取消</button>
                  </div>
                ) : <div className="px-5 py-3 border-t border-gray-50"><span className="text-xs font-semibold flex items-center gap-1.5" style={{ color: message.confirmed ? "#10b981" : "#94a3b8" }}>{message.confirmed ? <CheckCircle size={13} /> : <XCircle size={13} />}{message.confirmed ? "已应用" : "已取消"}</span></div>}
              </div>
            </div>
          );
        })}

        {loading && <div className="flex items-end gap-2.5"><div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg,#3b82f6,#6366f1)" }}><Sparkles size={14} color="white" /></div><div className="rounded-2xl px-5 py-4" style={{ background: "white", border: "1px solid #f1f5f9", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}><div className="flex gap-1.5 items-center">{[0, 1, 2].map((item) => <div key={item} className="w-2 h-2 rounded-full animate-bounce" style={{ background: "#3b82f6", animationDelay: `${item * 0.15}s` }} />)}</div></div></div>}
        <div ref={bottomRef} />
      </div>

      <div className="flex-shrink-0 bg-white border-t border-gray-100 px-6 py-4">
        <div className="flex items-center gap-3 bg-gray-50 rounded-2xl px-4 py-3" style={{ border: "1px solid #e2e8f0" }}>
          <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => event.key === "Enter" && !event.shiftKey && void send(input)} placeholder={'询问申请情况，或说"将字节跳动标记为二面"…'} className="flex-1 text-sm text-gray-700 placeholder-gray-400 outline-none bg-transparent" />
          <button onClick={() => void send(input)} disabled={!input.trim() || loading} className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 transition-all disabled:opacity-40 active:scale-90" style={{ background: "linear-gradient(135deg,#3b82f6,#6366f1)" }}><Send size={15} color="white" /></button>
        </div>
      </div>
    </div>
  );
}
