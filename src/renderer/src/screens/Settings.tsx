import { useEffect, useState } from 'react'
import { api } from '../api'

export default function Settings(): React.JSX.Element {
  const [dbPath, setDbPath] = useState('')
  const [version, setVersion] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [updateMsg, setUpdateMsg] = useState<string | null>(null)
  const [checkingUpdates, setCheckingUpdates] = useState(false)

  useEffect(() => {
    api.db.getPath().then(setDbPath).catch((e) => setError(e.message))
    api.app.version().then(setVersion).catch(() => {})
  }, [])

  const run = async (fn: () => Promise<string | null>, made: (p: string) => string): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await fn()
      if (result) setNotice(made(result))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const backup = (): Promise<void> => run(api.db.backup, (p) => `Backup saved to ${p}`)
  const restore = (): Promise<void> =>
    run(api.db.restore, (f) => `Restored from ${f}. Restart the app if anything looks stale.`)

  const checkUpdates = async (): Promise<void> => {
    setCheckingUpdates(true)
    setUpdateMsg(null)
    try {
      const result = await api.updates.check()
      setUpdateMsg(result.message)
    } catch (e) {
      setUpdateMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setCheckingUpdates(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">{error}</div>}
      {notice && <div className="rounded-lg bg-green-50 border border-green-200 text-green-700 px-4 py-3 text-sm">{notice}</div>}

      <section className="card-panel p-6 space-y-3">
        <h2 className="font-semibold text-slate-800">Your data</h2>
        <p className="text-sm text-slate-500">
          Everything lives in a single SQLite file on this PC. Nothing is ever sent anywhere.
        </p>
        <div className="text-sm">
          <div className="text-slate-500">Database file</div>
          <code className="block mt-1 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs break-all">{dbPath || '…'}</code>
        </div>
      </section>

      <section className="card-panel p-6 space-y-3">
        <h2 className="font-semibold text-slate-800">Backup &amp; restore</h2>
        <p className="text-sm text-slate-500">
          Back up regularly — copy the database to a USB drive or another folder. Restoring replaces all current data
          with the backup.
        </p>
        <div className="flex gap-3">
          <button className="btn-primary" onClick={backup} disabled={busy}>Back up database…</button>
          <button className="btn-secondary" onClick={restore} disabled={busy}>Restore from backup…</button>
        </div>
      </section>

      <section className="card-panel p-6 space-y-3">
        <h2 className="font-semibold text-slate-800">Updates</h2>
        <p className="text-sm text-slate-500">
          The app stays fully offline until you click below. Checking reaches out to GitHub once to see
          if a newer version exists, then asks before downloading or installing anything. No data is sent.
        </p>
        <div className="flex items-center gap-3">
          <button className="btn-secondary" onClick={checkUpdates} disabled={checkingUpdates || busy}>
            {checkingUpdates ? 'Checking…' : 'Check for updates'}
          </button>
          {version && <span className="text-sm text-slate-500">Current: v{version}</span>}
        </div>
        {updateMsg && <p className="text-sm text-slate-600">{updateMsg}</p>}
      </section>

      {version && <p className="text-center text-xs text-slate-400">Expense Tracker v{version} — 100% local</p>}
    </div>
  )
}
