import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api";
import type { UsageSummary } from "../types";

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ dataKey: string; name: string; value: number; fill?: string; stroke?: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return <div className="bg-white rounded-xl shadow-lg border border-gray-100 px-4 py-3 text-xs"><p className="font-semibold text-gray-700 mb-1">{label}</p>{payload.map((item) => <p key={item.dataKey} style={{ color: item.fill || item.stroke }}>{item.name}：<strong>{item.value}</strong></p>)}</div>;
}

export function UsageStatistics() {
  const [usage, setUsage] = useState<UsageSummary>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void api.getUsage(7).then((result) => setUsage(result.usage)).catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取用量"));
  }, []);

  const daily = usage?.daily ?? [];
  const totalCalls = usage?.totalCalls ?? 0;
  const totalTokens = (usage?.totalInputTokens ?? 0) + (usage?.totalOutputTokens ?? 0);
  const recentCalls = usage?.recentCalls ?? [];
  const successRate = recentCalls.length ? (recentCalls.filter((item) => item.status === "success").length / recentCalls.length) * 100 : 0;

  return (
    <div className="p-6 space-y-5">
      {error && <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 card p-5">
          <div className="flex items-center justify-between mb-5"><div><p className="text-sm font-bold text-gray-900">每日 API 调用量</p><p className="text-xs text-gray-400 mt-0.5">近 7 天共 {totalCalls} 次调用</p></div></div>
          {daily.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={daily} margin={{ top: 5, right: 5, left: -20, bottom: 0 }} barSize={28}>
                <defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6366f1" /><stop offset="100%" stopColor="#3b82f6" /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} /><XAxis dataKey="day" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} /><YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} /><Tooltip content={<CustomTooltip />} /><Bar dataKey="calls" name="调用次数" radius={[6, 6, 0, 0]} fill="url(#barGrad)" />
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">暂无模型调用记录</div>}
        </div>

        <div className="card p-5">
          <p className="text-sm font-bold text-gray-900 mb-4">近 7 天汇总</p>
          <div className="space-y-4">
            {[
              { label: "总调用次数", value: totalCalls, color: "#3b82f6", pct: totalCalls ? "100%" : "0%" },
              { label: "总 Token", value: totalTokens.toLocaleString(), color: "#8b5cf6", pct: totalTokens ? "100%" : "0%" },
              { label: "近期成功率", value: recentCalls.length ? `${successRate.toFixed(1)}%` : "—", color: "#10b981", pct: `${successRate}%` },
            ].map((row) => <div key={row.label}><div className="flex items-center justify-between mb-1.5"><span className="text-xs text-gray-500">{row.label}</span><span className="text-sm font-bold" style={{ color: row.color }}>{row.value}</span></div><div className="h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: row.pct, background: row.color }} /></div></div>)}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="px-6 py-4 border-b border-gray-50"><p className="text-sm font-bold text-gray-900">近期调用记录</p><p className="text-xs text-gray-400 mt-0.5">最近 {recentCalls.length} 次 API 调用详情</p></div>
        <div>
          <div className="grid px-6 py-2.5 bg-gray-50" style={{ gridTemplateColumns: "1.2fr 1.5fr 2fr 0.7fr 0.7fr auto" }}>{["时间", "模型", "调用类型", "输入", "输出", "状态"].map((heading) => <p key={heading} className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{heading}</p>)}</div>
          <div className="divide-y divide-gray-50">
            {recentCalls.length ? recentCalls.map((call) => (
              <div key={call.id} className="grid px-6 py-3.5 items-center hover:bg-gray-50 transition-colors" style={{ gridTemplateColumns: "1.2fr 1.5fr 2fr 0.7fr 0.7fr auto" }}>
                <p className="text-xs font-mono text-gray-400">{new Date(call.time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</p><p className="text-xs font-mono text-gray-600 truncate pr-2">{call.model}</p><p className="text-sm text-gray-700 truncate pr-2">{call.prompt}</p><p className="text-xs font-mono text-gray-500">{call.inputTokens}</p><p className="text-xs font-mono text-gray-500">{call.outputTokens}</p><span className="text-xs font-semibold px-2.5 py-1 rounded-lg" style={call.status === "success" ? { background: "#ecfdf5", color: "#10b981" } : { background: "#fef2f2", color: "#ef4444" }}>{call.status === "success" ? "成功" : "失败"}</span>
              </div>
            )) : <div className="py-12 text-center text-sm text-gray-400">暂无调用记录</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
