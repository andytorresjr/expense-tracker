import { useCallback, useEffect, useState } from 'react'
import type { Txn, TxnPage } from '@shared/types'
import { api, fmtMoney } from '../api'
import { useGlobalFilter } from '../App'

const PAGE_SIZE = 50

export default function Transactions(): React.JSX.Element {
  const { expenseType } = useGlobalFilter()
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [data, setData] = useState<TxnPage>({ rows: [], total: 0 })
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((): void => {
    api.transactions
      .list({ expenseType, search: search || undefined, page, pageSize: PAGE_SIZE })
      .then(setData)
      .catch((e) => setError(e.message))
  }, [expenseType, search, page])

  useEffect(() => {
    setPage(0)
  }, [expenseType, search])

  useEffect(load, [load])

  const toggleType = async (txn: Txn): Promise<void> => {
    try {
      await api.transactions.update(txn.id, {
        expense_type: txn.expense_type === 'business' ? 'personal' : 'business'
      })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE))

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

      <div className="card-panel overflow-auto">
        <table className="text-sm w-full">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium text-slate-600">Date</th>
              <th className="px-4 py-2.5 text-left font-medium text-slate-600">Description</th>
              <th className="px-4 py-2.5 text-right font-medium text-slate-600">Amount</th>
              <th className="px-4 py-2.5 text-left font-medium text-slate-600">Type</th>
              <th className="px-4 py-2.5 text-left font-medium text-slate-600">Category</th>
              <th className="px-4 py-2.5 text-left font-medium text-slate-600">Card</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((txn) => (
              <tr key={txn.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2 whitespace-nowrap">{txn.txn_date}</td>
                <td className="px-4 py-2 max-w-96 truncate" title={txn.description}>{txn.description}</td>
                <td className={`px-4 py-2 text-right whitespace-nowrap ${txn.amount < 0 ? 'text-green-600' : ''}`}>
                  {fmtMoney(txn.amount)}
                </td>
                <td className="px-4 py-2">
                  <button
                    onClick={() => toggleType(txn)}
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
                <td className="px-4 py-2">{txn.category_name ?? <span className="text-slate-400">Uncategorized</span>}</td>
                <td className="px-4 py-2 text-slate-500">{txn.card_name}</td>
              </tr>
            ))}
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
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
    </div>
  )
}
