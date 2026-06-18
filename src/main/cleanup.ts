import type Database from 'better-sqlite3'
import type { TransactionClearRequest } from '@shared/types'

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function clearTransactions(db: Database.Database, request: TransactionClearRequest): number {
  if (request.mode === 'all') {
    return db.prepare('DELETE FROM transactions').run().changes
  }

  if (!isIsoDate(request.dateFrom) || !isIsoDate(request.dateTo)) {
    throw new Error('Choose a valid start and end date.')
  }
  if (request.dateFrom > request.dateTo) {
    throw new Error('The start date must be on or before the end date.')
  }

  return db
    .prepare('DELETE FROM transactions WHERE txn_date >= ? AND txn_date <= ?')
    .run(request.dateFrom, request.dateTo).changes
}

export function deleteImportBatch(db: Database.Database, batchId: number): number {
  if (!Number.isInteger(batchId) || batchId <= 0) throw new Error('Invalid import history entry.')

  const removeTransactions = db.prepare('DELETE FROM transactions WHERE import_batch_id = ?')
  const removeBatch = db.prepare('DELETE FROM import_batches WHERE id = ?')
  const run = db.transaction(() => {
    const deletedTransactions = removeTransactions.run(batchId).changes
    const deletedBatch = removeBatch.run(batchId).changes
    if (deletedBatch === 0) throw new Error('Import history entry not found.')
    return deletedTransactions
  })
  return run()
}

export function deleteCard(db: Database.Database, cardId: number): void {
  if (!Number.isInteger(cardId) || cardId <= 0) throw new Error('Invalid card.')

  const cardExists = db.prepare('SELECT 1 FROM cards WHERE id = ?')
  const removeTransactions = db.prepare('DELETE FROM transactions WHERE card_id = ?')
  const removeProfiles = db.prepare('DELETE FROM import_profiles WHERE card_id = ?')
  const removeBatches = db.prepare('DELETE FROM import_batches WHERE card_id = ?')
  const removeCard = db.prepare('DELETE FROM cards WHERE id = ?')

  const run = db.transaction(() => {
    if (cardExists.get(cardId) === undefined) throw new Error('Card not found.')
    removeTransactions.run(cardId)
    removeProfiles.run(cardId)
    removeBatches.run(cardId)
    removeCard.run(cardId)
  })
  run()
}
