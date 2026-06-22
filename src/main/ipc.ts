import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import { copyFileSync, writeFileSync } from 'fs'
import { basename } from 'path'
import type Database from 'better-sqlite3'
import { getDb, closeDb, initDb } from './db'
import { buildPreview, commitImport, parseFile } from './importer'
import { rerunRules } from './rules'
import { clearTransactions, deleteCard, deleteImportBatch } from './cleanup'
import { appendWhere, buildTxnWhere, fetchCardholderSpend, fetchTransactionsForExport, TXN_SORT_EXPRESSIONS } from './query'
import { buildCsv, buildDashboardFileName, buildExportFileName, buildReportFileName, buildXlsx } from './export'
import { checkForUpdates } from './updater'
import type {
  Card,
  Category,
  ColumnMapping,
  CommitRow,
  DashboardExportResult,
  ExpenseType,
  ExportFormat,
  ExportResult,
  IpcResult,
  KpiFilters,
  Kpis,
  TransactionClearRequest,
  TxnFilters
} from '@shared/types'

const RESERVED_HOTKEYS = new Set(['b', 'p', 'r'])
const INCOME_CATEGORY_SQL = "lower(COALESCE(c.name, '')) = 'income'"
const REPORTABLE_SPEND_CATEGORY_SQL = "lower(COALESCE(c.name, '')) NOT IN ('income', 'transers', 'transfers')"

function normalizeCategoryHotkey(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase()
  if (!value) return null
  if (!/^[a-z0-9]$/.test(value)) throw new Error('Use one letter or number for a category hotkey.')
  if (RESERVED_HOTKEYS.has(value)) throw new Error('B, P, and R are reserved for Quick Categorize controls.')
  return value
}

function setCategoryHotkey(db: Database.Database, id: number, rawHotkey: string | null): Category {
  const category = db.prepare('SELECT * FROM categories WHERE id = ? AND is_archived = 0').get(id) as Category | undefined
  if (!category) throw new Error('Category not found.')

  const hotkey = normalizeCategoryHotkey(rawHotkey)
  if (hotkey) {
    const existing = db
      .prepare('SELECT name FROM categories WHERE lower(hotkey) = ? AND id <> ? AND is_archived = 0')
      .get(hotkey, id) as { name: string } | undefined
    if (existing) throw new Error(`Hotkey ${hotkey.toUpperCase()} is already assigned to ${existing.name}.`)
  }

  db.prepare('UPDATE categories SET hotkey = ? WHERE id = ?').run(hotkey, id)
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as Category
}

function handle<T>(channel: string, fn: (payload: never) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_event, payload): Promise<IpcResult<T>> => {
    try {
      return { ok: true, data: await fn(payload as never) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[ipc] ${channel} failed:`, message)
      return { ok: false, error: message }
    }
  })
}

function getKpis(db: Database.Database, filters: KpiFilters): Kpis {
  const { where, params } = buildTxnWhere(filters)
  const spendWhere = appendWhere(where, REPORTABLE_SPEND_CATEGORY_SQL)
  const incomeWhere = appendWhere(where, INCOME_CATEGORY_SQL)

  const totalSpend =
    (db.prepare(`SELECT COALESCE(SUM(t.amount), 0) AS total
                 FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
                 ${spendWhere}`).get(params) as {
      total: number
    }).total

  const totalIncome =
    (db.prepare(`SELECT COALESCE(SUM(ABS(t.amount)), 0) AS total
                 FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
                 ${incomeWhere}`).get(params) as {
      total: number
    }).total

  // previous period of equal length, immediately before dateFrom
  const from = new Date(`${filters.dateFrom}T00:00:00Z`)
  const to = new Date(`${filters.dateTo}T00:00:00Z`)
  const spanMs = to.getTime() - from.getTime() + 86400000
  const prevFrom = new Date(from.getTime() - spanMs).toISOString().slice(0, 10)
  const prevTo = new Date(from.getTime() - 86400000).toISOString().slice(0, 10)
  const prev = buildTxnWhere({ ...filters, dateFrom: prevFrom, dateTo: prevTo })
  const prevSpendWhere = appendWhere(prev.where, REPORTABLE_SPEND_CATEGORY_SQL)
  const prevIncomeWhere = appendWhere(prev.where, INCOME_CATEGORY_SQL)
  const prevPeriodSpend =
    (db.prepare(`SELECT COALESCE(SUM(t.amount), 0) AS total
                 FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
                 ${prevSpendWhere}`).get(prev.params) as {
      total: number
    }).total
  const prevPeriodIncome =
    (db.prepare(`SELECT COALESCE(SUM(ABS(t.amount)), 0) AS total
                 FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
                 ${prevIncomeWhere}`).get(prev.params) as {
      total: number
    }).total

  const byCategory = db
    .prepare(
      `SELECT COALESCE(c.name, 'Uncategorized') AS category, c.color, SUM(t.amount) AS total
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       ${spendWhere} GROUP BY t.category_id HAVING SUM(t.amount) > 0 ORDER BY total DESC`
    )
    .all(params) as Kpis['byCategory']

  const monthlyTrend = db
    .prepare(
      `SELECT strftime('%Y-%m', t.txn_date) AS month, SUM(t.amount) AS total
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       ${spendWhere} GROUP BY month ORDER BY month ASC`
    )
    .all(params) as Kpis['monthlyTrend']

  const topVendors = db
    .prepare(
      `SELECT t.description AS vendor, SUM(t.amount) AS total, COUNT(*) AS count
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       ${spendWhere} GROUP BY UPPER(t.description) HAVING SUM(t.amount) > 0 ORDER BY total DESC LIMIT 10`
    )
    .all(params) as Kpis['topVendors']

  let budgetVsActual: Kpis['budgetVsActual'] = []
  if (filters.expenseType === 'business' || filters.expenseType === 'personal') {
    budgetVsActual = db
      .prepare(
        `SELECT c.name AS category, b.monthly_limit AS "limit",
                COALESCE((SELECT SUM(t.amount) FROM transactions t
                          WHERE t.category_id = b.category_id AND t.expense_type = b.expense_type
                            AND t.txn_date >= @dateFrom AND t.txn_date <= @dateTo
                            ${filters.cardId ? 'AND t.card_id = @cardId' : ''}), 0) AS actual
         FROM budgets b JOIN categories c ON c.id = b.category_id
         WHERE b.expense_type = @expenseType AND lower(c.name) NOT IN ('income', 'transers', 'transfers') ORDER BY c.name`
      )
      .all(params) as Kpis['budgetVsActual']
  }

  const uncategorizedCount =
    (db.prepare(`SELECT COUNT(*) AS n FROM transactions t ${where ? `${where} AND` : 'WHERE'} t.category_id IS NULL`).get(
      params
    ) as { n: number }).n

  return {
    totalSpend,
    totalIncome,
    prevPeriodSpend,
    prevPeriodIncome,
    byCategory,
    monthlyTrend,
    topVendors,
    budgetVsActual,
    uncategorizedCount
  }
}

export function registerIpcHandlers(): void {
  // ---- cards ----
  handle('cards.list', () => getDb().prepare('SELECT * FROM cards ORDER BY name').all())
  handle('cards.create', (p: { name: string }) => {
    // No per-card expense type: statements mix both, so merchant rules or review
    // do the business/personal split. Unmatched rows import with no type set.
    const result = getDb().prepare('INSERT INTO cards (name) VALUES (?)').run(p.name.trim())
    return getDb().prepare('SELECT * FROM cards WHERE id = ?').get(result.lastInsertRowid)
  })
  handle('cards.update', (p: { id: number; name: string }) => {
    getDb().prepare('UPDATE cards SET name = ? WHERE id = ?').run(p.name.trim(), p.id)
    return getDb().prepare('SELECT * FROM cards WHERE id = ?').get(p.id)
  })
  handle('cards.delete', (p: { id: number }) => {
    deleteCard(getDb(), p.id)
    return true
  })

  // ---- import profiles ----
  handle('profiles.get', (p: { cardId: number }) =>
    getDb().prepare('SELECT * FROM import_profiles WHERE card_id = ?').get(p.cardId) ?? null
  )
  handle('profiles.save', (p: { cardId: number; mapping: ColumnMapping }) => {
    getDb()
      .prepare(
        `INSERT INTO import_profiles (card_id, name, date_col, amount_col, description_col, amount_col_secondary, cardholder_col, date_format, amount_sign)
         VALUES (@cardId, 'default', @date_col, @amount_col, @description_col, @amount_col_secondary, @cardholder_col, @date_format, @amount_sign)
         ON CONFLICT(card_id) DO UPDATE SET
           date_col = @date_col, amount_col = @amount_col, description_col = @description_col,
           amount_col_secondary = @amount_col_secondary, cardholder_col = @cardholder_col,
           date_format = @date_format, amount_sign = @amount_sign`
      )
      .run({ cardId: p.cardId, ...p.mapping })
    return true
  })

  // ---- categories ----
  handle('categories.list', () => getDb().prepare('SELECT * FROM categories WHERE is_archived = 0 ORDER BY name').all())
  handle('categories.create', (p: { name: string; color: string | null }) => {
    const result = getDb().prepare('INSERT INTO categories (name, color, hotkey) VALUES (?, ?, NULL)').run(p.name.trim(), p.color)
    return getDb().prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid)
  })
  handle('categories.update', (p: { id: number; name: string; color: string | null }) => {
    getDb().prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').run(p.name.trim(), p.color, p.id)
    return getDb().prepare('SELECT * FROM categories WHERE id = ?').get(p.id)
  })
  handle('categories.setHotkey', (p: { id: number; hotkey: string | null }) => setCategoryHotkey(getDb(), p.id, p.hotkey))
  handle('categories.delete', (p: { id: number }) => {
    getDb().prepare('UPDATE categories SET is_archived = 1 WHERE id = ?').run(p.id)
    return true
  })

  // ---- rules ----
  handle('rules.list', () => getDb().prepare('SELECT * FROM category_rules ORDER BY priority DESC, id').all())
  handle(
    'rules.create',
    (p: {
      category_id: number | null
      expense_type: ExpenseType | null
      match_type: string
      pattern: string
      priority: number
    }) => {
      const result = getDb()
        .prepare(
          'INSERT INTO category_rules (category_id, expense_type, match_type, pattern, priority) VALUES (?, ?, ?, ?, ?)'
        )
        .run(p.category_id, p.expense_type, p.match_type, p.pattern.trim(), p.priority)
      return getDb().prepare('SELECT * FROM category_rules WHERE id = ?').get(result.lastInsertRowid)
    }
  )
  handle(
    'rules.update',
    (p: {
      id: number
      category_id: number | null
      expense_type: ExpenseType | null
      match_type: string
      pattern: string
      priority: number
    }) => {
      getDb()
        .prepare(
          'UPDATE category_rules SET category_id = ?, expense_type = ?, match_type = ?, pattern = ?, priority = ? WHERE id = ?'
        )
        .run(p.category_id, p.expense_type, p.match_type, p.pattern.trim(), p.priority, p.id)
      return getDb().prepare('SELECT * FROM category_rules WHERE id = ?').get(p.id)
    }
  )
  handle('rules.delete', (p: { id: number }) => {
    getDb().prepare('DELETE FROM category_rules WHERE id = ?').run(p.id)
    return true
  })
  handle('rules.rerun', () => rerunRules(getDb()))

  // ---- budgets ----
  handle('budgets.list', () => getDb().prepare('SELECT * FROM budgets').all())
  handle('budgets.upsert', (p: { category_id: number; expense_type: ExpenseType; monthly_limit: number }) => {
    getDb()
      .prepare(
        `INSERT INTO budgets (category_id, expense_type, monthly_limit) VALUES (@category_id, @expense_type, @monthly_limit)
         ON CONFLICT(category_id, expense_type) DO UPDATE SET monthly_limit = @monthly_limit`
      )
      .run(p)
    return true
  })
  handle('budgets.delete', (p: { id: number }) => {
    getDb().prepare('DELETE FROM budgets WHERE id = ?').run(p.id)
    return true
  })

  // ---- transactions ----
  handle('transactions.list', (filters: TxnFilters) => {
    const db = getDb()
    const { where, params } = buildTxnWhere(filters)
    const sortBy = filters.sortBy && filters.sortBy in TXN_SORT_EXPRESSIONS ? filters.sortBy : 'txn_date'
    const sortDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC'
    const pageSize = Math.min(filters.pageSize ?? 50, 500)
    const offset = (filters.page ?? 0) * pageSize
    const rows = db
      .prepare(
        `SELECT t.*, ca.name AS card_name, c.name AS category_name
         FROM transactions t
         JOIN cards ca ON ca.id = t.card_id
         LEFT JOIN categories c ON c.id = t.category_id
         ${where} ORDER BY ${TXN_SORT_EXPRESSIONS[sortBy]} ${sortDir}, t.id DESC LIMIT ${pageSize} OFFSET ${offset}`
      )
      .all(params)
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM transactions t ${where}`).get(params) as { n: number }).n
    return { rows, total }
  })
  handle('transactions.update', (p: { id: number; category_id?: number | null; expense_type?: ExpenseType | null }) => {
    const db = getDb()
    if (p.category_id !== undefined) {
      db.prepare('UPDATE transactions SET category_id = ?, category_locked = 1 WHERE id = ?').run(p.category_id, p.id)
    }
    if (p.expense_type !== undefined) {
      db.prepare('UPDATE transactions SET expense_type = ?, type_locked = 1 WHERE id = ?').run(p.expense_type, p.id)
    }
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(p.id)
  })
  handle('transactions.bulkUpdate', (p: { ids: number[]; category_id?: number | null; expense_type?: ExpenseType | null }) => {
    const db = getDb()
    const updCat = db.prepare('UPDATE transactions SET category_id = ?, category_locked = 1 WHERE id = ?')
    const updType = db.prepare('UPDATE transactions SET expense_type = ?, type_locked = 1 WHERE id = ?')
    const run = db.transaction(() => {
      for (const id of p.ids) {
        if (p.category_id !== undefined) updCat.run(p.category_id, id)
        if (p.expense_type !== undefined) updType.run(p.expense_type, id)
      }
    })
    run()
    return p.ids.length
  })
  handle('transactions.clear', (p: TransactionClearRequest) => ({ deleted: clearTransactions(getDb(), p) }))
  // Quick-categorize queue: every transaction, uncategorized first, newest first
  // within each group. Ignores the global business/personal filter on purpose —
  // it is a one-pass cleanup over the whole dataset.
  handle('transactions.categorizeQueue', () =>
    getDb()
      .prepare(
        `SELECT t.*, ca.name AS card_name, c.name AS category_name
         FROM transactions t
         JOIN cards ca ON ca.id = t.card_id
         LEFT JOIN categories c ON c.id = t.category_id
         ORDER BY (t.category_id IS NULL) DESC, t.txn_date DESC, t.id DESC`
      )
      .all()
  )
  // Net spend per cardholder for the current filters — biggest spender first.
  handle('transactions.cardholderSpend', (filters: TxnFilters) => fetchCardholderSpend(getDb(), filters))
  // Full filtered row set for the printable report (rendered in the renderer).
  handle('transactions.exportRows', (filters: TxnFilters) => fetchTransactionsForExport(getDb(), filters))
  // Write the filtered rows to a CSV, Excel file, or mounted PDF report the user chooses via save dialog.
  handle('transactions.export', async (p: { filters: TxnFilters; format: ExportFormat; fileNameBase?: string }) => {
    const rows = fetchTransactionsForExport(getDb(), p.filters)
    if (rows.length === 0) throw new Error('No transactions match the current filters — nothing to export.')
    const win = BrowserWindow.getFocusedWindow()
    if (p.format === 'pdf' && !win) throw new Error('No active window is available for PDF export.')
    const result = await dialog.showSaveDialog(win ?? new BrowserWindow({ show: false }), {
      title: 'Export transactions',
      defaultPath: p.fileNameBase
        ? buildReportFileName(p.fileNameBase, p.format)
        : buildExportFileName(p.filters, rows, p.format),
      filters:
        p.format === 'csv'
          ? [{ name: 'CSV (comma-separated)', extensions: ['csv'] }]
          : p.format === 'xlsx'
            ? [{ name: 'Excel workbook', extensions: ['xlsx'] }]
            : [{ name: 'PDF document', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return null
    if (p.format === 'csv') writeFileSync(result.filePath, buildCsv(rows), 'utf8')
    else if (p.format === 'xlsx') writeFileSync(result.filePath, buildXlsx(rows))
    else {
      const pdf = await win!.webContents.printToPDF({
        printBackground: true,
        pageSize: 'Letter',
        margins: { marginType: 'default' }
      })
      writeFileSync(result.filePath, pdf)
    }
    return { path: result.filePath, count: rows.length } satisfies ExportResult
  })

  // ---- import ----
  handle('import.pickFile', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      title: 'Choose a card statement',
      filters: [
        { name: 'CSV, Excel, or PDF statements', extensions: ['csv', 'xlsx', 'xls', 'pdf'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return await parseFile(result.filePaths[0])
  })
  handle('import.preview', (p: { cardId: number; rows: Record<string, string>[]; mapping: ColumnMapping }) => {
    const db = getDb()
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(p.cardId) as Card | undefined
    if (!card) throw new Error('Card not found')
    return buildPreview(db, card, p.rows, p.mapping)
  })
  handle('import.commit', (p: { cardId: number; filename: string; rows: CommitRow[] }) =>
    commitImport(getDb(), p.cardId, p.filename, p.rows)
  )
  handle('import.batches', () =>
    getDb()
      .prepare(
        `SELECT b.*, c.name AS card_name,
                (SELECT COUNT(*) FROM transactions t WHERE t.import_batch_id = b.id) AS transaction_count
         FROM import_batches b JOIN cards c ON c.id = b.card_id
         ORDER BY b.imported_at DESC, b.id DESC`
      )
      .all()
  )
  handle('import.deleteBatch', (p: { id: number }) => ({
    deleted: deleteImportBatch(getDb(), p.id)
  }))

  // ---- dashboard ----
  handle('dashboard.getKpis', (filters: KpiFilters) => getKpis(getDb(), filters))
  // Save the dashboard as a PDF. The renderer mounts a printable #print-root view
  // before invoking this; printToPDF captures it via the @media print rules.
  handle('dashboard.exportPdf', async (p: { filters: KpiFilters }) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) throw new Error('No active window is available for PDF export.')
    const result = await dialog.showSaveDialog(win, {
      title: 'Export dashboard',
      defaultPath: buildDashboardFileName(p.filters),
      filters: [{ name: 'PDF document', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return null
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'Letter',
      margins: { marginType: 'default' }
    })
    writeFileSync(result.filePath, pdf)
    return { path: result.filePath } satisfies DashboardExportResult
  })

  // ---- db / settings ----
  handle('db.getPath', () => getDb().name)
  handle('db.backup', async () => {
    const db = getDb()
    const result = await dialog.showSaveDialog({
      title: 'Backup database',
      defaultPath: `expense-tracker-backup-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: 'SQLite database', extensions: ['db'] }]
    })
    if (result.canceled || !result.filePath) return null
    await db.backup(result.filePath)
    return result.filePath
  })
  handle('db.restore', async () => {
    const db = getDb()
    const result = await dialog.showOpenDialog({
      title: 'Restore database from backup',
      filters: [{ name: 'SQLite database', extensions: ['db'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const dbPath = db.name
    closeDb()
    copyFileSync(result.filePaths[0], dbPath)
    initDb(dbPath)
    return basename(result.filePaths[0])
  })

  // app metadata
  handle('app.version', () => app.getVersion())
  handle('updates.check', () => checkForUpdates(BrowserWindow.getFocusedWindow()))
}
