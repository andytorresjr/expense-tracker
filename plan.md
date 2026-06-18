# Build Plan: Standalone Company Card Expense Tracker

**For:** Claude Code, executing in the project terminal
**Audience of the finished app:** Company owners (non-technical), on Windows
**Hard constraints:** Zero recurring cost. Fully local. No cloud, no Plaid, no API keys, no hosting, no telemetry. Data never leaves the machine.

---

## Current Status

**Release candidate:** `1.1.0`

The planned application is implemented. Additional completed workflows include:

- Quick Categorize with keyboard-first category/type assignment and rule creation.
- Unassigned transaction type so unmatched imports stay out of Business and Personal until reviewed.
- `Other` spending category for transactions that do not fit a more specific category.
- Statement header detection for Excel exports with issuer preambles.
- Import History with per-statement transaction ownership and deletion.
- Transaction clearing by date range or all, while retaining import history.
- Card deletion cleanup for related transactions, import profiles, and import history.
- Full local database backup and restore.
- Selectable-text PDF statement import using Mozilla PDF.js, feeding the existing mapping, preview, rules, dedupe, commit, and import history flow.
- Windows NSIS installer and portable executable builds.

Distribution and owner handoff are documented in `RELEASE.md`.

---

## 0. Goal & Non-Goals

**Goal:** A double-click Windows desktop app where the owners import a card statement (CSV, Excel, or selectable-text PDF), the app categorizes transactions and splits them into **business vs. personal** (the owner pays for business expenses with his personal card, so statements mix both), and a dashboard shows spending KPIs and reports — switchable between business and personal so each can be reported separately.

**Non-goals (do NOT build these):**
- No multi-user / accounts / login (single local user).
- No bank/Plaid sync. Import only.
- No OCR/scanned-statement parsing. The first PDF import path supports selectable text only.
- No cloud sync, no server, no external API calls of any kind.
- No investment/net-worth/budgeting-app features. This is expense analysis only. (Tracking the *personal* slice of card spending IS in scope — see the business/personal split — but only as expense analysis, same as business.)

**Why this stack:** Electron (all-JavaScript, easy to maintain) + React (UI) + SQLite via better-sqlite3 (local file DB, no server). Everything is free and open-source. The only "cost" is build time.

---

## 1. Tech Stack (all free)

- **Electron** — desktop shell, produces a Windows `.exe` installer.
- **electron-vite** — build tooling (fast, handles main/preload/renderer).
- **React + TypeScript** — UI.
- **better-sqlite3** — synchronous local SQLite (native module; runs in the Electron main process).
- **Tailwind CSS** — styling.
- **Recharts** — charts (free, React-native).
- **PapaParse** — CSV parsing.
- **SheetJS (xlsx)** — Excel parsing.
- **Mozilla PDF.js (`pdfjs-dist`)** — selectable-text PDF parsing in the main process.
- **electron-builder** — packaging into a Windows installer.

All MIT/Apache/compatible licenses. No paid services.

---

## 2. Architecture

```
Renderer (React UI)  <-- IPC -->  Main process (Node)  -->  SQLite file
   dashboards, import wizard          file dialogs,            ~/AppData/.../expense-tracker/data.db
   tables, category editor            parsing, DB queries
```

- **All DB access lives in the main process.** The renderer never touches SQLite directly. Communicate via `ipcMain.handle` / `ipcRenderer.invoke` exposed through a `contextBridge` preload script. Keep `contextIsolation: true` and `nodeIntegration: false`.
- **SQLite file path:** `app.getPath('userData')/data.db`. Create on first launch.
- **No network code anywhere.** If a dependency tries to phone home, that's a bug.

---

## 3. Data Model (SQLite schema)

Create these tables on first run via a migration step.

```sql
-- Cards / sources (e.g. "Owner Amex", "Company Visa")
CREATE TABLE cards (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  -- type new imports from this card start as; per-transaction override below
  default_expense_type TEXT NOT NULL DEFAULT 'business', -- 'business' | 'personal'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Saved column mappings per card, so re-imports don't re-ask which column is which
CREATE TABLE import_profiles (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  date_col TEXT NOT NULL,
  amount_col TEXT NOT NULL,
  description_col TEXT NOT NULL,
  -- some issuers split debit/credit into two columns; support optional second amount col
  amount_col_secondary TEXT,
  date_format TEXT,              -- e.g. 'MM/DD/YYYY'
  amount_sign TEXT NOT NULL DEFAULT 'expense_positive', -- or 'expense_negative'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT,                    -- hex for charts
  is_archived INTEGER NOT NULL DEFAULT 0
);

-- Rules: if description matches pattern, assign a category, an expense type, or both.
-- Applied on import + on demand. e.g. "HOME DEPOT -> personal", "DELTA -> Travel + business".
CREATE TABLE category_rules (
  id INTEGER PRIMARY KEY,
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  expense_type TEXT,                            -- 'business' | 'personal' | NULL (don't set type)
  match_type TEXT NOT NULL DEFAULT 'contains', -- 'contains' | 'starts_with' | 'regex'
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,          -- higher wins on conflict
  CHECK (category_id IS NOT NULL OR expense_type IS NOT NULL)
);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  txn_date TEXT NOT NULL,        -- ISO 'YYYY-MM-DD'
  description TEXT NOT NULL,
  amount REAL NOT NULL,          -- store as positive = money spent (expense). normalize on import.
  -- business vs. personal lives on the TRANSACTION (one card can mix both).
  -- set on import from the card's default + matching type rules.
  expense_type TEXT,             -- 'business' | 'personal' | NULL (visible in All until reviewed)
  type_locked INTEGER NOT NULL DEFAULT 0,      -- 1 = manually set, rules won't overwrite
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_locked INTEGER NOT NULL DEFAULT 0,  -- 1 = manually set, rules won't overwrite
  import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  -- dedupe key: hash of card_id + date + amount + description
  dedupe_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(dedupe_hash)
);

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id),
  filename TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  inserted_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,  -- duplicates skipped
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Optional monthly budget per category, scoped per expense type so business
-- budgets aren't polluted by personal spend (and vice versa)
CREATE TABLE budgets (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  expense_type TEXT NOT NULL DEFAULT 'business', -- 'business' | 'personal'
  monthly_limit REAL NOT NULL,
  UNIQUE(category_id, expense_type)
);

CREATE INDEX idx_txn_date ON transactions(txn_date);
CREATE INDEX idx_txn_category ON transactions(category_id);
CREATE INDEX idx_txn_card ON transactions(card_id);
CREATE INDEX idx_txn_type ON transactions(expense_type);
```

**Amount normalization rule:** store `amount` as a positive number meaning "money spent." Convert from whatever sign convention the issuer uses during import, governed by the profile's `amount_sign`. This keeps every query simple.

**Dedupe:** `dedupe_hash = sha256(card_id + '|' + txn_date + '|' + amount + '|' + normalized_description)`. Skip rows whose hash already exists. This makes re-importing an overlapping statement safe. Do NOT include `expense_type` in the hash — re-imports must still dedupe correctly after the user reclassifies rows.

**Business vs. personal:** the owner pays for business expenses with his personal card, so a single statement mixes both. The split therefore lives on each transaction (`expense_type`). Matching type rules can set `business` or `personal`; rows with no matching type rule import with `expense_type = NULL` and stay out of both reports until reviewed. `type_locked` mirrors `category_locked`: a manual change is never overwritten by rule re-runs.

Seed a starter set of categories on first run: Travel, Meals & Entertainment, Office Supplies, Software & Subscriptions, Fuel, Utilities, Professional Services, Shipping, Uncategorized.

---

## 4. The Import Wizard (most important piece — get it right)

Card issuers format statements differently, so do NOT hardcode one format. Build a 4-step wizard:

1. **Pick file** — native open dialog (main process), accept `.csv`, `.xlsx`, `.xls`, `.pdf`.
2. **Pick / create card** — choose existing card or create one (creating asks for the card's default expense type: business or personal). If a saved `import_profile` exists for this card, pre-fill step 3.
3. **Map columns** — show the first ~10 parsed rows in a table. User maps: which column is Date, Amount, Description (and optional secondary amount column for debit/credit splits). User confirms date format and sign convention. Save this as an `import_profile` so next time it's automatic.
4. **Preview & confirm** — show normalized rows (parsed date, positive expense amount, description), with a count of new vs. duplicate rows. Apply category rules to preview the auto-categorization. Include an **Expense Type column** set by matching type rules or blank/All when no type rule matched, with per-row and bulk controls to mark selected rows as business or personal. On confirm, insert in a single transaction, write an `import_batches` row.

Parsing happens in the **main process** (PapaParse for CSV, SheetJS for Excel, PDF.js for selectable-text PDFs). Never trust the file; wrap parsing in try/catch and surface a friendly error. Password-protected PDFs, scanned/image-only PDFs, and PDFs without a detectable transaction table should surface clear unsupported-file messages.

---

## 5. Categorization Engine

- On import and on a "Re-run rules" button: rules apply category and expense type **independently** — for each transaction where `category_locked = 0`, the highest-priority matching rule with a `category_id` sets the category; where `type_locked = 0`, the highest-priority matching rule with an `expense_type` sets the type. No category match → leave as Uncategorized. No type match on import → leave the type unassigned and visible only in All.
- In the transactions table, the user can set a category or expense type manually; doing so sets `category_locked = 1` / `type_locked = 1` respectively, so rules never overwrite their choice.
- Provide a "Create rule from this transaction" action: pre-fills a rule with the merchant text — and optionally the transaction's expense type — so categorizing one Starbucks charge can categorize (and classify) all of them.

---

## 6. Dashboard / KPIs (the owners' main screen)

A global **Business | Personal | All** tab (segmented control in the app header, persisted across sessions) plus a date-range filter (This month, Last month, Last 3 months, This year, Custom) and an optional card filter sit at the top and drive every widget. Business and Personal are complete, independent reports; unassigned rows remain visible in All until reviewed.

Widgets:
- **Total spend** in range, plus % change vs. previous equivalent period.
- **Spend by category** — pie or horizontal bar (Recharts), sorted descending.
- **Monthly trend** — bar/line of total spend per month.
- **Top vendors** — table of top 10 merchants by total spend (group by normalized description).
- **Budget vs. actual** — for categories with a budget set for the selected expense type, show limit vs. actual with an over/under indicator. Hidden on the "All" tab (mixing the two types would make over/under ambiguous).
- **Uncategorized count** — a nudge showing how many transactions still need a category (links to filtered table).

All KPIs are plain SQL aggregations against the local DB. No external calls.

---

## 7. Other Screens

- **Transactions** — sortable, filterable, paginated table (date, description, amount, expense type, category, card). The global Business | Personal | All tab filters this screen too. Inline category editing and an inline type control. Bulk re-categorize and bulk "Mark as business/personal". Search by description.
- **Categories & Rules** — CRUD for categories (name, color), CRUD for rules (category, expense type, or both), set monthly budgets per expense type.
- **Cards** — CRUD for cards (including default expense type) and their import profiles.
- **Settings** — show DB file location, a "Backup database" button (copies the SQLite file to a user-chosen folder via save dialog), and a "Restore from backup" option. This is the whole backup story — no cloud needed.

---

## 8. Build Steps (execute in order)

1. Scaffold with electron-vite React+TS template. Initialize git.
2. Install deps: `electron`, `electron-vite`, `react`, `react-dom`, `typescript`, `better-sqlite3`, `tailwindcss`, `postcss`, `autoprefixer`, `recharts`, `papaparse`, `xlsx`, `pdfjs-dist`, `electron-builder`, and types. Note: `better-sqlite3` is a native module — ensure it rebuilds for Electron's Node version (use `electron-rebuild` or electron-builder's built-in rebuild). Document the exact command in the README.
3. Configure Tailwind. Set up `contextIsolation: true`, `nodeIntegration: false`, a preload script exposing a typed `window.api`.
4. DB layer in main process: connection singleton, migration runner (creates tables + seeds categories if DB is new).
5. IPC handlers: `cards.*`, `categories.*`, `rules.*`, `budgets.*`, `transactions.list/update/bulkUpdate`, `import.parseFile/preview/commit`, `dashboard.getKpis`, `db.backup/restore`. Each is an `ipcMain.handle`. Expense type rides through the existing handlers: `transactions.update/bulkUpdate` and `import.commit` accept it, and `transactions.list` / `dashboard.getKpis` take an `expenseType` filter param (`'business' | 'personal' | 'all'`).
6. Build the import wizard end-to-end first (it's the riskiest part). Test with at least two differently-formatted sample CSVs.
7. Build the transactions table + inline categorization.
8. Build categories/rules/budgets screens + the rules engine.
9. Build the dashboard widgets.
10. Build settings + backup/restore.
11. Package: configure electron-builder for Windows NSIS installer. Produce a portable `.exe` as well if straightforward. Test the installed app on a clean path.
12. Write a short README: how to dev (`npm run dev`), how to build the installer (`npm run build` / electron-builder command), where data lives, and how to back up.

---

## 9. Quality Bar

- TypeScript strict mode on.
- Wrap every IPC handler in try/catch; return `{ ok: false, error }` shapes the UI can display instead of crashing.
- Validate/parse all imported data defensively (bad dates, empty amounts, stray currency symbols like `$` and thousands separators — strip them before `parseFloat`).
- The app must function with zero internet connection. Verify by building and running offline.
- Keep the UI clean and obvious — the users are non-technical owners. Big clear dashboard, simple import button, minimal jargon.

---

## 10. First Milestone (stop and let me verify)

After step 6 (working import wizard that inserts deduplicated, normalized transactions into SQLite from a sample CSV), pause and report: schema created, sample file imported, row counts correct, duplicates skipped on re-import, unmatched rows import unassigned and visible in All, and toggling business/personal in the preview persists to the DB. We confirm that foundation before building the dashboard on top of it.
