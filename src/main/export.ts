import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import type { ExportFormat, KpiFilters, Txn, TxnFilters } from '@shared/types'

/** Columns written to exported files, in order. Cardholder is appended only when
 *  the data carries it, so statements without that column export unchanged. */
const BASE_COLUMNS = ['Date', 'Description', 'Amount', 'Type', 'Category', 'Card'] as const
type Column = (typeof BASE_COLUMNS)[number] | 'Cardholder'

function exportColumns(rows: Txn[]): Column[] {
  return rows.some((txn) => txn.cardholder) ? [...BASE_COLUMNS, 'Cardholder'] : [...BASE_COLUMNS]
}
function categorySegment(filters: TxnFilters, rows: Txn[]): string | null {
  if (filters.categoryId === 'uncategorized') return 'Uncategorized'
  if (typeof filters.categoryId === 'number') {
    return rows.find((row) => row.category_id === filters.categoryId && row.category_name)?.category_name ?? `Category-${filters.categoryId}`
  }
  return null
}

function typeLabel(filters: TxnFilters): string {
  if (filters.expenseType === 'business') return 'Business'
  if (filters.expenseType === 'personal') return 'Personal'
  return 'All'
}

function cardLabel(filters: TxnFilters, rows: Txn[]): string | null {
  if (!filters.cardId) return null
  return rows.find((row) => row.card_id === filters.cardId && row.card_name)?.card_name ?? `Card-${filters.cardId}`
}

function sanitizeSegment(value: string): string {
  const segment = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return (segment || 'export').slice(0, 60)
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function buildExportFileName(filters: TxnFilters, rows: Txn[], format: ExportFormat, now = new Date()): string {
  const parts = [
    'transactions',
    typeLabel(filters),
    categorySegment(filters, rows),
    cardLabel(filters, rows),
    filters.search ? `Search-${filters.search}` : null
  ]
    .filter((part): part is string => !!part)
    .map(sanitizeSegment)
  parts.push(localIsoDate(now))
  const base = (parts.join('-') || 'transactions').slice(0, 180).replace(/-+$/g, '')
  return `${base}.${format}`
}

/** Filename for a Quick Report export: the report's name plus the date stamp. */
export function buildReportFileName(base: string, format: ExportFormat, now = new Date()): string {
  const name = [sanitizeSegment(base), localIsoDate(now)].join('-').slice(0, 180).replace(/-+$/g, '')
  return `${name || 'report'}.${format}`
}

export function buildDashboardFileName(filters: KpiFilters, now = new Date()): string {
  const scope =
    filters.expenseType === 'business' ? 'Business' : filters.expenseType === 'personal' ? 'Personal' : 'All'
  const parts = ['dashboard', scope, filters.dateFrom, 'to', filters.dateTo, localIsoDate(now)].map(sanitizeSegment)
  const base = (parts.join('-') || 'dashboard').slice(0, 180).replace(/-+$/g, '')
  return `${base}.pdf`
}

/**
 * Flatten a transaction to its exported representation. Amount stays a raw
 * number (positive = spent, negative = refund/credit) so spreadsheets and
 * accounting software can total it; type/category fall back to the same labels
 * the UI shows for unset values.
 */
function toRecord(txn: Txn): Record<Column, string | number> {
  return {
    Date: txn.txn_date,
    Description: txn.description,
    Amount: txn.amount,
    Type: txn.expense_type ?? 'Unassigned',
    Category: txn.category_name ?? 'Uncategorized',
    Card: txn.card_name,
    Cardholder: txn.cardholder ?? ''
  }
}

export function buildCsv(rows: Txn[]): string {
  const columns = exportColumns(rows)
  return Papa.unparse({
    fields: [...columns],
    data: rows.map((txn) => {
      const record = toRecord(txn)
      return columns.map((column) => record[column])
    })
  })
}

export function buildXlsx(rows: Txn[]): Buffer {
  const columns = exportColumns(rows)
  const sheet = XLSX.utils.json_to_sheet(
    rows.map((txn) => {
      const record = toRecord(txn)
      return Object.fromEntries(columns.map((column) => [column, record[column]]))
    }),
    { header: [...columns] }
  )
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, 'Transactions')
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
