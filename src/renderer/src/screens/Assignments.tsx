import { useEffect, useState } from 'react'
import { api } from '../api'
import type {
  AssignmentCardholder,
  AssignmentPickResult,
  AssignmentReturnableCard
} from '@shared/types'

type Tone = 'ok' | 'err'
interface Msg {
  tone: Tone
  text: string
}

function Banner({ msg }: { msg: Msg | null }): React.JSX.Element | null {
  if (!msg) return null
  return <p className={`text-sm ${msg.tone === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</p>
}

/** Boss: pick a cardholder and export their charges as a packet to categorize. */
function SendSection({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const [cardholders, setCardholders] = useState<AssignmentCardholder[]>([])
  const [selected, setSelected] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)

  useEffect(() => {
    api.assignment
      .cardholders()
      .then((list) => {
        setCardholders(list)
        setSelected((cur) => cur || (list[0]?.cardholder ?? ''))
      })
      .catch((e) => setMsg({ tone: 'err', text: e.message }))
  }, [])

  const exportPacket = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setMsg(null)
    try {
      const result = await api.assignment.export(selected, from || undefined, to || undefined)
      if (result) {
        setMsg({ tone: 'ok', text: `Saved ${result.count} transactions to ${result.path}` })
        onChanged()
      }
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card-panel p-6 space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800">Send a cardholder their charges</h2>
        <p className="text-sm text-slate-500 mt-1">
          Export one cardholder&apos;s transactions as an Excel packet. They open it in their own copy of Expense
          Tracker, categorize with the hotkeys, and send it back — then you merge it below.
        </p>
      </div>

      {cardholders.length === 0 ? (
        <p className="text-sm text-slate-500">
          No cardholders found yet. Import a statement that carries a cardholder / card-member column first.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1">Cardholder</span>
              <select className="input !py-1.5 min-w-56" value={selected} onChange={(e) => setSelected(e.target.value)}>
                {cardholders.map((c) => (
                  <option key={c.cardholder} value={c.cardholder}>
                    {c.cardholder} ({c.count})
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1">From (optional)</span>
              <input type="date" className="input !py-1.5" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1">To (optional)</span>
              <input type="date" className="input !py-1.5" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <button className="btn-primary" disabled={busy || !selected} onClick={exportPacket}>
              {busy ? 'Exporting…' : 'Export packet…'}
            </button>
          </div>
          <p className="text-xs text-slate-400">
            Leave the dates blank to send every charge for this cardholder. The packet carries hidden reference tags so
            their categorizations land back on the exact same transactions.
          </p>
        </>
      )}

      <Banner msg={msg} />
    </section>
  )
}

/** Both roles: open a packet, then import (cardholder) or merge (boss). */
function OpenSection({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const [picked, setPicked] = useState<AssignmentPickResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)

  const pick = async (): Promise<void> => {
    setMsg(null)
    setBusy(true)
    try {
      const result = await api.assignment.pick()
      if (result) setPicked(result)
    } catch (e) {
      setPicked(null)
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const runImport = async (): Promise<void> => {
    if (!picked) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.assignment.import(picked.path)
      const added = r.categoriesAdded ? `, ${r.categoriesAdded} categories added` : ''
      setMsg({
        tone: 'ok',
        text: `Imported into “${r.cardName}”: ${r.inserted} new, ${r.updated} updated${added}. Categorize them in Quick Categorize, then send the packet back.`
      })
      setPicked(null)
      onChanged()
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const runMerge = async (): Promise<void> => {
    if (!picked) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.assignment.merge(picked.path)
      const parts = [`${r.updated} of ${r.total} transactions updated`]
      if (r.unmatched) parts.push(`${r.unmatched} couldn’t be matched`)
      if (r.unmatchedCategories.length) parts.push(`unknown categories: ${r.unmatchedCategories.join(', ')}`)
      setMsg({ tone: r.unmatched || r.unmatchedCategories.length ? 'err' : 'ok', text: parts.join(' · ') })
      setPicked(null)
      onChanged()
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const isReturned = picked?.meta.stage === 'returned'

  return (
    <section className="card-panel p-6 space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800">Open a packet</h2>
        <p className="text-sm text-slate-500 mt-1">
          Received an assignment file? Open it here. The cardholder <span className="font-medium">imports</span> charges
          to categorize; the owner <span className="font-medium">merges</span> the returned, categorized file back in.
        </p>
      </div>

      <button className="btn-secondary" disabled={busy} onClick={pick}>
        Choose packet file…
      </button>

      {picked && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
          <div className="text-sm text-slate-700 space-y-1">
            <div>
              <span className="text-slate-500">Cardholder:</span> {picked.meta.cardholder || '—'}
              {picked.meta.cardName ? ` · ${picked.meta.cardName}` : ''}
            </div>
            <div>
              <span className="text-slate-500">Contains:</span> {picked.rowCount} transactions
              {picked.meta.exportedAt
                ? ` · exported ${new Date(picked.meta.exportedAt).toLocaleString('en-US')}`
                : ''}
            </div>
            <div>
              <span className="text-slate-500">Type:</span>{' '}
              {isReturned ? 'Returned — categorized, ready to merge' : 'Assignment — to categorize'}
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            {isReturned ? (
              <>
                <button className="btn-primary" disabled={busy} onClick={runMerge}>
                  {busy ? 'Merging…' : 'Merge into my transactions'}
                </button>
                <button className="btn-secondary" disabled={busy} onClick={runImport}>
                  Import as new instead
                </button>
              </>
            ) : (
              <>
                <button className="btn-primary" disabled={busy} onClick={runImport}>
                  {busy ? 'Importing…' : 'Import these transactions'}
                </button>
                <button className="btn-secondary" disabled={busy} onClick={runMerge}>
                  Merge instead
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <Banner msg={msg} />
    </section>
  )
}

/** Cardholder: send categorized work back to the owner. */
function ReturnSection({ refreshKey }: { refreshKey: number }): React.JSX.Element {
  const [cards, setCards] = useState<AssignmentReturnableCard[]>([])
  const [selected, setSelected] = useState<number | ''>('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)

  useEffect(() => {
    api.assignment
      .returnableCards()
      .then((list) => {
        setCards(list)
        setSelected((cur) => (cur || list[0]?.cardId) ?? '')
      })
      .catch(() => {})
  }, [refreshKey])

  if (cards.length === 0) return <></>

  const exportReturn = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setMsg(null)
    try {
      const result = await api.assignment.exportReturn(Number(selected))
      if (result) setMsg({ tone: 'ok', text: `Saved ${result.count} transactions to ${result.path}. Send this file back to the owner.` })
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card-panel p-6 space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800">Send categorized work back</h2>
        <p className="text-sm text-slate-500 mt-1">
          Once you&apos;ve categorized your assigned charges, export them here and send the file back to the owner to
          merge.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block text-xs text-slate-500 mb-1">Assigned card</span>
          <select
            className="input !py-1.5 min-w-56"
            value={selected}
            onChange={(e) => setSelected(e.target.value ? Number(e.target.value) : '')}
          >
            {cards.map((c) => (
              <option key={c.cardId} value={c.cardId}>
                {c.cardName} ({c.count})
              </option>
            ))}
          </select>
        </label>
        <button className="btn-primary" disabled={busy || !selected} onClick={exportReturn}>
          {busy ? 'Exporting…' : 'Export categorized packet…'}
        </button>
      </div>
      <Banner msg={msg} />
    </section>
  )
}

export default function Assignments(): React.JSX.Element {
  // Bump to re-pull the "send back" list after an import lands new assigned rows.
  const [refreshKey, setRefreshKey] = useState(0)
  const bump = (): void => setRefreshKey((k) => k + 1)

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <SendSection onChanged={bump} />
      <OpenSection onChanged={bump} />
      <ReturnSection refreshKey={refreshKey} />
    </div>
  )
}
