export const RECRUITMENT_PROGRESS_VALUES = [
  "已投递",
  "笔试中",
  "AI Coding中",
  "面试中",
  "阻塞（需要预约时间）",
  "已拒绝",
  "其它",
] as const

export type RecruitmentProgress = (typeof RECRUITMENT_PROGRESS_VALUES)[number]

export function normalizeRecruitmentProgress(
  value: unknown,
  context: Array<unknown> = [],
): RecruitmentProgress {
  const current = typeof value === "string" ? value.trim() : ""
  if ((RECRUITMENT_PROGRESS_VALUES as readonly string[]).includes(current)) {
    return current as RecruitmentProgress
  }
  const text = [current, ...context]
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .toLocaleLowerCase()

  if (/(?:^|\s)rejected(?:\s|$)|拒绝|拒信|未通过|不通过|遗憾|流程终止|不再推进/i.test(text)) {
    return "已拒绝"
  }
  if (/(?:预约|选择|选定|提供|提交|确认).{0,12}(?:面试)?时间|待预约|等待预约|预约时间/i.test(text)) {
    return "阻塞（需要预约时间）"
  }
  if (/(?:ai\s*[- ]?coding|coding\s*(?:test|测试|测评))/i.test(text)) {
    return "AI Coding中"
  }
  if (/(?:笔试|测评|assessment|在线测试)/i.test(text)) {
    return "笔试中"
  }
  if (/(?:面试|一面|二面|三面|四面|五面|终面|hr面|技术面)/i.test(text)) {
    return "面试中"
  }
  if (/(?:已投递|投递确认|投递成功|简历已投递|简历已收到|已收到简历|等待评估|待评估|申请已收到)/i.test(text)) {
    return "已投递"
  }
  return "其它"
}
