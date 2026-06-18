# Expense Tracker Release and Handoff

This document covers internal Windows distribution of Expense Tracker to a company owner.

## Release Candidate 1.1.0

Built and verified on June 16, 2026:

- TypeScript typecheck passed.
- The ten-part import/database self-test passed, including selectable-text PDF import coverage.
- `npm audit` reported zero known vulnerabilities.
- The app version is `1.1.0`.
- `transactions.clear`, `import.deleteBatch`, and unassigned import behavior were verified through the app preload bridge.
- Card deletion removes the card's transactions, import profiles, and import history without foreign-key errors.
- Imported transactions without a matching type rule stay visible in All until reviewed.
- Selectable-text PDF statements import through the same mapping, preview, rules, dedupe, commit, and import history flow as CSV and Excel files.
- Password-protected PDFs, scanned/image-only PDFs, and PDFs without a detectable transaction table produce clear unsupported-file errors.
- The accidental `other` transaction type from earlier test builds is migrated back to an unassigned type.
- `Other` is a normal spending category, not a Business/Personal type.

The release is functionally ready for internal testing. Before a polished company rollout,
replace the default Electron icon with a company-approved Windows icon and sign the
executables as described under **Windows Signing**. Build and smoke-test fresh `1.1.0`
installer artifacts before delivery.

## Recommended Delivery

Use the NSIS installer:

```text
dist\Expense Tracker Setup 1.1.0.exe
```

The portable executable is useful for testing, but the installer is the normal delivery
format because it creates a standard installed application and Start menu entry.

## Before Delivery

1. Run the release checks:

   ```powershell
   npm ci
   npm run typecheck
   npm run selftest
   npm audit
   npm run dist
   ```

2. Install the generated setup file on a Windows test account or clean Windows PC.
3. Launch it offline and import one non-sensitive sample statement.
4. Verify Transactions, Quick Categorize, Dashboard, Import History, statement deletion,
   transaction clearing, backup, and restore.
5. Confirm the installed app reports version `1.1.0`, then record a SHA-256 checksum:

   ```powershell
   Get-FileHash "dist\Expense Tracker Setup 1.1.0.exe" -Algorithm SHA256
   ```

6. Deliver the installer and its checksum through a company-controlled location.
7. Commit the exact release source and tag it `v1.1.0` after owner acceptance.

## First-Time Setup for the Owner

Expense Tracker does not connect to a bank or card issuer and never needs account
credentials. Each company account or card is created as a local card record, then populated
by importing CSV, Excel, or selectable-text PDF statement files downloaded through the issuer's normal secure website.

1. Install Expense Tracker.
2. Open **Settings** and note the database path.
3. Create a card and import the first statement.
4. Review uncategorized and unassigned transactions, then mark them Business or Personal as needed.
5. Add merchant rules for recurring vendors.
6. Create the first database backup in a company-approved backup location.

## Data and Backups

The app is local-only. Its database is:

```text
%APPDATA%\expense-tracker\data.db
```

That file contains imported transactions, cards, categories, rules, budgets, saved
column mappings, and import history.

- Back up from **Settings → Back up database…** after imports or major classification work.
- Store backups in a company-controlled encrypted location.
- Restoring replaces the current database, so make a backup before restoring.
- Do not email real statements or database backups unless company policy explicitly permits it.
- Use the owner's individual Windows account. The database is local to that Windows profile.
- The database is not encrypted by the app; rely on company device encryption such as
  BitLocker and normal Windows access controls.
- Do not place the live database on a network share or try to use one database concurrently
  from multiple computers.

## Correcting Bad Imports

For an incorrect statement:

1. Open **Import Statement → History**.
2. Confirm the filename, card, timestamp, and remaining transaction count.
3. Click **Delete statement**.
4. Import the corrected file.

Deleting an import removes only transactions linked to that import. A duplicate-only
history entry does not own the transactions from the earlier successful import.

For broader cleanup, **Transactions → Clear transactions** supports an inclusive date
range or all transactions. This preserves import history and shows reduced remaining counts.

## Upgrades

Installing a newer version over the existing installation should retain the database in
the Windows user profile. Before every upgrade:

1. Back up the database in Settings.
2. Close Expense Tracker.
3. Run the new installer.
4. Open the app and verify the version shown in Settings.

Do not distribute two different builds with the same version number.

## Windows Signing

The current release artifacts are unsigned. Windows may show **Unknown publisher** or a
Microsoft Defender SmartScreen warning.

For a professional company rollout, obtain an Authenticode code-signing identity for the
legal company name and configure electron-builder signing. Sign every released installer
and portable executable with the same identity. Until signing is configured, distribute
only through a trusted internal location and provide the SHA-256 checksum.

Signing credentials must not be committed to this repository. Keep certificates, tokens,
client secrets, and passwords in the company credential-management system.

## Release Ownership

Assign one person to own:

- release versioning and release notes;
- code-signing credentials;
- final installer storage;
- backup and restore guidance;
- dependency/security updates;
- confirmation that company financial-data retention policies are followed.

## Support Checklist

When troubleshooting:

1. Record the app version from Settings.
2. Back up the database before making changes.
3. Record the exact error and action that caused it.
4. Confirm the statement filename and card without sharing sensitive account data unnecessarily.
5. Reproduce with a sanitized sample when possible.

Never ask the owner to delete `%APPDATA%\expense-tracker\data.db` as a troubleshooting
step unless a verified backup exists.
