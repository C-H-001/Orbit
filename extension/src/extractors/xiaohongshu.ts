export async function extractXiaohongshuPage() {
  const urlsByIndex = new Map<number, string>()

  const imageUrl = (slide: HTMLElement) => {
    const image = slide.querySelector<HTMLImageElement>("img")
    const source = slide.querySelector<HTMLSourceElement>("source[srcset]")
    const srcset = image?.srcset || source?.srcset || ""
    const largestSrcsetUrl = srcset
      .split(",")
      .map((item) => item.trim().split(/\s+/)[0] || "")
      .filter(Boolean)
      .at(-1)
    return image?.currentSrc || image?.src || image?.dataset.src || largestSrcsetUrl || ""
  }

  const roots = [
    "#noteContainer",
    "[data-testid='note-slider']",
    ".note-slider",
    ".note-content",
    ".note-detail",
    "main",
  ].flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)))
  const countSlides = (root: ParentNode) => root.querySelectorAll(
    ".swiper-slide:not(.swiper-slide-duplicate)",
  ).length
  const root: ParentNode = roots.sort((left, right) => countSlides(right) - countSlides(left))[0] || document

  const collect = () => {
    const slides = Array.from(root.querySelectorAll<HTMLElement>(
      ".swiper-slide:not(.swiper-slide-duplicate)",
    ))
    for (const [position, slide] of slides.entries()) {
      const dataIndex = Number(slide.dataset.index)
      const index = Number.isInteger(dataIndex) && dataIndex >= 0 ? dataIndex + 1 : position + 1
      const url = imageUrl(slide)
      if (url && !urlsByIndex.has(index)) urlsByIndex.set(index, url)
    }
    return slides.length
  }

  let expectedCount = collect()
  const paginationCount = Number(root.querySelector<HTMLElement>(".swiper-pagination-total")?.textContent?.trim())
  if (Number.isInteger(paginationCount) && paginationCount > expectedCount) expectedCount = paginationCount

  const rootElement = root instanceof HTMLElement ? root : undefined
  const nextButton = root.querySelector<HTMLElement>(".swiper-button-next")
    || rootElement?.parentElement?.querySelector<HTMLElement>(".swiper-button-next")
    || document.querySelector<HTMLElement>("#noteContainer .swiper-button-next, .note-detail .swiper-button-next")
  for (let attempt = 0; nextButton && attempt < Math.min(expectedCount, 20); attempt += 1) {
    if (urlsByIndex.size >= expectedCount) break
    nextButton.click()
    await new Promise<void>((resolve) => setTimeout(resolve, 350))
    expectedCount = Math.max(expectedCount, collect())
  }

  const seenUrls = new Set<string>()
  const images = Array.from(urlsByIndex, ([index, url]) => ({ index, url }))
    .sort((left, right) => left.index - right.index)
    .filter(({ url }) => {
      if (seenUrls.has(url)) return false
      seenUrls.add(url)
      return true
    })
  if (images.length === 0) throw new Error("XIAOHONGSHU_IMAGES_NOT_FOUND")

  const failedImageIndexes = Array.from({ length: Math.max(expectedCount, images.length) }, (_, index) => index + 1)
    .filter((index) => !urlsByIndex.has(index))
  const title = (
    document.querySelector<HTMLMetaElement>("meta[property='og:title']")?.content
    || document.querySelector<HTMLElement>("#noteContainer .title, .note-detail .title")?.innerText
    || document.title
  ).trim()
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
    ...Array.from(document.querySelectorAll<HTMLElement>("#noteContainer [class*='date'], #noteContainer [class*='time'], .note-detail [class*='date'], .note-detail [class*='time']"))
      .map((element) => element.innerText)
      .filter((value) => value.length < 80),
  ]
  const publishedAt = publishedCandidates.map(parsePublishedAt).find(Boolean) ?? null

  return {
    title: title || "小红书面经",
    publishedAt,
    images,
    imageCount: Math.max(expectedCount, images.length),
    failedImageIndexes,
  }
}
