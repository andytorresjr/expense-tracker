import { useEffect, useMemo, useRef, useState } from 'react'
import type { Category, ExpenseType, Txn } from '@shared/types'
import { api, fmtMoney } from '../api'
import RuleModal, { type RuleDraft } from '../components/RuleModal'

/** Keys reserved for controls, never handed to a category: b/p set the type, r makes a rule. */
const RESERVED = new Set(['b', 'p', 'r'])
const FALLBACK_KEYS = '1234567890qwertyuiopasdfghjklzxcvbnm'.split('')

function savedHotkey(category: Category): string | null {
  const key = category.hotkey?.trim().toLowerCase()
  return key && /^[a-z0-9]$/.test(key) && !RESERVED.has(key) ? key : null
}

/**
 * Assign a single keyboard key to each category. Saved category hotkeys win
 * first; categories without one claim the first free letter in their name, then
 * the fallback pool. Auto-assignment still processes most-used categories first
 * so common categories get the most natural remaining keys.
 */
function assignHotkeys(categories: Category[], usage: Map<number, number>): Map<number, string> {
  const ordered = [...categories].sort(
    (a, b) => (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0) || a.id - b.id
  )
  const used = new Set(RESERVED)
  const byCategory = new Map<number, string>()
  for (const cat of ordered) {
    const key = savedHotkey(cat)
    if (key && !used.has(key)) {
      used.add(key)
      byCategory.set(cat.id, key)
    }
  }
  for (const cat of ordered) {
    if (byCategory.has(cat.id)) continue
    let key: string | undefined
    for (const ch of cat.name.toLowerCase()) {
      if (ch >= 'a' && ch <= 'z' && !used.has(ch)) {
        key = ch
        break
      }
    }
    if (!key) key = FALLBACK_KEYS.find((ch) => !used.has(ch))
    if (key) {
      used.add(key)
      byCategory.set(cat.id, key)
    }
  }
  return byCategory
}

interface LastAction {
  description: string
  category_id: number | null
  category_name: string | null
  expense_type: ExpenseType | null
}

export default function QuickCategorize({
  categories,
  onClose
}: {
  categories: Category[]
  onClose: () => void
}): React.JSX.Element {
  const [queue, setQueue] = useState<Txn[]>([])
  const [index, setIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sessionCount, setSessionCount] = useState(0)
  const [lastAction, setLastAction] = useState<LastAction | null>(null)
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null)
  // Hotkeys are computed once from the initial data so they stay stable while you work.
  const [hotkeys, setHotkeys] = useState<Map<number, string>>(new Map())
  const [clientDraft, setClientDraft] = useState('')
  const [commentDraft, setCommentDraft] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const clientInputRef = useRef<HTMLInputElement>(null)
  // NULL is the app's uncategorized state; assigning the seeded namesake would lock the row.
  const assignableCategories = useMemo(
    () => categories.filter((category) => category.name.trim().toLowerCase() !== 'uncategorized'),
    [categories]
  )

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  useEffect(() => {
    api.transactions
      .categorizeQueue()
      .then((rows) => {
        setQueue(rows)
        const usage = new Map<number, number>()
        for (const t of rows) if (t.category_id !== null) usage.set(t.category_id, (usage.get(t.category_id) ?? 0) + 1)
        setHotkeys(assignHotkeys(assignableCategories, usage))
        // start at the top — the queue is already uncategorized-first, then the rest
        setIndex(0)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [assignableCategories])

  const keyToCategory = useMemo(() => {
    const m = new Map<string, number>()
    for (const [catId, key] of hotkeys) m.set(key, catId)
    return m
  }, [hotkeys])

  const categoryName = (id: number | null): string | null =>
    id === null ? null : categories.find((c) => c.id === id)?.name ?? null

  const current = queue[index] ?? null
  const done = !loading && index >= queue.length
  const uncategorizedLeft = useMemo(() => queue.filter((t) => t.category_id === null).length, [queue])
  // A business charge in a client-required category (e.g. Meals & Entertainment)
  // that still lacks a client name — surfaces the inline field below.
  const currentNeedsClient =
    !!current && current.expense_type === 'business' && current.category_requires_client === 1 && !current.client?.trim()

  // Keep the client and comment drafts in sync with whichever transaction is showing.
  useEffect(() => {
    setClientDraft(current?.client ?? '')
    setCommentDraft(current?.comment ?? '')
  }, [current?.id])

  const patchCurrent = (patch: Partial<Txn>): void =>
    setQueue((q) => q.map((t, i) => (i === index ? { ...t, ...patch } : t)))

  const setType = (type: ExpenseType): void => {
    if (!current || current.expense_type === type) return
    patchCurrent({ expense_type: type })
    api.transactions.update(current.id, { expense_type: type }).catch((e) => setError(e.message))
  }

  const assignCategory = (categoryId: number): void => {
    if (!current) return
    const name = categoryName(categoryId)
    const cat = categories.find((c) => c.id === categoryId)
    const requiresClient = cat?.requires_client ?? 0
    patchCurrent({ category_id: categoryId, category_name: name, category_requires_client: requiresClient })
    api.transactions.update(current.id, { category_id: categoryId }).catch((e) => setError(e.message))
    setLastAction({ description: current.description, category_id: categoryId, category_name: name, expense_type: current.expense_type })
    setSessionCount((n) => n + 1)
    // Business meals & entertainment need a client name for the IRS — pause on the
    // row so it can be entered (still skippable) instead of auto-advancing.
    if (requiresClient === 1 && current.expense_type === 'business' && !current.client?.trim()) {
      requestAnimationFrame(() => clientInputRef.current?.focus())
    } else {
      setIndex((i) => i + 1)
    }
  }

  const saveClient = (advance: boolean): void => {
    if (!current) return
    const value = clientDraft.trim() || null
    if (value !== (current.client ?? null)) {
      patchCurrent({ client: value })
      api.transactions.update(current.id, { client: value }).catch((e) => setError(e.message))
    }
    if (advance) setIndex((i) => Math.min(i + 1, queue.length))
  }

  const saveComment = (): void => {
    if (!current) return
    const value = commentDraft.trim() || null
    if (value !== (current.comment ?? null)) {
      patchCurrent({ comment: value })
      api.transactions.update(current.id, { comment: value }).catch((e) => setError(e.message))
    }
  }

  const skip = (): void => setIndex((i) => Math.min(i + 1, queue.length))
  const back = (): void => setIndex((i) => Math.max(i - 1, 0))

  const openRule = (): void => {
    const src =
      lastAction ??
      (current ? { description: current.description, category_id: current.category_id, expense_type: current.expense_type } : null)
    if (!src) return
    setRuleDraft({ pattern: src.description, match_type: 'contains', expense_type: src.expense_type, category_id: src.category_id, priority: 0 })
  }

  const saveRule = async (): Promise<void> => {
    if (!ruleDraft) return
    setBusy(true)
    setError(null)
    try {
      await api.rules.create(ruleDraft)
      await api.rules.rerun()
      // Re-run may auto-classify rows; refresh categories in place without
      // reordering so your position in the queue doesn't jump around.
      const fresh = await api.transactions.categorizeQueue()
      const byId = new Map(fresh.map((t) => [t.id, t]))
      setQueue((q) =>
        q.map((t) => {
          const f = byId.get(t.id)
          return f ? { ...t, category_id: f.category_id, category_name: f.category_name, expense_type: f.expense_type } : t
        })
      )
      setRuleDraft(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // One keydown listener, bound once; always calls the latest closure via ref.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {})
  keyHandler.current = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (ruleDraft) {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault()
        setRuleDraft(null)
      }
      return
    }
    if (busy) return

    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (done) {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        back()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        onClose()
      }
      return
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      back()
      return
    }
    if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault()
      skip()
      return
    }
    const k = e.key.toLowerCase()
    if (k === 'b') return e.preventDefault(), setType('business')
    if (k === 'p') return e.preventDefault(), setType('personal')
    if (k === 'r') return e.preventDefault(), openRule()
    const catId = keyToCategory.get(k)
    if (catId !== undefined) {
      e.preventDefault()
      assignCategory(catId)
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => keyHandler.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-categorize-title"
    >
      <div ref={panelRef} tabIndex={-1} className="card-panel w-full max-w-2xl p-6 space-y-5 outline-none">
        {/* header */}
        <div className="flex items-center gap-3">
          <h2 id="quick-categorize-title" className="font-semibold text-slate-800 mr-auto flex items-center gap-2">
            ⚡ Quick Categorize
          </h2>
          {!loading && !done && (
            <span className="text-sm text-slate-500">
              {index + 1} of {queue.length} · <span className="text-amber-600 font-medium">{uncategorizedLeft} uncategorized</span>
            </span>
          )}
          <button className="btn-secondary !py-1" onClick={onClose}>
            Close (Esc)
          </button>
        </div>

        {!loading && queue.length > 0 && (
          <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${(Math.min(index, queue.length) / queue.length) * 100}%` }} />
          </div>
        )}

        {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 text-sm">{error}</div>}

        {loading && <div className="py-16 text-center text-slate-400">Loading transactions…</div>}

        {!loading && queue.length === 0 && (
          <div className="py-16 text-center text-slate-400">No transactions yet — import a statement first.</div>
        )}

        {done && queue.length > 0 && (
          <div className="py-12 text-center space-y-3">
            <div className="text-4xl">🎉</div>
            <h3 className="text-lg font-semibold text-slate-800">
              {uncategorizedLeft === 0 ? 'All caught up' : 'Queue complete'}
            </h3>
            <p className="text-slate-600">
              You categorized <strong>{sessionCount}</strong> transaction{sessionCount === 1 ? '' : 's'} this session.
              {uncategorizedLeft > 0 && (
                <>
                  {' '}
                  <strong>{uncategorizedLeft}</strong> remain uncategorized.
                </>
              )}
            </p>
            <div className="flex justify-center gap-3">
              <button className="btn-secondary" onClick={back}>
                Back (←)
              </button>
              <button className="btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}

        {!loading && !done && current && (
          <>
            {/* transaction */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-5 py-4">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>
                  {current.txn_date} · {current.card_name}
                </span>
                {current.category_name && (
                  <span className="rounded-full bg-white border border-slate-200 px-2 py-0.5">
                    currently: {current.category_name}
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-start justify-between gap-4">
                <div className="text-lg font-medium text-slate-800 break-words" title={current.description}>
                  {current.description}
                </div>
                <div className={`text-lg font-semibold whitespace-nowrap ${current.amount < 0 ? 'text-green-600' : 'text-slate-800'}`}>
                  {fmtMoney(current.amount)}
                </div>
              </div>
            </div>

            {/* type */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-500 mr-1">Type:</span>
              {(['business', 'personal'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  className={`px-3 py-1 rounded-full border text-sm font-medium capitalize ${
                    current.expense_type === t
                      ? t === 'business'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-violet-600 text-white border-violet-600'
                      : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {t} <kbd className="ml-1 opacity-60 font-mono text-xs">{t === 'business' ? 'B' : 'P'}</kbd>
                </button>
              ))}
              {current.expense_type === null && <span className="text-xs text-slate-400">Visible in All until assigned</span>}
            </div>

            {/* categories */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {assignableCategories.map((c) => {
                const key = hotkeys.get(c.id)
                const active = current.category_id === c.id
                return (
                  <button
                    key={c.id}
                    onClick={() => assignCategory(c.id)}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm text-left transition-colors ${
                      active ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-slate-200 hover:border-blue-300 hover:bg-slate-50 text-slate-700'
                    }`}
                  >
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: c.color ?? '#9ca3af' }} />
                    <span className="flex-1 truncate" title={c.name}>
                      {c.name}
                    </span>
                    {key && (
                      <kbd className="shrink-0 rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-xs text-slate-500 uppercase">
                        {key}
                      </kbd>
                    )}
                  </button>
                )
              })}
            </div>

            {/* client / attendees — required for business meals & entertainment */}
            {current.expense_type === 'business' && current.category_requires_client === 1 && (
              <div
                className={`rounded-lg border px-4 py-3 ${
                  currentNeedsClient ? 'border-amber-300 bg-amber-50' : 'border-emerald-200 bg-emerald-50'
                }`}
              >
                <label className="block text-sm font-medium text-slate-700">
                  {currentNeedsClient ? '⚠ ' : '✓ '}Client / attendees
                  <span className="ml-1 font-normal text-slate-500">— IRS substantiation for business meals</span>
                </label>
                <input
                  ref={clientInputRef}
                  className="input mt-1 w-full"
                  placeholder="e.g. Acme Corp — J. Smith"
                  value={clientDraft}
                  onChange={(e) => setClientDraft(e.target.value)}
                  onBlur={() => saveClient(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      saveClient(true)
                    }
                  }}
                />
                <p className="mt-1 text-xs text-slate-500">
                  Press <kbd className="font-mono">Enter</kbd> to save &amp; continue, or <kbd className="font-mono">→</kbd> to
                  skip for now.
                </p>
              </div>
            )}

            {/* comment — optional free-text note, available on every transaction */}
            <div>
              <label className="block text-sm text-slate-500 mb-1">
                Comment <span className="text-slate-400">(optional)</span>
              </label>
              <textarea
                className="input w-full"
                rows={2}
                placeholder="Add a note about this transaction…"
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                onBlur={saveComment}
              />
            </div>

            {/* last action / rule prompt */}
            {lastAction && (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-2 text-sm text-emerald-800">
                <span className="flex-1 truncate">
                  ✓ Marked <strong className="font-medium">{lastAction.description}</strong> as{' '}
                  {lastAction.category_name ?? 'uncategorized'}
                </span>
                <button onClick={openRule} className="btn-secondary !py-0.5 !px-2 shrink-0">
                  Make a rule <kbd className="ml-1 font-mono text-xs opacity-60">R</kbd>
                </button>
              </div>
            )}

            {/* legend */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400 border-t border-slate-100 pt-3">
              <span><kbd className="font-mono">B</kbd>/<kbd className="font-mono">P</kbd> set type</span>
              <span><kbd className="font-mono">key</kbd> set category &amp; next</span>
              <span><kbd className="font-mono">R</kbd> make rule</span>
              <span><kbd className="font-mono">→</kbd>/<kbd className="font-mono">Enter</kbd> skip</span>
              <span><kbd className="font-mono">←</kbd> back</span>
              <span><kbd className="font-mono">Esc</kbd> close</span>
            </div>
          </>
        )}
      </div>

      {ruleDraft && (
        <RuleModal
          draft={ruleDraft}
          categories={assignableCategories}
          busy={busy}
          onChange={setRuleDraft}
          onCancel={() => setRuleDraft(null)}
          onSave={saveRule}
        />
      )}
    </div>
  )
}
