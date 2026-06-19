# Changelog

All notable changes to Expense Tracker. The same notes appear on each
[GitHub release](https://github.com/andytorresjr/expense-tracker/releases), and the
in-app updater shows them when a new version is found.

## 1.3.0-beta.1 — 2026-06-19
- Added **Quick Reports** (new sidebar page): save reusable shortcuts that capture a set of filters — reporting view, any number of cards and categories, a description search, and a date range — then export the matching statement as CSV, Excel, or PDF in one click.
- Added **Export PDF** to the Dashboard: save the current dashboard view (KPIs, category breakdown, monthly trend, top vendors, and budgets) as a PDF, respecting the active date range and reporting view.
- Moved **Cards** management into **Settings**; the standalone Cards sidebar item has been removed.

## 1.2.4-beta.1 — 2026-06-18
- Moved to **beta** version labeling (`-beta` suffix) while the app is in pre-production. The version shown in the app, installers, and releases now reads e.g. `v1.2.4-beta.1`.
- The in-app updater now accepts pre-release builds, so beta installs update to newer betas (and to the eventual production release).

## 1.2.3 — 2026-06-18
- The in-app updater now shows the release notes for a new version in the update prompt, with a **View full notes online** button that opens the GitHub release.
- Published `CHANGELOG.md` so version history renders directly in the repo.

## 1.2.2 — 2026-06-18
- Added an in-app updater. **Settings → Updates → Check for updates** checks GitHub for a newer release and, only with your confirmation, downloads and installs it (then restarts). The app stays fully offline unless you click the button; no data is ever sent.
- Note: auto-update works from this version forward. Installing 1.2.2 enables detection of 1.2.3 and later.

## 1.2.1 — 2026-06-18
- Repackaged so the installed app matches the finished export feature: exporting a PDF report now correctly offers the "PDF document" file type in the save dialog (the prior 1.2.0 installer predated this and showed "Excel workbook").

## 1.1.0 — 2026-06-16
- Added selectable-text PDF statement import using Mozilla PDF.js.
- PDF imports now feed the existing card selection, column mapping, preview, rules, dedupe, commit, and import history flow.
- Added clear errors for password-protected PDFs, scanned/image-only PDFs with no selectable text, and PDFs where no transaction table header can be found.
- Added sanitized PDF fixtures and self-test coverage for PDF parsing, preview, rules, duplicate detection, and unsupported PDF cases.
- Scanned/OCR and password-protected PDFs remain out of scope.

## 1.0.3 — 2026-06-16
- Corrected transaction type behavior: Business and Personal are the only transaction types.
- Restored the header filter to Business | Personal | All.
- Imported transactions with no matching type rule now remain unassigned and visible in All until reviewed.
- Added Other as a normal spending category.
- Added migration to convert accidental prior `expense_type = 'other'` rows back to unassigned.
- Verified packaged migration behavior against a simulated prior database.

## 1.0.2 — 2026-06-16
- Fixed card deletion foreign-key errors.
- Deleting a card now removes its transactions, import profiles, and import history in one database transaction.
- Added self-test coverage for deleting a card after import history exists.

## 1.0.1 — 2026-06-15
- Added an attempted neutral Other transaction type for unmatched imports.
- This behavior was later corrected in 1.0.3 because Other belongs in categories, not transaction type.

## 1.0.0 — 2026-06-15
- Added Quick Categorize workflow with keyboard shortcuts.
- Added transaction clearing by date range or all transactions.
- Added Import Statement History and per-import deletion.
- Added Excel header detection improvements for statements with issuer preambles.
- Added backup and restore workflow.
- Added Windows installer and portable build.
- Updated distribution and handoff documentation.
- Upgraded dependencies and verified zero npm audit vulnerabilities.
