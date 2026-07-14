/**
 * Headless verification of the import pipeline (run with `npm run selftest`).
 * Exercises the real main-process modules against the sample statements,
 * covering the §10 milestone checks: schema, import, dedupe on re-import,
 * neutral expense type, type toggling with lock semantics.
 */
import { app } from 'electron'
import { existsSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as XLSX from 'xlsx'
import { initDb, closeDb } from './db'
import { buildPreview, commitImport, detectHeaderRow, parseAmount, parseFile } from './importer'
import { rerunRules } from './rules'
import { clearTransactions, deleteCard, deleteImportBatch } from './cleanup'
import { buildTxnWhere, fetchCardholderSpend, fetchTransactionsForExport } from './query'
import { getKpis } from './ipc'
import { buildCsv, buildExportFileName, buildXlsx } from './export'
import { confirmLink, getLedger, getReviewQueue, getUnmatchedCharges, rejectLink, runMatch } from './matcher'
import { setReconConfig } from './reconcile'
import {
  ASSIGNMENT_FORMAT,
  ASSIGNMENT_VERSION,
  buildAssignmentPacket,
  fetchAssignmentRows,
  fetchReturnedRows,
  importAssignment,
  loadPacketCategories,
  mergeAssignment,
  readAssignmentPacket
} from './assignment'
import type { Card, ColumnMapping, CommitRow, ExpenseType } from '@shared/types'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function expectParseFailure(name: string, filePath: string, pattern: RegExp): Promise<void> {
  try {
    await parseFile(filePath)
    check(name, false, 'parsed successfully')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    check(name, pattern.test(message), message)
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
  const transactionSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'").get() as { sql: string }
  ).sql
  check('transactions schema keeps type optional', !transactionSql.includes("'other'") && !transactionSql.includes('expense_type TEXT NOT NULL'))
  const catCount = (db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n
  check('categories seeded', catCount === 10, `got ${catCount}`)
  check('Other category seeded', db.prepare("SELECT 1 FROM categories WHERE name = 'Other'").get() !== undefined)

  console.log('\n[2] Setup: card + rules')
  db.prepare("INSERT INTO cards (name, default_expense_type) VALUES ('Owner Personal Visa', 'business')").run()
  const card = db.prepare('SELECT * FROM cards WHERE id = 1').get() as Card
  const travelId = (db.prepare("SELECT id FROM categories WHERE name = 'Travel'").get() as { id: number }).id
  const mealsId = (db.prepare("SELECT id FROM categories WHERE name = 'Meals & Entertainment'").get() as { id: number }).id
  // category-only rule, type-only rule, combined rule
  db.prepare("INSERT INTO category_rules (category_id, expense_type, match_type, pattern, priority) VALUES (?, NULL, 'contains', 'starbucks', 0)").run(mealsId)
  db.prepare("INSERT INTO category_rules (category_id, expense_type, match_type, pattern, priority) VALUES (NULL, 'personal', 'contains', 'netflix', 0)").run()
  db.prepare("INSERT INTO category_rules (category_id, expense_type, match_type, pattern, priority) VALUES (?, 'business', 'contains', 'delta air', 0)").run(travelId)

  console.log('\n[3] Parse + preview sample-chase.csv (negative = expense)')
  const chase = await parseFile(join(app.getAppPath(), 'samples', 'sample-chase.csv'))
  check('parsed 8 rows', chase.rowCount === 8, `got ${chase.rowCount}`)
  const chaseMapping: ColumnMapping = {
    date_col: 'Transaction Date',
    amount_col: 'Amount',
    amount_col_secondary: null,
    description_col: 'Description',
    cardholder_col: null,
    date_format: 'MM/DD/YYYY',
    amount_sign: 'expense_negative'
  }
  const preview = buildPreview(db, card, chase.rows, chaseMapping)
  check('no parse errors', preview.errorCount === 0, JSON.stringify(preview.rows.filter((r) => r.error)))
  check('no duplicates on first import', preview.duplicateCount === 0)
  const starbucks = preview.rows.find((r) => r.description.toLowerCase().includes('starbucks'))
  check('rule set Starbucks category', starbucks?.category_name === 'Meals & Entertainment')
  check('category-only rule leaves Starbucks type unassigned', starbucks?.expense_type === null)
  check('category-only rule flags Starbucks for type review', starbucks?.needsReview === true)
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
      category_id: r.category_id,
      cardholder: r.cardholder
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
  const bank = await parseFile(join(app.getAppPath(), 'samples', 'sample-bank.csv'))
  const bankMapping: ColumnMapping = {
    date_col: 'Date',
    amount_col: 'Debit',
    amount_col_secondary: 'Credit',
    description_col: 'Merchant',
    cardholder_col: null,
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
      category_id: r.category_id,
      cardholder: r.cardholder
    }))
  )
  check('bank rows inserted', bankCommit.inserted === bank.rowCount, `inserted ${bankCommit.inserted} of ${bank.rowCount}`)

  console.log('\n[6] PDF statement import (selectable text only)')
  db.prepare("INSERT INTO cards (name) VALUES ('PDF Test Visa')").run()
  const pdfCard = db.prepare("SELECT * FROM cards WHERE name = 'PDF Test Visa'").get() as Card
  const pdf = await parseFile(join(app.getAppPath(), 'samples', 'sample-pdf-statement.pdf'))
  check('pdf: parsed 7 transaction rows', pdf.rowCount === 7, `got ${pdf.rowCount}`)
  check(
    'pdf: transaction columns detected',
    ['Transaction Date', 'Description', 'Debit', 'Credit'].every((h) => pdf.headers.includes(h)),
    JSON.stringify(pdf.headers)
  )
  const pdfMicrosoft = pdf.rows.find((r) => r.Description?.includes('MICROSOFT'))
  check(
    'pdf: continuation lines merge into description',
    pdfMicrosoft?.Description === 'MICROSOFT 365 SUBSCRIPTION Plan: Business Standard',
    `got ${pdfMicrosoft?.Description}`
  )
  const pdfMapping: ColumnMapping = {
    date_col: 'Transaction Date',
    amount_col: 'Debit',
    amount_col_secondary: 'Credit',
    description_col: 'Description',
    cardholder_col: null,
    date_format: 'auto',
    amount_sign: 'expense_positive'
  }
  const pdfPreview = buildPreview(db, pdfCard, pdf.rows, pdfMapping)
  check('pdf preview: no parse errors', pdfPreview.errorCount === 0, JSON.stringify(pdfPreview.rows.filter((r) => r.error)))
  check('pdf preview: no duplicates on first import for a new card', pdfPreview.duplicateCount === 0)
  const pdfStarbucks = pdfPreview.rows.find((r) => r.description.toLowerCase().includes('starbucks'))
  check('pdf rules: Starbucks category set', pdfStarbucks?.category_name === 'Meals & Entertainment')
  check('pdf rules: unmatched type remains unassigned', pdfStarbucks?.expense_type === null && pdfStarbucks.needsReview)
  const pdfDelta = pdfPreview.rows.find((r) => r.description.toLowerCase().includes('delta'))
  check('pdf rules: Delta category + type', pdfDelta?.category_name === 'Travel' && pdfDelta?.expense_type === 'business')
  const pdfRefund = pdfPreview.rows.find((r) => r.description.toLowerCase().includes('refund'))
  check('pdf preview: credit column stored as negative refund', (pdfRefund?.amount ?? 0) < 0, `got ${pdfRefund?.amount}`)
  const pdfCommitRows: CommitRow[] = pdfPreview.rows
    .filter((r) => !r.error && !r.duplicate)
    .map((r) => ({
      txn_date: r.txn_date!,
      description: r.description,
      amount: r.amount!,
      expense_type: r.expense_type,
      category_id: r.category_id,
      cardholder: r.cardholder
    }))
  const pdfFirst = commitImport(db, pdfCard.id, pdf.filename, pdfCommitRows)
  check('pdf commit inserted all rows', pdfFirst.inserted === pdf.rowCount, `inserted ${pdfFirst.inserted}`)
  const pdfRepreview = buildPreview(db, pdfCard, pdf.rows, pdfMapping)
  check('pdf re-preview flags all rows duplicate', pdfRepreview.duplicateCount === pdf.rowCount)
  const pdfSecond = commitImport(db, pdfCard.id, pdf.filename, pdfCommitRows)
  check('pdf re-import inserted 0', pdfSecond.inserted === 0, `inserted ${pdfSecond.inserted}`)
  check('pdf re-import skipped all rows', pdfSecond.skipped === pdf.rowCount, `skipped ${pdfSecond.skipped}`)

  const realLayoutPdf = await parseFile(join(app.getAppPath(), 'samples', 'sample-pdf-real-layouts.pdf'))
  check('pdf real layouts: date-only rows parsed', realLayoutPdf.rowCount === 8, `got ${realLayoutPdf.rowCount}`)
  check(
    'pdf real layouts: generic columns recovered',
    ['Date', 'Description', 'Amount'].every((h) => realLayoutPdf.headers.includes(h)),
    JSON.stringify(realLayoutPdf.headers)
  )
  check(
    'pdf real layouts: inferred years on every row',
    realLayoutPdf.rows.every((r) => /^2026-\d{2}-\d{2}$/.test(r.Date ?? '')),
    JSON.stringify(realLayoutPdf.rows.map((r) => r.Date))
  )
  check(
    'pdf real layouts: amount cells stay parseable',
    realLayoutPdf.rows.every((r) => parseAmount(r.Amount ?? '') !== null),
    JSON.stringify(realLayoutPdf.rows.map((r) => r.Amount))
  )
  const realLayoutPreview = buildPreview(db, pdfCard, realLayoutPdf.rows, {
    date_col: 'Date',
    amount_col: 'Amount',
    amount_col_secondary: null,
    description_col: 'Description',
    cardholder_col: null,
    date_format: 'auto',
    amount_sign: 'expense_positive'
  })
  check(
    'pdf real layouts: mapping + preview has no parse errors',
    realLayoutPreview.errorCount === 0,
    JSON.stringify(realLayoutPreview.rows.filter((r) => r.error))
  )
  await expectParseFailure(
    'pdf unsupported: password-protected error is clear',
    join(app.getAppPath(), 'samples', 'sample-pdf-encrypted.pdf'),
    /Password-protected PDF statements are not supported/
  )
  await expectParseFailure(
    'pdf unsupported: no selectable text error is clear',
    join(app.getAppPath(), 'samples', 'sample-pdf-no-text.pdf'),
    /No selectable text found/
  )
  await expectParseFailure(
    'pdf unsupported: no transaction table error is clear',
    join(app.getAppPath(), 'samples', 'sample-pdf-no-table.pdf'),
    /No transaction table header found/
  )

  console.log('\n[7] Unassigned type persisted + manual toggle with lock')
  const businessCount = (db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE expense_type = 'business'").get() as { n: number }).n
  const personalCount = (db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE expense_type = 'personal'").get() as { n: number }).n
  const unassignedCount = (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE expense_type IS NULL').get() as { n: number }).n
  check(
    'rows without type rules persisted unassigned',
    unassignedCount > businessCount && unassignedCount > personalCount,
    `${businessCount} business / ${personalCount} personal / ${unassignedCount} unassigned`
  )
  check('business type rule persisted', businessCount >= 1)
  check('netflix row persisted as personal', personalCount >= 1)

  const victim = db.prepare("SELECT id, expense_type FROM transactions WHERE expense_type = 'business' LIMIT 1").get() as {
    id: number
    expense_type: ExpenseType
  }
  db.prepare('UPDATE transactions SET expense_type = ?, type_locked = 1 WHERE id = ?').run('personal', victim.id)
  const toggled = db.prepare('SELECT expense_type, type_locked FROM transactions WHERE id = ?').get(victim.id) as {
    expense_type: ExpenseType | null
    type_locked: number
  }
  check('manual toggle persisted', toggled.expense_type === 'personal' && toggled.type_locked === 1)

  rerunRules(db)
  const afterRerun = db.prepare('SELECT expense_type FROM transactions WHERE id = ?').get(victim.id) as { expense_type: ExpenseType | null }
  check('rule re-run respects type_locked', afterRerun.expense_type === 'personal')

  console.log('\n[8] Header detection: preamble (Amex-style) statements')
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
  const amex = await parseFile(amexPath)
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

  // Headerless export (Amex "Transaction Details" .xlsx): data starts at row 0,
  // with extra columns (card member, card last-4, verbose detail, ref #, category)
  // around the date/merchant/amount we care about. No header row exists.
  const headerless: string[][] = [
    ['05/30/2026', 'BEST BUY LAREDO TX', 'ADOLFO CAMPERO', '-03003', '$43.28', '006001634 ELEC SLS', 'Electronics'],
    ['05/30/2026', 'WHATABURGER SAN ANTONIO TX', 'ADOLFO CAMPERO', '-03003', '$25.00', 'DGC7622148 FOOD', 'Restaurant'],
    ['05/29/2026', 'HOTELS.COM WA', 'LIZA CAMPERO', '-03003', '$48.08', '404FFHQ TRAVEL', 'Travel'],
    ['05/28/2026', 'AMAZON MARKETPLACE WA', 'LIZA CAMPERO', '-03003', '$49.71', '190QDN MERCHANDISE', 'Internet']
  ]
  check('detectHeaderRow: headerless data grid → -1', detectHeaderRow(headerless) === -1, `got ${detectHeaderRow(headerless)}`)

  const headerlessPath = join(app.getPath('userData'), 'selftest-headerless.xlsx')
  const wb2 = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(headerless), 'Transaction Details')
  XLSX.writeFile(wb2, headerlessPath)
  const headerlessFile = await parseFile(headerlessPath)
  check('headerless: no transaction consumed as header (4 rows)', headerlessFile.rowCount === 4, `got ${headerlessFile.rowCount}`)
  check('headerless: synthetic Column N headers', headerlessFile.headers[0] === 'Column 1' && headerlessFile.headers.length === 7)
  const hm = headerlessFile.suggestedMapping
  const firstRow = headerlessFile.rows[0]
  check('headerless: date column suggested by content', firstRow[hm.date_col] === '05/30/2026', `date_col=${hm.date_col}`)
  check('headerless: amount column is the currency-shaped one, not the card #', firstRow[hm.amount_col] === '$43.28', `amount_col=${hm.amount_col}`)
  check('headerless: description column is the merchant, not the detail/ref', firstRow[hm.description_col] === 'BEST BUY LAREDO TX', `description_col=${hm.description_col}`)
  const headerlessPreview = buildPreview(db, card, headerlessFile.rows, hm)
  check('headerless: preview parses every row cleanly', headerlessPreview.errorCount === 0, JSON.stringify(headerlessPreview.rows.filter((r) => r.error)))
  if (existsSync(headerlessPath)) unlinkSync(headerlessPath)

  console.log('\n[8b] Repeated identical charges (multiplicity dedup)')
  db.prepare("INSERT INTO cards (name) VALUES ('Repeat Charges Visa')").run()
  const repeatCard = db.prepare("SELECT * FROM cards WHERE name = 'Repeat Charges Visa'").get() as Card
  const repeatMapping: ColumnMapping = {
    date_col: 'Date',
    amount_col: 'Amount',
    amount_col_secondary: null,
    description_col: 'Description',
    cardholder_col: null,
    date_format: 'auto',
    amount_sign: 'expense_positive'
  }
  const fees = (n: number): Record<string, string>[] =>
    Array.from({ length: n }, () => ({ Date: '2026-05-05', Description: 'TEXAS.GOV*SERVICEFEEAUSTIN TX', Amount: '2.00' }))
  const toCommitRows = (p: ReturnType<typeof buildPreview>): CommitRow[] =>
    p.rows
      .filter((r) => !r.error)
      .map((r) => ({
        txn_date: r.txn_date!,
        description: r.description,
        amount: r.amount!,
        expense_type: r.expense_type,
        category_id: r.category_id,
        cardholder: r.cardholder
      }))

  const feePreview = buildPreview(db, repeatCard, fees(6), repeatMapping)
  check('repeat: 6 identical charges all new on first import', feePreview.newCount === 6 && feePreview.duplicateCount === 0, `new ${feePreview.newCount}, dup ${feePreview.duplicateCount}`)
  const feeCommit = commitImport(db, repeatCard.id, 'fees.csv', toCommitRows(feePreview))
  check('repeat: all 6 inserted', feeCommit.inserted === 6, `inserted ${feeCommit.inserted}`)

  const reFeePreview = buildPreview(db, repeatCard, fees(6), repeatMapping)
  check('repeat: re-importing the same statement flags all 6 duplicate', reFeePreview.newCount === 0 && reFeePreview.duplicateCount === 6)
  const reFeeCommit = commitImport(db, repeatCard.id, 'fees.csv', toCommitRows(reFeePreview))
  check('repeat: re-import inserts 0, skips 6', reFeeCommit.inserted === 0 && reFeeCommit.skipped === 6, `inserted ${reFeeCommit.inserted}, skipped ${reFeeCommit.skipped}`)

  const topUpPreview = buildPreview(db, repeatCard, fees(8), repeatMapping)
  check('repeat: a statement with 8 occurrences tops up by 2', topUpPreview.newCount === 2 && topUpPreview.duplicateCount === 6, `new ${topUpPreview.newCount}, dup ${topUpPreview.duplicateCount}`)
  const topUpCommit = commitImport(db, repeatCard.id, 'fees-2.csv', toCommitRows(topUpPreview))
  check('repeat: top-up inserts exactly 2', topUpCommit.inserted === 2 && topUpCommit.skipped === 6, `inserted ${topUpCommit.inserted}`)
  const repeatTotal = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE card_id = ?').get(repeatCard.id) as { n: number }
  check('repeat: 8 charges stored in total after top-up', repeatTotal.n === 8, `got ${repeatTotal.n}`)

  console.log('\n[8c] Cardholder detection + spend breakdown')
  // A statement without a person-name column must not get a cardholder mapping.
  const chaseSuggest = (await parseFile(join(app.getAppPath(), 'samples', 'sample-chase.csv'))).suggestedMapping
  check('cardholder: none detected when no name column exists', chaseSuggest.cardholder_col === null, `got ${chaseSuggest.cardholder_col}`)

  // A headerless Amex-style grid where the card-member column (index 2, right
  // after the merchant) repeats a small set of names. The trailing "UNITED STATES"
  // country column is also name-shaped with an even lower distinct ratio — the
  // detector must still pick the card member by its proximity to the description.
  const cardholderAoa: string[][] = [
    ['05/30/2026', 'BEST BUY LAREDO TX', 'ADOLFO CAMPERO', '-03003', '$100.00', 'Electronics', 'UNITED STATES'],
    ['05/29/2026', 'HOTELS.COM WA', 'ADOLFO CAMPERO', '-03003', '$100.00', 'Travel', 'UNITED STATES'],
    ['05/28/2026', 'SHELL OIL TX', 'ADOLFO CAMPERO', '-03003', '$50.00', 'Fuel', 'UNITED STATES'],
    ['05/27/2026', 'WHATABURGER TX', 'ADOLFO CAMPERO', '-03003', '$50.00', 'Restaurant', 'UNITED STATES'],
    ['05/26/2026', 'AMAZON WA', 'LIZA CAMPERO', '-03003', '$40.00', 'Internet', 'UNITED STATES'],
    ['05/25/2026', 'TARGET TX', 'LIZA CAMPERO', '-03003', '$30.00', 'Retail', 'UNITED STATES'],
    ['05/24/2026', 'COSTCO TX', 'JOHN T HALL', '-03003', '$25.00', 'Wholesale', 'UNITED STATES'],
    ['05/23/2026', 'UBER SF', 'JOHN T HALL', '-03003', '$15.00', 'Travel', 'UNITED STATES']
  ]
  const cardholderPath = join(app.getPath('userData'), 'selftest-cardholder.xlsx')
  const wb3 = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb3, XLSX.utils.aoa_to_sheet(cardholderAoa), 'Transaction Details')
  XLSX.writeFile(wb3, cardholderPath)
  const chFile = await parseFile(cardholderPath)
  const cm = chFile.suggestedMapping
  check('cardholder: detects the card-member column by content', !!cm.cardholder_col && chFile.rows[0][cm.cardholder_col] === 'ADOLFO CAMPERO', `cardholder_col=${cm.cardholder_col}`)
  check('cardholder: description stays the merchant, not the name', chFile.rows[0][cm.description_col] === 'BEST BUY LAREDO TX', `description_col=${cm.description_col}`)

  db.prepare("INSERT INTO cards (name) VALUES ('Cardholder Visa')").run()
  const chCard = db.prepare("SELECT * FROM cards WHERE name = 'Cardholder Visa'").get() as Card
  const chPreview = buildPreview(db, chCard, chFile.rows, cm)
  check('cardholder: preview carries the cardholder name', chPreview.rows[0].cardholder === 'ADOLFO CAMPERO', `got ${chPreview.rows[0].cardholder}`)
  const chCommit = commitImport(db, chCard.id, 'cardholders.xlsx', toCommitRows(chPreview))
  check('cardholder: all 8 rows committed', chCommit.inserted === 8, `inserted ${chCommit.inserted}`)
  const storedCardholder = db.prepare('SELECT cardholder FROM transactions WHERE card_id = ? ORDER BY txn_date DESC LIMIT 1').get(chCard.id) as { cardholder: string | null }
  check('cardholder: stored on the transaction row', storedCardholder.cardholder === 'ADOLFO CAMPERO', `got ${storedCardholder.cardholder}`)

  const spend = fetchCardholderSpend(db, { cardId: chCard.id })
  check('cardholder: spend grouped into 3 people', spend.length === 3, `got ${spend.length}`)
  check('cardholder: biggest spender is ADOLFO CAMPERO at $300', spend[0].cardholder === 'ADOLFO CAMPERO' && Math.abs(spend[0].total - 300) < 0.01, JSON.stringify(spend[0]))
  check('cardholder: top spender shows 4 transactions', spend[0].count === 4, `got ${spend[0].count}`)
  check('cardholder: results ordered by spend descending', spend.map((s) => s.total).join(',') === '300,70,40', spend.map((s) => `${s.cardholder}:${s.total}`).join(' '))

  // The dashboard surfaces the same breakdown via getKpis, scoped to its date range.
  const chKpis = getKpis(db, { expenseType: 'all', dateFrom: '2026-05-01', dateTo: '2026-05-31' })
  check('dashboard: KPIs expose byCardholder', chKpis.byCardholder.length === 3, `got ${chKpis.byCardholder.length}`)
  check('dashboard: top spender is ADOLFO CAMPERO at $300', chKpis.byCardholder[0]?.cardholder === 'ADOLFO CAMPERO' && Math.abs(chKpis.byCardholder[0].total - 300) < 0.01, JSON.stringify(chKpis.byCardholder[0]))
  if (existsSync(cardholderPath)) unlinkSync(cardholderPath)

  console.log('\n[9] Quick-categorize queue ordering (uncategorized first)')
  const queue = db
    .prepare(
      `SELECT t.id, t.category_id
       FROM transactions t
       JOIN cards ca ON ca.id = t.card_id
       LEFT JOIN categories c ON c.id = t.category_id
       ORDER BY (t.category_id IS NULL) DESC, t.txn_date DESC, t.id DESC`
    )
    .all() as { id: number; category_id: number | null }[]
  const firstCategorizedAt = queue.findIndex((r) => r.category_id !== null)
  const lastUncategorizedAt = queue.map((r) => r.category_id === null).lastIndexOf(true)
  check('queue has both categorized and uncategorized rows', firstCategorizedAt > 0 && queue.some((r) => r.category_id !== null))
  check(
    'all uncategorized rows precede categorized ones',
    lastUncategorizedAt < firstCategorizedAt,
    `last uncategorized @${lastUncategorizedAt}, first categorized @${firstCategorizedAt}`
  )

  console.log('\n[10] Transaction cleanup and import history deletion')
  const deletedFromDuplicateBatch = deleteImportBatch(db, second.batchId)
  check('deleting a duplicate-only import removes no original transactions', deletedFromDuplicateBatch === 0)
  check(
    'original import transactions remain after duplicate history deletion',
    (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE import_batch_id = ?').get(first.batchId) as { n: number }).n ===
      first.inserted
  )
  const cleanupRows: CommitRow[] = [
    {
      txn_date: '2024-01-15',
      description: 'SELFTEST CLEANUP JANUARY',
      amount: 10,
      expense_type: 'business',
      category_id: null,
      cardholder: null
    },
    {
      txn_date: '2024-02-15',
      description: 'SELFTEST CLEANUP FEBRUARY',
      amount: 20,
      expense_type: 'business',
      category_id: null,
      cardholder: null
    }
  ]
  const cleanupBatch = commitImport(db, card.id, 'selftest-cleanup.csv', cleanupRows)
  const clearedRange = clearTransactions(db, { mode: 'range', dateFrom: '2024-01-01', dateTo: '2024-01-31' })
  check('date-range clear deletes only matching transactions', clearedRange === 1, `deleted ${clearedRange}`)
  const cleanupRemaining = (
    db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE import_batch_id = ?').get(cleanupBatch.batchId) as { n: number }
  ).n
  check('date-range clear preserves batch history and out-of-range rows', cleanupRemaining === 1, `remaining ${cleanupRemaining}`)
  const deletedFromBatch = deleteImportBatch(db, cleanupBatch.batchId)
  check('deleting one import removes its remaining transactions', deletedFromBatch === 1, `deleted ${deletedFromBatch}`)
  check(
    'deleting one import removes its history entry',
    db.prepare('SELECT 1 FROM import_batches WHERE id = ?').get(cleanupBatch.batchId) === undefined
  )
  const batchCountBeforeClearAll = (db.prepare('SELECT COUNT(*) AS n FROM import_batches').get() as { n: number }).n
  const clearedAll = clearTransactions(db, { mode: 'all' })
  check('clear all removes every remaining transaction', clearedAll > 0 && (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n === 0)
  check(
    'clear all preserves import history',
    (db.prepare('SELECT COUNT(*) AS n FROM import_batches').get() as { n: number }).n === batchCountBeforeClearAll
  )
  deleteCard(db, card.id)
  check('deleting card succeeds with retained import history', db.prepare('SELECT 1 FROM cards WHERE id = ?').get(card.id) === undefined)
  check(
    'deleting card removes its import history',
    (db.prepare('SELECT COUNT(*) AS n FROM import_batches WHERE card_id = ?').get(card.id) as { n: number }).n === 0
  )
  check('deleting card leaves no foreign key violations', db.prepare('PRAGMA foreign_key_check').all().length === 0)

  console.log('\n[11] Export: scope filtering + CSV/Excel builders')
  db.prepare("INSERT INTO cards (name) VALUES ('Export Test Card')").run()
  const exportCard = db.prepare("SELECT * FROM cards WHERE name = 'Export Test Card'").get() as Card
  const exportRows: CommitRow[] = [
    { txn_date: '2026-03-01', description: 'DINING ONE', amount: 25, expense_type: 'business', category_id: mealsId, cardholder: null },
    { txn_date: '2026-03-02', description: 'DINING TWO', amount: 40, expense_type: 'personal', category_id: mealsId, cardholder: null },
    { txn_date: '2026-03-03', description: 'TRAVEL ONE', amount: 100, expense_type: 'business', category_id: travelId, cardholder: null }
  ]
  commitImport(db, exportCard.id, 'export-test.csv', exportRows)
  const allExport = fetchTransactionsForExport(db, { expenseType: 'all', cardId: exportCard.id })
  check('export: all scope returns every row', allExport.length === 3, `got ${allExport.length}`)
  const businessExport = fetchTransactionsForExport(db, { expenseType: 'business', cardId: exportCard.id })
  check('export: business scope filters out personal', businessExport.length === 2, `got ${businessExport.length}`)
  const diningExport = fetchTransactionsForExport(db, { expenseType: 'all', cardId: exportCard.id, categoryId: mealsId })
  check('export: category filter yields per-category report rows', diningExport.length === 2, `got ${diningExport.length}`)
  const personalDiningExport = fetchTransactionsForExport(db, { expenseType: 'personal', cardId: exportCard.id, categoryId: mealsId })
  const exportDate = new Date(2026, 5, 18)
  const personalDiningName = buildExportFileName(
    { expenseType: 'personal', categoryId: mealsId },
    personalDiningExport,
    'csv',
    exportDate
  )
  check(
    'export filename: type/category/date',
    personalDiningName === 'transactions-personal-meals-and-entertainment-2026-06-18.csv',
    personalDiningName
  )
  const cardDiningName = buildExportFileName(
    { expenseType: 'personal', cardId: exportCard.id, categoryId: mealsId },
    personalDiningExport,
    'csv',
    exportDate
  )
  check(
    'export filename: card filter included',
    cardDiningName === 'transactions-personal-meals-and-entertainment-export-test-card-2026-06-18.csv',
    cardDiningName
  )

  const csv = buildCsv(diningExport)
  const csvLines = csv.trim().split(/\r?\n/)
  check('export csv: header + one row per transaction', csvLines.length === diningExport.length + 1, `got ${csvLines.length}`)
  check('export csv: header columns present', csvLines[0] === 'Date,Description,Amount,Type,Category,Card', csvLines[0])
  check('export csv: row carries category and card', csv.includes('Meals & Entertainment') && csv.includes('Export Test Card'))

  const xlsxBuffer = buildXlsx(diningExport)
  const roundTrip = XLSX.read(xlsxBuffer, { type: 'buffer' })
  const xlsxRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(roundTrip.Sheets[roundTrip.SheetNames[0]])
  check('export xlsx: round-trips every row', xlsxRows.length === diningExport.length, `got ${xlsxRows.length}`)
  check('export xlsx: amount stays numeric', typeof xlsxRows[0]?.Amount === 'number', `got ${typeof xlsxRows[0]?.Amount}`)

  db.prepare("UPDATE categories SET name = 'Dining' WHERE id = ?").run(mealsId)
  const renamedDiningExport = fetchTransactionsForExport(db, { expenseType: 'personal', cardId: exportCard.id, categoryId: mealsId })
  const renamedDiningName = buildExportFileName(
    { expenseType: 'personal', categoryId: mealsId },
    renamedDiningExport,
    'xlsx',
    exportDate
  )
  check('export filename uses current category name', renamedDiningName === 'transactions-personal-dining-2026-06-18.xlsx', renamedDiningName)
  const pdfReportName = buildExportFileName(
    { expenseType: 'personal', categoryId: mealsId },
    renamedDiningExport,
    'pdf',
    exportDate
  )
  check('export filename: pdf report extension', pdfReportName === 'transactions-personal-dining-2026-06-18.pdf', pdfReportName)

  console.log('\n[11b] Client substantiation: requires-client flag, missing-client filter, export')
  // The exportCard rows are the only transactions in the DB at this point: DINING
  // ONE (business, meals), DINING TWO (personal, meals), TRAVEL ONE (business,
  // travel). Only the first is a business charge in a client-required category.
  const missingClientCount = (): number => {
    const { where, params } = buildTxnWhere({ missingClient: true })
    return (db.prepare(`SELECT COUNT(*) AS n FROM transactions t ${where}`).get(params) as { n: number }).n
  }
  const mealsRequiresClient = (db.prepare('SELECT requires_client FROM categories WHERE id = ?').get(mealsId) as { requires_client: number }).requires_client
  check('requires_client: meals category seeded as client-required', mealsRequiresClient === 1, `got ${mealsRequiresClient}`)
  check('missing-client: one business meal lacks a client name', missingClientCount() === 1, `got ${missingClientCount()}`)

  // The flag drives the filter: clearing it drops the gap, restoring it brings it back.
  db.prepare('UPDATE categories SET requires_client = 0 WHERE id = ?').run(mealsId)
  check('missing-client: none flagged once the category no longer requires a client', missingClientCount() === 0, `got ${missingClientCount()}`)
  db.prepare('UPDATE categories SET requires_client = 1 WHERE id = ?').run(mealsId)
  check('missing-client: flag restored re-surfaces the gap', missingClientCount() === 1, `got ${missingClientCount()}`)

  // Recording a client name closes the gap (empty/whitespace is treated as unset).
  const diningOneId = (db.prepare("SELECT id FROM transactions WHERE description = 'DINING ONE'").get() as { id: number }).id
  db.prepare('UPDATE transactions SET client = ? WHERE id = ?').run('Acme Corp — J. Smith', diningOneId)
  check('missing-client: recording a client name clears the gap', missingClientCount() === 0, `got ${missingClientCount()}`)

  // Export gains the Client column only once a row carries one.
  const clientExport = fetchTransactionsForExport(db, { expenseType: 'all', cardId: exportCard.id })
  const clientCsv = buildCsv(clientExport)
  const clientHeader = clientCsv.trim().split(/\r?\n/)[0]
  check('export csv: Client column appears once a client is recorded', clientHeader.includes('Client'), clientHeader)
  check('export csv: client name is written out', clientCsv.includes('Acme Corp'), 'missing client value')

  // Per-transaction comment: stored as free text, surfaced in export only once set.
  const noCommentHeader = buildCsv(fetchTransactionsForExport(db, { expenseType: 'all', cardId: exportCard.id }))
    .trim()
    .split(/\r?\n/)[0]
  check('comment: no Comment column before any comment is set', !noCommentHeader.includes('Comment'), noCommentHeader)
  db.prepare('UPDATE transactions SET comment = ? WHERE id = ?').run('Split with personal lunch', diningOneId)
  const storedComment = (db.prepare('SELECT comment FROM transactions WHERE id = ?').get(diningOneId) as { comment: string | null }).comment
  check('comment: value persists on the transaction', storedComment === 'Split with personal lunch', `got ${storedComment}`)
  const commentCsv = buildCsv(fetchTransactionsForExport(db, { expenseType: 'all', cardId: exportCard.id }))
  const commentHeader = commentCsv.trim().split(/\r?\n/)[0]
  check('export csv: Comment column appears once a comment is recorded', commentHeader.includes('Comment'), commentHeader)
  check('export csv: comment text is written out', commentCsv.includes('Split with personal lunch'), 'missing comment value')

  console.log('\n[11c] Cardholder assignment round-trip (export → import → categorize → merge)')
  db.prepare("INSERT INTO cards (name) VALUES ('Assignment Boss Card')").run()
  const assignCard = db.prepare("SELECT * FROM cards WHERE name = 'Assignment Boss Card'").get() as Card
  const assignRows: CommitRow[] = [
    { txn_date: '2026-04-01', description: 'PEDRO DINNER MEETING', amount: 120, expense_type: null, category_id: null, cardholder: 'PEDRO PAGE' },
    { txn_date: '2026-04-02', description: 'PEDRO FLIGHT AUSTIN', amount: 300, expense_type: null, category_id: null, cardholder: 'PEDRO PAGE' },
    { txn_date: '2026-04-03', description: 'PEDRO OFFICE STORE', amount: 45, expense_type: null, category_id: null, cardholder: 'PEDRO PAGE' }
  ]
  commitImport(db, assignCard.id, 'assign-boss.csv', assignRows)

  // Boss exports PEDRO PAGE's charges as an 'assigned' packet.
  const fetched = fetchAssignmentRows(db, { cardholder: 'PEDRO PAGE' })
  check('assignment: boss export gathers all 3 of the cardholder rows', fetched.rows.length === 3, `got ${fetched.rows.length}`)
  check('assignment: each row carries an id:hash round-trip token', fetched.rows.every((r) => /^\d+:[0-9a-f]{64}$/.test(r.ref)), JSON.stringify(fetched.rows.map((r) => r.ref)))
  const assignedBuffer = buildAssignmentPacket(
    {
      format: ASSIGNMENT_FORMAT,
      version: ASSIGNMENT_VERSION,
      stage: 'assigned',
      appVersion: '0.0.0-selftest',
      cardName: fetched.cardName,
      cardholder: 'PEDRO PAGE',
      exportedAt: '2026-06-26T00:00:00.000Z'
    },
    loadPacketCategories(db),
    fetched.rows
  )
  const assignedPath = join(app.getPath('userData'), 'selftest-assignment.xlsx')
  writeFileSync(assignedPath, assignedBuffer)
  const assignedPacket = readAssignmentPacket(assignedPath)
  check('assignment: packet round-trips as stage=assigned', assignedPacket.meta.stage === 'assigned')
  check('assignment: packet carries 3 rows + the category list', assignedPacket.rows.length === 3 && assignedPacket.categories.length > 0, `${assignedPacket.rows.length} rows, ${assignedPacket.categories.length} cats`)
  check('assignment: rejects a newer packet format', (() => {
    const meta = { ...assignedPacket.meta, version: ASSIGNMENT_VERSION + 1 }
    const buf = buildAssignmentPacket(meta, [], assignedPacket.rows)
    const p = join(app.getPath('userData'), 'selftest-assignment-future.xlsx')
    writeFileSync(p, buf)
    let threw = false
    try {
      readAssignmentPacket(p)
    } catch {
      threw = true
    }
    if (existsSync(p)) unlinkSync(p)
    return threw
  })())

  // Cardholder imports into their own (separate) copy — simulate with a distinct
  // card name so the same DB stands in for both sides.
  assignedPacket.meta.cardName = 'PEDRO inbox'
  const importResult = importAssignment(db, assignedPacket, 'assignment.xlsx')
  check('assignment: cardholder import inserts all 3 rows', importResult.inserted === 3, JSON.stringify(importResult))
  const importedRows = db.prepare('SELECT id, source_token FROM transactions WHERE card_id = ? ORDER BY txn_date').all(importResult.cardId) as { id: number; source_token: string }[]
  check('assignment: imported rows carry the round-trip token', importedRows.length === 3 && importedRows.every((r) => /^\d+:[0-9a-f]{64}$/.test(r.source_token)), JSON.stringify(importedRows.map((r) => r.source_token)))
  // Re-importing the same packet updates in place, never duplicates.
  const reImport = importAssignment(db, assignedPacket, 'assignment.xlsx')
  check('assignment: re-import updates in place (0 new, 3 updated)', reImport.inserted === 0 && reImport.updated === 3, JSON.stringify(reImport))

  // Cardholder categorizes: flight → Travel/business, dinner → business + client.
  const flightId = importedRows.find((_, i) => i === 1)!.id // 2026-04-02 PEDRO FLIGHT
  const dinnerId = importedRows.find((_, i) => i === 0)!.id // 2026-04-01 PEDRO DINNER
  db.prepare('UPDATE transactions SET expense_type = ?, category_id = ?, type_locked = 1, category_locked = 1 WHERE id = ?').run('business', travelId, flightId)
  db.prepare('UPDATE transactions SET expense_type = ?, client = ?, type_locked = 1 WHERE id = ?').run('business', 'Acme Corp — P. Page', dinnerId)

  // Cardholder exports the categorized work back as a 'returned' packet.
  const returnedRows = fetchReturnedRows(db, importResult.cardId)
  check('assignment: return export carries all 3 assigned rows', returnedRows.length === 3, `got ${returnedRows.length}`)
  const returnedBuffer = buildAssignmentPacket(
    {
      format: ASSIGNMENT_FORMAT,
      version: ASSIGNMENT_VERSION,
      stage: 'returned',
      appVersion: '0.0.0-selftest',
      cardName: 'PEDRO inbox',
      cardholder: 'PEDRO PAGE',
      exportedAt: '2026-06-26T00:00:00.000Z'
    },
    loadPacketCategories(db),
    returnedRows
  )
  const returnedPath = join(app.getPath('userData'), 'selftest-assignment-return.xlsx')
  writeFileSync(returnedPath, returnedBuffer)
  const returnedPacket = readAssignmentPacket(returnedPath)
  check('assignment: returned packet round-trips as stage=returned', returnedPacket.meta.stage === 'returned')

  // Boss merges the returned packet onto the ORIGINAL rows (matched by token).
  const mergeResult = mergeAssignment(db, returnedPacket)
  check('assignment: merge updates the 2 categorized rows', mergeResult.updated === 2 && mergeResult.unmatched === 0, JSON.stringify(mergeResult))
  check('assignment: merge reports no unknown categories', mergeResult.unmatchedCategories.length === 0, JSON.stringify(mergeResult.unmatchedCategories))
  const bossFlight = db.prepare("SELECT expense_type, category_id, type_locked, category_locked FROM transactions WHERE card_id = ? AND description = 'PEDRO FLIGHT AUSTIN'").get(assignCard.id) as { expense_type: string | null; category_id: number | null; type_locked: number; category_locked: number }
  check('assignment: boss flight row now Travel/business and locked', bossFlight.expense_type === 'business' && bossFlight.category_id === travelId && bossFlight.type_locked === 1 && bossFlight.category_locked === 1, JSON.stringify(bossFlight))
  const bossDinner = db.prepare("SELECT expense_type, client FROM transactions WHERE card_id = ? AND description = 'PEDRO DINNER MEETING'").get(assignCard.id) as { expense_type: string | null; client: string | null }
  check('assignment: boss dinner row gained business type + client name', bossDinner.expense_type === 'business' && bossDinner.client === 'Acme Corp — P. Page', JSON.stringify(bossDinner))

  // A tampered/stale token (right id, wrong hash) must NOT update a row.
  const staleId = (db.prepare("SELECT id FROM transactions WHERE card_id = ? AND description = 'PEDRO OFFICE STORE'").get(assignCard.id) as { id: number }).id
  const tampered = mergeAssignment(db, {
    meta: returnedPacket.meta,
    categories: [],
    rows: [{ ref: `${staleId}:deadbeef`, date: '2026-04-03', description: 'PEDRO OFFICE STORE', amount: 45, type: 'personal', category: '', cardholder: 'PEDRO PAGE', client: '', businessPurpose: '' }]
  })
  check('assignment: hash mismatch is rejected, not applied', tampered.updated === 0 && tampered.unmatched === 1, JSON.stringify(tampered))
  const untouched = db.prepare('SELECT expense_type FROM transactions WHERE id = ?').get(staleId) as { expense_type: string | null }
  check('assignment: the mismatched row stayed unchanged', untouched.expense_type === null, JSON.stringify(untouched))

  // An unknown category name is surfaced, not silently created.
  const unknownCat = mergeAssignment(db, {
    meta: returnedPacket.meta,
    categories: [],
    rows: [{ ref: returnedRows[0].ref, date: returnedRows[0].date, description: returnedRows[0].description, amount: returnedRows[0].amount, type: '', category: 'Nonexistent Category', cardholder: '', client: '', businessPurpose: '' }]
  })
  check('assignment: unknown category name reported', unknownCat.unmatchedCategories.includes('Nonexistent Category'), JSON.stringify(unknownCat.unmatchedCategories))

  for (const p of [assignedPath, returnedPath]) if (existsSync(p)) unlinkSync(p)

  console.log('\n[12] Reconciliation: match statement charges to POs')
  db.prepare("INSERT INTO cards (name) VALUES ('Recon Test Amex')").run()
  const reconCard = db.prepare("SELECT * FROM cards WHERE name = 'Recon Test Amex'").get() as Card

  const insPo = db.prepare(
    `INSERT INTO po_cache (id, po_number, po_date, vendor, subtotal, sales_tax, total, status, is_chargeback, requester_name, lines_json)
     VALUES (@id, @po_number, @po_date, @vendor, @subtotal, @sales_tax, @total, 'CLOSED', 0, @requester_name, @lines_json)`
  )
  const po = (id: string, n: number, day: string, vendor: string, total: number, lines = '[]', requester = 'Tester'): void => {
    insPo.run({
      id,
      po_number: n,
      po_date: `2026-06-${day}T12:00:00.000Z`,
      vendor,
      subtotal: total,
      sales_tax: 0,
      total,
      requester_name: requester,
      lines_json: lines
    })
  }
  po('po-9001', 9001, '10', 'Amazon', 100.0) // unique exact for charge A -> auto
  po('po-9002', 9002, '10', 'Amazon', 250.0, '[{"description":"Office chairs","qty":1,"rate":250,"amount":250}]') // ambiguous
  po('po-9003', 9003, '11', 'Amazon', 250.0) // ambiguous (same amount as 9002)
  po('po-9004', 9004, '10', 'Dell', 500.0) // vendor test: matches the Dell charge, not Amazon
  po('po-9005', 9005, '10', 'Amazon', 77.77) // no charge -> posWithoutCharge report
  po('po-9006', 9006, '10', 'Amazon', 80.0) // band (not exact) target for charge G

  const insTxn = db.prepare(
    'INSERT INTO transactions (card_id, txn_date, description, amount, dedupe_hash) VALUES (?, ?, ?, ?, ?)'
  )
  const txn = (date: string, desc: string, amount: number): number =>
    Number(insTxn.run(reconCard.id, date, desc, amount, `recon-${desc}-${amount}`).lastInsertRowid)
  const txnA = txn('2026-06-12', 'AMZN Mktp US*A100', 100.0) // +2d, exact, unique -> auto 9001
  txn('2026-06-12', 'AMZN Mktp US*B250', 250.0) // exact but 2 POs -> queue (9002 + 9003)
  const txnC = txn('2026-06-11', 'DELL ORDER 0099', 500.0) // exact Dell -> auto 9004
  txn('2026-06-12', 'AMAZON.COM*ROGUE', 33.33) // no PO -> rogue report
  txn('2026-06-25', 'AMZN Mktp US*LATE', 100.0) // +15d, outside window -> no match
  txn('2026-06-12', 'AMZN Mktp US*BAND', 82.0) // 2.5% off 80.00 -> band -> queue, not auto

  const result = runMatch(db)
  // The matcher scans every card's charges (correct), so chargesConsidered also
  // counts rows left by earlier sections; only the 6 POs here are isolated.
  check('match: considered all charges + the 6 seeded POs', result.chargesConsidered >= 6 && result.posConsidered === 6, JSON.stringify(result))
  check('match: 2 auto-links (unique exact A->9001, C->9004)', result.autoLinked === 2, `got ${result.autoLinked}`)
  check('match: 2 charges queued for review (B, G)', result.queued === 2, `got ${result.queued}`)

  const autoA = db.prepare("SELECT po_id, status FROM po_links WHERE txn_id = ?").get(txnA) as { po_id: string; status: string } | undefined
  check('match: charge A auto-linked to PO 9001', autoA?.status === 'auto' && autoA.po_id === 'po-9001', JSON.stringify(autoA))
  const autoC = db.prepare("SELECT po_id, status FROM po_links WHERE txn_id = ?").get(txnC) as { po_id: string; status: string } | undefined
  check('match: Dell charge matched Dell PO (vendor gating)', autoC?.status === 'auto' && autoC.po_id === 'po-9004', JSON.stringify(autoC))

  const lateLinks = (db.prepare("SELECT COUNT(*) AS n FROM po_links l JOIN transactions t ON t.id = l.txn_id WHERE t.description LIKE '%LATE%'").get() as { n: number }).n
  check('match: out-of-window charge produced no link', lateLinks === 0, `got ${lateLinks}`)

  let reconQueue = getReviewQueue(db)
  const bItem = reconQueue.find((q) => q.description.includes('B250'))
  check('queue: ambiguous charge B has 2 candidate POs', bItem?.candidates.length === 2, `got ${bItem?.candidates.length}`)
  check('queue: candidate carries PO line detail', !!bItem?.candidates.find((c) => c.poNumber === 9002)?.lines.length)
  const gItem = reconQueue.find((q) => q.description.includes('BAND'))
  check('queue: band-only charge G has 1 candidate (PO 9006), not auto', gItem?.candidates.length === 1 && gItem.candidates[0].poNumber === 9006, JSON.stringify(gItem?.candidates))

  // Confirm B -> 9002; the competing pending (B -> 9003) must be dropped.
  const b9002 = bItem!.candidates.find((c) => c.poNumber === 9002)!
  confirmLink(db, b9002.linkId)
  const bConfirmed = db.prepare("SELECT status FROM po_links WHERE id = ?").get(b9002.linkId) as { status: string }
  check('confirm: chosen link becomes confirmed', bConfirmed.status === 'confirmed')
  const bLeftover = (db.prepare("SELECT COUNT(*) AS n FROM po_links l JOIN transactions t ON t.id = l.txn_id WHERE t.description LIKE '%B250%' AND l.status IN ('auto','pending')").get() as { n: number }).n
  check('confirm: competing candidate for the same charge removed', bLeftover === 0, `got ${bLeftover}`)
  reconQueue = getReviewQueue(db)
  check('queue: only charge G remains after confirming B', reconQueue.length === 1 && reconQueue[0].description.includes('BAND'), JSON.stringify(reconQueue.map((q) => q.description)))

  // PO-centric ledger (B confirmed, G still pending).
  const ledger = getLedger(db)
  check('ledger: 6 POs total', ledger.summary.totalPos === 6, JSON.stringify(ledger.summary))
  check('ledger: 3 matched (9001+9004 auto, 9002 confirmed)', ledger.summary.matchedPos === 3, JSON.stringify(ledger.summary))
  check('ledger: 1 PO in review (9006)', ledger.summary.reviewPos === 1, JSON.stringify(ledger.summary))
  check('ledger: 2 POs unmatched (9003, 9005)', ledger.summary.unmatchedPos === 2, JSON.stringify(ledger.summary))
  check('ledger: $850 reconciled (100+250+500)', Math.abs(ledger.summary.amountReconciled - 850) < 0.01, `got ${ledger.summary.amountReconciled}`)
  const li = (n: number): (typeof ledger.items)[number] | undefined => ledger.items.find((i) => i.poNumber === n)
  check('ledger: PO 9001 matched to charge A via auto-link', li(9001)?.status === 'matched' && li(9001)?.matchedTxnId === txnA && li(9001)?.linkStatus === 'auto', JSON.stringify(li(9001)))
  check('ledger: PO 9002 matched via confirmation', li(9002)?.status === 'matched' && li(9002)?.linkStatus === 'confirmed', JSON.stringify(li(9002)))
  check('ledger: PO 9006 shows as needs-review', li(9006)?.status === 'review' && li(9006)?.reviewCount === 1, JSON.stringify(li(9006)))
  check('ledger: PO 9005 shows as unmatched', li(9005)?.status === 'unmatched', JSON.stringify(li(9005)))

  // Unmatched charges, scoped to tracked vendors (defaults to ['Amazon']).
  const trackedAmazon = getUnmatchedCharges(db).map((c) => c.description).sort()
  check('unmatched (Amazon tracked): ROGUE + LATE', trackedAmazon.length === 2 && trackedAmazon.some((d) => d.includes('ROGUE')) && trackedAmazon.some((d) => d.includes('LATE')), JSON.stringify(trackedAmazon))
  check('unmatched: excludes the matched Dell charge', !trackedAmazon.some((d) => d.includes('DELL')))
  // Vendor scoping is general, not hardcoded to Amazon: track only Dell and the
  // Amazon charges drop out (no unmatched Dell charges here).
  setReconConfig({ trackedVendors: ['Dell'] })
  check('unmatched respects the tracked-vendor list (Dell only -> none)', getUnmatchedCharges(db).length === 0, JSON.stringify(getUnmatchedCharges(db)))
  setReconConfig({ trackedVendors: ['Amazon'] })

  // Reject G's candidate, then re-run: the rejected pair must not reappear.
  rejectLink(db, gItem!.candidates[0].linkId)
  const rematch = runMatch(db)
  check('reject: re-running the matcher does not resurrect a rejected pair', rematch.queued === 0, JSON.stringify(rematch))
  check('reject: confirmed link survives a re-run', (db.prepare("SELECT COUNT(*) AS n FROM po_links WHERE status = 'confirmed'").get() as { n: number }).n === 1)

  closeDb()
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  return failures === 0 ? 0 : 1
}
