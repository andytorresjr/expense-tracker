# Expense Tracker

A standalone, **100% local** Windows desktop app for company-card expense analysis.
Import a card statement (CSV, Excel, or selectable-text PDF), let merchant rules
split every transaction into **business vs. personal**, and read the dashboard — switchable between a
business report and a personal report off the same mixed statement.

No cloud, no accounts, no API keys, no telemetry. Your data never leaves the machine —
it lives in a single SQLite file in your Windows user profile.

---

## Download & install (Windows)

Grab the latest installer from the **[Releases page »](https://github.com/andytorresjr/expense-tracker/releases/latest)**:

- **`Expense Tracker Setup x.y.z.exe`** — the installer (recommended). Download, run it, and follow the prompts.
- **`Expense Tracker x.y.z.exe`** — a portable build that runs without installing.

> Windows SmartScreen may warn that the app is from an unidentified publisher because the
> build is not code-signed. Click **More info → Run anyway** to proceed.

### Staying up to date

From v1.2.2 on, the app can update itself. Open **Settings → Updates → Check for updates**: it
checks GitHub for a newer release and, only if you confirm, downloads and installs it, then restarts.
The app stays fully offline otherwise — the check is the one time it touches the network, and no data
is ever sent.

---

## Features

- Import `.csv`, `.xlsx`, `.xls`, and selectable-text `.pdf` statements with reusable per-card column mappings.
- Detect statement headers after issuer preambles and normalize dates, amounts, refunds, and descriptions.
- Extract normal text PDF statement tables; scanned/image-only and password-protected PDFs are not supported.
- Skip duplicate transactions when overlapping statements are imported.
- Split transactions into Business and Personal reporting, with manual locks that rules cannot overwrite.
- Create merchant rules that set category, expense type, or both.
- Use **Quick Categorize** with keyboard shortcuts to review transactions rapidly.
- View dashboard totals, category spend, monthly trends, vendors, budgets, and uncategorized counts.
- Search, edit, and bulk-update transactions.
- Clear transactions by inclusive date range or clear all transactions while preserving import history.
- Review **Import Statement → History** and delete one incorrect statement plus only its linked transactions.
- Back up and restore the complete local SQLite database.

---

## How it works

A single statement mixes business and personal charges (the owner pays for business
expenses with a personal card). So the business/personal split is decided **per
transaction**, by **merchant rules** — not by the card.

- **Import** a statement. Each row is auto-classified by your rules
  (e.g. `UBER → personal`, `DELTA → business + Travel`).
- Rows no type rule matched are flagged **Needs review** and stay visible in *All* until you mark them Business or Personal.
- Fix any row with the per-row toggle, or click **+ rule** to teach the app — every
  future import then classifies that merchant automatically.
- The **Business | Personal | All** switch in the header re-runs every screen over
  that slice, so unreviewed transactions stay out of business and personal reports.

---

## Develop

```bash
npm install        # also rebuilds better-sqlite3 for Electron (postinstall)
npm run dev        # launch the app with hot reload
```

Useful checks:

```bash
npm run typecheck  # strict TypeScript across main + renderer
npm run selftest   # headless test of the import pipeline against samples/
```

If `better-sqlite3` fails to load after an Electron upgrade, rebuild the native module:

```bash
npm run rebuild
```

---

## Build the Windows installer

```bash
npm run typecheck
npm run selftest
npm run dist
```

This runs `electron-vite build` then `electron-builder --win`, producing in `dist/`:

- an **NSIS installer** (`Expense Tracker Setup x.y.z.exe`), recommended for normal use, and
- a **portable** `.exe` (`Expense Tracker x.y.z.exe`) for testing or no-install use.

The app is fully offline — verify by disconnecting from the network and running it.

See [RELEASE.md](RELEASE.md) for the boss handoff, release checklist, Windows signing,
upgrade behavior, and support procedure.

---

## Where your data lives

A single SQLite database at:

```
%APPDATA%\expense-tracker\data.db
```

(Open **Settings** in the app to see the exact path.)

### Backup & restore

This is the whole backup story — no cloud needed:

- **Settings → Back up database…** copies `data.db` to a folder you choose
  (a USB drive, another disk, etc.). Do this regularly.
- **Settings → Restore from backup…** replaces all current data with a backup file.

### Correcting an import

- Go to **Import Statement → History**.
- Find the incorrect filename and card.
- Click **Delete statement**. This removes that history entry and only transactions
  still linked to that import.
- Import the corrected statement.

Clearing transactions by date or clearing all transactions intentionally keeps History,
where each import shows how many of its originally inserted transactions remain.

---

## Tech

Electron + React + TypeScript, SQLite via `better-sqlite3` (all DB access in the main
process, behind a `contextIsolation` preload bridge), Tailwind CSS, Recharts,
PapaParse (CSV), SheetJS (Excel), and Mozilla PDF.js (text PDF parsing). All free and open-source.
