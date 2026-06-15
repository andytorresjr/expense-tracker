/**
 * Headless verification of the import pipeline (run with `npm run selftest`).
 * Exercises the real main-process modules against the sample statements,
 * covering the §10 milestone checks: schema, import, dedupe on re-import,
 * default expense type, type toggling with lock semantics.
 */
import { app } from 'electron'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import * as XLSX from 'xlsx'
import { initDb, closeDb } from './db'
import { buildPreview, commitImport, detectHeaderRow, parseFile } from './importer'
import { rerunRules } from './rules'
import type { Card, ColumnMapping, CommitRow, ExpenseType } from '@shared/types'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

export async function runSelfTest(): Promise<number> {
  const dbPath = join(app.getPath('userData'), 'selftest.db')
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix)
  }
  const db = initDb(dbPath)

  console.log('\n[1] Schema & seed')
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name)
  for (const t of ['cards', 'import_profiles', 'categories', 'category_rules', 'transactions', 'import_batches', 'budgets']) {
    check(`table ${t} exists`, tables.includes(t))
  }
  const catCount = (db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n
  check('categories seeded', catCount === 9, `got ${catCount}`)

  console.log('\n[2] Setup: card (default business) + rules')
  db.prepare("INSERT INTO cards (name, default_expense_type) VALUES ('Owner Personal Visa', 'business')").run()
  const card = db.prepare('SELECT * FROM cards WHERE id = 1').get() as Card
  const travelId = (db.prepare("SELECT id FROM categories WHERE name = 'Travel'").get() as { id: number }).id
  const mealsId = (db.prepare("SELECT id FROM categories WHERE name = 'Meals & Entertainment'").get() as { id: number }).id
  // category-only rule, type-only rule, combined rule
  db.prepare("INSERT INTO category_rules (category_id, expense_type, match_type, pattern, priority) VALUES (?, NULL, 'contains', 'starbucks', 0)").run(mealsId)
  db.prepare("INSERT INTO category_rules (category_id, expense_type, match_type, pattern, priority) VALUES (NULL, 'personal', 'contains', 'netflix', 0)").run()
  db.prepare("INSERT INTO category_rules (category_id, expense_type, match_type, pattern, priority) VALUES (?, 'business', 'contains', 'delta air', 0)").run(travelId)

  console.log('\n[3] Parse + preview sample-chase.csv (negative = expense)')
  const chase = parseFile(join(app.getAppPath(), 'samples', 'sample-chase.csv'))
  check('parsed 8 rows', chase.rowCount === 8, `got ${chase.rowCount}`)
  const chaseMapping: ColumnMapping = {
    date_col: 'Transaction Date',
    amount_col: 'Amount',
    amount_col_secondary: null,
    description_col: 'Description',
    date_format: 'MM/DD/YYYY',
    amount_sign: 'expense_negative'
  }
  const preview = buildPreview(db, card, chase.rows, chaseMapping)
  check('no parse errors', preview.errorCount === 0, JSON.stringify(preview.rows.filter((r) => r.error)))
  check('no duplicates on first import', preview.duplicateCount === 0)
  const starbucks = preview.rows.find((r) => r.description.toLowerCase().includes('starbucks'))
  check('rule set Starbucks category', starbucks?.category_name === 'Meals & Entertainment')
  check('Starbucks type from card default', starbucks?.expense_type === 'business')
  const netflix = preview.rows.find((r) => r.description.toLowerCase().includes('netflix'))
  check('type rule flagged Netflix personal', netflix?.expense_type === 'personal')
  const delta = preview.rows.find((r) => r.description.toLowerCase().includes('delta'))
  check('combined rule: Delta category + type', delta?.category_name === 'Travel' && delta?.expense_type === 'business')
  check('negative amounts normalized positive', preview.rows.every((r) => (r.amount ?? 0) > 0))

  console.log('\n[4] Commit + dedupe on re-import')
  const toCommit: CommitRow[] = preview.rows
    .filter((r) => !r.error && !r.duplicate)
    .map((r) => ({
      txn_date: r.txn_date!,
      description: r.description,
      amount: r.amount!,
      expense_type: r.expense_type,
      category_id: r.category_id
    }))
  const first = commitImport(db, card.id, chase.filename, toCommit)
  check('first import inserted 8', first.inserted === 8, `inserted ${first.inserted}, skipped ${first.skipped}`)
  const second = commitImport(db, card.id, chase.filename, toCommit)
  check('re-import inserted 0', second.inserted === 0, `inserted ${second.inserted}`)
  check('re-import skipped 8', second.skipped === 8, `skipped ${second.skipped}`)
  const batches = (db.prepare('SELECT COUNT(*) AS n FROM import_batches').get() as { n: number }).n
  check('two import batches recorded', batches === 2)
  const repreview = buildPreview(db, card, chase.rows, chaseMapping)
  check('preview now flags all rows duplicate', repreview.duplicateCount === 8)

  console.log('\n[5] Second format: debit/credit columns (sample-bank.csv)')
  const bank = parseFile(join(app.getAppPath(), 'samples', 'sample-bank.csv'))
  const bankMapping: ColumnMapping = {
    date_col: 'Date',
    amount_col: 'Debit',
    amount_col_secondary: 'Credit',
    description_col: 'Merchant',
    date_format: 'auto',
    amount_sign: 'expense_positive'
  }
  const bankPreview = buildPreview(db, card, bank.rows, bankMapping)
  check('bank file: no parse errors', bankPreview.errorCount === 0, JSON.stringify(bankPreview.rows.filter((r) => r.error)))
  const refund = bankPreview.rows.find((r) => r.description.toLowerCase().includes('refund'))
  check('credit column stored as negative (refund)', (refund?.amount ?? 0) < 0, `got ${refund?.amount}`)
  check('ISO dates parsed via auto', bankPreview.rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.txn_date ?? '')))
  const bankCommit = commitImport(
    db,
    card.id,
    bank.filename,
    bankPreview.rows.filter((r) => !r.error && !r.duplicate).map((r) => ({
      txn_date: r.txn_date!,
      description: r.description,
      amount: r.amount!,
      expense_type: r.expense_type,
      category_id: r.category_id
    }))
  )
  check('bank rows inserted', bankCommit.inserted === bank.rowCount, `inserted ${bankCommit.inserted} of ${bank.rowCount}`)

  console.log('\n[6] Default type persisted + manual toggle with lock')
  const businessCount = (db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE expense_type = 'business'").get() as { n: number }).n
  const personalCount = (db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE expense_type = 'personal'").get() as { n: number }).n
  check('default type applied (business majority)', businessCount > personalCount, `${businessCount} business / ${personalCount} personal`)
  check('netflix row persisted as personal', personalCount >= 1)

  const victim = db.prepare("SELECT id, expense_type FROM transactions WHERE expense_type = 'business' LIMIT 1").get() as { id: number; expense_type: ExpenseType }
  db.prepare('UPDATE transactions SET expense_type = ?, type_locked = 1 WHERE id = ?').run('personal', victim.id)
  const toggled = db.prepare('SELECT expense_type, type_locked FROM transactions WHERE id = ?').get(victim.id) as { expense_type: ExpenseType; type_locked: number }
  check('manual toggle persisted', toggled.expense_type === 'personal' && toggled.type_locked === 1)

  rerunRules(db)
  const afterRerun = db.prepare('SELECT expense_type FROM transactions WHERE id = ?').get(victim.id) as { expense_type: ExpenseType }
  check('rule re-run respects type_locked', afterRerun.expense_type === 'personal')

  console.log('\n[7] Header detection: preamble (Amex-style) statements')
  // Amex .xlsx exports lead with title/account-holder/account-number rows and a
  // blank spacer before the real header, with a trailing unlabeled column.
  const amexAoa: string[][] = [
    ['Transaction Details', 'American Express Gold Card / May 13, 2026 to Jun 12, 2026', '', '', ''],
    ['Prepared for', '', '', '', ''],
    ['ANDRES TORRES', '', '', '', ''],
    ['Account Number', '', '', '', ''],
    ['XXXX-XXXXXX-51001', '', '', '', ''],
    ['', '', '', '', ''],
    ['Date', 'Description', 'Amount', 'Category', ''],
    ['06/10/2026', 'APPLE.COM/BILL INTERNET CHARGE', '0.99', 'Merchandise & Supplies', ''],
    ['06/01/2026', "AMEX DUNKIN' CREDIT", '-7.00', 'Fees & Adjustments', ''],
    ['05/22/2026', 'CLAUDE.AI SUBSCRIPTION', '21.32', 'Computer Supplies', '']
  ]
  check('detectHeaderRow: clean file → row 0', detectHeaderRow([['Date', 'Amount'], ['1', '2']]) === 0)
  check('detectHeaderRow: skips preamble → row 6', detectHeaderRow(amexAoa) === 6, `got ${detectHeaderRow(amexAoa)}`)

  // Regression cases for header-detection failure modes (see review findings):
  // a sparse first data row must NOT steal the header from row 0.
  const sparseFirst = [
    ['Date', 'Description', 'Category', 'Reference', 'Notes', 'Amount'],
    ['01/02/2026', '', '', '', '', '100.00'],
    ['01/03/2026', 'GROCERY STORE', 'Food', 'REF1', 'note', '40.00'],
    ['01/04/2026', 'GAS STATION', 'Auto', 'REF2', 'note', '55.00']
  ]
  check('detectHeaderRow: sparse first data row → row 0', detectHeaderRow(sparseFirst) === 0, `got ${detectHeaderRow(sparseFirst)}`)

  // a leading summary/total block (bank exports) must not win over the real header.
  const summaryBlock = [
    ['Account Number', 'XXXX1234', 'Statement Period', '05/01/2026 - 05/31/2026'],
    ['Beginning Balance', '1,234.56', 'Ending Balance', '2,345.67'],
    ['Date', 'Description', 'Amount', 'Balance'],
    ['05/02/2026', 'GROCERY', '-42.10', '2,303.57'],
    ['05/03/2026', 'GAS', '-30.00', '2,273.57']
  ]
  check('detectHeaderRow: leading summary block → row 2', detectHeaderRow(summaryBlock) === 2, `got ${detectHeaderRow(summaryBlock)}`)

  // a same-row label/value preamble on a narrow statement must not win.
  const labelValuePreamble = [
    ['Prepared For', 'ANDRES TORRES', '', ''],
    ['Account Number', 'XXXX-XXXXXX-51001', '', ''],
    ['Date', 'Description', 'Amount', 'Category'],
    ['06/10/2026', 'APPLE.COM', '0.99', 'Supplies'],
    ['06/11/2026', 'WHATABURGER', '12.50', 'Restaurant']
  ]
  check('detectHeaderRow: label/value preamble → row 2', detectHeaderRow(labelValuePreamble) === 2, `got ${detectHeaderRow(labelValuePreamble)}`)

  // a 2-cell title banner directly above the header must not win.
  const banner = [
    ['American Express', 'May 2026 Statement', '', ''],
    ['Date', 'Description', 'Amount', 'Balance'],
    ['06/10/2026', 'APPLE.COM', '0.99', '1200.50'],
    ['06/11/2026', 'WHATABURGER', '12.50', '1213.00']
  ]
  check('detectHeaderRow: 2-cell banner above header → row 1', detectHeaderRow(banner) === 1, `got ${detectHeaderRow(banner)}`)

  const amexPath = join(app.getPath('userData'), 'selftest-amex.xlsx')
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(amexAoa), 'Transaction Details')
  XLSX.writeFile(wb, amexPath)
  const amex = parseFile(amexPath)
  check(
    'amex: real columns recovered (Date/Amount/Category)',
    ['Date', 'Amount', 'Category'].every((h) => amex.headers.includes(h)),
    JSON.stringify(amex.headers)
  )
  check('amex: no __EMPTY / blank columns leak through', !amex.headers.some((h) => h === '' || h.startsWith('__EMPTY')))
  check('amex: 6 preamble rows skipped, 3 txns parsed', amex.rowCount === 3, `got ${amex.rowCount}`)
  const amexCredit = amex.rows.find((r) => r.Description?.includes('DUNKIN'))
  check('amex: negative amount preserved through parse', amexCredit?.Amount === '-7.00', `got ${amexCredit?.Amount}`)
  if (existsSync(amexPath)) unlinkSync(amexPath)

  closeDb()
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  return failures === 0 ? 0 : 1
}
