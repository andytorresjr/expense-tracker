import { useCallback, useEffect, useState } from 'react'
import type { ImportBatch } from '@shared/types'
import { api } from '../api'

function formatImportedAt(value: string): string {
  const date = new Date(`${value.replace(' ', 'T')}Z`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
}

export default function ImportHistory(): React.JSX.Element {
  const [batches, setBatches] = useState<ImportBatch[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setBatches(await api.import.batches())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const remove = async (batch: ImportBatch): Promise<void> => {
    const noun = batch.transaction_count === 1 ? 'transaction' : 'transactions'
    if (
      !window.confirm(
        `Delete the import "${batch.filename}" and its ${batch.transaction_count} remaining ${noun}? This cannot be undone.`
      )
    ) {
      return
    }

    setBusyId(batch.id)
    setError(null)
    setNotice(null)
    try {
      const result = await api.import.deleteBatch(batch.id)
      setNotice(
        `Deleted "${batch.filename}" and ${result.deleted} transaction${result.deleted === 1 ? '' : 's'}.`
      )
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="card-panel p-6 space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800">History</h2>
        <p className="mt-1 text-sm text-slate-500">
          Every completed import is recorded here. Delete one entry to remove only the transactions added by that statement.
        </p>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{notice}</div>}

      {loading ? (
        <div className="py-8 text-center text-sm text-slate-400">Loading import history…</div>
      ) : batches.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">
          No statements have been imported yet.
        </div>
      ) : (
        <div className="overflow-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Imported</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Statement</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Card</th>
                <th className="px-4 py-2 text-right font-medium text-slate-600">Transactions</th>
                <th className="px-4 py-2 text-right font-medium text-slate-600">Skipped</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.id} className="border-t border-slate-100">
                  <td className="px-4 py-2 whitespace-nowrap text-slate-500">{formatImportedAt(batch.imported_at)}</td>
                  <td className="px-4 py-2 max-w-64 truncate font-medium text-slate-800" title={batch.filename}>
                    {batch.filename}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{batch.card_name}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <span className={batch.transaction_count < batch.inserted_count ? 'text-amber-600' : 'text-slate-700'}>
                      {batch.transaction_count} remaining
                    </span>
                    {batch.transaction_count !== batch.inserted_count && (
                      <span className="ml-1 text-xs text-slate-400">of {batch.inserted_count}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-500">{batch.skipped_count}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      className="text-red-600 hover:underline whitespace-nowrap disabled:opacity-50"
                      onClick={() => void remove(batch)}
                      disabled={busyId !== null}
                    >
                      {busyId === batch.id ? 'Deleting…' : 'Delete statement'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
