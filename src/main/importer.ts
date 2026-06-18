import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
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

/** Raw cell grid read from a file before the header row is known. */
type Matrix = string[][]
type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

type PdfTextItem = {
  str: string
  transform: unknown[]
  width: number
  height: number
}

type PdfTextSpan = {
  page: number
  text: string
  x: number
  y: number
  width: number
  height: number
}

type PdfTextRow = {
  page: number
  y: number
  items: PdfTextSpan[]
}

type PdfColumnKind = 'date' | 'description' | 'amount' | 'debit' | 'credit' | 'ignored'

type PdfHeaderCandidate = {
  kind: Exclude<PdfColumnKind, 'ignored'>
  label: string
  x: number
  indexes: number[]
}

type PdfColumn = {
  key: string
  kind: PdfColumnKind
  x: number
}

type PdfHeader = {
  semanticColumns: PdfColumn[]
  boundaryColumns: PdfColumn[]
  rowCount: number
}

type PdfHeaderMatch = {
  index: number
  header: PdfHeader
  score: number
}

type PdfDateParts = {
  month: number
  day: number
  year: number | null
}

type PdfStatementPeriod = {
  start: string
  end: string
}

/** True when a cell reads as transaction data — a parseable date or amount. */
function isValueCell(cell: string): boolean {
  return cell !== '' && (parseAmount(cell) !== null || parseDate(cell, 'auto') !== null)
}

/**
 * Locate the column-header row in a raw cell grid.
 *
 * Statements frequently carry non-transaction rows above the real header:
 *  - preamble lines — Amex .xlsx leads with a title, "Prepared for", the account
 *    holder, the account number and a blank spacer;
 *  - summary/total blocks — many bank exports open with beginning/ending balance
 *    and total credit/debit lines.
 *
 * The header is distinguished by three traits, all required: it spans (nearly)
 * the full width of the widest row; it carries only text labels — no dates or
 * amounts, unlike both data rows *and* summary lines; and it sits directly above
 * value-bearing data. Requiring near-full width rejects narrow summary blocks and
 * 2-cell title banners; the "no values" test rejects label/value preamble pairs
 * and summary rows; the "data follows" test rejects a stray all-label line that
 * isn't actually a header. Taking the first such row keeps trailing totals out.
 *
 * Fallbacks cover atypical files (e.g. headers whose column names look numeric);
 * a degenerate single-column grid ultimately falls back to row 0.
 */
export function detectHeaderRow(matrix: Matrix): number {
  const fill = matrix.map((row) => row.reduce((n, c) => (c.trim() !== '' ? n + 1 : n), 0))
  const values = matrix.map((row) => row.reduce((n, c) => (isValueCell(c.trim()) ? n + 1 : n), 0))
  const maxFill = Math.max(0, ...fill)
  if (maxFill === 0) return 0
  // Allow one short cell so a header with an empty trailing label still counts.
  const widthBar = Math.max(2, maxFill - 1)

  const dataFollows = (i: number): boolean => {
    for (let j = i + 1; j < matrix.length; j++) {
      if (fill[j] === 0) continue // skip blank spacer rows
      return values[j] > 0
    }
    return false
  }

  // Primary: a (near-)full-width row of pure labels sitting above real data.
  for (let i = 0; i < matrix.length; i++) {
    if (fill[i] >= widthBar && values[i] === 0 && dataFollows(i)) return i
  }
  // Fallback A: two adjacent (near-)full-width rows — for headers whose own
  // column names parse as values, which the pure-label test above rejects.
  for (let i = 0; i < matrix.length - 1; i++) {
    if (fill[i] >= widthBar && fill[i + 1] >= widthBar) return i
  }
  // Fallback B: any (near-)full-width row (e.g. a header-only file).
  for (let i = 0; i < matrix.length; i++) {
    if (fill[i] >= widthBar) return i
  }
  return 0
}

/**
 * Turn a raw cell grid into a header list plus rows keyed by header name.
 * Detects the header row, drops unlabeled (blank-header) columns so they don't
 * surface as "__EMPTY" in the mapping UI, de-duplicates repeated header names
 * (suffixing `_2`, `_3`, …) so no column silently overwrites another, trims
 * every value, and skips rows that are entirely blank.
 */
function recordsFromMatrix(matrix: Matrix): { headers: string[]; rows: Record<string, string>[] } {
  const headerIdx = detectHeaderRow(matrix)
  const rawHeader = matrix[headerIdx] ?? []

  const seen = new Map<string, number>()
  const columns: { index: number; key: string }[] = []
  rawHeader.forEach((cell, index) => {
    const name = cell.trim()
    if (!name) return // unlabeled column — not mappable, so omit it
    const prior = seen.get(name) ?? 0
    seen.set(name, prior + 1)
    columns.push({ index, key: prior === 0 ? name : `${name}_${prior + 1}` })
  })

  const headers = columns.map((c) => c.key)
  const rows: Record<string, string>[] = []
  for (let r = headerIdx + 1; r < matrix.length; r++) {
    const row = matrix[r] ?? []
    const record: Record<string, string> = {}
    let hasValue = false
    for (const { index, key } of columns) {
      const value = (row[index] ?? '').trim()
      if (value) hasValue = true
      record[key] = value
    }
    if (hasValue) rows.push(record)
  }
  return { headers, rows }
}

async function loadPdfjs(): Promise<PdfJsModule> {
  return import('pdfjs-dist/legacy/build/pdf.mjs')
}

function pdfjsAssetPath(directory: 'standard_fonts' | 'cmaps'): string {
  return `${join(dirname(require.resolve('pdfjs-dist/package.json')), directory).replace(/\\/g, '/')}/`
}

function normalizePdfLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function normalizePdfText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function classifyPdfHeaderLabel(label: string): PdfHeaderCandidate['kind'] | null {
  const containsAmountLabel = /\b(amount|amt|debit|debits|credit|credits|charge|charges|payment|payments|refund|refunds)\b/.test(label)
  if (/^(transaction |trans |posted |post |posting |purchase )?date$/.test(label) || /^date of transaction$/.test(label)) {
    return 'date'
  }
  if (
    [
      'description',
      'transaction description',
      'description of transaction',
      'merchant name or transaction description',
      'merchant',
      'merchant name',
      'payee',
      'payee name',
      'name'
    ].includes(label)
    || (label.includes('description') && !containsAmountLabel)
  ) {
    return 'description'
  }
  if (/^(credit|credits|credit amount|payment|payments|refund|refunds|refund amount)$/.test(label)) return 'credit'
  if (/^(debit|debits|debit amount|charge|charges|charge amount|withdrawal|withdrawals|withdrawal amount)$/.test(label)) {
    return 'debit'
  }
  if (/^(amount|transaction amount|txn amount|amt)$/.test(label)) return 'amount'
  return null
}

function uniqueKeys(labels: string[]): string[] {
  const seen = new Map<string, number>()
  return labels.map((label) => {
    const clean = normalizePdfText(label)
    const fallback = clean || 'Column'
    const prior = seen.get(fallback) ?? 0
    seen.set(fallback, prior + 1)
    return prior === 0 ? fallback : `${fallback}_${prior + 1}`
  })
}

function pdfHeaderCandidates(row: PdfTextRow): PdfHeaderCandidate[] {
  const candidates: PdfHeaderCandidate[] = []
  for (let i = 0; i < row.items.length; i++) {
    for (let j = i; j < Math.min(row.items.length, i + 4); j++) {
      const label = normalizePdfText(row.items.slice(i, j + 1).map((item) => item.text).join(' '))
      const kind = classifyPdfHeaderLabel(normalizePdfLabel(label))
      if (!kind) continue
      candidates.push({
        kind,
        label,
        x: row.items[i].x,
        indexes: Array.from({ length: j - i + 1 }, (_, offset) => i + offset)
      })
    }
  }

  return candidates.sort((a, b) => {
    const lengthDiff = b.indexes.length - a.indexes.length
    return lengthDiff !== 0 ? lengthDiff : a.x - b.x
  })
}

function overlaps(a: number[], b: number[]): boolean {
  return a.some((n) => b.includes(n))
}

function takePdfHeaderCandidate(
  candidates: PdfHeaderCandidate[],
  kinds: PdfHeaderCandidate['kind'][],
  usedIndexes: number[]
): PdfHeaderCandidate | null {
  return candidates.find((candidate) => kinds.includes(candidate.kind) && !overlaps(candidate.indexes, usedIndexes)) ?? null
}

function detectPdfHeader(row: PdfTextRow): PdfHeader | null {
  const candidates = pdfHeaderCandidates(row)
  const usedIndexes: number[] = []

  const date = takePdfHeaderCandidate(candidates, ['date'], usedIndexes)
  if (!date) return null
  usedIndexes.push(...date.indexes)

  const description = takePdfHeaderCandidate(candidates, ['description'], usedIndexes)
  if (!description) return null
  usedIndexes.push(...description.indexes)

  const amountCandidates = candidates
    .filter((candidate) => ['amount', 'debit', 'credit'].includes(candidate.kind) && !overlaps(candidate.indexes, usedIndexes))
    .sort((a, b) => a.x - b.x)

  const amountColumns: PdfHeaderCandidate[] = []
  for (const candidate of amountCandidates) {
    if (amountColumns.some((prior) => overlaps(prior.indexes, candidate.indexes))) continue
    amountColumns.push(candidate)
  }
  if (amountColumns.length === 0) return null

  const semanticCandidates = [date, description, ...amountColumns].sort((a, b) => a.x - b.x)
  const semanticKeys = uniqueKeys(semanticCandidates.map((candidate) => candidate.label))
  const semanticColumns: PdfColumn[] = semanticCandidates.map((candidate, index) => ({
    key: semanticKeys[index],
    kind: candidate.kind,
    x: candidate.x
  }))

  const semanticIndexes = new Set(semanticCandidates.flatMap((candidate) => candidate.indexes))
  const boundaryColumns: PdfColumn[] = [...semanticColumns]
  row.items.forEach((item, index) => {
    if (semanticIndexes.has(index)) return
    if (boundaryColumns.some((column) => Math.abs(column.x - item.x) < 1)) return
    boundaryColumns.push({ key: `__ignored_${index}`, kind: 'ignored', x: item.x })
  })
  boundaryColumns.sort((a, b) => a.x - b.x)

  return { semanticColumns, boundaryColumns, rowCount: 1 }
}

function combinePdfHeaderRows(first: PdfTextRow, second: PdfTextRow): PdfTextRow {
  const clusters: PdfTextSpan[][] = []
  for (const item of [...first.items, ...second.items].sort((a, b) => a.x - b.x || b.y - a.y)) {
    const cluster = clusters.find((candidate) => Math.abs(candidate[0].x - item.x) <= 24)
    if (cluster) cluster.push(item)
    else clusters.push([item])
  }

  const items = clusters.map((cluster) => {
    const sorted = [...cluster].sort((a, b) => b.y - a.y || a.x - b.x)
    return {
      ...sorted[0],
      x: Math.min(...sorted.map((item) => item.x)),
      y: first.y,
      width: Math.max(...sorted.map((item) => item.x + item.width)) - Math.min(...sorted.map((item) => item.x)),
      text: normalizePdfText(sorted.map((item) => item.text).join(' '))
    }
  })

  return { page: first.page, y: first.y, items: items.sort((a, b) => a.x - b.x) }
}

function detectPdfHeaderAt(rows: PdfTextRow[], index: number): PdfHeader | null {
  const header = detectPdfHeader(rows[index])
  if (header) return header

  const next = rows[index + 1]
  if (!next || next.page !== rows[index].page || rows[index].y - next.y > 22) return null
  const combined = detectPdfHeader(combinePdfHeaderRows(rows[index], next))
  return combined ? { ...combined, rowCount: 2 } : null
}

function groupPdfTextRows(spans: PdfTextSpan[]): PdfTextRow[] {
  const rows: PdfTextRow[] = []
  const sorted = [...spans].sort((a, b) => b.y - a.y || a.x - b.x)

  for (const span of sorted) {
    const tolerance = Math.max(2.5, span.height * 0.6)
    const row = rows.find((candidate) => candidate.page === span.page && Math.abs(candidate.y - span.y) <= tolerance)
    if (row) {
      row.items.push(span)
      row.y = (row.y * (row.items.length - 1) + span.y) / row.items.length
    } else {
      rows.push({ page: span.page, y: span.y, items: [span] })
    }
  }

  for (const row of rows) row.items.sort((a, b) => a.x - b.x)
  return rows.sort((a, b) => a.page - b.page || b.y - a.y)
}

function projectPdfRow(row: PdfTextRow, header: PdfHeader): Record<string, string> {
  const projected: Record<string, string> = {}
  for (const column of header.semanticColumns) projected[column.key] = ''

  const columns = header.boundaryColumns
  const boundaries = columns.slice(0, -1).map((column, index) => (column.x + columns[index + 1].x) / 2)

  for (const item of row.items) {
    const columnIndex = boundaries.findIndex((boundary) => item.x < boundary)
    const column = columns[columnIndex === -1 ? columns.length - 1 : columnIndex]
    if (!column || column.kind === 'ignored') continue
    projected[column.key] = normalizePdfText(`${projected[column.key]} ${item.text}`)
  }

  return projected
}

function appendPdfDescription(record: Record<string, string>, descriptionKey: string, continuation: string): void {
  record[descriptionKey] = normalizePdfText(`${record[descriptionKey] ?? ''} ${continuation}`)
}

const PDF_MONTHS = new Map<string, number>(
  [
    ['jan', 1],
    ['january', 1],
    ['feb', 2],
    ['february', 2],
    ['mar', 3],
    ['march', 3],
    ['apr', 4],
    ['april', 4],
    ['may', 5],
    ['jun', 6],
    ['june', 6],
    ['jul', 7],
    ['july', 7],
    ['aug', 8],
    ['august', 8],
    ['sep', 9],
    ['sept', 9],
    ['september', 9],
    ['oct', 10],
    ['october', 10],
    ['nov', 11],
    ['november', 11],
    ['dec', 12],
    ['december', 12]
  ] as Array<[string, number]>
)

function normalizePdfYear(year: string | number): number {
  const n = Number(year)
  return n < 100 ? 2000 + n : n
}

function parsePdfDateParts(raw: string): PdfDateParts | null {
  const value = normalizePdfText(raw).replace(/\.$/, '')
  let match = value.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?$/)
  if (match) {
    return {
      month: Number(match[1]),
      day: Number(match[2]),
      year: match[3] ? normalizePdfYear(match[3]) : null
    }
  }

  match = value.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{2,4}))?$/)
  if (!match) return null
  const month = PDF_MONTHS.get(match[1].toLowerCase())
  if (!month) return null
  return {
    month,
    day: Number(match[2]),
    year: match[3] ? normalizePdfYear(match[3]) : null
  }
}

function pdfDatePartsToIso(parts: PdfDateParts, year: number): string | null {
  return buildIso(year, parts.month, parts.day)
}

function compareIso(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function inferPdfDateYear(parts: PdfDateParts, period: PdfStatementPeriod | null): string | null {
  if (parts.year !== null) return pdfDatePartsToIso(parts, parts.year)
  if (!period) return null

  const startYear = Number(period.start.slice(0, 4))
  const endYear = Number(period.end.slice(0, 4))
  const candidates = Array.from(new Set([startYear - 1, startYear, endYear, endYear + 1]))
  for (const year of candidates) {
    const iso = pdfDatePartsToIso(parts, year)
    if (iso && compareIso(iso, period.start) >= 0 && compareIso(iso, period.end) <= 0) return iso
  }

  return pdfDatePartsToIso(parts, endYear)
}

function normalizePdfTransactionDate(raw: string, period: PdfStatementPeriod | null): string | null {
  const parsed = parseDate(raw, 'auto')
  if (parsed) return parsed
  const parts = parsePdfDateParts(raw)
  if (!parts) return null
  return inferPdfDateYear(parts, period)
}

function extractPdfStatementPeriod(orderedRows: PdfTextRow[]): PdfStatementPeriod | null {
  for (const row of orderedRows.slice(0, 120)) {
    const text = normalizePdfText(row.items.map((item) => item.text).join(' '))
    const numeric = text.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})\s*[-–]\s*(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})/)
    if (numeric) {
      const start = normalizePdfTransactionDate(numeric[1], null)
      const end = normalizePdfTransactionDate(numeric[2], null)
      if (start && end) return { start, end }
    }

    const named = text.match(
      /([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\s*(?:through|-|–)\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/i
    )
    if (named) {
      const start = normalizePdfTransactionDate(named[1], null)
      const end = normalizePdfTransactionDate(named[2], null)
      if (start && end) return { start, end }
    }
  }

  return null
}

function scorePdfHeader(orderedRows: PdfTextRow[], startIndex: number, header: PdfHeader, period: PdfStatementPeriod | null): number {
  const dateColumn = header.semanticColumns.find((column) => column.kind === 'date')
  const descriptionColumn = header.semanticColumns.find((column) => column.kind === 'description')
  const amountColumns = header.semanticColumns.filter((column) => ['amount', 'debit', 'credit'].includes(column.kind))
  if (!dateColumn || !descriptionColumn || amountColumns.length === 0) return 0

  let score = 0
  const limit = Math.min(orderedRows.length, startIndex + header.rowCount + 180)
  for (let i = startIndex + header.rowCount; i < limit; i++) {
    const repeatedHeader = detectPdfHeaderAt(orderedRows, i)
    if (repeatedHeader) {
      i += repeatedHeader.rowCount - 1
      continue
    }

    const projected = projectPdfRow(orderedRows[i], header)
    const dateText = normalizePdfTransactionDate(projected[dateColumn.key] ?? '', period)
    const descriptionText = projected[descriptionColumn.key] ?? ''
    const hasDate = parseDate(dateText ?? '', 'auto') !== null
    const hasAmount = amountColumns.some((column) => parseAmount(projected[column.key] ?? '') !== null)
    if (hasDate && hasAmount && descriptionText) score += 4
    else if (hasDate && hasAmount) score += 2
  }

  return score
}

function findBestPdfHeader(orderedRows: PdfTextRow[], period: PdfStatementPeriod | null): PdfHeaderMatch | null {
  const candidates: PdfHeaderMatch[] = []
  for (let index = 0; index < orderedRows.length; index++) {
    const header = detectPdfHeaderAt(orderedRows, index)
    if (!header) continue
    candidates.push({ index, header, score: scorePdfHeader(orderedRows, index, header, period) })
  }

  if (candidates.length === 0) return null
  return candidates.sort((a, b) => b.score - a.score || a.index - b.index)[0]
}

function compactPdfRowLabel(row: PdfTextRow): string {
  const words = normalizePdfLabel(row.items.map((item) => item.text).join(' ')).split(/\s+/).filter(Boolean)
  const compacted: string[] = []
  for (const word of words) {
    if (compacted[compacted.length - 1] !== word) compacted.push(word)
  }
  return compacted.join(' ')
}

function isPdfTransactionSectionStart(row: PdfTextRow): boolean {
  const label = compactPdfRowLabel(row)
  return (
    label === 'account activity' ||
    label === 'transactions' ||
    label === 'start transaction detail' ||
    /^transaction detail(?: continued)?$/.test(label)
  )
}

function isPdfTransactionSectionEnd(row: PdfTextRow): boolean {
  return compactPdfRowLabel(row) === 'end transaction detail'
}

function recordsFromDirectPdfRows(
  orderedRows: PdfTextRow[],
  period: PdfStatementPeriod | null
): { headers: string[]; rows: Record<string, string>[] } {
  const headers = ['Date', 'Description', 'Amount']
  const rows: Record<string, string>[] = []
  let inTransactionSection = false

  for (const textRow of orderedRows) {
    if (isPdfTransactionSectionStart(textRow)) {
      inTransactionSection = true
      continue
    }
    if (isPdfTransactionSectionEnd(textRow)) {
      inTransactionSection = false
      continue
    }
    if (!inTransactionSection) continue
    if (textRow.items.length < 3) continue
    const dateItem = textRow.items.find((item) => item.x < 120 && normalizePdfTransactionDate(item.text, period) !== null)
    if (!dateItem) continue

    const amountItems = textRow.items
      .map((item) => ({ item, amount: parseAmount(item.text) }))
      .filter((candidate) => candidate.amount !== null && candidate.item.x > dateItem.x + 80)
      .sort((a, b) => a.item.x - b.item.x)
    if (amountItems.length === 0) continue

    const rightSideAmounts = amountItems.filter((candidate) => candidate.item.x > 300)
    const amountItem =
      rightSideAmounts.length >= 2
        ? rightSideAmounts[rightSideAmounts.length - 2].item
        : (rightSideAmounts[rightSideAmounts.length - 1]?.item ?? amountItems[amountItems.length - 1].item)

    const description = normalizePdfText(
      textRow.items
        .filter((item) => item.x > dateItem.x + 20 && item.x < amountItem.x - 8)
        .filter((item) => !(item.x < dateItem.x + 150 && normalizePdfTransactionDate(item.text, period) !== null))
        .map((item) => item.text)
        .join(' ')
    )
    const date = normalizePdfTransactionDate(dateItem.text, period)
    const amount = normalizePdfText(amountItem.text)
    if (!date || !description || parseAmount(amount) === null) continue

    rows.push({ Date: date, Description: description, Amount: amount })
  }

  return { headers, rows }
}

function pdfRecordQuality(records: { headers: string[]; rows: Record<string, string>[] }): number {
  const dateHeader = records.headers.find((header) => header.toLowerCase().includes('date'))
  const descriptionHeader = records.headers.find((header) => /(description|merchant|payee|name)/i.test(header))
  const amountHeader = records.headers.find((header) => /(amount|debit|credit|charge)/i.test(header))
  if (!dateHeader || !descriptionHeader || !amountHeader) return 0

  return records.rows.filter(
    (row) =>
      parseDate(row[dateHeader] ?? '', 'auto') !== null &&
      normalizeDescription(row[descriptionHeader] ?? '') !== '' &&
      parseAmount(row[amountHeader] ?? '') !== null
  ).length
}

function buildPdfRecords(orderedRows: PdfTextRow[]): { headers: string[]; rows: Record<string, string>[] } {
  const period = extractPdfStatementPeriod(orderedRows)
  const directRecords = recordsFromDirectPdfRows(orderedRows, period)
  const match = findBestPdfHeader(orderedRows, period)
  if (!match) {
    if (directRecords.rows.length > 0) return directRecords
    throw new Error('No transaction table header found in the PDF. Use a statement with date, description, and amount columns.')
  }

  if (match.score === 0) {
    if (directRecords.rows.length > 0) return directRecords
    throw new Error('No transaction rows found in the PDF statement.')
  }

  const headerIndex = match.index
  const header = match.header
  const dateColumn = header.semanticColumns.find((column) => column.kind === 'date')
  const descriptionColumn = header.semanticColumns.find((column) => column.kind === 'description')
  const amountColumns = header.semanticColumns.filter((column) => ['amount', 'debit', 'credit'].includes(column.kind))
  if (!dateColumn || !descriptionColumn || amountColumns.length === 0) {
    throw new Error('No transaction table header found in the PDF. Use a statement with date, description, and amount columns.')
  }

  const rows: Record<string, string>[] = []
  let current: { record: Record<string, string>; page: number; y: number } | null = null

  for (let i = headerIndex + header.rowCount; i < orderedRows.length; i++) {
    const textRow = orderedRows[i]
    const repeatedHeader = detectPdfHeaderAt(orderedRows, i)
    if (repeatedHeader) {
      current = null
      i += repeatedHeader.rowCount - 1
      continue
    }

    const projected = projectPdfRow(textRow, header)
    const dateText = normalizePdfTransactionDate(projected[dateColumn.key] ?? '', period)
    if (dateText) projected[dateColumn.key] = dateText
    const descriptionText = projected[descriptionColumn.key] ?? ''
    const hasDate = parseDate(dateText ?? '', 'auto') !== null
    const hasAmount = amountColumns.some((column) => parseAmount(projected[column.key] ?? '') !== null)

    if (hasDate && (descriptionText || hasAmount)) {
      rows.push(projected)
      current = { record: projected, page: textRow.page, y: textRow.y }
      continue
    }

    const verticalGap = current && current.page === textRow.page ? current.y - textRow.y : Number.POSITIVE_INFINITY
    if (current && !hasDate && !hasAmount && descriptionText && verticalGap > 0 && verticalGap <= 20) {
      appendPdfDescription(current.record, descriptionColumn.key, descriptionText)
      current.y = textRow.y
    }
  }

  if (rows.length === 0) {
    if (directRecords.rows.length > 0) return directRecords
    throw new Error('No transaction rows found in the PDF statement.')
  }

  const headerRecords = { headers: header.semanticColumns.map((column) => column.key), rows }
  return pdfRecordQuality(directRecords) >= pdfRecordQuality(headerRecords) && directRecords.rows.length > 0
    ? directRecords
    : headerRecords
}

function isPdfPasswordError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const name = (err as Error & { name?: string }).name
  return name === 'PasswordException' || /password/i.test(err.message)
}

async function recordsFromPdf(filePath: string): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const pdfjs = await loadPdfjs()
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(readFileSync(filePath)),
    cMapPacked: true,
    cMapUrl: pdfjsAssetPath('cmaps'),
    isEvalSupported: false,
    standardFontDataUrl: pdfjsAssetPath('standard_fonts'),
    useWorkerFetch: false
  })

  try {
    const pdf = await loadingTask.promise
    const spans: PdfTextSpan[] = []

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      for (const item of content.items) {
        if (!('str' in item)) continue
        const textItem = item as PdfTextItem
        const text = normalizePdfText(textItem.str)
        if (!text) continue
        const transform = textItem.transform
        const x = Number(transform[4] ?? 0)
        const y = Number(transform[5] ?? 0)
        const height = Math.abs(Number(textItem.height || transform[3] || 0)) || 10
        spans.push({ page: pageNumber, text, x, y, width: textItem.width, height })
      }
    }

    await pdf.destroy()

    if (spans.length === 0) {
      throw new Error('No selectable text found in the PDF. Scanned or image-only statements are not supported.')
    }

    return buildPdfRecords(groupPdfTextRows(spans))
  } catch (err) {
    if (isPdfPasswordError(err)) {
      throw new Error('Password-protected PDF statements are not supported. Export an unlocked CSV, Excel, or selectable-text PDF statement.')
    }
    throw err
  } finally {
    await loadingTask.destroy()
  }
}

export async function parseFile(filePath: string): Promise<ParsedFile> {
  const ext = extname(filePath).toLowerCase()
  let parsed: { headers: string[]; rows: Record<string, string>[] }

  if (ext === '.csv') {
    // strip a leading BOM so it can't cling to the first header name
    const content = readFileSync(filePath, 'utf8').replace(/^﻿/, '')
    const result = Papa.parse<string[]>(content, { skipEmptyLines: 'greedy' })
    parsed = recordsFromMatrix(result.data.map((row) => row.map((c) => String(c ?? ''))))
  } else if (ext === '.xlsx' || ext === '.xls') {
    const workbook = XLSX.read(readFileSync(filePath), { type: 'buffer' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    if (!sheet) throw new Error('The workbook has no sheets.')
    // header:1 reads the sheet as a raw grid (no header assumed); raw:false
    // renders dates/numbers as display text so every cell comes through a string
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      blankrows: false,
      defval: ''
    })
    parsed = recordsFromMatrix(aoa.map((row) => row.map((c) => String(c ?? ''))))
  } else if (ext === '.pdf') {
    parsed = await recordsFromPdf(filePath)
  } else {
    throw new Error(`Unsupported file type: ${ext}. Use .csv, .xlsx, .xls or .pdf.`)
  }

  const { headers, rows } = parsed
  if (headers.length === 0 || rows.length === 0) {
    throw new Error('No data rows found in the file.')
  }
  return { path: filePath, filename: basename(filePath), headers, rows, rowCount: rows.length }
}

// ---------- normalization ----------

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
    const expense_type: ExpenseType | null = matched.expense_type

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
