import { safeStorage } from 'electron'
import type Database from 'better-sqlite3'
import { getDb } from './db'
import { fetchAllOrders, probe, PoApiError } from './poClient'
import type { PoApiOrder, ReconConfig, ReconConfigInput, ReconSyncResult, ReconTestResult } from '@shared/types'

// Reconciliation config + PO sync. The pure network calls live in poClient.ts;
// this module owns the local state: connection settings (in app_config) and the
// cached PO records (in po_cache). The API token is stored encrypted via Electron
// safeStorage when available, and is never returned to the renderer.

const DEFAULTS = { dateBeforeDays: 1, dateAfterDays: 7, amountExactCents: 2, amountBandPct: 5 }
// Vendors that should have a PO (so an unmatched charge from them is worth flagging).
// Seeded with Amazon — the original priority — but fully editable in Settings.
const DEFAULT_TRACKED_VENDORS = ['Amazon']

function parseVendors(raw: string | null): string[] {
  if (!raw) return DEFAULT_TRACKED_VENDORS
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : DEFAULT_TRACKED_VENDORS
  } catch {
    return DEFAULT_TRACKED_VENDORS
  }
}

/** Normalize a tracked-vendor list: trim, drop blanks, de-dupe case-insensitively. */
function cleanVendors(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of list) {
    const name = v.trim()
    const key = name.toLowerCase()
    if (name && !seen.has(key)) {
      seen.add(key)
      out.push(name)
    }
  }
  return out
}

function getCfg(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

function setCfg(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value
  )
}

function delCfg(db: Database.Database, ...keys: string[]): void {
  const stmt = db.prepare('DELETE FROM app_config WHERE key = ?')
  for (const key of keys) stmt.run(key)
}

function num(value: string | null, fallback: number): number {
  const n = value == null ? NaN : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false // not running in a ready Electron app (e.g. tests)
  }
}

function storeToken(db: Database.Database, token: string | null): void {
  const trimmed = token?.trim() ?? ''
  if (!trimmed) {
    delCfg(db, 'po_token_enc', 'po_token_plain')
    return
  }
  if (encryptionAvailable()) {
    setCfg(db, 'po_token_enc', safeStorage.encryptString(trimmed).toString('base64'))
    delCfg(db, 'po_token_plain')
  } else {
    setCfg(db, 'po_token_plain', trimmed)
    delCfg(db, 'po_token_enc')
  }
}

function readToken(db: Database.Database): string | null {
  const enc = getCfg(db, 'po_token_enc')
  if (enc && encryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      return null
    }
  }
  return getCfg(db, 'po_token_plain')
}

export function getReconConfig(): ReconConfig {
  const db = getDb()
  const count = getCfg(db, 'po_last_sync_count')
  return {
    baseUrl: getCfg(db, 'po_base_url') ?? '',
    hasToken: !!readToken(db),
    dateBeforeDays: num(getCfg(db, 'recon_date_before'), DEFAULTS.dateBeforeDays),
    dateAfterDays: num(getCfg(db, 'recon_date_after'), DEFAULTS.dateAfterDays),
    amountExactCents: num(getCfg(db, 'recon_amount_exact_cents'), DEFAULTS.amountExactCents),
    amountBandPct: num(getCfg(db, 'recon_amount_band_pct'), DEFAULTS.amountBandPct),
    trackedVendors: parseVendors(getCfg(db, 'recon_tracked_vendors')),
    lastSyncAt: getCfg(db, 'po_last_sync_at'),
    lastSyncCount: count == null ? null : Number(count)
  }
}

export function setReconConfig(input: ReconConfigInput): ReconConfig {
  const db = getDb()
  if (input.baseUrl !== undefined) setCfg(db, 'po_base_url', input.baseUrl.trim().replace(/\/+$/, ''))
  if (input.token !== undefined) storeToken(db, input.token)
  if (input.dateBeforeDays !== undefined) setCfg(db, 'recon_date_before', String(input.dateBeforeDays))
  if (input.dateAfterDays !== undefined) setCfg(db, 'recon_date_after', String(input.dateAfterDays))
  if (input.amountExactCents !== undefined) setCfg(db, 'recon_amount_exact_cents', String(input.amountExactCents))
  if (input.amountBandPct !== undefined) setCfg(db, 'recon_amount_band_pct', String(input.amountBandPct))
  if (input.trackedVendors !== undefined) setCfg(db, 'recon_tracked_vendors', JSON.stringify(cleanVendors(input.trackedVendors)))
  return getReconConfig()
}

export async function testReconConnection(): Promise<ReconTestResult> {
  const db = getDb()
  const baseUrl = getCfg(db, 'po_base_url')
  const token = readToken(db)
  if (!baseUrl) return { ok: false, status: 0, message: 'Set the PO system URL first.' }
  if (!token) return { ok: false, status: 0, message: 'Set the API token first.' }
  try {
    const sampleCount = await probe(baseUrl, token)
    return { ok: true, status: 200, message: 'Connected to the PO system.', sampleCount }
  } catch (err) {
    if (err instanceof PoApiError) return { ok: false, status: err.status, message: err.message }
    return { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) }
  }
}

function upsertOrders(db: Database.Database, orders: PoApiOrder[]): number {
  const stmt = db.prepare(`
    INSERT INTO po_cache (
      id, po_number, po_date, vendor, subtotal, sales_tax, total, status,
      is_chargeback, chargeback_client, requester_name, requester_email,
      created_by_name, created_by_email, lines_json, synced_at
    ) VALUES (
      @id, @po_number, @po_date, @vendor, @subtotal, @sales_tax, @total, @status,
      @is_chargeback, @chargeback_client, @requester_name, @requester_email,
      @created_by_name, @created_by_email, @lines_json, datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      po_number = excluded.po_number, po_date = excluded.po_date, vendor = excluded.vendor,
      subtotal = excluded.subtotal, sales_tax = excluded.sales_tax, total = excluded.total,
      status = excluded.status, is_chargeback = excluded.is_chargeback,
      chargeback_client = excluded.chargeback_client, requester_name = excluded.requester_name,
      requester_email = excluded.requester_email, created_by_name = excluded.created_by_name,
      created_by_email = excluded.created_by_email, lines_json = excluded.lines_json,
      synced_at = datetime('now')
  `)
  const run = db.transaction((rows: PoApiOrder[]) => {
    for (const o of rows) {
      stmt.run({
        id: o.id,
        po_number: o.poNumber,
        po_date: o.date,
        vendor: o.vendor,
        subtotal: o.subtotal,
        sales_tax: o.salesTax,
        total: o.total,
        status: o.status ?? null,
        is_chargeback: o.isChargeback ? 1 : 0,
        chargeback_client: o.chargebackClient ?? null,
        requester_name: o.requester?.name ?? null,
        requester_email: o.requester?.email ?? null,
        created_by_name: o.createdBy?.name ?? null,
        created_by_email: o.createdBy?.email ?? null,
        lines_json: JSON.stringify(o.lines ?? [])
      })
    }
    return rows.length
  })
  return run(orders)
}

export async function syncPurchaseOrders(): Promise<ReconSyncResult> {
  const db = getDb()
  const baseUrl = getCfg(db, 'po_base_url')
  const token = readToken(db)
  if (!baseUrl) throw new Error('Set the PO system URL first.')
  if (!token) throw new Error('Set the API token first.')

  const orders = await fetchAllOrders(baseUrl, token)
  const upserted = upsertOrders(db, orders)
  const syncedAt = new Date().toISOString()
  setCfg(db, 'po_last_sync_at', syncedAt)
  setCfg(db, 'po_last_sync_count', String(orders.length))
  return { fetched: orders.length, upserted, syncedAt }
}
