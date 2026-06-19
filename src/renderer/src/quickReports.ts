// Quick Reports: saved shortcuts that capture a set of transaction filters
// (reporting view, any number of cards and categories, a search term and a date
// range) so a configured statement can be exported in one click. Definitions are
// persisted in localStorage alongside the app's other UI preferences — they are
// shortcuts, not transactional data.

import type { ExpenseTypeFilter, TxnFilters } from '@shared/types'

const KEY = 'quickReports'

export type DateMode = 'all' | 'this_month' | 'last_month' | 'last_3' | 'this_year' | 'custom'

export const DATE_MODES: { id: DateMode; label: string }[] = [
  { id: 'all', label: 'All dates' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'last_3', label: 'Last 3 months' },
  { id: 'this_year', label: 'This year' },
  { id: 'custom', label: 'Custom range' }
]

/** A category target: a real category id, or transactions with no category. */
export type CategoryTarget = number | 'uncategorized'

export interface QuickReport {
  id: string
  name: string
  expenseType: ExpenseTypeFilter
  /** Empty = all cards. */
  cardIds: number[]
  /** Empty = all categories. */
  categoryIds: CategoryTarget[]
  search: string
  dateMode: DateMode
  /** Only used when dateMode === 'custom'. */
  customFrom: string
  customTo: string
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  } catch {
    // crypto.randomUUID can throw outside a secure context — fall through.
  }
  return `qr-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

export function emptyReport(): QuickReport {
  return {
    id: newId(),
    name: '',
    expenseType: 'all',
    cardIds: [],
    categoryIds: [],
    search: '',
    dateMode: 'all',
    customFrom: '',
    customTo: ''
  }
}

export function listReports(): QuickReport[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as QuickReport[]) : []
  } catch {
    return []
  }
}

function saveAll(reports: QuickReport[]): QuickReport[] {
  localStorage.setItem(KEY, JSON.stringify(reports))
  return reports
}

/** Insert or update a report by id, returning the new list. */
export function upsertReport(report: QuickReport): QuickReport[] {
  const reports = listReports()
  const idx = reports.findIndex((r) => r.id === report.id)
  if (idx >= 0) reports[idx] = report
  else reports.push(report)
  return saveAll(reports)
}

export function deleteReport(id: string): QuickReport[] {
  return saveAll(listReports().filter((r) => r.id !== id))
}

const iso = (d: Date): string => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Resolve a report's date mode to concrete from/to bounds (undefined = unbounded). */
export function resolveDateRange(report: QuickReport, now = new Date()): { from?: string; to?: string } {
  const y = now.getFullYear()
  const m = now.getMonth()
  switch (report.dateMode) {
    case 'all':
      return {}
    case 'this_month':
      return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) }
    case 'last_month':
      return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) }
    case 'last_3':
      return { from: iso(new Date(y, m - 2, 1)), to: iso(new Date(y, m + 1, 0)) }
    case 'this_year':
      return { from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)) }
    case 'custom':
      return { from: report.customFrom || undefined, to: report.customTo || undefined }
  }
}

/** Map a saved report to the filter shape the export pipeline expects. */
export function toTxnFilters(report: QuickReport): TxnFilters {
  const range = resolveDateRange(report)
  return {
    expenseType: report.expenseType,
    cardIds: report.cardIds.length ? report.cardIds : undefined,
    categoryIds: report.categoryIds.length ? report.categoryIds : undefined,
    search: report.search.trim() || undefined,
    dateFrom: range.from,
    dateTo: range.to
  }
}
