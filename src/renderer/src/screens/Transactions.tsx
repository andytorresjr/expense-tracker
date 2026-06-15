import { useCallback, useEffect, useState } from 'react'
import type { Category, Txn, TxnPage } from '@shared/types'
import { api, fmtMoney } from '../api'
import { useGlobalFilter } from '../App'
import RuleModal, { type RuleDraft } from '../components/RuleModal'

const PAGE_SIZE = 50

export default function Transactions(): React.JSX.Element {
  const { expenseType } = useGlobalFilter()
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [data, setData] = useState<TxnPage>({ rows: [], total: 0 })
  const [categories, setCategories] = useState<Category[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((): void => {
    api.transactions
      .list({ expenseType, search: search || undefined, page, pageSize: PAGE_SIZE })
      .then((d) => {
        setData(d)
        setSelected(new Set())
      })
      .catch((e) => setError(e.message))
  }, [expenseType, search, page])

  useEffect(() => {
    api.categories.list().then(setCategories).catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    setPage(0)
  }, [expenseType, search])

  useEffect(load, [load])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
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
      api.transactions.update(txn.id, { expense_type: txn.expense_type === 'business' ? 'personal' : 'business' }).then(() => {})
    )

  const setCategory = (txn: Txn, value: string): Promise<void> =>
    run(() => api.transactions.update(txn.id, { category_id: value ? Number(value) : null }).then(() => {}))

  const bulkType = (type: 'business' | 'personal'): Promise<void> =>
    run(() => api.transactions.bulkUpdate([...selected], { expense_type: type }).then(() => {}))

  const bulkCategory = (value: string): Promise<void> =>
    run(() => api.transactions.bulkUpdate([...selected], { category_id: value ? Number(value) : null }).then(() => {}))

  const openRuleFor = (txn: Txn): void => {
    setRuleDraft({
      pattern: txn.description,
      match_type: 'contains',
      expense_type: txn.expense_type,
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

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          className="input w-72"
          placeholder="Search description…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="text-sm text-slate-500">
          {data.total} transaction{data.total === 1 ? '' : 's'}
          {expenseType !== 'all' ? ` (${expenseType})` : ''}
        </span>
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">{error}</div>}

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
              <th className="px-4 py-2.5 text-left font-medium text-slate-600">Date</th>
              <th className="px-4 py-2.5 text-left font-medium text-slate-600">Description</th>
              <th className="px-4 py-2.5 text-right font-medium text-slate-600">Amount</th>
              <th className="px-4 py-2.5 text-left font-medium text-slate-600">Type</th>
              <th className="px-4 py-2.5 text-left font-medium text-slate-600">Category</th>
              <th className="px-4 py-2.5 text-left font-medium text-slate-600">Card</th>
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
                <td className="px-4 py-2 max-w-96 truncate" title={txn.description}>{txn.description}</td>
                <td className={`px-4 py-2 text-right whitespace-nowrap ${txn.amount < 0 ? 'text-green-600' : ''}`}>
                  {fmtMoney(txn.amount)}
                </td>
                <td className="px-4 py-2">
                  <button
                    onClick={() => toggleType(txn)}
                    disabled={busy}
                    title="Click to switch business/personal"
                    className={`px-2 py-0.5 rounded-full border text-xs font-medium capitalize hover:opacity-75 ${
                      txn.expense_type === 'business'
                        ? 'bg-blue-100 text-blue-700 border-blue-200'
                        : 'bg-violet-100 text-violet-700 border-violet-200'
                    }`}
                  >
                    {txn.expense_type}
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
                <td colSpan={8} className="px-4 py-10 text-center text-slate-400">
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
    </div>
  )
}
