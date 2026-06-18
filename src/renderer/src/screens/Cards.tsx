import { useCallback, useEffect, useState } from 'react'
import type { Card } from '@shared/types'
import { api } from '../api'

export default function Cards(): React.JSX.Element {
  const [cards, setCards] = useState<Card[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('')
  const [editId, setEditId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')

  const load = useCallback((): void => {
    api.cards.list().then(setCards).catch((e) => setError(e.message))
  }, [])

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

  const add = (): Promise<void> =>
    run(async () => {
      if (!newName.trim()) throw new Error('Enter a card name.')
      await api.cards.create(newName.trim())
      setNewName('')
    })

  const saveEdit = (): Promise<void> =>
    run(async () => {
      if (editId === null) return
      await api.cards.update(editId, editName.trim())
      setEditId(null)
    })

  const remove = (c: Card): Promise<void> =>
    run(async () => {
      if (!window.confirm(`Delete "${c.name}" and all of its transactions? This cannot be undone.`)) return
      await api.cards.remove(c.id)
    })

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">{error}</div>}

      <section className="card-panel p-6 space-y-4">
        <h2 className="font-semibold text-slate-800">Cards</h2>
        <p className="text-sm text-slate-500">
          A card is just a source for a statement. Each statement mixes business and personal charges; rows stay visible
          in All until a rule or manual review marks them Business or Personal.
        </p>
        <div className="overflow-auto rounded-lg border border-slate-200">
          <table className="text-sm w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Name</th>
                <th className="px-4 py-2 text-right font-medium text-slate-600">Added</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {cards.map((c) => (
                <tr key={c.id} className="border-t border-slate-100">
                  <td className="px-4 py-2">
                    {editId === c.id ? (
                      <input
                        className="input !py-1 w-64"
                        value={editName}
                        autoFocus
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                      />
                    ) : (
                      <span className="font-medium text-slate-700">💳 {c.name}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-400 whitespace-nowrap">{c.created_at?.slice(0, 10)}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {editId === c.id ? (
                      <>
                        <button className="text-blue-600 hover:underline mr-3" disabled={busy} onClick={saveEdit}>Save</button>
                        <button className="text-slate-500 hover:underline" onClick={() => setEditId(null)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button
                          className="text-blue-600 hover:underline mr-3"
                          onClick={() => {
                            setEditId(c.id)
                            setEditName(c.name)
                          }}
                        >
                          Rename
                        </button>
                        <button className="text-red-500 hover:underline" disabled={busy} onClick={() => remove(c)}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {cards.length === 0 && (
                <tr><td colSpan={3} className="px-4 py-8 text-center text-slate-400">No cards yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-end gap-3 border-t border-slate-200 pt-4">
          <label className="text-sm text-slate-600">
            New card
            <input
              className="input block w-64 mt-1"
              placeholder="e.g. Owner Personal Visa"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
          </label>
          <button className="btn-secondary" onClick={add} disabled={busy}>Add card</button>
        </div>
      </section>
    </div>
  )
}
