// Pure scoring for matching a statement charge to a purchase order. No DB or
// Electron imports on purpose, so this is unit-testable under plain Node.
//
// Given the "statement-only" reality (no Amazon item detail, single shared Amazon
// account so no per-person signal), matching rests on three things: the vendor must
// agree, the amount must be ~equal (PO totals are entered tax-inclusive), and the
// charge must fall in a small date window after the PO. Amount is the primary
// signal; date breaks ties between equally-priced candidates.

export type AmountTier = 'exact' | 'band' | 'none'

export interface AmountScore {
  /** 0 (no match) .. 1 (exact). */
  score: number
  tier: AmountTier
  /** Absolute dollar difference. */
  diff: number
}

// Statement descriptions rarely equal the PO vendor verbatim ("AMZN Mktp US*1A2"
// vs "Amazon"). Map a normalized vendor to the substrings that identify it.
const VENDOR_ALIASES: Record<string, string[]> = {
  amazon: ['amazon', 'amzn']
}

/** Lowercase and strip everything but a-z0-9, so punctuation/spacing don't matter. */
export function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Does a freeform statement description plausibly name this PO's vendor? */
export function vendorMatches(description: string, vendor: string): boolean {
  const haystack = normalizeKey(description)
  const key = normalizeKey(vendor)
  if (!haystack || !key) return false

  const needles = new Set<string>([key, ...(VENDOR_ALIASES[key] ?? [])].map(normalizeKey))
  for (const needle of needles) {
    if (needle && haystack.includes(needle)) return true
  }
  // Fallback: any significant word of a multi-word vendor (e.g. "Office Depot").
  for (const token of vendor.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length >= 4 && haystack.includes(token)) return true
  }
  return false
}

/**
 * Score the amount match. <= exactCents difference is an auto-linkable exact match;
 * within bandPct is a softer "review candidate" (scored 0.5..1 by closeness);
 * anything further is no match.
 */
export function amountScore(charge: number, poTotal: number, exactCents: number, bandPct: number): AmountScore {
  const diff = Math.abs(charge - poTotal)
  if (Math.round(diff * 100) <= exactCents) return { score: 1, tier: 'exact', diff }
  const pct = poTotal > 0 ? (diff / poTotal) * 100 : Infinity
  if (pct <= bandPct) return { score: 1 - (pct / bandPct) * 0.5, tier: 'band', diff }
  return { score: 0, tier: 'none', diff }
}

/** Whole-day offset of the charge from the PO date (positive = charge is later). */
export function dateDeltaDays(chargeDate: string, poDate: string): number {
  const day = (iso: string): number => Math.floor(new Date(iso).getTime() / 86_400_000)
  return day(chargeDate) - day(poDate)
}

/**
 * Score how well the charge date fits the window [-before, +after] around the PO.
 * Returns null when the charge falls outside the window (not a candidate). Inside,
 * scores 0.5..1, preferring a charge that lands close to the PO date.
 */
export function dateScore(deltaDays: number, beforeDays: number, afterDays: number): number | null {
  if (deltaDays < -beforeDays || deltaDays > afterDays) return null
  const span = beforeDays + afterDays || 1
  return 1 - (Math.min(Math.abs(deltaDays), span) / span) * 0.5
}

/** Blend amount (primary) and date (tie-breaker) into a 0..1 confidence. */
export function combineConfidence(amount: number, date: number): number {
  return amount * (0.6 + 0.4 * date)
}
