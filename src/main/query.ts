import type Database from 'better-sqlite3'
import type { Txn, TxnFilters } from '@shared/types'

/** SQL sort expressions shared by the paginated list and the export fetch. */
export const TXN_SORT_EXPRESSIONS: Record<NonNullable<TxnFilters['sortBy']>, string> = {
  txn_date: 't.txn_date',
  description: 'UPPER(t.description)',
  amount: 't.amount',
  expense_type: "COALESCE(t.expense_type, '')",
  category_name: "UPPER(COALESCE(c.name, 'Uncategorized'))"
}

export function buildTxnWhere(filters: TxnFilters): { where: string; params: Record<string, unknown> } {
  const clauses: string[] = []
  const params: Record<string, unknown> = {}
  if (filters.expenseType && filters.expenseType !== 'all') {
    clauses.push('t.expense_type = @expenseType')
    params.expenseType = filters.expenseType
  }
  const cardIds = filters.cardIds?.filter((n): n is number => Number.isInteger(n))
  if (cardIds && cardIds.length) {
    // Safe to inline: filtered to integers above. better-sqlite3 can't bind an
    // array to a single IN placeholder.
    clauses.push(`t.card_id IN (${cardIds.join(',')})`)
  } else if (filters.cardId) {
    clauses.push('t.card_id = @cardId')
    params.cardId = filters.cardId
  }
  if (filters.categoryIds && filters.categoryIds.length) {
    const numeric = filters.categoryIds.filter((c): c is number => Number.isInteger(c as number))
    const parts: string[] = []
    if (numeric.length) parts.push(`t.category_id IN (${numeric.join(',')})`)
    if (filters.categoryIds.includes('uncategorized')) parts.push('t.category_id IS NULL')
    if (parts.length) clauses.push(parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0])
  } else if (filters.categoryId === 'uncategorized') {
    clauses.push('t.category_id IS NULL')
  } else if (filters.categoryId) {
    clauses.push('t.category_id = @categoryId')
    params.categoryId = filters.categoryId
  }
  if (filters.search) {
    clauses.push('t.description LIKE @search')
    params.search = `%${filters.search}%`
  }
  if (filters.dateFrom) {
    clauses.push('t.txn_date >= @dateFrom')
    params.dateFrom = filters.dateFrom
  }
  if (filters.dateTo) {
    clauses.push('t.txn_date <= @dateTo')
    params.dateTo = filters.dateTo
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

export function appendWhere(where: string, clause: string): string {
  return where ? `${where} AND ${clause}` : `WHERE ${clause}`
}

/**
 * Every transaction matching the filters, unpaginated and ordered — the row set
 * behind both file export (CSV/Excel) and the printable report. Reuses the same
 * WHERE/ORDER BY as the on-screen table so an export mirrors exactly what the
 * user sees, minus pagination.
 */
export function fetchTransactionsForExport(db: Database.Database, filters: TxnFilters): Txn[] {
  const { where, params } = buildTxnWhere(filters)
  const sortBy = filters.sortBy && filters.sortBy in TXN_SORT_EXPRESSIONS ? filters.sortBy : 'txn_date'
  const sortDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC'
  return db
    .prepare(
      `SELECT t.*, ca.name AS card_name, c.name AS category_name
       FROM transactions t
       JOIN cards ca ON ca.id = t.card_id
       LEFT JOIN categories c ON c.id = t.category_id
       ${where} ORDER BY ${TXN_SORT_EXPRESSIONS[sortBy]} ${sortDir}, t.id DESC`
    )
    .all(params) as Txn[]
}
