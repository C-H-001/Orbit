import { useEffect, useRef, useState } from "react";
import { BookOpen, ChevronLeft, ChevronRight, Search, Shuffle, X } from "lucide-react";
import { api } from "../api";
import type {
  InterviewExperience,
  InterviewExperienceList,
  InterviewExperienceSummary,
  InterviewPracticeQuestion,
  InterviewPlatform,
} from "../types";
import { InterviewExperienceDrawer } from "../components/InterviewExperienceDrawer";

interface Props {
  polling?: boolean;
  onDrawerOpenChange?: (open: boolean) => void;
}

const EMPTY_RESULT: InterviewExperienceList = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
};

const PLATFORM_LABELS: Record<InterviewPlatform, string> = {
  nowcoder: "牛客",
  xiaohongshu: "小红书",
};

function formatPublishedAt(value: string | null) {
  if (!value) return "未标注";
  return new Date(value).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

interface ReconciledInterviewResult {
  result: InterviewExperienceList;
  page: number;
  pageChanged: boolean;
}

export function reconcileAuthoritativeInterviewResult(
  current: InterviewExperienceList,
  authoritative: InterviewExperienceList,
  requestedPage: number,
): ReconciledInterviewResult {
  const pageSize = authoritative.pageSize || current.pageSize || 20;
  const page = Math.min(Math.max(1, requestedPage), Math.max(1, Math.ceil(authoritative.total / pageSize)));
  const pageChanged = page !== requestedPage;
  return {
    result: { ...authoritative, page, pageSize, items: pageChanged ? [] : authoritative.items },
    page,
    pageChanged,
  };
}

export function removeInterviewExperienceOptimistically(
  current: InterviewExperienceList,
  id: string,
  requestedPage: number,
): ReconciledInterviewResult {
  const containsExperience = current.items.some((item) => item.id === id);
  const result = {
    ...current,
    items: current.items.filter((item) => item.id !== id),
    total: Math.max(0, current.total - (containsExperience ? 1 : 0)),
  };
  const page = Math.min(Math.max(1, requestedPage), Math.max(1, Math.ceil(result.total / result.pageSize)));
  const pageChanged = page !== requestedPage;
  return { result: { ...result, page }, page, pageChanged };
}

export function createLatestRequestRunner() {
  let latestToken = 0;
  return {
    invalidate() {
      latestToken += 1;
    },
    async run<T>(
      request: () => Promise<T>,
      onCommit: (value: T) => void,
      onLatestFinally?: () => void,
      onLatestError?: (error: unknown) => void,
    ) {
      const token = ++latestToken;
      try {
        const value = await request();
        if (token !== latestToken) return false;
        onCommit(value);
        return true;
      } catch (requestError) {
        if (token !== latestToken) return false;
        if (onLatestError) onLatestError(requestError);
        else throw requestError;
        return false;
      } finally {
        if (token === latestToken) onLatestFinally?.();
      }
    },
  };
}

interface MutableRef<T> {
  current: T;
}

export async function reconcileInterviewExperienceDeletion({
  id,
  resultRef,
  pageRef,
  invalidateListRequests,
  commitResult,
  commitPage,
  reload,
}: {
  id: string;
  resultRef: MutableRef<InterviewExperienceList>;
  pageRef: MutableRef<number>;
  invalidateListRequests: () => void;
  commitResult: (result: InterviewExperienceList) => void;
  commitPage: (page: number) => void;
  reload: (page: number) => Promise<unknown>;
}) {
  invalidateListRequests();
  const reconciled = removeInterviewExperienceOptimistically(resultRef.current, id, pageRef.current);
  resultRef.current = reconciled.result;
  pageRef.current = reconciled.page;
  commitResult(reconciled.result);
  if (reconciled.pageChanged) commitPage(reconciled.page);
  await reload(reconciled.page);
  return reconciled;
}

export function getInterviewListPresentation({
  loading,
  error,
  hasLoadedData,
}: {
  loading: boolean;
  error?: string;
  hasLoadedData: boolean;
}) {
  const initialError = Boolean(error) && !hasLoadedData;
  return {
    initialError,
    showEmptySuccess: !loading && !initialError,
  };
}

export function InterviewExperiences({ polling = true, onDrawerOpenChange }: Props) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState<InterviewPlatform | "">("");
  const [interviewRound, setInterviewRound] = useState("");
  const [result, setResult] = useState<InterviewExperienceList>(EMPTY_RESULT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [hasLoadedData, setHasLoadedData] = useState(false);
  const [selectedExperience, setSelectedExperience] = useState<InterviewExperience | null>(null);
  const [openingId, setOpeningId] = useState<string>();
  const [randomQuestions, setRandomQuestions] = useState<InterviewPracticeQuestion[]>([]);
  const [randomOpen, setRandomOpen] = useState(false);
  const [randomLoading, setRandomLoading] = useState(false);
  const [randomError, setRandomError] = useState<string>();
  const detailRequests = useRef(createLatestRequestRunner()).current;
  const listRequests = useRef(createLatestRequestRunner()).current;
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const librarySearchInput = useRef<HTMLInputElement>(null);
  const resultRef = useRef(result);
  const pageRef = useRef(page);
  const activeQueryRef = useRef({ page, search, platform, interviewRound });
  resultRef.current = result;
  pageRef.current = page;
  activeQueryRef.current = { page, search, platform, interviewRound };

  useEffect(() => {
    onDrawerOpenChange?.(selectedExperience !== null);
  }, [onDrawerOpenChange, selectedExperience]);

  useEffect(() => () => onDrawerOpenChange?.(false), [onDrawerOpenChange]);

  useEffect(() => {
    detailRequests.invalidate();
    setOpeningId(undefined);
    return () => detailRequests.invalidate();
  }, [detailRequests, page, search, platform, interviewRound]);

  async function loadActiveQuery(requestedPage = pageRef.current) {
    const activeQuery = activeQueryRef.current;
    return listRequests.run(
      () => api.listInterviewExperiences({
        page: requestedPage,
        search: activeQuery.search,
        platform: activeQuery.platform || undefined,
        interviewRound: activeQuery.interviewRound,
      }),
      (nextResult) => {
        const reconciled = reconcileAuthoritativeInterviewResult(EMPTY_RESULT, nextResult, requestedPage);
        resultRef.current = reconciled.result;
        setResult(reconciled.result);
        setHasLoadedData(true);
        if (reconciled.pageChanged) {
          pageRef.current = reconciled.page;
          setPage(reconciled.page);
        }
        setError(undefined);
      },
      () => setLoading(false),
      (loadError) => setError(loadError instanceof Error ? loadError.message : "无法读取面经"),
    );
  }

  useEffect(() => {
    setLoading(true);
    void loadActiveQuery(page);
    if (!polling) return () => { listRequests.invalidate(); };
    const interval = window.setInterval(() => void loadActiveQuery(page), 5_000);
    return () => {
      listRequests.invalidate();
      window.clearInterval(interval);
    };
  }, [page, search, platform, interviewRound, polling, listRequests]);

  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const rangeStart = result.total === 0 ? 0 : (result.page - 1) * result.pageSize + 1;
  const rangeEnd = Math.min(result.total, result.page * result.pageSize);
  const presentation = getInterviewListPresentation({ loading, error, hasLoadedData });

  async function retryInitialLoad() {
    setLoading(true);
    await loadActiveQuery(pageRef.current);
  }

  async function openExperience(summary: InterviewExperienceSummary) {
    drawerTrigger.current = document.activeElement as HTMLElement | null;
    setOpeningId(summary.id);
    setError(undefined);
    await detailRequests.run(
      () => api.getInterviewExperience(summary.id),
      ({ experience }) => setSelectedExperience(experience),
      () => setOpeningId(undefined),
      (openError) => setError(openError instanceof Error ? openError.message : "无法读取面经详情"),
    );
  }

  async function handleChanged(experience: InterviewExperience) {
    setSelectedExperience(experience);
    listRequests.invalidate();
    await loadActiveQuery(pageRef.current);
  }

  async function handleDeleted(id: string) {
    setSelectedExperience(null);
    await reconcileInterviewExperienceDeletion({
      id,
      resultRef,
      pageRef,
      invalidateListRequests: () => listRequests.invalidate(),
      commitResult: setResult,
      commitPage: setPage,
      reload: loadActiveQuery,
    });
  }

  async function drawRandomQuestions() {
    setRandomOpen(true);
    setRandomLoading(true);
    setRandomError(undefined);
    try {
      const response = await api.getRandomInterviewQuestions();
      setRandomQuestions(response.questions);
    } catch (drawError) {
      setRandomError(drawError instanceof Error ? drawError.message : "随机抽题失败");
    } finally {
      setRandomLoading(false);
    }
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between gap-5 overflow-hidden rounded-2xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-indigo-50 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-500 text-white shadow-sm shadow-blue-200">
            <BookOpen size={20} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-gray-900">我的面经库</h2>
            <p className="mt-1 truncate text-xs text-gray-500">从牛客和小红书采集，确认后自动出现在这里</p>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2.5">
          <button
            type="button"
            onClick={() => void drawRandomQuestions()}
            className="flex cursor-pointer items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-500 px-4 py-2.5 text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <Shuffle size={14} aria-hidden="true" />随机抽 3 题
          </button>
          <div className="rounded-xl border border-white bg-white/80 px-4 py-2 text-center shadow-sm">
            <p className="text-lg font-bold leading-none text-blue-600">{result.total}</p>
            <p className="mt-1 text-[11px] font-medium text-gray-400">篇面经</p>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-700" role="alert">
          <span>{error}</span>
          {presentation.initialError && (
            <button
              type="button"
              onClick={() => void retryInitialLoad()}
              className="flex-shrink-0 rounded-lg border border-red-200 bg-white px-3 py-1.5 font-semibold text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
            >
              重试加载
            </button>
          )}
        </div>
      )}

      {!presentation.initialError && <div className="card p-4">
        <div className="grid grid-cols-[minmax(260px,1fr)_160px_160px] gap-3 items-end">
          <label className="min-w-0">
            <span className="block text-xs font-semibold text-gray-500 mb-1.5">搜索</span>
            <span className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 transition-all">
              <Search size={15} className="text-gray-400 flex-shrink-0" aria-hidden="true" />
              <input
                ref={librarySearchInput}
                value={search}
                onChange={(event) => { setSearch(event.target.value); setPage(1); }}
                placeholder="搜索公司、岗位或问题"
                className="min-w-0 flex-1 bg-transparent text-sm text-gray-700 placeholder-gray-400 outline-none"
              />
            </span>
          </label>
          <label>
            <span className="block text-xs font-semibold text-gray-500 mb-1.5">来源平台</span>
            <select
              value={platform}
              onChange={(event) => { setPlatform(event.target.value as InterviewPlatform | ""); setPage(1); }}
              className="w-full cursor-pointer rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-600 outline-none transition-all hover:border-gray-300 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            >
              <option value="">全部平台</option>
              <option value="nowcoder">牛客</option>
              <option value="xiaohongshu">小红书</option>
            </select>
          </label>
          <label>
            <span className="block text-xs font-semibold text-gray-500 mb-1.5">面试轮次</span>
            <input
              value={interviewRound}
              onChange={(event) => { setInterviewRound(event.target.value); setPage(1); }}
              placeholder="例如：一面"
              className="w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-600 placeholder-gray-400 outline-none transition-all hover:border-gray-300 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
          </label>
        </div>
      </div>}

      {!presentation.initialError && <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
          <div>
            <p className="text-sm font-bold text-gray-900">面经库</p>
            <p className="text-xs text-gray-400 mt-0.5">显示 {rangeStart}-{rangeEnd} / {result.total} 篇面经</p>
          </div>
          {loading && <span className="text-xs font-medium text-blue-500">正在更新…</span>}
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[1080px]">
            <div className="grid grid-cols-[minmax(190px,1.25fr)_minmax(240px,2fr)_100px_140px_80px_90px_120px_48px] items-center gap-3 bg-gray-50 px-6 py-2.5 border-b border-gray-100">
              {[
                ["公司 / 岗位", "text-left"],
                ["来源标题", "text-left"],
                ["轮次", "text-center"],
                ["面试时间", "text-left"],
                ["题目", "text-center"],
                ["平台", "text-center"],
                ["发布时间", "text-left"],
                ["", "text-right"],
              ].map(([label, align], index) => (
                <p key={`${label}-${index}`} className={`text-xs font-semibold text-gray-400 uppercase tracking-wider ${align}`}>{label}</p>
              ))}
            </div>

            <div className="divide-y divide-gray-50">
              {presentation.showEmptySuccess && result.items.length === 0 ? (
                <div className="py-14 text-center">
                  <BookOpen size={24} className="mx-auto text-gray-300" aria-hidden="true" />
                  <p className="text-sm text-gray-400 mt-2">没有符合条件的面经。</p>
                  <p className="text-xs text-gray-300 mt-1">通过浏览器扩展采集后会显示在这里。</p>
                </div>
              ) : (
                result.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void openExperience(item)}
                    disabled={openingId === item.id}
                    aria-label={`查看面经：${item.company} ${item.position}`}
                    className="group grid w-full cursor-pointer grid-cols-[minmax(190px,1.25fr)_minmax(240px,2fr)_100px_140px_80px_90px_120px_48px] items-center gap-3 px-6 py-4 text-left transition-colors hover:bg-blue-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 disabled:cursor-wait disabled:opacity-60"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-gray-800" title={item.company}>{item.company}</p>
                      <p className="truncate text-xs text-gray-400 mt-0.5" title={item.position}>{item.position}</p>
                    </div>
                    <p className="truncate text-sm font-medium text-gray-700" title={item.source.title}>{item.source.title}</p>
                    <div className="text-center">
                      <span className="inline-block max-w-full truncate rounded-lg bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-600" title={item.interviewRound ?? "未标注"}>
                        {item.interviewRound ?? "未标注"}
                      </span>
                    </div>
                    <p className="truncate text-xs font-medium text-gray-500" title={item.interviewTime ?? "未标注"}>{item.interviewTime ?? "未标注"}</p>
                    <p className="text-center text-xs font-semibold text-gray-600">{item.questionCount} 题</p>
                    <div className="text-center">
                      <span className="inline-block rounded-lg bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-600">
                        {PLATFORM_LABELS[item.source.platform]}
                      </span>
                    </div>
                    <p className="truncate text-xs text-gray-400 font-mono">{formatPublishedAt(item.source.publishedAt)}</p>
                    <span className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 transition-colors group-hover:bg-blue-100" aria-hidden="true">
                      <ChevronRight size={14} className="text-gray-400 group-hover:text-blue-500" />
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="px-6 py-3 border-t border-gray-100 bg-gray-50/60 flex items-center justify-between">
          <p className="text-xs text-gray-400">每页 20 条</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page === 1}
              className="flex cursor-pointer items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft size={13} aria-hidden="true" />上一页
            </button>
            <span className="min-w-14 text-center text-xs font-semibold text-gray-500">{page} / {totalPages}</span>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={page === totalPages}
              className="flex cursor-pointer items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              下一页<ChevronRight size={13} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>}

      <InterviewExperienceDrawer
        experience={selectedExperience}
        returnFocusTo={drawerTrigger.current}
        fallbackFocusTo={librarySearchInput.current}
        onClose={() => setSelectedExperience(null)}
        onChanged={handleChanged}
        onDeleted={handleDeleted}
      />

      {randomOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-5" role="presentation">
          <button
            type="button"
            className="absolute inset-0 cursor-default bg-slate-900/35 backdrop-blur-[2px]"
            aria-label="关闭随机抽题"
            onClick={() => setRandomOpen(false)}
          />
          <section
            className="relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/70 bg-white shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="random-questions-title"
          >
            <header className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><Shuffle size={15} /></span>
                  <h2 id="random-questions-title" className="text-base font-bold text-gray-900">随机面试题</h2>
                </div>
                <p className="mt-1 text-xs text-gray-400">从全部面经中随机抽取 3 道问题</p>
              </div>
              <button type="button" onClick={() => setRandomOpen(false)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl bg-gray-100 text-gray-500 transition-colors hover:bg-gray-200" aria-label="关闭">
                <X size={16} />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {randomLoading ? (
                <div className="space-y-3" aria-label="正在随机抽题">
                  {[0, 1, 2].map((item) => <div key={item} className="h-28 animate-pulse rounded-2xl bg-gray-100" />)}
                </div>
              ) : randomError ? (
                <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{randomError}</div>
              ) : randomQuestions.length === 0 ? (
                <div className="py-12 text-center"><BookOpen size={26} className="mx-auto text-gray-300" /><p className="mt-3 text-sm text-gray-500">面经库中还没有可抽取的问题</p></div>
              ) : (
                <div className="space-y-3">
                  {randomQuestions.map((item, index) => (
                    <article key={item.id} className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4">
                      <div className="flex items-start gap-3">
                        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-blue-600 text-xs font-bold text-white">{index + 1}</span>
                        <div className="min-w-0 flex-1">
                          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-semibold text-gray-700">{item.company}</span>
                            <span className="text-gray-300">·</span>
                            <span className="text-gray-500">{item.position || "—"}</span>
                            {item.interviewRound && <span className="rounded-md bg-indigo-50 px-2 py-0.5 font-medium text-indigo-600">{item.interviewRound}</span>}
                          </div>
                          <p className="whitespace-pre-wrap text-sm font-semibold leading-relaxed text-gray-900">{item.question}</p>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>

            <footer className="flex items-center justify-end gap-2 border-t border-gray-100 bg-gray-50/60 px-6 py-4">
              <button type="button" onClick={() => setRandomOpen(false)} className="cursor-pointer rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-50">关闭</button>
              <button type="button" onClick={() => void drawRandomQuestions()} disabled={randomLoading} className="flex cursor-pointer items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-500 px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
                <Shuffle size={13} />换一组
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
