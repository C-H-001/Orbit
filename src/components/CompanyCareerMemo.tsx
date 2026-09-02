import { useEffect, useState } from "react"
import { ExternalLink, Pencil, Plus, Trash2, X } from "lucide-react"
import { api } from "../api"
import type { CompanyCareerPage } from "../types"

export function CompanyCareerMemo() {
  const [pages, setPages] = useState<CompanyCareerPage[]>([])
  const [error, setError] = useState<string>()
  const [editing, setEditing] = useState<CompanyCareerPage | null | undefined>(undefined)
  const [company, setCompany] = useState("")
  const [url, setUrl] = useState("")
  const [saving, setSaving] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<string>()

  useEffect(() => {
    void api.listCompanyCareerPages()
      .then((result) => setPages(result.pages))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取公司官网备忘录"))
  }, [])

  function openEditor(page?: CompanyCareerPage) {
    setEditing(page ?? null)
    setCompany(page?.company ?? "")
    setUrl(page?.url ?? "")
    setError(undefined)
  }

  async function save() {
    if (!company.trim() || !url.trim() || saving) return
    setSaving(true)
    setError(undefined)
    try {
      const result = editing
        ? await api.updateCompanyCareerPage(editing.id, { company: company.trim(), url: url.trim() })
        : await api.createCompanyCareerPage({ company: company.trim(), url: url.trim() })
      setPages((current) => editing
        ? current.map((item) => item.id === result.page.id ? result.page : item).sort((a, b) => a.company.localeCompare(b.company, "zh-CN"))
        : [...current, result.page].sort((a, b) => a.company.localeCompare(b.company, "zh-CN")))
      setEditing(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteCompanyCareerPage(id)
      setPages((current) => current.filter((item) => item.id !== id))
      setPendingDeleteId(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败")
    }
  }

  return (
    <>
      <section className="card mt-5 overflow-hidden">
        <header className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <div>
            <h2 className="text-sm font-bold text-gray-900">公司官网备忘录</h2>
            <p className="mt-1 text-xs text-gray-400">手动保存常用公司的招聘页面</p>
          </div>
          <button type="button" onClick={() => openEditor()} className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-blue-50 px-3.5 py-2 text-xs font-semibold text-blue-600 transition-colors hover:bg-blue-100">
            <Plus size={14} />新增记录
          </button>
        </header>
        {error && <div className="mx-6 mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-700">{error}</div>}
        <div className="grid grid-cols-[minmax(180px,0.8fr)_minmax(0,2fr)] border-b border-gray-100 bg-gray-50 px-6 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
          <span>公司</span><span>招聘网址</span>
        </div>
        <div className="divide-y divide-gray-50">
          {pages.length === 0 ? (
            <div className="py-10 text-center text-sm text-gray-400">点击右上角加号添加公司招聘页面</div>
          ) : pages.map((page) => (
            <div key={page.id} className="grid grid-cols-[minmax(180px,0.8fr)_minmax(0,2fr)] items-center px-6 py-3.5 hover:bg-blue-50/30">
              <p className="truncate text-sm font-semibold text-gray-800">{page.company}</p>
              <div className="flex min-w-0 items-center gap-2">
                <a href={page.url} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700">
                  <span className="truncate">{page.url}</span><ExternalLink size={13} className="flex-shrink-0" />
                </a>
                {pendingDeleteId === page.id ? (
                  <div className="flex flex-shrink-0 items-center gap-1.5">
                    <button type="button" onClick={() => void remove(page.id)} className="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-600">确认删除</button>
                    <button type="button" onClick={() => setPendingDeleteId(undefined)} className="rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs text-gray-500">取消</button>
                  </div>
                ) : (
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <button type="button" onClick={() => openEditor(page)} aria-label={`编辑 ${page.company}`} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-gray-400 hover:bg-white hover:text-blue-600"><Pencil size={13} /></button>
                    <button type="button" onClick={() => setPendingDeleteId(page.id)} aria-label={`删除 ${page.company}`} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500"><Trash2 size={13} /></button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {editing !== undefined && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-5">
          <button type="button" className="absolute inset-0 cursor-default bg-slate-900/35 backdrop-blur-[2px]" aria-label="关闭" onClick={() => setEditing(undefined)} />
          <section role="dialog" aria-modal="true" aria-labelledby="career-page-title" className="relative z-10 w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between">
              <div><h2 id="career-page-title" className="text-base font-bold text-gray-900">{editing ? "编辑招聘页面" : "新增招聘页面"}</h2><p className="mt-1 text-xs text-gray-400">仅保存在本地 Orbit</p></div>
              <button type="button" onClick={() => setEditing(undefined)} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-xl bg-gray-100 text-gray-500"><X size={15} /></button>
            </div>
            <label className="mt-5 block"><span className="mb-1.5 block text-xs font-semibold text-gray-500">公司</span><input value={company} onChange={(event) => setCompany(event.target.value)} className="w-full rounded-xl border border-gray-200 px-3.5 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" placeholder="例如：字节跳动" /></label>
            <label className="mt-4 block"><span className="mb-1.5 block text-xs font-semibold text-gray-500">招聘网址</span><input value={url} onChange={(event) => setUrl(event.target.value)} className="w-full rounded-xl border border-gray-200 px-3.5 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" placeholder="https://jobs.example.com" /></label>
            <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={() => setEditing(undefined)} className="cursor-pointer rounded-xl bg-gray-100 px-4 py-2 text-xs font-semibold text-gray-600">取消</button><button type="button" onClick={() => void save()} disabled={!company.trim() || !url.trim() || saving} className="cursor-pointer rounded-xl bg-gradient-to-r from-blue-500 to-indigo-500 px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{saving ? "保存中…" : "保存"}</button></div>
          </section>
        </div>
      )}
    </>
  )
}
