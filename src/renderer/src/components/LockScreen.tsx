import { useCallback, useEffect, useState } from 'react'
import { verifyPin } from '../lock'

const KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫']

/**
 * Full-screen privacy lock. Blurs everything behind it (backdrop-blur) and only
 * dismisses when the correct 4-digit code is entered. Accepts both on-screen
 * keypad taps and physical number-key input.
 */
export default function LockScreen({ onUnlock }: { onUnlock: () => void }): React.JSX.Element {
  const [entry, setEntry] = useState('')
  const [shake, setShake] = useState(false)

  const press = useCallback(
    (key: string) => {
      setShake(false)
      if (key === '⌫') {
        setEntry((e) => e.slice(0, -1))
        return
      }
      if (!/^\d$/.test(key)) return
      setEntry((e) => {
        if (e.length >= 4) return e
        const next = e + key
        if (next.length === 4) {
          if (verifyPin(next)) {
            // Defer so the 4th dot paints before the overlay tears down.
            setTimeout(onUnlock, 80)
          } else {
            setTimeout(() => {
              setShake(true)
              setEntry('')
            }, 120)
          }
        }
        return next
      })
    },
    [onUnlock]
  )

  // Physical keyboard: digits enter, Backspace deletes. Capture phase so nothing
  // underneath the overlay reacts while locked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (/^\d$/.test(e.key)) {
        e.preventDefault()
        e.stopPropagation()
        press(e.key)
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        e.stopPropagation()
        press('⌫')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [press])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xl">
      <div
        className={`w-80 rounded-2xl bg-white shadow-2xl border border-slate-200 px-8 py-9 text-center ${
          shake ? 'animate-lock-shake' : ''
        }`}
      >
        <div className="text-3xl">🔒</div>
        <h2 className="mt-3 text-lg font-semibold text-slate-800">Locked</h2>
        <p className="mt-1 text-sm text-slate-500">Enter your code to unlock</p>

        <div className="mt-6 flex justify-center gap-3">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={`h-3.5 w-3.5 rounded-full border-2 ${
                i < entry.length ? 'bg-slate-700 border-slate-700' : 'border-slate-300'
              }`}
            />
          ))}
        </div>

        <div className="mt-7 grid grid-cols-3 gap-3">
          {KEYPAD.map((key, i) =>
            key === '' ? (
              <span key={i} />
            ) : (
              <button
                key={i}
                onClick={() => press(key)}
                className="h-14 rounded-xl bg-slate-50 border border-slate-200 text-xl font-medium text-slate-700 hover:bg-slate-100 active:bg-slate-200"
              >
                {key}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  )
}
