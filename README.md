# Expense Tracker

A standalone, **100% local** Windows desktop app for company-card expense analysis.
Import a card statement (CSV or Excel), let merchant rules split every transaction
into **business vs. personal**, and read the dashboard — switchable between a
business report and a personal report off the same mixed statement.

No cloud, no accounts, no API keys, no telemetry. Your data never leaves the machine —
it lives in a single SQLite file in your Windows user profile.

---

## How it works

A single statement mixes business and personal charges (the owner pays for business
expenses with a personal card). So the business/personal split is decided **per
transaction**, by **merchant rules** — not by the card.

- **Import** a statement. Each row is auto-classified by your rules
  (e.g. `UBER → personal`, `DELTA → business + Travel`).
- Rows no rule matched are flagged **Needs review** and default to *business*.
- Fix any row with the per-row toggle, or click **+ rule** to teach the app — every
  future import then classifies that merchant automatically.
- The **Business | Personal | All** switch in the header re-runs every screen over
  that slice, so you get independent business and personal reports.

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
npm run dist
```

This runs `electron-vite build` then `electron-builder --win`, producing in `dist/`:

- an **NSIS installer** (`Expense Tracker Setup x.y.z.exe`), and
- a **portable** `.exe` (run without installing).

The app is fully offline — verify by disconnecting from the network and running it.

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

---

## Tech

Electron + React + TypeScript, SQLite via `better-sqlite3` (all DB access in the main
process, behind a `contextIsolation` preload bridge), Tailwind CSS, Recharts,
PapaParse (CSV) and SheetJS (Excel). All free and open-source.
