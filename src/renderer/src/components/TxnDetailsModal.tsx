import { useState } from 'react'
import type { Txn } from '@shared/types'
import { fmtMoney } from '../api'

/**
 * Edit the free-text fields on a single transaction: the client / attendees
 * present, the business purpose, and a general comment. All optional; the client
 * is what the warning badge and "missing client" filter key off of.
 */
export default function TxnDetailsModal({
  txn,
  busy,
  needsClient,
  onCancel,
  onSave
}: {
  txn: Txn
  busy: boolean
  /** true when this is a business charge in a client-required category with no client yet. */
  needsClient: boolean
  onCancel: () => void
  onSave: (fields: { client: string | null; business_purpose: string | null; comment: string | null }) => void
}): React.JSX.Element {
  const [client, setClient] = useState(txn.client ?? '')
  const [purpose, setPurpose] = useState(txn.business_purpose ?? '')
  const [comment, setComment] = useState(txn.comment ?? '')

  const submit = (): void =>
    onSave({
      client: client.trim() || null,
      business_purpose: purpose.trim() || null,
      comment: comment.trim() || null
    })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="txn-details-title"
    >
      <div className="card-panel w-full max-w-lg p-6 space-y-4">
        <h2 id="txn-details-title" className="font-semibold text-slate-800">
          Expense details
        </h2>

        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="font-medium text-slate-800 break-words" title={txn.description}>
              {txn.description}
            </div>
            <div className={`font-semibold whitespace-nowrap ${txn.amount < 0 ? 'text-green-600' : 'text-slate-800'}`}>
              {fmtMoney(txn.amount)}
            </div>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {txn.txn_date} · {txn.category_name ?? 'Uncategorized'} · {txn.expense_type ?? 'unassigned'}
          </div>
        </div>

        {needsClient && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 text-sm">
            ⚠ The IRS requires a client / attendee name to claim a business meal or entertainment expense.
          </div>
        )}

        <label className="block text-sm text-slate-600">
          Client / attendees
          <input
            className="input block w-full mt-1"
            autoFocus
            placeholder="e.g. Acme Corp — J. Smith, M. Lee"
            value={client}
            onChange={(e) => setClient(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            disabled={busy}
          />
        </label>

        <label className="block text-sm text-slate-600">
          Business purpose <span className="text-slate-400">(optional)</span>
          <textarea
            className="input block w-full mt-1"
            rows={2}
            placeholder="e.g. Q3 contract review"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="block text-sm text-slate-600">
          Comment <span className="text-slate-400">(optional)</span>
          <textarea
            className="input block w-full mt-1"
            rows={2}
            placeholder="Any note about this transaction"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={busy}
          />
        </label>

        <div className="flex justify-end gap-3 pt-1">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
