// Screen-lock ("sleep") configuration, persisted in localStorage alongside the
// app's other UI preferences. After an idle timeout the app blurs and asks for a
// 4-digit code before it becomes usable again.
//
// This is a *privacy screen lock*, not encryption: the database still lives
// unencrypted on this PC, so the PIN only deters a passer-by glancing at the
// screen — it is not protection against someone with full access to the machine.

const KEYS = {
  enabled: 'lock.enabled',
  timeout: 'lock.timeoutMs',
  pinHash: 'lock.pinHash'
} as const

export const DEFAULT_TIMEOUT_MS = 5 * 60_000

/** Preset idle timeouts offered in Settings (label → milliseconds). */
export const TIMEOUT_OPTIONS: { label: string; ms: number }[] = [
  { label: '1 minute', ms: 60_000 },
  { label: '2 minutes', ms: 120_000 },
  { label: '5 minutes', ms: 300_000 },
  { label: '10 minutes', ms: 600_000 },
  { label: '15 minutes', ms: 900_000 },
  { label: '30 minutes', ms: 1_800_000 }
]

export interface LockConfig {
  /** Lock is on AND a PIN exists — i.e. the idle timer should actually run. */
  enabled: boolean
  timeoutMs: number
  hasPin: boolean
}

// Lightweight salted hash so the literal PIN isn't sitting in localStorage. A
// 4-digit code is brute-forceable regardless of hashing — see the file header for
// the threat model — this just avoids storing it in the clear.
function hashPin(pin: string): string {
  let h = 0x811c9dc5
  const salted = `expense-tracker::${pin}`
  for (let i = 0; i < salted.length; i++) {
    h ^= salted.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

export function hasPin(): boolean {
  return !!localStorage.getItem(KEYS.pinHash)
}

export function getLockConfig(): LockConfig {
  const pinSet = hasPin()
  const timeout = Number(localStorage.getItem(KEYS.timeout))
  return {
    enabled: localStorage.getItem(KEYS.enabled) === '1' && pinSet,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    hasPin: pinSet
  }
}

export function setEnabled(enabled: boolean): void {
  localStorage.setItem(KEYS.enabled, enabled ? '1' : '0')
}

export function setTimeoutMs(ms: number): void {
  localStorage.setItem(KEYS.timeout, String(ms))
}

/** Store a new 4-digit PIN. Returns false (no-op) if the input isn't 4 digits. */
export function setPin(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return false
  localStorage.setItem(KEYS.pinHash, hashPin(pin))
  return true
}

/** Remove the PIN, which also disables the lock (it can't run without one). */
export function clearPin(): void {
  localStorage.removeItem(KEYS.pinHash)
  setEnabled(false)
}

export function verifyPin(pin: string): boolean {
  const stored = localStorage.getItem(KEYS.pinHash)
  return !!stored && stored === hashPin(pin)
}
