export type InterviewPlatform = "nowcoder" | "xiaohongshu"

export function detectInterviewPlatform(
  value: string,
): InterviewPlatform | null {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== ""
    ) {
      return null
    }
    if (
      url.hostname === "www.nowcoder.com" &&
      (/^\/discuss\/\d+\/?$/.test(url.pathname) ||
        /^\/feed\/main\/detail\/[a-zA-Z0-9]+\/?$/.test(url.pathname))
    ) {
      return "nowcoder"
    }
    if (
      url.hostname === "www.xiaohongshu.com" &&
      /^\/explore\/[a-zA-Z0-9]+\/?$/.test(url.pathname)
    ) {
      return "xiaohongshu"
    }
    return null
  } catch {
    return null
  }
}
