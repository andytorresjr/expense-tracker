/**
 * Cardholder assignment round-trip.
 *
 * The card owner ("boss") hands each cardholder only their own charges so they
 * can categorize them (business/personal, category, client/attendees), then the
 * cardholder sends the file back and the boss merges the decisions onto the
 * exact original rows.
 *
 * The reused statement-import pipeline can't do this: it dedups on
 * card|date|amount|description, so re-importing a returned file would skip every
 * row as a duplicate, and commitImport ignores the category/type/client columns
 * on the way in. So assignments use a purpose-built packet instead.
 *
 * A packet is an .xlsx with three sheets:
 *  - Assignment  — key/value metadata (format marker, version, stage, card, …)
 *  - Categories  — the boss's category set (name/color/hotkey/requires_client)
 *                  so the cardholder categorizes with the same names + hotkeys
 *  - Transactions — one row per charge, carrying a `Ref` round-trip token
 *
 * The token is the boss transaction's `id:dedupe_hash`. The id locates the row
 * on the boss's machine; the hash (card+date+amount+description) is re-checked on
 * merge so a deleted-and-reimported row that reused the id can't be mis-updated.
 * The cardholder's copy carries the token verbatim in `transactions.source_token`
 * and re-emits it on the way back.
 */
import { readFileSync } from 'fs'
import * as XLSX from 'xlsx'
import type Database from 'better-sqlite3'
import type {
  AssignmentImportResult,
  AssignmentMergeResult,
  AssignmentMeta,
  AssignmentStage,
  ExpenseType
} from '@shared/types'
import { dedupeHash } from './importer'

export const ASSIGNMENT_FORMAT = 'expense-tracker-assignment'
export const ASSIGNMENT_VERSION = 1

const META_SHEET = 'Assignment'
const CATEGORIES_SHEET = 'Categories'
const TXN_SHEET = 'Transactions'
const TXN_HEADER = ['Ref', 'Date', 'Description', 'Amount', 'Type', 'Category', 'Cardholder', 'Client', 'Business Purpose']

const RESERVED_HOTKEYS = new Set(['b', 'p', 'r'])

/** One transaction row inside a packet, normalized to plain strings/number. A
 *  blank `type`/`category`/`client`/`businessPurpose` means "not provided" — on
 *  merge those leave the boss's existing value untouched. */
export interface AssignmentPacketRow {
  ref: string
  date: string
  description: string
  amount: number
  type: '' | ExpenseType
  category: string
  cardholder: string
  client: string
  businessPurpose: string
}

interface PacketCategory {
  name: string
  color: string | null
  hotkey: string | null
  requires_client: 0 | 1
}

export interface AssignmentPacket {
  meta: AssignmentMeta
  categories: PacketCategory[]
  rows: AssignmentPacketRow[]
}

// ---------- build ----------

/** The boss's category set, shipped in the packet so the cardholder categorizes
 *  with identical names and hotkeys — which makes the merge match cleanly by name. */
export function loadPacketCategories(db: Database.Database): PacketCategory[] {
  return db
    .prepare('SELECT name, color, hotkey, requires_client FROM categories WHERE is_archived = 0 ORDER BY name')
    .all() as PacketCategory[]
}

export function buildAssignmentPacket(
  meta: AssignmentMeta,
  categories: PacketCategory[],
  rows: AssignmentPacketRow[]
): Buffer {
  const workbook = XLSX.utils.book_new()

  const metaAoa: (string | number)[][] = [
    ['Field', 'Value'],
    ['format', meta.format],
    ['version', meta.version],
    ['stage', meta.stage],
    ['appVersion', meta.appVersion],
    ['cardName', meta.cardName],
    ['cardholder', meta.cardholder],
    ['exportedAt', meta.exportedAt]
  ]
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(metaAoa), META_SHEET)

  const catSheet = XLSX.utils.json_to_sheet(
    categories.map((c) => ({
      Name: c.name,
      Color: c.color ?? '',
      Hotkey: c.hotkey ?? '',
      'Requires Client': c.requires_client
    })),
    { header: ['Name', 'Color', 'Hotkey', 'Requires Client'] }
  )
  XLSX.utils.book_append_sheet(workbook, catSheet, CATEGORIES_SHEET)

  const txnSheet = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      Ref: r.ref,
      Date: r.date,
      Description: r.description,
      Amount: r.amount,
      Type: r.type,
      Category: r.category,
      Cardholder: r.cardholder,
      Client: r.client,
      'Business Purpose': r.businessPurpose
    })),
    { header: TXN_HEADER }
  )
  XLSX.utils.book_append_sheet(workbook, txnSheet, TXN_SHEET)

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

// ---------- read ----------

function normalizeType(raw: unknown): '' | ExpenseType {
  const value = String(raw ?? '').trim().toLowerCase()
  return value === 'business' || value === 'personal' ? value : ''
}

function parsePacketAmount(raw: unknown): number {
  if (typeof raw === 'number') return raw
  const value = String(raw ?? '').replace(/[$€£¥,\s]/g, '')
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

export function readAssignmentPacket(filePath: string): AssignmentPacket {
  const workbook = XLSX.read(readFileSync(filePath), { type: 'buffer' })

  const metaSheet = workbook.Sheets[META_SHEET]
  if (!metaSheet) {
    throw new Error('This file is not an Expense Tracker assignment packet (no Assignment sheet).')
  }
  const metaRows = XLSX.utils.sheet_to_json<{ Field: string; Value: unknown }>(metaSheet)
  const metaMap = new Map(metaRows.map((r) => [String(r.Field).trim(), String(r.Value ?? '').trim()]))
  if (metaMap.get('format') !== ASSIGNMENT_FORMAT) {
    throw new Error('This file is not an Expense Tracker assignment packet.')
  }
  const version = Number(metaMap.get('version') ?? 0)
  if (version > ASSIGNMENT_VERSION) {
    throw new Error(
      `This packet was created by a newer version of Expense Tracker (packet format v${version}). Update the app, then try again.`
    )
  }
  const stage: AssignmentStage = metaMap.get('stage') === 'returned' ? 'returned' : 'assigned'
  const meta: AssignmentMeta = {
    format: ASSIGNMENT_FORMAT,
    version,
    stage,
    appVersion: metaMap.get('appVersion') ?? '',
    cardName: metaMap.get('cardName') ?? '',
    cardholder: metaMap.get('cardholder') ?? '',
    exportedAt: metaMap.get('exportedAt') ?? ''
  }

  const catSheet = workbook.Sheets[CATEGORIES_SHEET]
  const categories: PacketCategory[] = catSheet
    ? XLSX.utils
        .sheet_to_json<Record<string, unknown>>(catSheet, { defval: '' })
        .map((r) => {
          const hotkey = String(r.Hotkey ?? '').trim().toLowerCase()
          return {
            name: String(r.Name ?? '').trim(),
            color: String(r.Color ?? '').trim() || null,
            hotkey: hotkey || null,
            requires_client: Number(r['Requires Client']) ? (1 as const) : (0 as const)
          }
        })
        .filter((c) => c.name)
    : []

  const txnSheet = workbook.Sheets[TXN_SHEET]
  if (!txnSheet) throw new Error('The assignment packet has no Transactions sheet.')
  const rows: AssignmentPacketRow[] = XLSX.utils
    .sheet_to_json<Record<string, unknown>>(txnSheet, { defval: '' })
    .map((r) => ({
      ref: String(r.Ref ?? '').trim(),
      date: String(r.Date ?? '').trim(),
      description: String(r.Description ?? '').trim(),
      amount: parsePacketAmount(r.Amount),
      type: normalizeType(r.Type),
      category: String(r.Category ?? '').trim(),
      cardholder: String(r.Cardholder ?? '').trim(),
      client: String(r.Client ?? '').trim(),
      businessPurpose: String(r['Business Purpose'] ?? '').trim()
    }))
    .filter((r) => r.ref || r.description)

  return { meta, categories, rows }
}

// ---------- fetch (boss export / cardholder return) ----------

interface BossAssignmentRow {
  id: number
  dedupe_hash: string
  txn_date: string
  description: string
  amount: number
  expense_type: ExpenseType | null
  cardholder: string | null
  client: string | null
  business_purpose: string | null
  category_name: string | null
  card_name: string
}

/** The boss's rows for one cardholder (optionally within a date range), turned
 *  into packet rows with an `id:dedupe_hash` round-trip token. */
export function fetchAssignmentRows(
  db: Database.Database,
  opts: { cardholder: string; dateFrom?: string; dateTo?: string }
): { cardName: string; rows: AssignmentPacketRow[] } {
  const clauses = ['t.cardholder = @cardholder']
  const params: Record<string, unknown> = { cardholder: opts.cardholder }
  if (opts.dateFrom) {
    clauses.push('t.txn_date >= @dateFrom')
    params.dateFrom = opts.dateFrom
  }
  if (opts.dateTo) {
    clauses.push('t.txn_date <= @dateTo')
    params.dateTo = opts.dateTo
  }
  const rows = db
    .prepare(
      `SELECT t.id, t.dedupe_hash, t.txn_date, t.description, t.amount, t.expense_type,
              t.cardholder, t.client, t.business_purpose, c.name AS category_name, ca.name AS card_name
       FROM transactions t
       JOIN cards ca ON ca.id = t.card_id
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY t.txn_date DESC, t.id DESC`
    )
    .all(params) as BossAssignmentRow[]

  const cardNames = Array.from(new Set(rows.map((r) => r.card_name)))
  const cardName = cardNames.length === 1 ? cardNames[0] : `${opts.cardholder} — assignment`
  return {
    cardName,
    rows: rows.map((r) => ({
      ref: `${r.id}:${r.dedupe_hash}`,
      date: r.txn_date,
      description: r.description,
      amount: r.amount,
      type: r.expense_type ?? '',
      category: r.category_name ?? '',
      cardholder: r.cardholder ?? '',
      client: r.client ?? '',
      businessPurpose: r.business_purpose ?? ''
    }))
  }
}

/** The cardholder's categorized rows for one assigned card, re-emitting the
 *  round-trip token so the boss can merge them back. */
export function fetchReturnedRows(db: Database.Database, cardId: number): AssignmentPacketRow[] {
  const rows = db
    .prepare(
      `SELECT t.source_token, t.txn_date, t.description, t.amount, t.expense_type,
              t.cardholder, t.client, t.business_purpose, c.name AS category_name
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.card_id = ? AND TRIM(COALESCE(t.source_token, '')) <> ''
       ORDER BY t.txn_date DESC, t.id DESC`
    )
    .all(cardId) as (Omit<BossAssignmentRow, 'id' | 'dedupe_hash' | 'card_name'> & { source_token: string })[]
  return rows.map((r) => ({
    ref: String(r.source_token),
    date: r.txn_date,
    description: r.description,
    amount: r.amount,
    type: r.expense_type ?? '',
    category: r.category_name ?? '',
    cardholder: r.cardholder ?? '',
    client: r.client ?? '',
    businessPurpose: r.business_purpose ?? ''
  }))
}

/** Cardholders with charges — the boss's "send to" list, biggest first. */
export function listAssignmentCardholders(db: Database.Database): { cardholder: string; count: number }[] {
  return db
    .prepare(
      `SELECT cardholder, COUNT(*) AS count FROM transactions
       WHERE TRIM(COALESCE(cardholder, '')) <> ''
       GROUP BY cardholder ORDER BY count DESC, cardholder`
    )
    .all() as { cardholder: string; count: number }[]
}

/** Cards holding assigned (token-carrying) rows — the cardholder's "send back" list. */
export function listReturnableCards(db: Database.Database): { cardId: number; cardName: string; count: number }[] {
  return db
    .prepare(
      `SELECT t.card_id AS cardId, ca.name AS cardName, COUNT(*) AS count
       FROM transactions t JOIN cards ca ON ca.id = t.card_id
       WHERE TRIM(COALESCE(t.source_token, '')) <> ''
       GROUP BY t.card_id, ca.name ORDER BY count DESC`
    )
    .all() as { cardId: number; cardName: string; count: number }[]
}

// ---------- import (cardholder side) ----------

/** Adopt the boss's categories so the cardholder picks from the same names and
 *  hotkeys. Returns how many were newly created. Hotkeys are claimed only when
 *  free and not reserved for the Quick Categorize controls. */
function adoptPacketCategories(db: Database.Database, categories: PacketCategory[]): number {
  const insert = db.prepare('INSERT OR IGNORE INTO categories (name, color, requires_client) VALUES (?, ?, ?)')
  const find = db.prepare('SELECT id, hotkey FROM categories WHERE name = ? AND is_archived = 0')
  const hotkeyTaken = db.prepare('SELECT 1 FROM categories WHERE lower(hotkey) = ? AND is_archived = 0')
  const setHotkey = db.prepare('UPDATE categories SET hotkey = ? WHERE id = ?')
  let added = 0
  for (const c of categories) {
    if (insert.run(c.name, c.color, c.requires_client).changes > 0) added++
    if (!c.hotkey || RESERVED_HOTKEYS.has(c.hotkey)) continue
    const cat = find.get(c.name) as { id: number; hotkey: string | null } | undefined
    if (cat && !cat.hotkey && !hotkeyTaken.get(c.hotkey)) setHotkey.run(c.hotkey, cat.id)
  }
  return added
}

/**
 * Import an 'assigned' packet into the cardholder's database. Rows land tagged
 * with their round-trip token (source_token). Boss-set categorization is carried
 * through and locked; unset fields stay blank for the cardholder to fill. Local
 * auto-rules are intentionally NOT applied — the cardholder's manual choices are
 * what flow back. Re-importing a refreshed packet updates matched rows in place
 * (matched by token) rather than duplicating.
 */
export function importAssignment(
  db: Database.Database,
  packet: AssignmentPacket,
  filename: string
): AssignmentImportResult {
  const result: AssignmentImportResult = { cardId: 0, cardName: '', inserted: 0, updated: 0, categoriesAdded: 0 }
  const run = db.transaction(() => {
    result.categoriesAdded = adoptPacketCategories(db, packet.categories)

    const cardName = packet.meta.cardName || `Assignment — ${packet.meta.cardholder || 'cardholder'}`
    let card = db.prepare('SELECT id, name FROM cards WHERE name = ?').get(cardName) as
      | { id: number; name: string }
      | undefined
    if (!card) {
      const info = db.prepare('INSERT INTO cards (name) VALUES (?)').run(cardName)
      card = { id: Number(info.lastInsertRowid), name: cardName }
    }
    result.cardId = card.id
    result.cardName = card.name

    const batchId = Number(
      db
        .prepare(
          'INSERT INTO import_batches (card_id, filename, row_count, inserted_count, skipped_count) VALUES (?, ?, ?, 0, 0)'
        )
        .run(card.id, filename, packet.rows.length).lastInsertRowid
    )

    const catMap = new Map(
      (db.prepare('SELECT id, lower(name) AS n FROM categories WHERE is_archived = 0').all() as {
        id: number
        n: string
      }[]).map((r) => [r.n, r.id])
    )
    const findByToken = db.prepare('SELECT id FROM transactions WHERE source_token = ?')
    const insTxn = db.prepare(
      `INSERT INTO transactions
         (card_id, txn_date, description, amount, expense_type, type_locked, category_id, category_locked,
          import_batch_id, dedupe_hash, cardholder, client, business_purpose, source_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const updTxn = db.prepare(
      `UPDATE transactions SET txn_date = ?, description = ?, amount = ?, expense_type = ?, category_id = ?,
         cardholder = ?, client = ?, business_purpose = ? WHERE id = ?`
    )

    for (const row of packet.rows) {
      const catId = row.category ? catMap.get(row.category.toLowerCase()) ?? null : null
      const type = row.type || null
      const existing = row.ref ? (findByToken.get(row.ref) as { id: number } | undefined) : undefined
      if (existing) {
        updTxn.run(
          row.date,
          row.description,
          row.amount,
          type,
          catId,
          row.cardholder || null,
          row.client || null,
          row.businessPurpose || null,
          existing.id
        )
        result.updated++
      } else {
        const hash = dedupeHash(card.id, row.date, row.amount, row.description)
        insTxn.run(
          card.id,
          row.date,
          row.description,
          row.amount,
          type,
          type ? 1 : 0,
          catId,
          catId ? 1 : 0,
          batchId,
          hash,
          row.cardholder || null,
          row.client || null,
          row.businessPurpose || null,
          row.ref || null
        )
        result.inserted++
      }
    }

    db.prepare('UPDATE import_batches SET inserted_count = ?, skipped_count = ? WHERE id = ?').run(
      result.inserted,
      result.updated,
      batchId
    )
  })
  run()
  return result
}

// ---------- merge (boss side) ----------

/**
 * Merge a 'returned' packet back onto the boss's transactions. Matches each row
 * by its `id:dedupe_hash` token (id locates the row, hash re-verifies it's still
 * the same charge) and UPDATEs categorization only — never inserts or deletes.
 * Cardholder-filled fields win; blanks leave the boss's value. Category names the
 * boss doesn't have are reported, not auto-created.
 */
export function mergeAssignment(db: Database.Database, packet: AssignmentPacket): AssignmentMergeResult {
  const catMap = new Map(
    (db.prepare('SELECT id, lower(name) AS n FROM categories WHERE is_archived = 0').all() as {
      id: number
      n: string
    }[]).map((r) => [r.n, r.id])
  )
  const findTxn = db.prepare('SELECT id, dedupe_hash FROM transactions WHERE id = ?')
  const updType = db.prepare('UPDATE transactions SET expense_type = ?, type_locked = 1 WHERE id = ?')
  const updCat = db.prepare('UPDATE transactions SET category_id = ?, category_locked = 1 WHERE id = ?')
  const updClient = db.prepare('UPDATE transactions SET client = ? WHERE id = ?')
  const updPurpose = db.prepare('UPDATE transactions SET business_purpose = ? WHERE id = ?')

  let updated = 0
  let unmatched = 0
  const unmatchedCategories = new Set<string>()

  const run = db.transaction(() => {
    for (const row of packet.rows) {
      const sep = row.ref.indexOf(':')
      const id = sep > 0 ? Number(row.ref.slice(0, sep)) : NaN
      const hash = sep > 0 ? row.ref.slice(sep + 1) : ''
      if (!id || !hash) {
        unmatched++
        continue
      }
      const txn = findTxn.get(id) as { id: number; dedupe_hash: string } | undefined
      if (!txn || txn.dedupe_hash !== hash) {
        unmatched++
        continue
      }
      let touched = false
      if (row.type) {
        updType.run(row.type, id)
        touched = true
      }
      if (row.category) {
        const catId = catMap.get(row.category.toLowerCase())
        if (catId === undefined) unmatchedCategories.add(row.category)
        else {
          updCat.run(catId, id)
          touched = true
        }
      }
      if (row.client) {
        updClient.run(row.client, id)
        touched = true
      }
      if (row.businessPurpose) {
        updPurpose.run(row.businessPurpose, id)
        touched = true
      }
      if (touched) updated++
    }
  })
  run()

  return { total: packet.rows.length, updated, unmatched, unmatchedCategories: [...unmatchedCategories] }
}
