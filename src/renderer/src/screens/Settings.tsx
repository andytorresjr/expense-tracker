import { useEffect, useState } from 'react'
import { api } from '../api'
import { useLock } from '../App'
import CardsSection from '../components/CardsSection'
import {
  clearPin,
  getLockConfig,
  hasPin,
  setEnabled,
  setPin,
  setTimeoutMs,
  TIMEOUT_OPTIONS
} from '../lock'

function ScreenLockSection(): React.JSX.Element {
  const { lockNow, refreshLockConfig } = useLock()
  const [config, setConfig] = useState(getLockConfig)
  const [editingPin, setEditingPin] = useState(false)
  const [pin1, setPin1] = useState('')
  const [pin2, setPin2] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // Re-read config and let App's idle timer pick up the change in one step.
  const sync = (): void => {
    setConfig(getLockConfig())
    refreshLockConfig()
  }

  const onlyDigits = (v: string): string => v.replace(/\D/g, '').slice(0, 4)

  const savePin = (): void => {
    setErr(null)
    setNote(null)
    if (!/^\d{4}$/.test(pin1)) {
      setErr('Enter a 4-digit code.')
      return
    }
    if (pin1 !== pin2) {
      setErr('The two codes do not match.')
      return
    }
    setPin(pin1)
    setEnabled(true)
    setPin1('')
    setPin2('')
    setEditingPin(false)
    setNote('Code saved. The app will lock after the selected inactivity time.')
    sync()
  }

  const removePin = (): void => {
    clearPin()
    setEditingPin(false)
    setPin1('')
    setPin2('')
    setNote('Code removed. Auto-lock is off.')
    setErr(null)
    sync()
  }

  const toggleEnabled = (on: boolean): void => {
    setNote(null)
    setErr(null)
    if (on && !hasPin()) {
      setEditingPin(true)
      setErr('Set a 4-digit code first.')
      return
    }
    setEnabled(on)
    sync()
  }

  const changeTimeout = (ms: number): void => {
    setTimeoutMs(ms)
    sync()
  }

  return (
    <section className="card-panel p-6 space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800">Screen lock</h2>
        <p className="text-sm text-slate-500 mt-1">
          Blur the app after a period of inactivity and require a 4-digit code to unlock — useful when you step away
          from your desk. This is a privacy screen, not encryption: your data still lives only on this PC.
        </p>
      </div>

      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={config.enabled}
          onChange={(e) => toggleEnabled(e.target.checked)}
        />
        <span className="text-slate-700">Lock the app after inactivity</span>
      </label>

      <div className="flex items-center gap-3 text-sm">
        <span className="text-slate-700">Lock after</span>
        <select
          className="input !py-1.5"
          value={config.timeoutMs}
          onChange={(e) => changeTimeout(Number(e.target.value))}
        >
          {TIMEOUT_OPTIONS.map((o) => (
            <option key={o.ms} value={o.ms}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-slate-400">of inactivity</span>
      </div>

      {editingPin ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
          <div className="flex flex-wrap gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">{config.hasPin ? 'New code' : 'Code'}</label>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                className="input w-28 tracking-[0.4em] text-center"
                placeholder="••••"
                value={pin1}
                onChange={(e) => setPin1(onlyDigits(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Confirm code</label>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                className="input w-28 tracking-[0.4em] text-center"
                placeholder="••••"
                value={pin2}
                onChange={(e) => setPin2(onlyDigits(e.target.value))}
                onKeyDown={(e) => e.key === 'Enter' && savePin()}
              />
            </div>
          </div>
          <div className="flex gap-3">
            <button className="btn-primary" onClick={savePin}>Save code</button>
            <button
              className="btn-secondary"
              onClick={() => {
                setEditingPin(false)
                setPin1('')
                setPin2('')
                setErr(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <button className="btn-secondary" onClick={() => setEditingPin(true)}>
            {config.hasPin ? 'Change code' : 'Set a 4-digit code'}
          </button>
          {config.hasPin && (
            <button className="btn-secondary" onClick={removePin}>
              Remove code
            </button>
          )}
          {config.enabled && (
            <button className="btn-secondary" onClick={lockNow}>
              Lock now
            </button>
          )}
        </div>
      )}

      {err && <p className="text-sm text-red-600">{err}</p>}
      {note && <p className="text-sm text-green-700">{note}</p>}
    </section>
  )
}

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

      <CardsSection />

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

      <ScreenLockSection />

      {version && <p className="text-center text-xs text-slate-400">Expense Tracker v{version} — 100% local</p>}
    </div>
  )
}
