import Database from 'better-sqlite3'

let db: Database.Database | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  default_expense_type TEXT NOT NULL DEFAULT 'business' CHECK (default_expense_type IN ('business','personal')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS import_profiles (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  date_col TEXT NOT NULL,
  amount_col TEXT NOT NULL,
  description_col TEXT NOT NULL,
  amount_col_secondary TEXT,
  date_format TEXT,
  amount_sign TEXT NOT NULL DEFAULT 'expense_positive' CHECK (amount_sign IN ('expense_positive','expense_negative')),
  cardholder_col TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(card_id)
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  hotkey TEXT CHECK (hotkey IS NULL OR length(hotkey) = 1),
  is_archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS category_rules (
  id INTEGER PRIMARY KEY,
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  expense_type TEXT CHECK (expense_type IN ('business','personal')),
  match_type TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains','starts_with','regex')),
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  CHECK (category_id IS NOT NULL OR expense_type IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id),
  filename TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  inserted_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  txn_date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  expense_type TEXT CHECK (expense_type IN ('business','personal')),
  type_locked INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_locked INTEGER NOT NULL DEFAULT 0,
  import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  dedupe_hash TEXT NOT NULL,
  cardholder TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  expense_type TEXT NOT NULL DEFAULT 'business' CHECK (expense_type IN ('business','personal')),
  monthly_limit REAL NOT NULL,
  UNIQUE(category_id, expense_type)
);

CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_txn_card ON transactions(card_id);
CREATE INDEX IF NOT EXISTS idx_txn_type ON transactions(expense_type);
CREATE INDEX IF NOT EXISTS idx_txn_dedupe ON transactions(dedupe_hash);

-- ---- Reconciliation (match statement charges to PO Automation records) ----

-- Generic key/value app settings (PO connection URL, encrypted token, match
-- tolerances, last-sync metadata). One row per setting key.
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Local cache of purchase orders pulled from the PO Automation read-only API.
-- id is the PO app's PurchaseOrder.id (cuid). Amounts mirror the statement's REAL
-- storage; lines_json holds [{description,qty,rate,amount}] for review/LLM context.
CREATE TABLE IF NOT EXISTS po_cache (
  id TEXT PRIMARY KEY,
  po_number INTEGER NOT NULL,
  po_date TEXT NOT NULL,
  vendor TEXT NOT NULL,
  subtotal REAL NOT NULL,
  sales_tax REAL NOT NULL,
  total REAL NOT NULL,
  status TEXT,
  is_chargeback INTEGER NOT NULL DEFAULT 0,
  chargeback_client TEXT,
  requester_name TEXT,
  requester_email TEXT,
  created_by_name TEXT,
  created_by_email TEXT,
  lines_json TEXT NOT NULL DEFAULT '[]',
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_po_cache_total ON po_cache(total);
CREATE INDEX IF NOT EXISTS idx_po_cache_date ON po_cache(po_date);
CREATE INDEX IF NOT EXISTS idx_po_cache_vendor ON po_cache(vendor);

-- A match between a statement transaction and a cached PO. status: 'auto'
-- (high-confidence auto-link), 'pending' (in the review queue), 'confirmed'
-- (boss approved), 'rejected' (boss dismissed). confidence 0..1; score_json
-- records the per-signal breakdown for transparency.
CREATE TABLE IF NOT EXISTS po_links (
  id INTEGER PRIMARY KEY,
  txn_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  po_id TEXT NOT NULL REFERENCES po_cache(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('auto','pending','confirmed','rejected')),
  confidence REAL,
  score_json TEXT,
  matched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(txn_id, po_id)
);
CREATE INDEX IF NOT EXISTS idx_po_links_txn ON po_links(txn_id);
CREATE INDEX IF NOT EXISTS idx_po_links_po ON po_links(po_id);
CREATE INDEX IF NOT EXISTS idx_po_links_status ON po_links(status);
`

const SEED_CATEGORIES: [string, string][] = [
  ['Travel', '#3b82f6'],
  ['Meals & Entertainment', '#f59e0b'],
  ['Office Supplies', '#8b5cf6'],
  ['Software & Subscriptions', '#06b6d4'],
  ['Fuel', '#ef4444'],
  ['Utilities', '#10b981'],
  ['Professional Services', '#6366f1'],
  ['Shipping', '#f97316'],
  ['Other', '#64748b'],
  ['Uncategorized', '#9ca3af']
]

function tableSql(database: Database.Database, name: string): string {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    | { sql: string }
    | undefined
  return row?.sql ?? ''
}

function createTransactionIndexes(database: Database.Database): void {
  database.exec(`
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_txn_card ON transactions(card_id);
CREATE INDEX IF NOT EXISTS idx_txn_type ON transactions(expense_type);
CREATE INDEX IF NOT EXISTS idx_txn_dedupe ON transactions(dedupe_hash);
`)
}

function createCategoryIndexes(database: Database.Database): void {
  database.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_hotkey_active ON categories(hotkey) WHERE hotkey IS NOT NULL AND is_archived = 0;
`)
}

function ensureCategoryHotkeyColumn(database: Database.Database): void {
  const columns = database.prepare('PRAGMA table_info(categories)').all() as { name: string }[]
  if (!columns.some((column) => column.name === 'hotkey')) {
    database.exec('ALTER TABLE categories ADD COLUMN hotkey TEXT')
  }
  createCategoryIndexes(database)
}

/** Add the per-transaction cardholder column to databases created before the
 *  cardholder feature. Runs after the table-rebuild migrations, which only fire
 *  on databases too old to carry this column, so a plain ALTER is safe. */
function ensureTransactionCardholderColumn(database: Database.Database): void {
  const columns = database.prepare('PRAGMA table_info(transactions)').all() as { name: string }[]
  if (!columns.some((column) => column.name === 'cardholder')) {
    database.exec('ALTER TABLE transactions ADD COLUMN cardholder TEXT')
  }
}

/** Add the saved cardholder-column mapping to pre-existing import profiles. */
function ensureProfileCardholderColumn(database: Database.Database): void {
  const columns = database.prepare('PRAGMA table_info(import_profiles)').all() as { name: string }[]
  if (!columns.some((column) => column.name === 'cardholder_col')) {
    database.exec('ALTER TABLE import_profiles ADD COLUMN cardholder_col TEXT')
  }
}

function ensureNullableTransactionType(database: Database.Database): void {
  const sql = tableSql(database, 'transactions')
  if (!sql.includes("'other'") && !sql.includes('expense_type TEXT NOT NULL')) return

  const priorForeignKeys = database.pragma('foreign_keys', { simple: true }) as number
  database.pragma('foreign_keys = OFF')
  try {
    const migrate = database.transaction(() => {
      database.exec(`
CREATE TABLE transactions_new (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  txn_date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  expense_type TEXT CHECK (expense_type IN ('business','personal')),
  type_locked INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_locked INTEGER NOT NULL DEFAULT 0,
  import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  dedupe_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO transactions_new (
  id,
  card_id,
  txn_date,
  description,
  amount,
  expense_type,
  type_locked,
  category_id,
  category_locked,
  import_batch_id,
  dedupe_hash,
  created_at
)
SELECT
  id,
  card_id,
  txn_date,
  description,
  amount,
  CASE WHEN expense_type = 'other' THEN NULL ELSE expense_type END,
  type_locked,
  category_id,
  category_locked,
  import_batch_id,
  dedupe_hash,
  created_at
FROM transactions;

DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
`)
    })
    migrate()
  } finally {
    database.pragma(`foreign_keys = ${priorForeignKeys ? 'ON' : 'OFF'}`)
  }
  createTransactionIndexes(database)
}

/**
 * Drop the legacy UNIQUE(dedupe_hash) constraint. The original schema deduped by
 * hash existence, which silently collapsed legitimately repeated charges — a
 * statement may list the same merchant, date, and amount several times (e.g. six
 * identical $2.00 service fees in one day). Dedup is now multiplicity-based in the
 * importer, so the table must permit multiple rows sharing a hash; a plain index
 * keeps the occurrence-count lookups fast.
 */
function ensureDedupeMultiplicity(database: Database.Database): void {
  const sql = tableSql(database, 'transactions')
  if (!/UNIQUE\s*\(\s*dedupe_hash\s*\)/i.test(sql)) {
    createTransactionIndexes(database)
    return
  }

  const priorForeignKeys = database.pragma('foreign_keys', { simple: true }) as number
  database.pragma('foreign_keys = OFF')
  try {
    const migrate = database.transaction(() => {
      database.exec(`
CREATE TABLE transactions_new (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  txn_date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  expense_type TEXT CHECK (expense_type IN ('business','personal')),
  type_locked INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_locked INTEGER NOT NULL DEFAULT 0,
  import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  dedupe_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO transactions_new (
  id,
  card_id,
  txn_date,
  description,
  amount,
  expense_type,
  type_locked,
  category_id,
  category_locked,
  import_batch_id,
  dedupe_hash,
  created_at
)
SELECT
  id,
  card_id,
  txn_date,
  description,
  amount,
  expense_type,
  type_locked,
  category_id,
  category_locked,
  import_batch_id,
  dedupe_hash,
  created_at
FROM transactions;

DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
`)
    })
    migrate()
  } finally {
    database.pragma(`foreign_keys = ${priorForeignKeys ? 'ON' : 'OFF'}`)
  }
  createTransactionIndexes(database)
}

function ensureSeedCategories(database: Database.Database): void {
  const insert = database.prepare('INSERT OR IGNORE INTO categories (name, color) VALUES (?, ?)')
  const seedMissing = database.transaction(() => {
    for (const [name, color] of SEED_CATEGORIES) insert.run(name, color)
  })
  seedMissing()
}

export function initDb(dbPath: string): Database.Database {
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  ensureNullableTransactionType(db)
  ensureDedupeMultiplicity(db)
  ensureTransactionCardholderColumn(db)
  ensureProfileCardholderColumn(db)
  ensureCategoryHotkeyColumn(db)

  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }
  if (count.n === 0) {
    const insert = db.prepare('INSERT INTO categories (name, color) VALUES (?, ?)')
    const seedAll = db.transaction(() => {
      for (const [name, color] of SEED_CATEGORIES) insert.run(name, color)
    })
    seedAll()
  }
  ensureSeedCategories(db)
  createCategoryIndexes(db)
  return db
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
