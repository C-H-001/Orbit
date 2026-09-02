export function extractNowcoderPage() {
  const normalize = (value: string) => value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  const isVisible = (element: HTMLElement) => {
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      const style = typeof getComputedStyle === "function" ? getComputedStyle(current) : null
      if (
        current.hidden ||
        current.getAttribute("aria-hidden") === "true" ||
        style?.display === "none" ||
        style?.visibility === "hidden"
      ) return false
    }
    return true
  }

  const title = normalize(
    document.querySelector<HTMLMetaElement>("meta[property='og:title']")?.content ||
    Array.from(document.querySelectorAll<HTMLElement>("h1")).find(isVisible)?.innerText ||
    document.title.replace(/[_-]牛客网.*$/, ""),
  )

  const parsePublishedAt = (value: string | null | undefined) => {
    if (!value) return null
    const text = value.trim()
    if (/^\d{10,13}$/.test(text)) {
      const timestamp = Number(text) * (text.length === 10 ? 1_000 : 1)
      if (!Number.isNaN(timestamp)) return new Date(timestamp).toISOString()
    }
    const full = text.match(/(20\d{2})[年/.\-](\d{1,2})[月/.\-](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/)
    const short = text.match(/(?:^|\s)(\d{1,2})[月/.\-](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/)
    if (full || short) {
      const now = new Date()
      let year = full ? Number(full[1]) : now.getFullYear()
      const month = Number(full?.[2] ?? short?.[1])
      const day = Number(full?.[3] ?? short?.[2])
      const hour = Number(full?.[4] ?? short?.[3] ?? 0)
      const minute = Number(full?.[5] ?? short?.[4] ?? 0)
      let date = new Date(year, month - 1, day, hour, minute)
      if (!full && date.getTime() > now.getTime() + 7 * 86400000) {
        year -= 1
        date = new Date(year, month - 1, day, hour, minute)
      }
      if (!Number.isNaN(date.getTime())) return date.toISOString()
    }
    const parsed = Date.parse(text)
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
  }
  const publishedCandidates = [
    document.querySelector<HTMLMetaElement>("meta[property='article:published_time']")?.content,
    document.querySelector<HTMLMetaElement>("meta[itemprop='datePublished']")?.content,
    document.querySelector<HTMLTimeElement>("time[datetime]")?.dateTime,
    ...Array.from(document.querySelectorAll<HTMLElement>("[data-time], [data-publish-time], [class*='publish-time'], [class*='post-time'], [class*='create-time'], [class*='edit-time'], [class*='time']"))
      .flatMap((element) => [element.dataset.time, element.dataset.publishTime, element.getAttribute("datetime"), element.innerText])
      .filter((value): value is string => Boolean(value) && value!.length < 80),
  ]
  const publishedAt = publishedCandidates.map(parsePublishedAt).find(Boolean) ?? null

  const selectors = [
    "[data-testid='discussion-main']",
    "[class*='feed-detail']",
    "[class*='article-content']",
    "[class*='post-content']",
    "[class*='discuss-content']",
    "[class*='detail-content']",
    "article",
    "main [class*='content']",
    "main",
    "[role='main']",
  ]
  const candidates = Array.from(new Set(
    selectors.flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector))),
  )).filter((element) => !element.closest("aside, nav, header, footer") && isVisible(element))

  const score = (element: HTMLElement) => {
    const text = normalize(element.innerText || "")
    if (text.length < 100) return -1
    const numberedQuestions = text.match(/(?:^|\n)\s*(?:Q?\d{1,2}\s*[、.．:：)）]|问题\s*\d+)/g)?.length ?? 0
    const signals = text.match(/面经|面试|一面|二面|三面|终面|自我介绍|反问/g)?.length ?? 0
    const titleBonus = title && text.includes(title) ? 2_000 : 0
    const breadthPenalty = Math.max(0, element.querySelectorAll("a,button").length - 30) * 20
    return Math.min(text.length, 40_000) + numberedQuestions * 900 + signals * 120 + titleBonus - breadthPenalty
  }

  const container = candidates.sort((left, right) => score(right) - score(left))[0]
  if (!container || score(container) < 0) throw new Error("NOWCODER_STRUCTURE_CHANGED")

  const stopPattern = /订阅后查看|登录后查看|剩余内容|解锁全文/
  let pageText = normalize(container.innerText || "")
  const stopMatch = stopPattern.exec(pageText)
  const partial = Boolean(stopMatch)
  if (stopMatch?.index !== undefined) pageText = pageText.slice(0, stopMatch.index).trim()
  if (pageText.length < 100) throw new Error("NOWCODER_CONTENT_NOT_FOUND")

  const questionHeadings = Array.from(container.querySelectorAll<HTMLHeadingElement>("h2"))
    .filter(isVisible)
    .filter((heading) => {
      const text = normalize(heading.innerText || "")
      return text.length > 0 && text.length < 300 && !/评论|推荐|相关|作者|专栏/.test(text)
    })

  if (questionHeadings.length >= 2) {
    const sections = questionHeadings.map((heading) => {
      const blocks: string[] = []
      for (let node = heading.nextElementSibling as HTMLElement | null; node; node = node.nextElementSibling as HTMLElement | null) {
        if (node.tagName === "H2") break
        if (!isVisible(node) || node.matches("aside,nav,header,footer")) continue
        const text = normalize(node.innerText || node.textContent || "")
        if (stopPattern.test(text)) break
        if (text) blocks.push(text)
      }
      return { heading: normalize(heading.innerText || ""), blocks }
    })
    return {
      title: title || "牛客面经",
      publishedAt,
      sections,
      contentCompleteness: partial ? "partial" as const : "complete" as const,
    }
  }

  return {
    title: title || "牛客面经",
    publishedAt,
    sections: [{ heading: "面经正文", blocks: [pageText.slice(0, 60_000)] }],
    contentCompleteness: partial ? "partial" as const : "complete" as const,
  }
}
