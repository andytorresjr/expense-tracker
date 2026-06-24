import type Database from 'better-sqlite3'
import { getReconConfig } from './reconcile'
import { amountScore, combineConfidence, dateDeltaDays, dateScore, vendorMatches } from './matchScore'
import type {
  PoLineLite,
  ReconCandidate,
  ReconLedger,
  ReconLedgerItem,
  ReconMatchResult,
  ReconReviewItem,
  ReconUnmatchedCharge
} from '@shared/types'

// Orchestrates matching statement charges (transactions) to cached POs (po_cache),
// writing candidate links into po_links. Pure scoring lives in matchScore.ts; this
// module owns the DB I/O and the assignment policy:
//   - auto-link a charge only when it has exactly ONE exact-amount candidate and
//     neither side is already taken (no double-booking),
//   - everything else with a viable candidate goes to the review queue (pending),
//   - confirmed/rejected links from earlier runs are preserved and respected.

interface ChargeRow {
  id: number
  txn_date: string
  description: string
  amount: number
  card_name: string
}

interface PoRow {
  id: string
  po_number: number
  po_date: string
  vendor: string
  total: number
  requester_name: string | null
  lines_json: string
}

function parseLines(json: string): PoLineLite[] {
  try {
    const parsed = JSON.parse(json) as PoLineLite[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function runMatch(db: Database.Database): ReconMatchResult {
  const cfg = getReconConfig()
  const charges = db
    .prepare(
      `SELECT t.id, t.txn_date, t.description, t.amount, ca.name AS card_name
       FROM transactions t JOIN cards ca ON ca.id = t.card_id
       WHERE t.amount > 0`
    )
    .all() as ChargeRow[]
  const pos = db
    .prepare('SELECT id, po_number, po_date, vendor, total, requester_name, lines_json FROM po_cache')
    .all() as PoRow[]

  const confirmed = db.prepare("SELECT txn_id, po_id FROM po_links WHERE status = 'confirmed'").all() as {
    txn_id: number
    po_id: string
  }[]
  const rejected = new Set(
    (db.prepare("SELECT txn_id || ':' || po_id AS k FROM po_links WHERE status = 'rejected'").all() as { k: string }[]).map(
      (r) => r.k
    )
  )
  const takenTxn = new Set(confirmed.map((c) => c.txn_id))
  const takenPo = new Set(confirmed.map((c) => c.po_id))

  interface Candidate {
    txnId: number
    poId: string
    confidence: number
    tier: string
    amountDiff: number
    delta: number
    dateScore: number
  }
  const candidates: Candidate[] = []
  const exactCountByTxn = new Map<number, number>()

  for (const charge of charges) {
    if (takenTxn.has(charge.id)) continue
    for (const po of pos) {
      if (takenPo.has(po.id)) continue
      if (rejected.has(`${charge.id}:${po.id}`)) continue
      if (!vendorMatches(charge.description, po.vendor)) continue

      const amount = amountScore(charge.amount, po.total, cfg.amountExactCents, cfg.amountBandPct)
      if (amount.score === 0) continue
      const delta = dateDeltaDays(charge.txn_date, po.po_date)
      const ds = dateScore(delta, cfg.dateBeforeDays, cfg.dateAfterDays)
      if (ds === null) continue

      candidates.push({
        txnId: charge.id,
        poId: po.id,
        confidence: combineConfidence(amount.score, ds),
        tier: amount.tier,
        amountDiff: amount.diff,
        delta,
        dateScore: ds
      })
      if (amount.tier === 'exact') exactCountByTxn.set(charge.id, (exactCountByTxn.get(charge.id) ?? 0) + 1)
    }
  }

  // Exact matches first, then by confidence — so auto-links claim the best pairs.
  candidates.sort((a, b) => Number(b.tier === 'exact') - Number(a.tier === 'exact') || b.confidence - a.confidence)

  db.prepare("DELETE FROM po_links WHERE status IN ('auto','pending')").run()
  const insert = db.prepare(
    'INSERT OR IGNORE INTO po_links (txn_id, po_id, status, confidence, score_json) VALUES (?, ?, ?, ?, ?)'
  )
  const breakdown = (c: Candidate): string =>
    JSON.stringify({ tier: c.tier, amountDiff: c.amountDiff, delta: c.delta, dateScore: c.dateScore })

  const autoTxn = new Set<number>()
  const autoPo = new Set<string>()
  let autoLinked = 0
  let candidatesWritten = 0

  const write = db.transaction(() => {
    // Pass 1: auto-link unambiguous exact matches (one exact candidate, both free).
    for (const c of candidates) {
      if (c.tier !== 'exact' || (exactCountByTxn.get(c.txnId) ?? 0) !== 1) continue
      if (autoTxn.has(c.txnId) || autoPo.has(c.poId)) continue
      insert.run(c.txnId, c.poId, 'auto', c.confidence, breakdown(c))
      autoTxn.add(c.txnId)
      autoPo.add(c.poId)
      autoLinked++
      candidatesWritten++
    }
    // Pass 2: queue remaining viable candidates whose charge + PO aren't auto-claimed.
    for (const c of candidates) {
      if (autoTxn.has(c.txnId) || autoPo.has(c.poId)) continue
      insert.run(c.txnId, c.poId, 'pending', c.confidence, breakdown(c))
      candidatesWritten++
    }
  })
  write()

  const queued = (db.prepare("SELECT COUNT(DISTINCT txn_id) AS n FROM po_links WHERE status = 'pending'").get() as {
    n: number
  }).n

  return { autoLinked, queued, candidatesWritten, chargesConsidered: charges.length, posConsidered: pos.length }
}

interface CandidateRow {
  link_id: number
  status: ReconCandidate['status']
  confidence: number | null
  txn_id: number
  txn_date: string
  description: string
  amount: number
  card_name: string
  po_id: string
  po_number: number
  po_date: string
  vendor: string
  total: number
  requester_name: string | null
  lines_json: string
}

/** Charges with one or more pending candidates, each charge's options ranked. */
export function getReviewQueue(db: Database.Database): ReconReviewItem[] {
  const rows = db
    .prepare(
      `SELECT l.id AS link_id, l.status, l.confidence,
              t.id AS txn_id, t.txn_date, t.description, t.amount, ca.name AS card_name,
              p.id AS po_id, p.po_number, p.po_date, p.vendor, p.total, p.requester_name, p.lines_json
       FROM po_links l
       JOIN transactions t ON t.id = l.txn_id
       JOIN cards ca ON ca.id = t.card_id
       JOIN po_cache p ON p.id = l.po_id
       WHERE l.status = 'pending'
       ORDER BY t.txn_date DESC, t.id DESC, l.confidence DESC`
    )
    .all() as CandidateRow[]

  const byTxn = new Map<number, ReconReviewItem>()
  for (const r of rows) {
    let item = byTxn.get(r.txn_id)
    if (!item) {
      item = {
        txnId: r.txn_id,
        txnDate: r.txn_date,
        description: r.description,
        amount: r.amount,
        cardName: r.card_name,
        candidates: []
      }
      byTxn.set(r.txn_id, item)
    }
    item.candidates.push({
      linkId: r.link_id,
      poId: r.po_id,
      poNumber: r.po_number,
      poDate: r.po_date,
      vendor: r.vendor,
      total: r.total,
      requesterName: r.requester_name,
      status: r.status,
      confidence: r.confidence ?? 0,
      lines: parseLines(r.lines_json)
    })
  }
  return [...byTxn.values()]
}

/** Confirm a link: it becomes the charge's match and frees nothing else to claim
 *  that charge or that PO (one charge ↔ one PO). */
export function confirmLink(db: Database.Database, linkId: number): boolean {
  const link = db.prepare('SELECT txn_id, po_id FROM po_links WHERE id = ?').get(linkId) as
    | { txn_id: number; po_id: string }
    | undefined
  if (!link) throw new Error('Match not found.')
  const run = db.transaction(() => {
    db.prepare("UPDATE po_links SET status = 'confirmed' WHERE id = ?").run(linkId)
    db.prepare(
      "DELETE FROM po_links WHERE id <> ? AND status IN ('auto','pending') AND (txn_id = ? OR po_id = ?)"
    ).run(linkId, link.txn_id, link.po_id)
  })
  run()
  return true
}

/** Reject a link: tombstoned as 'rejected' so re-running the matcher won't re-suggest it. */
export function rejectLink(db: Database.Database, linkId: number): boolean {
  const info = db.prepare("UPDATE po_links SET status = 'rejected' WHERE id = ?").run(linkId)
  if (info.changes === 0) throw new Error('Match not found.')
  return true
}

/** Statement charges with no PO, scoped to the configured "tracked" vendors
 *  (vendors that should have a PO) so the report isn't drowned by normal non-PO
 *  spend like utilities, fuel, or fees. Amazon is just one tracked vendor. */
export function getUnmatchedCharges(db: Database.Database): ReconUnmatchedCharge[] {
  const tracked = getReconConfig().trackedVendors
  if (tracked.length === 0) return []
  const charges = db
    .prepare(
      `SELECT t.id AS txnId, t.txn_date AS txnDate, t.description, t.amount, ca.name AS cardName
       FROM transactions t JOIN cards ca ON ca.id = t.card_id
       WHERE t.amount > 0
         AND NOT EXISTS (
           SELECT 1 FROM po_links l WHERE l.txn_id = t.id AND l.status IN ('auto','pending','confirmed')
         )
       ORDER BY t.txn_date DESC`
    )
    .all() as ReconUnmatchedCharge[]
  return charges.filter((c) => tracked.some((v) => vendorMatches(c.description, v)))
}

interface LedgerLinkRow {
  po_id: string
  status: 'auto' | 'pending' | 'confirmed' | 'rejected'
  txn_id: number
  txn_date: string
  description: string
  amount: number
}

/** PO-centric reconciliation ledger: every PO and how it lines up to the statement
 *  (matched to a specific charge, awaiting review, or not yet on the statement),
 *  plus summary totals. This is the primary "match POs to the statement" view. */
export function getLedger(db: Database.Database): ReconLedger {
  const pos = db
    .prepare('SELECT id, po_number, po_date, vendor, total, requester_name FROM po_cache ORDER BY po_date DESC, po_number DESC')
    .all() as PoRow[]
  const links = db
    .prepare(
      `SELECT l.po_id, l.status, l.txn_id, t.txn_date, t.description, t.amount
       FROM po_links l JOIN transactions t ON t.id = l.txn_id
       WHERE l.status IN ('auto','pending','confirmed')`
    )
    .all() as LedgerLinkRow[]

  const byPo = new Map<string, LedgerLinkRow[]>()
  for (const l of links) {
    const list = byPo.get(l.po_id)
    if (list) list.push(l)
    else byPo.set(l.po_id, [l])
  }

  let matchedPos = 0
  let reviewPos = 0
  let unmatchedPos = 0
  let amountReconciled = 0

  const items: ReconLedgerItem[] = pos.map((po) => {
    const ls = byPo.get(po.id) ?? []
    const matched = ls.find((l) => l.status === 'confirmed') ?? ls.find((l) => l.status === 'auto')
    const pendings = ls.filter((l) => l.status === 'pending')

    const item: ReconLedgerItem = {
      poId: po.id,
      poNumber: po.po_number,
      poDate: po.po_date,
      vendor: po.vendor,
      total: po.total,
      requesterName: po.requester_name,
      status: 'unmatched',
      matchedTxnId: null,
      matchedTxnDate: null,
      matchedDescription: null,
      matchedAmount: null,
      linkStatus: null,
      reviewCount: 0
    }

    if (matched) {
      matchedPos++
      amountReconciled += po.total
      item.status = 'matched'
      item.matchedTxnId = matched.txn_id
      item.matchedTxnDate = matched.txn_date
      item.matchedDescription = matched.description
      item.matchedAmount = matched.amount
      item.linkStatus = matched.status
    } else if (pendings.length > 0) {
      reviewPos++
      item.status = 'review'
      item.reviewCount = pendings.length
    } else {
      unmatchedPos++
    }
    return item
  })

  return {
    summary: { totalPos: pos.length, matchedPos, reviewPos, unmatchedPos, amountReconciled },
    items
  }
}
