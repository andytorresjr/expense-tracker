# Expenses Tracker

A Windows desktop application for personal and business expense tracking. Imports bank/credit card statements (Excel and PDF), categorizes transactions with rule-based automation, and exports PDF reports. Built with Electron and packaged as a standalone installer.

## Features

- **Statement import** — Excel and selectable-text PDF statements (via Mozilla PDF.js)
- **Card management** — multiple cards with per-card import profiles and history
- **Rule-based categorization** — auto-assign Business or Personal type and spending categories based on configurable rules
- **Quick Categorize** — keyboard-shortcut workflow for rapid manual review
- **Duplicate detection** — prevents importing the same transactions twice
- **PDF export** — formatted expense report
- **Backup & restore** — one-click database backup and restore
- **In-app updater** — Settings → Updates → Check for updates (checks GitHub, downloads with confirmation, restarts)
- **Transaction clearing** — clear by date range or all transactions

## Stack

- **Runtime:** Electron (desktop shell)
- **Build tool:** electron-vite
- **Language:** TypeScript
- **Database:** SQLite (local, persisted per install)

## Running from Source

```bash
npm install
npm run dev
```

## Building

```bash
npm run build
# Installer output: dist/
```

## Distribution

Packaged as a Windows installer (`.exe`) and portable build. The in-app updater checks the GitHub releases page for newer versions and accepts pre-release (`-beta`) builds on beta installs.

## Transaction Types

- **Business** — business expenses
- **Personal** — personal expenses
- **Unassigned** — imported transactions with no matching rule (visible in the All filter until reviewed)

## Spending Categories

Standard spending categories plus **Other** for miscellaneous items.

## Limitations

- Scanned/OCR PDFs and password-protected PDFs are not supported for import.
- PDF import requires selectable text (not image-only).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history.
