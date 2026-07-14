export type ExpenseType = 'business' | 'personal'
export type ExpenseTypeFilter = ExpenseType | 'all'
export type MatchType = 'contains' | 'starts_with' | 'regex'
export type AmountSign = 'expense_positive' | 'expense_negative'
export type ExportFormat = 'csv' | 'xlsx' | 'pdf'

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
  hotkey: string | null
  is_archived: 0 | 1
  /** When 1, business transactions in this category should carry a client/attendee
   *  name (IRS meals & entertainment substantiation). Surfaced as a warning, not enforced. */
  requires_client: 0 | 1
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
  expense_type: ExpenseType | null
  type_locked: 0 | 1
  category_id: number | null
  category_locked: 0 | 1
  import_batch_id: number | null
  /** Name of the individual cardholder who made the charge, when the statement carries it. */
  cardholder: string | null
  /** Client / attendees present, for IRS substantiation of business meals & entertainment. */
  client: string | null
  /** Optional free-text business purpose for the expense. */
  business_purpose: string | null
  /** Optional free-text note the user can attach to any transaction. */
  comment: string | null
  card_name: string
  category_name: string | null
  /** 1 when this transaction's category requires a client name (joined from categories). */
  category_requires_client: 0 | 1
}

export interface ImportProfile {
  id: number
  card_id: number
  name: string
  date_col: string
  amount_col: string
  description_col: string
  amount_col_secondary: string | null
  cardholder_col: string | null
  date_format: string
  amount_sign: AmountSign
}

export interface ColumnMapping {
  date_col: string
  amount_col: string
  amount_col_secondary: string | null
  description_col: string
  /** Optional column naming the individual cardholder (e.g. Amex card member). */
  cardholder_col: string | null
  date_format: string // 'auto' | 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD'
  amount_sign: AmountSign
}

export interface ParsedFile {
  path: string
  filename: string
  headers: string[]
  rows: Record<string, string>[]
  rowCount: number
  /** Best-guess column mapping from header names and cell content. */
  suggestedMapping: ColumnMapping
}

export interface PreviewRow {
  index: number
  txn_date: string | null
  description: string
  amount: number | null
  expense_type: ExpenseType | null
  /** true when no rule classified the type — it is visible in All until reviewed */
  needsReview: boolean
  category_id: number | null
  category_name: string | null
  cardholder: string | null
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
  expense_type: ExpenseType | null
  category_id: number | null
  cardholder: string | null
}

export interface ImportResult {
  batchId: number
  inserted: number
  skipped: number
}

export interface ExportResult {
  path: string
  count: number
}

export interface DashboardExportResult {
  path: string
}

/** Outcome of a manual "Check for updates" run, surfaced in Settings. */
export interface UpdateStatus {
  state: 'unsupported' | 'up-to-date' | 'available' | 'downloaded' | 'declined' | 'error'
  /** The version currently running. */
  version: string
  /** The newer version found on GitHub, when one exists. */
  latestVersion?: string
  message: string
}

export interface ImportBatch {
  id: number
  card_id: number
  filename: string
  row_count: number
  inserted_count: number
  skipped_count: number
  imported_at: string
  card_name: string
  transaction_count: number
}

export type TransactionClearRequest =
  | { mode: 'all' }
  | { mode: 'range'; dateFrom: string; dateTo: string }

export interface TransactionDeleteResult {
  deleted: number
}

export interface TxnFilters {
  expenseType?: ExpenseTypeFilter
  cardId?: number
  categoryId?: number | 'uncategorized'
  /** Quick Reports: match any of several cards. Takes precedence over cardId. */
  cardIds?: number[]
  /** Quick Reports: match any of several categories ('uncategorized' = no category). Takes precedence over categoryId. */
  categoryIds?: (number | 'uncategorized')[]
  search?: string
  dateFrom?: string
  dateTo?: string
  /** When true, match only business transactions whose category requires a client
   *  name but have none recorded yet (the IRS-substantiation gap filter). */
  missingClient?: boolean
  sortBy?: 'txn_date' | 'amount' | 'description' | 'expense_type' | 'category_name' | 'cardholder'
  sortDir?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

/** Total spend per individual cardholder, used to surface the biggest spenders. */
export interface CardholderSpend {
  cardholder: string
  total: number
  count: number
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
  totalIncome: number
  prevPeriodSpend: number
  prevPeriodIncome: number
  byCategory: { category: string; color: string | null; total: number }[]
  monthlyTrend: { month: string; total: number }[]
  topVendors: { vendor: string; total: number; count: number }[]
  byCardholder: CardholderSpend[]
  budgetVsActual: { category: string; limit: number; actual: number }[]
  uncategorizedCount: number
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

// ---- Cardholder assignment round-trip ----

/** Direction of an assignment packet: 'assigned' = boss → cardholder (to
 *  categorize), 'returned' = cardholder → boss (to merge back). */
export type AssignmentStage = 'assigned' | 'returned'

/** Header metadata stamped into every assignment packet. */
export interface AssignmentMeta {
  format: string
  version: number
  stage: AssignmentStage
  appVersion: string
  cardName: string
  cardholder: string
  exportedAt: string
}

/** Result of inspecting a chosen packet file before acting on it. */
export interface AssignmentPickResult {
  path: string
  meta: AssignmentMeta
  rowCount: number
  categoryCount: number
}

/** A cardholder with charges, offered when the boss picks who to send to. */
export interface AssignmentCardholder {
  cardholder: string
  count: number
}

/** A card holding assigned (round-trip token) rows the cardholder can send back. */
export interface AssignmentReturnableCard {
  cardId: number
  cardName: string
  count: number
}

/** Outcome of a cardholder importing an 'assigned' packet. */
export interface AssignmentImportResult {
  cardId: number
  cardName: string
  inserted: number
  updated: number
  categoriesAdded: number
}

/** Outcome of the boss merging a 'returned' packet back into their data. */
export interface AssignmentMergeResult {
  total: number
  updated: number
  unmatched: number
  /** Category names the cardholder used that don't exist on the boss's side. */
  unmatchedCategories: string[]
}

// ---- Reconciliation: matching statement charges to PO Automation records ----

/** One purchase-order line as returned by the PO Automation read-only API. */
export interface PoLineLite {
  description: string
  qty: number
  rate: number
  amount: number
}

/** A purchase order pulled from `GET /api/reconciliation/orders` on the PO app. */
export interface PoApiOrder {
  id: string
  poNumber: number
  date: string // ISO
  vendor: string
  vendorAddress: string | null
  shipToName: string
  subtotal: number
  salesTax: number
  total: number
  status: string
  isChargeback: boolean
  chargebackClient: string | null
  chargebackSettledAt: string | null
  requester: { name: string; email: string } | null
  createdBy: { name: string; email: string }
  lines: PoLineLite[]
}

/** Reconciliation settings surfaced to the renderer. The API token is NEVER
 *  included — only whether one is stored. */
export interface ReconConfig {
  baseUrl: string
  hasToken: boolean
  /** Match window: how many days BEFORE the PO date a charge may appear. */
  dateBeforeDays: number
  /** Match window: how many days AFTER the PO date a charge may appear. */
  dateAfterDays: number
  /** Amount difference (in cents) treated as an exact, auto-linkable match. */
  amountExactCents: number
  /** Amount difference (as a %) still offered as a review candidate. */
  amountBandPct: number
  /** Vendors that SHOULD have a PO; only these are flagged when a charge has none. */
  trackedVendors: string[]
  lastSyncAt: string | null
  lastSyncCount: number | null
}

/** Partial update; `token: null` clears the stored token, `undefined` leaves it. */
export interface ReconConfigInput {
  baseUrl?: string
  token?: string | null
  dateBeforeDays?: number
  dateAfterDays?: number
  amountExactCents?: number
  amountBandPct?: number
  trackedVendors?: string[]
}

export interface ReconTestResult {
  ok: boolean
  status: number
  message: string
  sampleCount?: number
}

export interface ReconSyncResult {
  fetched: number
  upserted: number
  syncedAt: string
}

export type ReconLinkStatus = 'auto' | 'pending' | 'confirmed' | 'rejected'

/** Summary returned after (re)running the matcher. */
export interface ReconMatchResult {
  autoLinked: number
  queued: number
  candidatesWritten: number
  chargesConsidered: number
  posConsidered: number
}

/** A candidate PO offered for a charge in the review queue. */
export interface ReconCandidate {
  linkId: number
  poId: string
  poNumber: number
  poDate: string
  vendor: string
  total: number
  requesterName: string | null
  status: ReconLinkStatus
  confidence: number
  lines: PoLineLite[]
}

/** A charge plus its ranked candidate POs awaiting the boss's decision. */
export interface ReconReviewItem {
  txnId: number
  txnDate: string
  description: string
  amount: number
  cardName: string
  candidates: ReconCandidate[]
}

export interface ReconUnmatchedCharge {
  txnId: number
  txnDate: string
  description: string
  amount: number
  cardName: string
}

/** Reconciliation status of a single PO against the statement. */
export type ReconPoStatus = 'matched' | 'review' | 'unmatched'

/** One PO in the reconciliation ledger, with how it lines up to the statement. */
export interface ReconLedgerItem {
  poId: string
  poNumber: number
  poDate: string
  vendor: string
  total: number
  requesterName: string | null
  status: ReconPoStatus
  /** When matched: the statement charge it's tied to. */
  matchedTxnId: number | null
  matchedTxnDate: string | null
  matchedDescription: string | null
  matchedAmount: number | null
  /** Whether the match was auto-linked or boss-confirmed (when matched). */
  linkStatus: ReconLinkStatus | null
  /** Number of pending candidates (when status is 'review'). */
  reviewCount: number
}

export interface ReconSummary {
  totalPos: number
  matchedPos: number
  reviewPos: number
  unmatchedPos: number
  /** Sum of matched POs' totals. */
  amountReconciled: number
}

/** PO-centric reconciliation view: every PO and its statement status. */
export interface ReconLedger {
  summary: ReconSummary
  items: ReconLedgerItem[]
}
