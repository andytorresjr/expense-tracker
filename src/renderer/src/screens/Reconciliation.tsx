import { useCallback, useEffect, useState } from 'react'
import { api, fmtMoney } from '../api'
import type { ReconCandidate, ReconLedger, ReconLedgerItem, ReconMatchResult, ReconReviewItem, ReconUnmatchedCharge } from '@shared/types'

const fmtDate = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function ConfidenceBadge({ value }: { value: number }): React.JSX.Element {
  const pct = Math.round(value * 100)
  const tone = pct >= 85 ? 'bg-green-100 text-green-700' : pct >= 65 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{pct}% match</span>
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-slate-200 px-4 py-3">
      <div className={`text-xl font-semibold ${tone ?? 'text-slate-800'}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </div>
  )
}

function LedgerRow({ item }: { item: ReconLedgerItem }): React.JSX.Element {
  const badge =
    item.status === 'matched'
      ? { text: item.linkStatus === 'confirmed' ? '✓ confirmed' : '✓ auto', tone: 'bg-green-100 text-green-700' }
      : item.status === 'review'
        ? { text: `⚠ ${item.reviewCount} to review`, tone: 'bg-amber-100 text-amber-700' }
        : { text: 'not on statement', tone: 'bg-slate-100 text-slate-500' }
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-100 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-slate-800">PO #{item.poNumber}</span>
          <span className="text-slate-400">·</span>
          <span className="text-slate-600 truncate">{item.vendor}</span>
        </div>
        <div className="text-xs text-slate-500 mt-0.5">
          {fmtDate(item.poDate)}
          {item.status === 'matched' && item.matchedTxnDate
            ? ` · charge ${fmtDate(item.matchedTxnDate)}`
            : item.requesterName
              ? ` · ${item.requesterName}`
              : ''}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="font-medium text-slate-800">{fmtMoney(item.total)}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.tone}`}>{badge.text}</span>
      </div>
    </div>
  )
}

function CandidateRow({
  candidate,
  onConfirm,
  onReject,
  busy
}: {
  candidate: ReconCandidate
  onConfirm: (linkId: number) => void
  onReject: (linkId: number) => void
  busy: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-slate-800">PO #{candidate.poNumber}</span>
          <span className="text-slate-400">·</span>
          <span className="text-slate-600">{candidate.vendor}</span>
          <span className="font-medium text-slate-800">{fmtMoney(candidate.total)}</span>
          <ConfidenceBadge value={candidate.confidence} />
        </div>
        <div className="mt-1 text-xs text-slate-500">
          {fmtDate(candidate.poDate)}
          {candidate.requesterName ? ` · ${candidate.requesterName}` : ''}
        </div>
        {candidate.lines.length > 0 && (
          <div className="mt-1 text-xs text-slate-500 truncate">{candidate.lines.map((l) => l.description).join(', ')}</div>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-1.5">
        <button className="btn-primary !py-1" disabled={busy} onClick={() => onConfirm(candidate.linkId)}>
          Confirm
        </button>
        <button className="btn-secondary !py-1" disabled={busy} onClick={() => onReject(candidate.linkId)}>
          Not a match
        </button>
      </div>
    </div>
  )
}

export default function Reconciliation(): React.JSX.Element {
  const [ledger, setLedger] = useState<ReconLedger | null>(null)
  const [queue, setQueue] = useState<ReconReviewItem[]>([])
  const [unmatched, setUnmatched] = useState<ReconUnmatchedCharge[]>([])
  const [summary, setSummary] = useState<ReconMatchResult | null>(null)
  const [hasToken, setHasToken] = useState(true)
  const [baseUrl, setBaseUrl] = useState('')
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const [l, q, u] = await Promise.all([api.recon.ledger(), api.recon.queue(), api.recon.unmatchedCharges()])
    setLedger(l)
    setQueue(q)
    setUnmatched(u)
  }, [])

  useEffect(() => {
    api.recon
      .getConfig()
      .then((c) => {
        setHasToken(c.hasToken)
        setBaseUrl(c.baseUrl)
        setLastSyncAt(c.lastSyncAt)
      })
      .catch(() => {})
    refresh().catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [refresh])

  const run = async (tag: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(tag)
    setError(null)
    setNotice(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const syncAndMatch = (): Promise<void> =>
    run('sync', async () => {
      const synced = await api.recon.sync()
      const matched = await api.recon.match()
      setSummary(matched)
      setLastSyncAt(synced.syncedAt)
      setNotice(`Synced ${synced.fetched} purchase orders and re-matched.`)
      await refresh()
    })

  const rematch = (): Promise<void> =>
    run('match', async () => {
      const matched = await api.recon.match()
      setSummary(matched)
      setNotice(`Matched: ${matched.autoLinked} auto-linked, ${matched.queued} need review.`)
      await refresh()
    })

  const confirm = (linkId: number): Promise<void> => run('row', async () => { await api.recon.confirm(linkId); await refresh() })
  const reject = (linkId: number): Promise<void> => run('row', async () => { await api.recon.reject(linkId); await refresh() })

  if (!baseUrl || !hasToken) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="card-panel p-6 space-y-3">
          <h2 className="font-semibold text-slate-800">Connect the PO system first</h2>
          <p className="text-sm text-slate-500">
            To reconcile statement charges against purchase orders, set the PO system URL and API token in{' '}
            <span className="font-medium text-slate-700">Settings → Purchase-order matching</span>, then run a sync.
          </p>
        </div>
      </div>
    )
  }

  const s = ledger?.summary
  return (
    <div className="max-w-6xl mx-auto space-y-4">
      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">{error}</div>}
      {notice && <div className="rounded-lg bg-green-50 border border-green-200 text-green-700 px-4 py-3 text-sm">{notice}</div>}

      <section className="card-panel p-6 space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-semibold text-slate-800">PO reconciliation</h2>
            <p className="text-sm text-slate-500 mt-1">
              {lastSyncAt ? `Last synced ${fmtDate(lastSyncAt)}.` : 'Not synced yet.'} Matches every purchase order to its
              statement charge by vendor, amount, and date.
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" disabled={!!busy} onClick={syncAndMatch}>
              {busy === 'sync' ? 'Syncing…' : 'Sync & match'}
            </button>
            <button className="btn-secondary" disabled={!!busy} onClick={rematch}>
              {busy === 'match' ? 'Matching…' : 'Re-match'}
            </button>
          </div>
        </div>
        {s && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="POs matched" value={`${s.matchedPos} / ${s.totalPos}`} tone="text-green-700" />
            <Stat label="Reconciled" value={fmtMoney(s.amountReconciled)} />
            <Stat label="Need review" value={String(s.reviewPos)} tone={s.reviewPos ? 'text-amber-700' : undefined} />
            <Stat label="Not on statement" value={String(s.unmatchedPos)} />
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="card-panel p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-800">Purchase orders</h2>
            <span className="text-sm text-slate-500">{ledger?.items.length ?? 0} total</span>
          </div>
          {!ledger || ledger.items.length === 0 ? (
            <p className="text-sm text-slate-500">No purchase orders yet — run a sync to pull them in.</p>
          ) : (
            <div className="max-h-[28rem] overflow-auto pr-1">
              {ledger.items.map((item) => (
                <LedgerRow key={item.poId} item={item} />
              ))}
            </div>
          )}
        </section>

        <section className="card-panel p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-800">Review queue</h2>
            <span className="text-sm text-slate-500">{queue.length} to review</span>
          </div>
          {queue.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing to review — every matched charge is resolved. 🎉</p>
          ) : (
            <div className="max-h-[28rem] overflow-auto pr-1 space-y-3">
              {queue.map((item) => (
                <div key={item.txnId} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-800 truncate">{item.description}</div>
                      <div className="text-xs text-slate-500">{fmtDate(item.txnDate)} · {item.cardName}</div>
                    </div>
                    <span className="font-semibold text-slate-800">{fmtMoney(item.amount)}</span>
                  </div>
                  <div className="space-y-2">
                    {item.candidates.map((c) => (
                      <CandidateRow key={c.linkId} candidate={c} onConfirm={confirm} onReject={reject} busy={busy === 'row'} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="card-panel p-6 space-y-3">
        <h2 className="font-semibold text-slate-800">Charges with no purchase order</h2>
        <p className="text-sm text-slate-500">
          Statement charges from tracked vendors (set in Settings) that don&apos;t match any PO — spend that may have
          bypassed the PO process.
        </p>
        {unmatched.length === 0 ? (
          <p className="text-sm text-slate-500">None — every charge from a tracked vendor is accounted for.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-200">
                <th className="py-2 font-medium">Date</th>
                <th className="py-2 font-medium">Description</th>
                <th className="py-2 font-medium">Card</th>
                <th className="py-2 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {unmatched.map((c) => (
                <tr key={c.txnId} className="border-b border-slate-100">
                  <td className="py-2 text-slate-600">{fmtDate(c.txnDate)}</td>
                  <td className="py-2 text-slate-800">{c.description}</td>
                  <td className="py-2 text-slate-600">{c.cardName}</td>
                  <td className="py-2 text-right font-medium text-slate-800">{fmtMoney(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
