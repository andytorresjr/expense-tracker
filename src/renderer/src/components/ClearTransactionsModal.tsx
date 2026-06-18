import { useState } from 'react'
import type { TransactionClearRequest } from '@shared/types'

function localIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export default function ClearTransactionsModal({
  busy,
  onCancel,
  onClear
}: {
  busy: boolean
  onCancel: () => void
  onClear: (request: TransactionClearRequest) => Promise<void>
}): React.JSX.Element {
  const today = new Date()
  const [mode, setMode] = useState<'range' | 'all'>('range')
  const [dateFrom, setDateFrom] = useState(localIsoDate(new Date(today.getFullYear(), today.getMonth(), 1)))
  const [dateTo, setDateTo] = useState(localIsoDate(today))

  const submit = (): void => {
    if (mode === 'range' && (!dateFrom || !dateTo || dateFrom > dateTo)) return
    const description =
      mode === 'all'
        ? 'all transactions'
        : `transactions dated ${dateFrom} through ${dateTo}`
    if (!window.confirm(`Permanently delete ${description}? Import history will be kept. This cannot be undone.`)) return
    void onClear(mode === 'all' ? { mode: 'all' } : { mode: 'range', dateFrom, dateTo })
  }

  const valid = mode === 'all' || (!!dateFrom && !!dateTo && dateFrom <= dateTo)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={busy ? undefined : onCancel}>
      <div className="card-panel w-full max-w-md p-6 space-y-4" onClick={(event) => event.stopPropagation()}>
        <div>
          <h2 className="font-semibold text-slate-800">Clear transactions</h2>
          <p className="mt-1 text-sm text-slate-500">
            This affects every card and every transaction type. Import history remains available.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1">
          <button
            className={`rounded-md px-3 py-2 text-sm font-medium ${mode === 'range' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}
            onClick={() => setMode('range')}
            disabled={busy}
          >
            Date range
          </button>
          <button
            className={`rounded-md px-3 py-2 text-sm font-medium ${mode === 'all' ? 'bg-red-600 text-white shadow-sm' : 'text-slate-500'}`}
            onClick={() => setMode('all')}
            disabled={busy}
          >
            Clear all
          </button>
        </div>

        {mode === 'range' ? (
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm text-slate-600">
              From
              <input
                type="date"
                className="input mt-1 block w-full"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={(event) => setDateFrom(event.target.value)}
                disabled={busy}
              />
            </label>
            <label className="text-sm text-slate-600">
              Through
              <input
                type="date"
                className="input mt-1 block w-full"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(event) => setDateTo(event.target.value)}
                disabled={busy}
              />
            </label>
          </div>
        ) : (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Every transaction will be removed. Cards, rules, categories, budgets, and import history will stay.
          </div>
        )}

        {mode === 'range' && !valid && (
          <p className="text-xs text-amber-600">Choose a valid date range with the start on or before the end.</p>
        )}

        <div className="flex justify-end gap-3 pt-1">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn bg-red-600 text-white hover:bg-red-700"
            onClick={submit}
            disabled={busy || !valid}
          >
            {busy ? 'Deleting…' : mode === 'all' ? 'Clear all transactions' : 'Clear date range'}
          </button>
        </div>
      </div>
    </div>
  )
}
