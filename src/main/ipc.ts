import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import { copyFileSync } from 'fs'
import { basename } from 'path'
import type Database from 'better-sqlite3'
import { getDb, closeDb, initDb } from './db'
import { buildPreview, commitImport, parseFile } from './importer'
import { rerunRules } from './rules'
import type {
  Card,
  ColumnMapping,
  CommitRow,
  ExpenseType,
  IpcResult,
  KpiFilters,
  Kpis,
  TxnFilters
} from '@shared/types'

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

function buildTxnWhere(filters: TxnFilters): { where: string; params: Record<string, unknown> } {
  const clauses: string[] = []
  const params: Record<string, unknown> = {}
  if (filters.expenseType && filters.expenseType !== 'all') {
    clauses.push('t.expense_type = @expenseType')
    params.expenseType = filters.expenseType
  }
  if (filters.cardId) {
    clauses.push('t.card_id = @cardId')
    params.cardId = filters.cardId
  }
  if (filters.categoryId === 'uncategorized') {
    clauses.push('t.category_id IS NULL')
  } else if (filters.categoryId) {
    clauses.push('t.category_id = @categoryId')
    params.categoryId = filters.categoryId
  }
  if (filters.search) {
    clauses.push('t.description LIKE @search')
    params.search = `%${filters.search}%`
  }
  if (filters.dateFrom) {
    clauses.push('t.txn_date >= @dateFrom')
    params.dateFrom = filters.dateFrom
  }
  if (filters.dateTo) {
    clauses.push('t.txn_date <= @dateTo')
    params.dateTo = filters.dateTo
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

function getKpis(db: Database.Database, filters: KpiFilters): Kpis {
  const { where, params } = buildTxnWhere(filters)

  const totalSpend =
    (db.prepare(`SELECT COALESCE(SUM(t.amount), 0) AS total FROM transactions t ${where}`).get(params) as {
      total: number
    }).total

  // previous period of equal length, immediately before dateFrom
  const from = new Date(`${filters.dateFrom}T00:00:00Z`)
  const to = new Date(`${filters.dateTo}T00:00:00Z`)
  const spanMs = to.getTime() - from.getTime() + 86400000
  const prevFrom = new Date(from.getTime() - spanMs).toISOString().slice(0, 10)
  const prevTo = new Date(from.getTime() - 86400000).toISOString().slice(0, 10)
  const prev = buildTxnWhere({ ...filters, dateFrom: prevFrom, dateTo: prevTo })
  const prevPeriodSpend =
    (db.prepare(`SELECT COALESCE(SUM(t.amount), 0) AS total FROM transactions t ${prev.where}`).get(prev.params) as {
      total: number
    }).total

  const byCategory = db
    .prepare(
      `SELECT COALESCE(c.name, 'Uncategorized') AS category, c.color, SUM(t.amount) AS total
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       ${where} GROUP BY t.category_id ORDER BY total DESC`
    )
    .all(params) as Kpis['byCategory']

  const monthlyTrend = db
    .prepare(
      `SELECT strftime('%Y-%m', t.txn_date) AS month, SUM(t.amount) AS total
       FROM transactions t ${where} GROUP BY month ORDER BY month ASC`
    )
    .all(params) as Kpis['monthlyTrend']

  const topVendors = db
    .prepare(
      `SELECT t.description AS vendor, SUM(t.amount) AS total, COUNT(*) AS count
       FROM transactions t ${where} GROUP BY UPPER(t.description) ORDER BY total DESC LIMIT 10`
    )
    .all(params) as Kpis['topVendors']

  let budgetVsActual: Kpis['budgetVsActual'] = []
  if (filters.expenseType !== 'all') {
    budgetVsActual = db
      .prepare(
        `SELECT c.name AS category, b.monthly_limit AS "limit",
                COALESCE((SELECT SUM(t.amount) FROM transactions t
                          WHERE t.category_id = b.category_id AND t.expense_type = b.expense_type
                            AND t.txn_date >= @dateFrom AND t.txn_date <= @dateTo
                            ${filters.cardId ? 'AND t.card_id = @cardId' : ''}), 0) AS actual
         FROM budgets b JOIN categories c ON c.id = b.category_id
         WHERE b.expense_type = @expenseType ORDER BY c.name`
      )
      .all(params) as Kpis['budgetVsActual']
  }

  const uncategorizedCount =
    (db.prepare(`SELECT COUNT(*) AS n FROM transactions t ${where ? `${where} AND` : 'WHERE'} t.category_id IS NULL`).get(
      params
    ) as { n: number }).n

  return { totalSpend, prevPeriodSpend, byCategory, monthlyTrend, topVendors, budgetVsActual, uncategorizedCount }
}

export function registerIpcHandlers(): void {
  // ---- cards ----
  handle('cards.list', () => getDb().prepare('SELECT * FROM cards ORDER BY name').all())
  handle('cards.create', (p: { name: string; default_expense_type: ExpenseType }) => {
    const result = getDb()
      .prepare('INSERT INTO cards (name, default_expense_type) VALUES (?, ?)')
      .run(p.name.trim(), p.default_expense_type)
    return getDb().prepare('SELECT * FROM cards WHERE id = ?').get(result.lastInsertRowid)
  })
  handle('cards.update', (p: { id: number; name: string; default_expense_type: ExpenseType }) => {
    getDb()
      .prepare('UPDATE cards SET name = ?, default_expense_type = ? WHERE id = ?')
      .run(p.name.trim(), p.default_expense_type, p.id)
    return getDb().prepare('SELECT * FROM cards WHERE id = ?').get(p.id)
  })
  handle('cards.delete', (p: { id: number }) => {
    getDb().prepare('DELETE FROM cards WHERE id = ?').run(p.id)
    return true
  })

  // ---- import profiles ----
  handle('profiles.get', (p: { cardId: number }) =>
    getDb().prepare('SELECT * FROM import_profiles WHERE card_id = ?').get(p.cardId) ?? null
  )
  handle('profiles.save', (p: { cardId: number; mapping: ColumnMapping }) => {
    getDb()
      .prepare(
        `INSERT INTO import_profiles (card_id, name, date_col, amount_col, description_col, amount_col_secondary, date_format, amount_sign)
         VALUES (@cardId, 'default', @date_col, @amount_col, @description_col, @amount_col_secondary, @date_format, @amount_sign)
         ON CONFLICT(card_id) DO UPDATE SET
           date_col = @date_col, amount_col = @amount_col, description_col = @description_col,
           amount_col_secondary = @amount_col_secondary, date_format = @date_format, amount_sign = @amount_sign`
      )
      .run({ cardId: p.cardId, ...p.mapping })
    return true
  })

  // ---- categories ----
  handle('categories.list', () => getDb().prepare('SELECT * FROM categories WHERE is_archived = 0 ORDER BY name').all())
  handle('categories.create', (p: { name: string; color: string | null }) => {
    const result = getDb().prepare('INSERT INTO categories (name, color) VALUES (?, ?)').run(p.name.trim(), p.color)
    return getDb().prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid)
  })
  handle('categories.update', (p: { id: number; name: string; color: string | null }) => {
    getDb().prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').run(p.name.trim(), p.color, p.id)
    return getDb().prepare('SELECT * FROM categories WHERE id = ?').get(p.id)
  })
  handle('categories.delete', (p: { id: number }) => {
    getDb().prepare('UPDATE categories SET is_archived = 1 WHERE id = ?').run(p.id)
    return true
  })

  // ---- rules ----
  handle('rules.list', () => getDb().prepare('SELECT * FROM category_rules ORDER BY priority DESC, id').all())
  handle(
    'rules.create',
    (p: { category_id: number | null; expense_type: ExpenseType | null; match_type: string; pattern: string; priority: number }) => {
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
    (p: { id: number; category_id: number | null; expense_type: ExpenseType | null; match_type: string; pattern: string; priority: number }) => {
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
    const sortBy = ['txn_date', 'amount', 'description'].includes(filters.sortBy ?? '') ? filters.sortBy : 'txn_date'
    const sortDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC'
    const pageSize = Math.min(filters.pageSize ?? 50, 500)
    const offset = (filters.page ?? 0) * pageSize
    const rows = db
      .prepare(
        `SELECT t.*, ca.name AS card_name, c.name AS category_name
         FROM transactions t
         JOIN cards ca ON ca.id = t.card_id
         LEFT JOIN categories c ON c.id = t.category_id
         ${where} ORDER BY t.${sortBy} ${sortDir}, t.id DESC LIMIT ${pageSize} OFFSET ${offset}`
      )
      .all(params)
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM transactions t ${where}`).get(params) as { n: number }).n
    return { rows, total }
  })
  handle('transactions.update', (p: { id: number; category_id?: number | null; expense_type?: ExpenseType }) => {
    const db = getDb()
    if (p.category_id !== undefined) {
      db.prepare('UPDATE transactions SET category_id = ?, category_locked = 1 WHERE id = ?').run(p.category_id, p.id)
    }
    if (p.expense_type !== undefined) {
      db.prepare('UPDATE transactions SET expense_type = ?, type_locked = 1 WHERE id = ?').run(p.expense_type, p.id)
    }
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(p.id)
  })
  handle('transactions.bulkUpdate', (p: { ids: number[]; category_id?: number | null; expense_type?: ExpenseType }) => {
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

  // ---- import ----
  handle('import.pickFile', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      title: 'Choose a card statement',
      filters: [{ name: 'Statements', extensions: ['csv', 'xlsx', 'xls'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return parseFile(result.filePaths[0])
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
        `SELECT b.*, c.name AS card_name FROM import_batches b JOIN cards c ON c.id = b.card_id
         ORDER BY b.imported_at DESC LIMIT 20`
      )
      .all()
  )

  // ---- dashboard ----
  handle('dashboard.getKpis', (filters: KpiFilters) => getKpis(getDb(), filters))

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
}
