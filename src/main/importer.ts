import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { basename, extname } from 'path'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import type Database from 'better-sqlite3'
import type {
  Card,
  ColumnMapping,
  CommitRow,
  ExpenseType,
  ImportPreview,
  ImportResult,
  ParsedFile,
  PreviewRow
} from '@shared/types'
import { applyRules, loadRules } from './rules'

// ---------- file parsing ----------

export function parseFile(filePath: string): ParsedFile {
  const ext = extname(filePath).toLowerCase()
  let headers: string[] = []
  let rows: Record<string, string>[] = []

  if (ext === '.csv') {
    const content = readFileSync(filePath, 'utf8')
    const result = Papa.parse<Record<string, string>>(content, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim()
    })
    headers = result.meta.fields ?? []
    rows = result.data
  } else if (ext === '.xlsx' || ext === '.xls') {
    const workbook = XLSX.read(readFileSync(filePath), { type: 'buffer' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    if (!sheet) throw new Error('The workbook has no sheets.')
    // raw:false formats cells (incl. dates) as display text, so everything is a string
    const json = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { raw: false, defval: '' })
    rows = json.map((r) => {
      const clean: Record<string, string> = {}
      for (const [k, v] of Object.entries(r)) clean[k.trim()] = String(v ?? '').trim()
      return clean
    })
    headers = rows.length > 0 ? Object.keys(rows[0]) : []
  } else {
    throw new Error(`Unsupported file type: ${ext}. Use .csv, .xlsx or .xls.`)
  }

  if (headers.length === 0 || rows.length === 0) {
    throw new Error('No data rows found in the file.')
  }
  return { path: filePath, filename: basename(filePath), headers, rows, rowCount: rows.length }
}

// ---------- normalization ----------

/**
 * Expense type used only when no rule classifies a row. Statements mix business
 * and personal, so there is no meaningful per-card default — merchant rules do
 * the splitting and these fall-through rows are flagged for review.
 */
const FALLBACK_EXPENSE_TYPE: ExpenseType = 'business'

const DATE_FORMATS = ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY'] as const

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function buildIso(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null
  const date = new Date(Date.UTC(y, m - 1, d))
  // reject rollovers like Feb 30
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

export function parseDate(raw: string, format: string): string | null {
  const value = raw.trim()
  if (!value) return null

  const tryFormat = (fmt: string): string | null => {
    if (fmt === 'YYYY-MM-DD') {
      const m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
      return m ? buildIso(Number(m[1]), Number(m[2]), Number(m[3])) : null
    }
    const m = value.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/)
    if (!m) return null
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    if (fmt === 'MM/DD/YYYY') return buildIso(year, Number(m[1]), Number(m[2]))
    if (fmt === 'DD/MM/YYYY') return buildIso(year, Number(m[2]), Number(m[1]))
    return null
  }

  if (format !== 'auto') return tryFormat(format)
  for (const fmt of DATE_FORMATS) {
    const result = tryFormat(fmt)
    if (result) return result
  }
  return null
}

/** Strip currency symbols, thousands separators, spaces; parentheses mean negative. */
export function parseAmount(raw: string): number | null {
  let value = raw.trim()
  if (!value) return null
  let negative = false
  const paren = value.match(/^\((.*)\)$/)
  if (paren) {
    negative = true
    value = paren[1]
  }
  value = value.replace(/[$€£¥,\s]/g, '')
  if (!/^[+-]?\d*\.?\d+$/.test(value)) return null
  const n = parseFloat(value)
  if (Number.isNaN(n)) return null
  return negative ? -n : n
}

export function normalizeDescription(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

export function dedupeHash(cardId: number, txnDate: string, amount: number, description: string): string {
  const key = `${cardId}|${txnDate}|${amount.toFixed(2)}|${description.toUpperCase()}`
  return createHash('sha256').update(key).digest('hex')
}

/**
 * Resolve the spent amount for a row. With a secondary (credit) column, the
 * primary column is treated as debit/spend and the secondary as credit/refund
 * (stored negative so refunds reduce totals). Otherwise the single column is
 * interpreted via the profile's sign convention; positive = money spent.
 */
function resolveAmount(row: Record<string, string>, mapping: ColumnMapping): number | null {
  const primaryRaw = row[mapping.amount_col] ?? ''
  const primary = parseAmount(primaryRaw)

  if (mapping.amount_col_secondary) {
    if (primary !== null && primary !== 0) return Math.abs(primary)
    const secondary = parseAmount(row[mapping.amount_col_secondary] ?? '')
    if (secondary !== null && secondary !== 0) return -Math.abs(secondary)
    return primary === null ? null : 0
  }

  if (primary === null) return null
  return mapping.amount_sign === 'expense_negative' ? -primary : primary
}

// ---------- preview & commit ----------

export function buildPreview(
  db: Database.Database,
  card: Card,
  rows: Record<string, string>[],
  mapping: ColumnMapping
): ImportPreview {
  const rules = loadRules(db)
  const categoryNames = new Map(
    (db.prepare('SELECT id, name FROM categories').all() as { id: number; name: string }[]).map((c) => [c.id, c.name])
  )
  const hashExists = db.prepare('SELECT 1 FROM transactions WHERE dedupe_hash = ?')

  const seenInFile = new Set<string>()
  const preview: PreviewRow[] = rows.map((row, index) => {
    const description = normalizeDescription(row[mapping.description_col] ?? '')
    const txn_date = parseDate(row[mapping.date_col] ?? '', mapping.date_format)
    const amount = resolveAmount(row, mapping)

    let error: string | null = null
    if (!description) error = 'Missing description'
    else if (!txn_date) error = `Unreadable date: "${(row[mapping.date_col] ?? '').trim() || '(empty)'}"`
    else if (amount === null) error = `Unreadable amount: "${(row[mapping.amount_col] ?? '').trim() || '(empty)'}"`

    let duplicate = false
    if (!error && txn_date && amount !== null) {
      const hash = dedupeHash(card.id, txn_date, amount, description)
      duplicate = seenInFile.has(hash) || hashExists.get(hash) !== undefined
      seenInFile.add(hash)
    }

    const matched = error ? { category_id: null, expense_type: null } : applyRules(rules, description)
    const category_id = matched.category_id
    const expense_type: ExpenseType = matched.expense_type ?? FALLBACK_EXPENSE_TYPE

    return {
      index,
      txn_date,
      description,
      amount,
      expense_type,
      needsReview: !error && matched.expense_type === null,
      category_id,
      category_name: category_id !== null ? (categoryNames.get(category_id) ?? null) : null,
      duplicate,
      error
    }
  })

  return {
    rows: preview,
    newCount: preview.filter((r) => !r.error && !r.duplicate).length,
    duplicateCount: preview.filter((r) => !r.error && r.duplicate).length,
    errorCount: preview.filter((r) => r.error).length
  }
}

export function commitImport(
  db: Database.Database,
  cardId: number,
  filename: string,
  rows: CommitRow[]
): ImportResult {
  const insertBatch = db.prepare(
    'INSERT INTO import_batches (card_id, filename, row_count, inserted_count, skipped_count) VALUES (?, ?, ?, 0, 0)'
  )
  const updateBatch = db.prepare('UPDATE import_batches SET inserted_count = ?, skipped_count = ? WHERE id = ?')
  const insertTxn = db.prepare(
    `INSERT OR IGNORE INTO transactions
       (card_id, txn_date, description, amount, expense_type, category_id, import_batch_id, dedupe_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )

  let inserted = 0
  let skipped = 0
  let batchId = 0
  const run = db.transaction(() => {
    batchId = Number(insertBatch.run(cardId, filename, rows.length).lastInsertRowid)
    for (const row of rows) {
      const hash = dedupeHash(cardId, row.txn_date, row.amount, row.description)
      const result = insertTxn.run(
        cardId,
        row.txn_date,
        row.description,
        row.amount,
        row.expense_type,
        row.category_id,
        batchId,
        hash
      )
      if (result.changes > 0) inserted++
      else skipped++
    }
    updateBatch.run(inserted, skipped, batchId)
  })
  run()
  return { batchId, inserted, skipped }
}
