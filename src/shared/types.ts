export type ExpenseType = 'business' | 'personal'
export type ExpenseTypeFilter = ExpenseType | 'all'
export type MatchType = 'contains' | 'starts_with' | 'regex'
export type AmountSign = 'expense_positive' | 'expense_negative'

export interface Card {
  id: number
  name: string
  default_expense_type: ExpenseType
  created_at: string
}

export interface Category {
  id: number
  name: string
  color: string | null
  is_archived: 0 | 1
}

export interface CategoryRule {
  id: number
  category_id: number | null
  expense_type: ExpenseType | null
  match_type: MatchType
  pattern: string
  priority: number
}

export interface Budget {
  id: number
  category_id: number
  expense_type: ExpenseType
  monthly_limit: number
}

export interface Txn {
  id: number
  card_id: number
  txn_date: string
  description: string
  amount: number
  expense_type: ExpenseType
  type_locked: 0 | 1
  category_id: number | null
  category_locked: 0 | 1
  import_batch_id: number | null
  card_name: string
  category_name: string | null
}

export interface ImportProfile {
  id: number
  card_id: number
  name: string
  date_col: string
  amount_col: string
  description_col: string
  amount_col_secondary: string | null
  date_format: string
  amount_sign: AmountSign
}

export interface ColumnMapping {
  date_col: string
  amount_col: string
  amount_col_secondary: string | null
  description_col: string
  date_format: string // 'auto' | 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD'
  amount_sign: AmountSign
}

export interface ParsedFile {
  path: string
  filename: string
  headers: string[]
  rows: Record<string, string>[]
  rowCount: number
}

export interface PreviewRow {
  index: number
  txn_date: string | null
  description: string
  amount: number | null
  expense_type: ExpenseType
  /** true when no rule classified the type — it fell back to the default and likely needs a look */
  needsReview: boolean
  category_id: number | null
  category_name: string | null
  duplicate: boolean
  error: string | null
}

export interface ImportPreview {
  rows: PreviewRow[]
  newCount: number
  duplicateCount: number
  errorCount: number
}

export interface CommitRow {
  txn_date: string
  description: string
  amount: number
  expense_type: ExpenseType
  category_id: number | null
}

export interface ImportResult {
  batchId: number
  inserted: number
  skipped: number
}

export interface TxnFilters {
  expenseType?: ExpenseTypeFilter
  cardId?: number
  categoryId?: number | 'uncategorized'
  search?: string
  dateFrom?: string
  dateTo?: string
  sortBy?: 'txn_date' | 'amount' | 'description'
  sortDir?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

export interface TxnPage {
  rows: Txn[]
  total: number
}

export interface KpiFilters {
  expenseType: ExpenseTypeFilter
  dateFrom: string
  dateTo: string
  cardId?: number
}

export interface Kpis {
  totalSpend: number
  prevPeriodSpend: number
  byCategory: { category: string; color: string | null; total: number }[]
  monthlyTrend: { month: string; total: number }[]
  topVendors: { vendor: string; total: number; count: number }[]
  budgetVsActual: { category: string; limit: number; actual: number }[]
  uncategorizedCount: number
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
