import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Card,
  CardholderSpend,
  Category,
  ExpenseType,
  ExpenseTypeFilter,
  ExportFormat,
  TransactionClearRequest,
  Txn,
  TxnFilters,
  TxnPage
} from '@shared/types'
import { api, fmtMoney } from '../api'
import { useGlobalFilter } from '../App'
import RuleModal, { type RuleDraft } from '../components/RuleModal'
import ClearTransactionsModal from '../components/ClearTransactionsModal'
import ExportModal from '../components/ExportModal'
import PrintableReport, { type ReportMeta } from '../components/PrintableReport'
import TxnDetailsModal from '../components/TxnDetailsModal'
import QuickCategorize from './QuickCategorize'

/** A business charge in a client-required category that still has no client name —
 *  the IRS-substantiation gap the warning badge and filter highlight. */
const needsClient = (txn: Txn): boolean =>
  txn.expense_type === 'business' && txn.category_requires_client === 1 && !txn.client?.trim()

const PAGE_SIZE = 50

type CategoryFilter = '' | 'uncategorized' | `${number}`
type CardFilter = '' | `${number}`
type SortBy = NonNullable<TxnFilters['sortBy']>
type SortDir = NonNullable<TxnFilters['sortDir']>

const nextExpenseType = (type: ExpenseType | null): ExpenseType => (type === 'business' ? 'personal' : 'business')

const ruleTypeFor = (type: ExpenseType | null): RuleDraft['expense_type'] => type
const SORT_BUTTON_CLASS = 'inline-flex items-center gap-1 whitespace-nowrap hover:text-blue-700'
const SORT_MARK_CLASS = 'inline-block w-3 text-center text-xs text-slate-400'

function typePillClass(type: ExpenseType | null): string {
  if (type === 'business') return 'bg-blue-100 text-blue-700 border-blue-200'
  if (type === 'personal') return 'bg-violet-100 text-violet-700 border-violet-200'
  return 'bg-slate-100 text-slate-700 border-slate-200'
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

export default function Transactions(): React.JSX.Element {
  const { expenseType } = useGlobalFilter()
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('')
  const [cardFilter, setCardFilter] = useState<CardFilter>('')
  const [sortBy, setSortBy] = useState<SortBy>('txn_date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [data, setData] = useState<TxnPage>({ rows: [], total: 0 })
  const [cardholderSpend, setCardholderSpend] = useState<CardholderSpend[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [printState, setPrintState] = useState<{ rows: Txn[]; meta: ReportMeta } | null>(null)
  const [uncatCount, setUncatCount] = useState(0)
  const [allCount, setAllCount] = useState(0)
  const [missingClientCount, setMissingClientCount] = useState(0)
  const [missingClientOnly, setMissingClientOnly] = useState(false)
  const [detailsTxn, setDetailsTxn] = useState<Txn | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const quickButtonRef = useRef<HTMLButtonElement>(null)

  const load = useCallback((): void => {
    const categoryId =
      categoryFilter === '' ? undefined : categoryFilter === 'uncategorized' ? 'uncategorized' : Number(categoryFilter)
    const cardId = cardFilter === '' ? undefined : Number(cardFilter)
    const scopeFilters: TxnFilters = {
      expenseType,
      cardId,
      categoryId,
      search: search || undefined,
      missingClient: missingClientOnly || undefined
    }
    api.transactions
      .list({
        ...scopeFilters,
        sortBy,
        sortDir,
        page,
        pageSize: PAGE_SIZE
      })
      .then((d) => {
        setData(d)
        setSelected(new Set())
      })
      .catch((e) => setError(e.message))
    // Who's spending the most — totals per cardholder over the whole filtered
    // set (not just the visible page). Empty when the statement carries no
    // cardholder column, which also hides the table's Cardholder column.
    api.transactions
      .cardholderSpend(scopeFilters)
      .then(setCardholderSpend)
      .catch(() => setCardholderSpend([]))
    // Quick-categorize works over the whole dataset, independent of the visible filters.
    Promise.all([
      api.transactions.list({ expenseType: 'all', categoryId: 'uncategorized', page: 0, pageSize: 1 }),
      api.transactions.list({ expenseType: 'all', page: 0, pageSize: 1 })
    ])
      .then(([uncategorized, all]) => {
        setUncatCount(uncategorized.total)
        setAllCount(all.total)
      })
      .catch(() => {})
    // Business meals/entertainment missing a client name — the IRS-substantiation gap.
    api.transactions.missingClientCount().then(setMissingClientCount).catch(() => setMissingClientCount(0))
  }, [expenseType, search, categoryFilter, cardFilter, sortBy, sortDir, page, missingClientOnly])

  useEffect(() => {
    api.categories.list().then(setCategories).catch((e) => setError(e.message))
    api.cards.list().then(setCards).catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    setPage(0)
  }, [expenseType, search, categoryFilter, cardFilter, sortBy, sortDir, missingClientOnly])

  useEffect(load, [load])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggleType = (txn: Txn): Promise<void> =>
    run(() =>
      api.transactions.update(txn.id, { expense_type: nextExpenseType(txn.expense_type) }).then(() => {})
    )

  const setCategory = (txn: Txn, value: string): Promise<void> =>
    run(() => api.transactions.update(txn.id, { category_id: value ? Number(value) : null }).then(() => {}))

  const bulkType = (type: ExpenseType): Promise<void> =>
    run(() => api.transactions.bulkUpdate([...selected], { expense_type: type }).then(() => {}))

  const bulkCategory = (value: string): Promise<void> =>
    run(() => api.transactions.bulkUpdate([...selected], { category_id: value ? Number(value) : null }).then(() => {}))

  const saveDetails = (
    txn: Txn,
    fields: { client: string | null; business_purpose: string | null; comment: string | null }
  ): Promise<void> =>
    run(async () => {
      await api.transactions.update(txn.id, fields)
      setDetailsTxn(null)
    })

  const clearTransactions = (request: TransactionClearRequest): Promise<void> =>
    run(async () => {
      const result = await api.transactions.clear(request)
      setPage(0)
      setClearOpen(false)
      setNotice(`Deleted ${result.deleted} transaction${result.deleted === 1 ? '' : 's'}. Import history was kept.`)
    })

  const categoryLabel =
    categoryFilter === ''
      ? 'All categories'
      : categoryFilter === 'uncategorized'
        ? 'Uncategorized'
        : categories.find((c) => String(c.id) === categoryFilter)?.name ?? 'Category'
  const cardLabel = cardFilter === '' ? 'All cards' : cards.find((c) => String(c.id) === cardFilter)?.name ?? 'Card'

  // Exports use the same filters as the visible table (category, card,
  // search), but the expense-type scope is chosen in the modal rather than the
  // global header tab — that is the "business / personal / all" export option.
  const exportFilters = (scope: ExpenseTypeFilter): TxnFilters => ({
    expenseType: scope,
    cardId: cardFilter === '' ? undefined : Number(cardFilter),
    categoryId:
      categoryFilter === '' ? undefined : categoryFilter === 'uncategorized' ? 'uncategorized' : Number(categoryFilter),
    search: search || undefined,
    missingClient: missingClientOnly || undefined,
    sortBy,
    sortDir
  })

  const doExport = (scope: ExpenseTypeFilter, format: ExportFormat): Promise<void> =>
    run(async () => {
      const result = await api.transactions.export(exportFilters(scope), format)
      setExportOpen(false)
      if (result) {
        setNotice(`Exported ${result.count} transaction${result.count === 1 ? '' : 's'} to ${result.path}`)
      }
    })

  const doPdf = (scope: ExpenseTypeFilter): Promise<void> =>
    run(async () => {
      const filters = exportFilters(scope)
      const rows = await api.transactions.exportRows(filters)
      if (rows.length === 0) throw new Error('No transactions match the current filters — nothing to export.')
      setExportOpen(false)
      setPrintState({
        rows,
        meta: {
          scope,
          categoryLabel,
          cardLabel,
          search,
          generatedAt: new Date().toLocaleString()
        }
      })
      await nextFrame()
      await nextFrame()
      try {
        const result = await api.transactions.exportPdf(filters)
        if (result) {
          setNotice(`Saved PDF report with ${result.count} transaction${result.count === 1 ? '' : 's'} to ${result.path}`)
        }
      } finally {
        setPrintState(null)
      }
    })

  const openRuleFor = (txn: Txn): void => {
    setRuleDraft({
      pattern: txn.description,
      match_type: 'contains',
      expense_type: ruleTypeFor(txn.expense_type),
      category_id: txn.category_id,
      priority: 0
    })
  }

  const saveRule = (): Promise<void> =>
    run(async () => {
      if (!ruleDraft) return
      await api.rules.create(ruleDraft)
      await api.rules.rerun()
      setRuleDraft(null)
    })

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE))
  const allChecked = data.rows.length > 0 && data.rows.every((r) => selected.has(r.id))
  // The Cardholder column appears only once a statement that carries a cardholder
  // column has been imported (the spend query returns rows then). The "who spends
  // the most" breakdown itself lives on the Dashboard, alongside the other KPIs.
  const hasCardholder = cardholderSpend.length > 0
  // Show the Client column once any client-required gap exists or any visible row
  // already carries a client, so meal-free statements stay uncluttered.
  const showClient = missingClientCount > 0 || data.rows.some((r) => r.client || needsClient(r))
  const columnCount = 8 + (hasCardholder ? 1 : 0) + (showClient ? 1 : 0)
  const toggleSort = (key: SortBy): void => {
    if (sortBy === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(key)
      setSortDir(key === 'txn_date' ? 'desc' : 'asc')
    }
  }
  const sortLabel = (key: SortBy): string => (sortBy === key ? (sortDir === 'asc' ? '▲' : '▼') : '↕')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="input w-72"
          placeholder="Search description…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="input w-56"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value as CategoryFilter)}
        >
          <option value="">All categories</option>
          <option value="uncategorized">Uncategorized</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select
          className="input w-56"
          value={cardFilter}
          onChange={(e) => setCardFilter(e.target.value as CardFilter)}
        >
          <option value="">All cards</option>
          {cards.map((card) => (
            <option key={card.id} value={card.id}>{card.name}</option>
          ))}
        </select>
        <span className="text-sm text-slate-500">
          {data.total} transaction{data.total === 1 ? '' : 's'}
          {expenseType !== 'all' ? ` (${expenseType})` : ''}
        </span>
        <button
          className="btn-secondary !py-1.5 ml-auto"
          onClick={() => setExportOpen(true)}
          disabled={allCount === 0 || busy}
          title="Export the current filters as CSV, Excel, or PDF"
        >
          ⤓ Export
        </button>
        <button
          className="btn-secondary !py-1.5 text-red-600 border-red-200 hover:bg-red-50"
          onClick={() => setClearOpen(true)}
          disabled={allCount === 0 || busy}
        >
          Clear transactions
        </button>
        <button
          ref={quickButtonRef}
          className="btn-primary !py-1.5"
          onClick={() => setQuickOpen(true)}
          disabled={allCount === 0}
          title="Step through transactions and categorize them fast with the keyboard"
        >
          ⚡ Quick categorize
          {uncatCount > 0 && (
            <span className="ml-1 rounded-full bg-white/25 px-1.5 text-xs font-semibold">{uncatCount}</span>
          )}
        </button>
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">{error}</div>}
      {notice && <div className="rounded-lg bg-green-50 border border-green-200 text-green-700 px-4 py-3 text-sm">{notice}</div>}

      {(missingClientCount > 0 || missingClientOnly) && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-4 py-2.5 text-sm">
          <span className="flex-1">
            ⚠ <strong>{missingClientCount}</strong> business meal/entertainment transaction
            {missingClientCount === 1 ? '' : 's'} {missingClientCount === 1 ? 'is' : 'are'} missing a client name the IRS
            requires.
          </span>
          <button
            className={`btn-secondary !py-1 ${missingClientOnly ? 'border-amber-400 text-amber-800 bg-amber-100' : ''}`}
            onClick={() => setMissingClientOnly((v) => !v)}
          >
            {missingClientOnly ? 'Show all' : 'Show only these'}
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 border border-slate-200 px-4 py-2 text-sm">
          <span className="text-slate-600">{selected.size} selected:</span>
          <button className="btn-secondary !py-1" disabled={busy} onClick={() => bulkType('business')}>Mark business</button>
          <button className="btn-secondary !py-1" disabled={busy} onClick={() => bulkType('personal')}>Mark personal</button>
          <select
            className="input !py-1"
            value=""
            disabled={busy}
            onChange={(e) => e.target.value && bulkCategory(e.target.value)}
          >
            <option value="">Set category…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      )}

      <div className="card-panel overflow-auto">
        <table className="text-sm w-full">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-3 py-2.5 w-8">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(data.rows.map((r) => r.id)) : new Set())
                  }
                />
              </th>
              <th className="px-4 py-2.5 text-left font-medium text-slate-600">
                <button className={SORT_BUTTON_CLASS} onClick={() => toggleSort('txn_date')}>
                  Date <span className={SORT_MARK_CLASS}>{sortLabel('txn_date')}</span>
                </button>
              </th>
              <th className="px-4 py-2.5 text-left font-medium text-slate-600">
                <button className={SORT_BUTTON_CLASS} onClick={() => toggleSort('description')}>
                  Description <span className={SORT_MARK_CLASS}>{sortLabel('description')}</span>
                </button>
              </th>
              <th className="px-4 py-2.5 text-right font-medium text-slate-600">
                <button className={SORT_BUTTON_CLASS} onClick={() => toggleSort('amount')}>
                  Amount <span className={SORT_MARK_CLASS}>{sortLabel('amount')}</span>
                </button>
              </th>
              <th className="px-4 py-2.5 text-left font-medium text-slate-600">
                <button className={SORT_BUTTON_CLASS} onClick={() => toggleSort('expense_type')}>
                  Type <span className={SORT_MARK_CLASS}>{sortLabel('expense_type')}</span>
                </button>
              </th>
              <th className="px-4 py-2.5 text-left font-medium text-slate-600">
                <button className={SORT_BUTTON_CLASS} onClick={() => toggleSort('category_name')}>
                  Category <span className={SORT_MARK_CLASS}>{sortLabel('category_name')}</span>
                </button>
              </th>
              <th className="px-4 py-2.5 text-left font-medium text-slate-600">Card</th>
              {hasCardholder && (
                <th className="px-4 py-2.5 text-left font-medium text-slate-600">
                  <button className={SORT_BUTTON_CLASS} onClick={() => toggleSort('cardholder')}>
                    Cardholder <span className={SORT_MARK_CLASS}>{sortLabel('cardholder')}</span>
                  </button>
                </th>
              )}
              {showClient && (
                <th className="px-4 py-2.5 text-left font-medium text-slate-600" title="Client / attendees — required for business meals & entertainment">
                  Client
                </th>
              )}
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((txn) => (
              <tr key={txn.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(txn.id)}
                    onChange={(e) => {
                      const next = new Set(selected)
                      if (e.target.checked) next.add(txn.id)
                      else next.delete(txn.id)
                      setSelected(next)
                    }}
                  />
                </td>
                <td className="px-4 py-2 whitespace-nowrap">{txn.txn_date}</td>
                <td className="px-4 py-2 max-w-96">
                  <button
                    onClick={() => setDetailsTxn(txn)}
                    className="flex items-center gap-1.5 max-w-full text-left hover:text-blue-600"
                    title={txn.comment ? `${txn.description}\n💬 ${txn.comment}` : `${txn.description}\n(click to add a comment or details)`}
                  >
                    <span className="truncate">{txn.description}</span>
                    {txn.comment && <span className="shrink-0 text-slate-400" title={txn.comment}>💬</span>}
                  </button>
                </td>
                <td className={`px-4 py-2 text-right whitespace-nowrap ${txn.amount < 0 ? 'text-green-600' : ''}`}>
                  {fmtMoney(txn.amount)}
                </td>
                <td className="px-4 py-2">
                  <button
                    onClick={() => toggleType(txn)}
                    disabled={busy}
                    title="Click to switch Business/Personal"
                    className={`px-2 py-0.5 rounded-full border text-xs font-medium capitalize hover:opacity-75 ${typePillClass(txn.expense_type)}`}
                  >
                    {txn.expense_type ?? 'All'}
                  </button>
                </td>
                <td className="px-4 py-2">
                  <select
                    className="input !py-1 !px-2 max-w-44"
                    value={txn.category_id ?? ''}
                    disabled={busy}
                    onChange={(e) => setCategory(txn, e.target.value)}
                  >
                    <option value="">Uncategorized</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2 text-slate-500">{txn.card_name}</td>
                {hasCardholder && (
                  <td className="px-4 py-2 text-slate-600 max-w-44 truncate" title={txn.cardholder ?? ''}>
                    {txn.cardholder ?? <span className="text-slate-300">—</span>}
                  </td>
                )}
                {showClient && (
                  <td className="px-4 py-2 max-w-44">
                    {txn.client ? (
                      <button
                        onClick={() => setDetailsTxn(txn)}
                        className="text-slate-600 truncate max-w-full hover:text-blue-600"
                        title={`${txn.client}${txn.business_purpose ? ` — ${txn.business_purpose}` : ''} (click to edit)`}
                      >
                        {txn.client}
                      </button>
                    ) : needsClient(txn) ? (
                      <button
                        onClick={() => setDetailsTxn(txn)}
                        className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100"
                        title="The IRS requires a client name for business meals & entertainment"
                      >
                        ⚠ Add client
                      </button>
                    ) : (
                      <button
                        onClick={() => setDetailsTxn(txn)}
                        className="text-xs text-slate-300 hover:text-blue-600"
                        title="Add client / business purpose"
                      >
                        + add
                      </button>
                    )}
                  </td>
                )}
                <td className="px-4 py-2 text-right">
                  <button
                    onClick={() => openRuleFor(txn)}
                    className="text-xs text-slate-400 hover:text-blue-600 whitespace-nowrap"
                    title="Create a rule from this merchant so future imports classify it automatically"
                  >
                    + rule
                  </button>
                </td>
              </tr>
            ))}
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="px-4 py-10 text-center text-slate-400">
                  No transactions yet — use Import Statement to bring in a card statement.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-end gap-3 text-sm">
          <button className="btn-secondary !py-1" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="text-slate-500">
            Page {page + 1} of {pages}
          </span>
          <button className="btn-secondary !py-1" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}

      {ruleDraft && (
        <RuleModal
          draft={ruleDraft}
          categories={categories}
          busy={busy}
          onChange={setRuleDraft}
          onCancel={() => setRuleDraft(null)}
          onSave={saveRule}
        />
      )}

      {quickOpen && (
        <QuickCategorize
          categories={categories}
          onClose={() => {
            setQuickOpen(false)
            load()
            requestAnimationFrame(() => quickButtonRef.current?.focus())
          }}
        />
      )}

      {clearOpen && (
        <ClearTransactionsModal
          busy={busy}
          onCancel={() => setClearOpen(false)}
          onClear={clearTransactions}
        />
      )}

      {exportOpen && (
        <ExportModal
          busy={busy}
          defaultScope={expenseType}
          categoryLabel={categoryLabel}
          cardLabel={cardLabel}
          search={search}
          onCancel={() => setExportOpen(false)}
          onExport={doExport}
          onPdf={doPdf}
        />
      )}

      {detailsTxn && (
        <TxnDetailsModal
          txn={detailsTxn}
          busy={busy}
          needsClient={needsClient(detailsTxn)}
          onCancel={() => setDetailsTxn(null)}
          onSave={(fields) => saveDetails(detailsTxn, fields)}
        />
      )}

      {printState && <PrintableReport rows={printState.rows} meta={printState.meta} />}
    </div>
  )
}
