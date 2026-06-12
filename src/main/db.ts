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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(card_id)
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
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
  expense_type TEXT NOT NULL CHECK (expense_type IN ('business','personal')),
  type_locked INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_locked INTEGER NOT NULL DEFAULT 0,
  import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  dedupe_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(dedupe_hash)
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
  ['Uncategorized', '#9ca3af']
]

export function initDb(dbPath: string): Database.Database {
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)

  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }
  if (count.n === 0) {
    const insert = db.prepare('INSERT INTO categories (name, color) VALUES (?, ?)')
    const seedAll = db.transaction(() => {
      for (const [name, color] of SEED_CATEGORIES) insert.run(name, color)
    })
    seedAll()
  }
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
