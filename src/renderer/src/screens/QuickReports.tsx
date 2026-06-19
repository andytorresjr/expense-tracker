import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Card, Category, ExpenseTypeFilter, ExportFormat, Txn } from '@shared/types'
import { api } from '../api'
import PrintableReport, { type ReportMeta } from '../components/PrintableReport'
import {
  DATE_MODES,
  deleteReport,
  emptyReport,
  listReports,
  resolveDateRange,
  toTxnFilters,
  upsertReport,
  type CategoryTarget,
  type DateMode,
  type QuickReport
} from '../quickReports'

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

const SCOPES: { id: ExpenseTypeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'business', label: 'Business' },
  { id: 'personal', label: 'Personal' }
]

const scopeText = (s: ExpenseTypeFilter): string =>
  s === 'business' ? 'Business' : s === 'personal' ? 'Personal' : 'Business & Personal'

const dateModeLabel = (mode: DateMode): string => DATE_MODES.find((d) => d.id === mode)?.label ?? mode

function Chip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="inline-flex items-center rounded-full bg-slate-100 text-slate-600 px-2.5 py-0.5 text-xs">{children}</span>
}

export default function QuickReports(): React.JSX.Element {
  const [reports, setReports] = useState<QuickReport[]>(listReports)
  const [cards, setCards] = useState<Card[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [draft, setDraft] = useState<QuickReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [printState, setPrintState] = useState<{ rows: Txn[]; meta: ReportMeta } | null>(null)

  useEffect(() => {
    api.cards.list().then(setCards).catch((e) => setError(e.message))
    api.categories.list().then(setCategories).catch((e) => setError(e.message))
  }, [])

  const cardName = useCallback((id: number) => cards.find((c) => c.id === id)?.name ?? `Card ${id}`, [cards])
  const categoryName = useCallback(
    (id: CategoryTarget) => (id === 'uncategorized' ? 'Uncategorized' : categories.find((c) => c.id === id)?.name ?? `Category ${id}`),
    [categories]
  )

  const cardsLabel = useCallback(
    (r: QuickReport) => (r.cardIds.length === 0 ? 'All cards' : r.cardIds.length === 1 ? cardName(r.cardIds[0]) : `${r.cardIds.length} cards`),
    [cardName]
  )
  const categoriesLabel = useCallback(
    (r: QuickReport) =>
      r.categoryIds.length === 0
        ? 'All categories'
        : r.categoryIds.length === 1
          ? categoryName(r.categoryIds[0])
          : `${r.categoryIds.length} categories`,
    [categoryName]
  )

  const dateLabel = (r: QuickReport): string => {
    if (r.dateMode !== 'custom') return dateModeLabel(r.dateMode)
    const { from, to } = resolveDateRange(r)
    return from || to ? `${from || '…'} → ${to || '…'}` : 'Custom range'
  }

  const saveDraft = (): void => {
    if (!draft) return
    if (!draft.name.trim()) {
      setError('Give the report a name.')
      return
    }
    setReports(upsertReport({ ...draft, name: draft.name.trim() }))
    setDraft(null)
    setError(null)
    setNotice(null)
  }

  const removeReport = (r: QuickReport): void => {
    if (!window.confirm(`Delete the "${r.name}" quick report?`)) return
    setReports(deleteReport(r.id))
  }

  const runExport = (r: QuickReport, format: ExportFormat): Promise<void> =>
    withBusy(async () => {
      const filters = toTxnFilters(r)
      if (format === 'pdf') {
        const rows = await api.transactions.exportRows(filters)
        if (rows.length === 0) throw new Error('No transactions match this report — nothing to export.')
        setPrintState({
          rows,
          meta: {
            scope: r.expenseType,
            categoryLabel: categoriesLabel(r),
            cardLabel: cardsLabel(r),
            search: r.search,
            generatedAt: new Date().toLocaleString(),
            title: r.name
          }
        })
        await nextFrame()
        await nextFrame()
        try {
          const result = await api.transactions.exportPdf(filters, r.name)
          if (result) setNotice(`Saved PDF report with ${result.count} transaction${result.count === 1 ? '' : 's'} to ${result.path}`)
        } finally {
          setPrintState(null)
        }
      } else {
        const result = await api.transactions.export(filters, format, r.name)
        if (result) setNotice(`Exported ${result.count} transaction${result.count === 1 ? '' : 's'} to ${result.path}`)
      }
    })

  async function withBusy(fn: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">{error}</div>}
      {notice && <div className="rounded-lg bg-green-50 border border-green-200 text-green-700 px-4 py-3 text-sm">{notice}</div>}

      <section className="card-panel p-6 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-slate-800">Quick Reports</h2>
            <p className="text-sm text-slate-500 mt-1">
              Save a set of filters — reporting view, any number of cards and categories, a search term and a date
              range — then export the matching statement as CSV, Excel, or PDF in one click.
            </p>
          </div>
          {!draft && (
            <button className="btn-primary shrink-0" onClick={() => setDraft(emptyReport())}>
              New report
            </button>
          )}
        </div>
      </section>

      {draft && (
        <ReportEditor
          draft={draft}
          cards={cards}
          categories={categories}
          onChange={setDraft}
          onSave={saveDraft}
          onCancel={() => {
            setDraft(null)
            setError(null)
          }}
        />
      )}

      {!draft && reports.length === 0 && (
        <p className="text-sm text-slate-400 text-center py-8">No quick reports yet. Create one to get started.</p>
      )}

      {!draft &&
        reports.map((r) => (
          <section key={r.id} className="card-panel p-5 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-semibold text-slate-800">{r.name}</h3>
              <div className="flex gap-3 text-sm shrink-0">
                <button className="text-blue-600 hover:underline" onClick={() => setDraft({ ...r })}>Edit</button>
                <button className="text-red-500 hover:underline" onClick={() => removeReport(r)}>Delete</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Chip>{scopeText(r.expenseType)}</Chip>
              <Chip>{cardsLabel(r)}</Chip>
              <Chip>{categoriesLabel(r)}</Chip>
              <Chip>{dateLabel(r)}</Chip>
              {r.search.trim() && <Chip>“{r.search.trim()}”</Chip>}
            </div>
            <div className="flex gap-2 pt-1">
              <button className="btn-secondary !py-1.5" disabled={busy} onClick={() => runExport(r, 'csv')}>⤓ CSV</button>
              <button className="btn-secondary !py-1.5" disabled={busy} onClick={() => runExport(r, 'xlsx')}>⤓ Excel</button>
              <button className="btn-secondary !py-1.5" disabled={busy} onClick={() => runExport(r, 'pdf')}>⤓ PDF</button>
            </div>
          </section>
        ))}

      {printState && <PrintableReport rows={printState.rows} meta={printState.meta} />}
    </div>
  )
}

function ReportEditor({
  draft,
  cards,
  categories,
  onChange,
  onSave,
  onCancel
}: {
  draft: QuickReport
  cards: Card[]
  categories: Category[]
  onChange: (r: QuickReport) => void
  onSave: () => void
  onCancel: () => void
}): React.JSX.Element {
  const set = (patch: Partial<QuickReport>): void => onChange({ ...draft, ...patch })

  const toggleCard = (id: number): void =>
    set({ cardIds: draft.cardIds.includes(id) ? draft.cardIds.filter((c) => c !== id) : [...draft.cardIds, id] })
  const toggleCategory = (id: CategoryTarget): void =>
    set({
      categoryIds: draft.categoryIds.includes(id) ? draft.categoryIds.filter((c) => c !== id) : [...draft.categoryIds, id]
    })

  const categoryTargets = useMemo<CategoryTarget[]>(() => [...categories.map((c) => c.id), 'uncategorized'], [categories])

  return (
    <section className="card-panel p-6 space-y-5">
      <h3 className="font-semibold text-slate-800">{draft.name ? `Edit “${draft.name}”` : 'New quick report'}</h3>

      <label className="block text-sm text-slate-600">
        Report name
        <input
          className="input block w-full mt-1"
          placeholder="e.g. Q1 Business — Meals & Travel"
          value={draft.name}
          autoFocus
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>

      <div>
        <div className="text-sm text-slate-600 mb-1">Reporting view</div>
        <div className="flex rounded-lg border border-slate-300 overflow-hidden w-min">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              onClick={() => set({ expenseType: s.id })}
              className={`px-4 py-1.5 text-sm font-medium ${
                draft.expenseType === s.id ? 'bg-slate-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-sm text-slate-600 mb-1">Cards <span className="text-slate-400">(none selected = all cards)</span></div>
        {cards.length === 0 ? (
          <p className="text-sm text-slate-400">No cards yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {cards.map((c) => (
              <CheckChip key={c.id} checked={draft.cardIds.includes(c.id)} onToggle={() => toggleCard(c.id)}>
                💳 {c.name}
              </CheckChip>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="text-sm text-slate-600 mb-1">Categories <span className="text-slate-400">(none selected = all categories)</span></div>
        <div className="flex flex-wrap gap-2">
          {categoryTargets.map((id) => (
            <CheckChip key={String(id)} checked={draft.categoryIds.includes(id)} onToggle={() => toggleCategory(id)}>
              {id === 'uncategorized' ? 'Uncategorized' : categories.find((c) => c.id === id)?.name}
            </CheckChip>
          ))}
        </div>
      </div>

      <label className="block text-sm text-slate-600">
        Description contains <span className="text-slate-400">(optional)</span>
        <input
          className="input block w-full mt-1"
          placeholder="e.g. UBER"
          value={draft.search}
          onChange={(e) => set({ search: e.target.value })}
        />
      </label>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm text-slate-600">
          Date range
          <select className="input block mt-1" value={draft.dateMode} onChange={(e) => set({ dateMode: e.target.value as DateMode })}>
            {DATE_MODES.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </label>
        {draft.dateMode === 'custom' && (
          <div className="flex items-center gap-2 text-sm">
            <input type="date" className="input !py-1.5" value={draft.customFrom} onChange={(e) => set({ customFrom: e.target.value })} />
            <span className="text-slate-400">to</span>
            <input type="date" className="input !py-1.5" value={draft.customTo} onChange={(e) => set({ customTo: e.target.value })} />
          </div>
        )}
      </div>

      <div className="flex gap-3 border-t border-slate-200 pt-4">
        <button className="btn-primary" onClick={onSave}>Save report</button>
        <button className="btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  )
}

function CheckChip({
  checked,
  onToggle,
  children
}: {
  checked: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm border ${
        checked ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
      }`}
    >
      {checked && <span>✓</span>}
      {children}
    </button>
  )
}
