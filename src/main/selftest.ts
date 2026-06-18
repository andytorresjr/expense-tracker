/**
 * Headless verification of the import pipeline (run with `npm run selftest`).
 * Exercises the real main-process modules against the sample statements,
 * covering the §10 milestone checks: schema, import, dedupe on re-import,
 * neutral expense type, type toggling with lock semantics.
 */
import { app } from 'electron'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import * as XLSX from 'xlsx'
import { initDb, closeDb } from './db'
import { buildPreview, commitImport, detectHeaderRow, parseAmount, parseFile } from './importer'
import { rerunRules } from './rules'
import { clearTransactions, deleteCard, deleteImportBatch } from './cleanup'
import { fetchTransactionsForExport } from './query'
import { buildCsv, buildExportFileName, buildXlsx } from './export'
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
  const bank = await parseFile(join(app.getAppPath(), 'samples', 'sample-bank.csv'))
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
      category_id: r.category_id
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
      category_id: null
    },
    {
      txn_date: '2024-02-15',
      description: 'SELFTEST CLEANUP FEBRUARY',
      amount: 20,
      expense_type: 'business',
      category_id: null
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
    { txn_date: '2026-03-01', description: 'DINING ONE', amount: 25, expense_type: 'business', category_id: mealsId },
    { txn_date: '2026-03-02', description: 'DINING TWO', amount: 40, expense_type: 'personal', category_id: mealsId },
    { txn_date: '2026-03-03', description: 'TRAVEL ONE', amount: 100, expense_type: 'business', category_id: travelId }
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

  closeDb()
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  return failures === 0 ? 0 : 1
}
