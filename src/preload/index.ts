import { contextBridge, ipcRenderer } from 'electron'

const CHANNELS = new Set([
  'cards.list',
  'cards.create',
  'cards.update',
  'cards.delete',
  'profiles.get',
  'profiles.save',
  'categories.list',
  'categories.create',
  'categories.update',
  'categories.setHotkey',
  'categories.setRequiresClient',
  'categories.delete',
  'rules.list',
  'rules.create',
  'rules.update',
  'rules.delete',
  'rules.rerun',
  'budgets.list',
  'budgets.upsert',
  'budgets.delete',
  'transactions.list',
  'transactions.update',
  'transactions.bulkUpdate',
  'transactions.clear',
  'transactions.categorizeQueue',
  'transactions.missingClientCount',
  'transactions.cardholderSpend',
  'transactions.export',
  'transactions.exportRows',
  'assignment.cardholders',
  'assignment.export',
  'assignment.returnableCards',
  'assignment.exportReturn',
  'assignment.pick',
  'assignment.import',
  'assignment.merge',
  'import.pickFile',
  'import.preview',
  'import.commit',
  'import.batches',
  'import.deleteBatch',
  'dashboard.getKpis',
  'dashboard.exportPdf',
  'db.getPath',
  'db.backup',
  'db.restore',
  'recon.getConfig',
  'recon.setConfig',
  'recon.testConnection',
  'recon.sync',
  'recon.match',
  'recon.queue',
  'recon.confirm',
  'recon.reject',
  'recon.ledger',
  'recon.unmatchedCharges',
  'app.version',
  'updates.check'
])

contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, payload?: unknown): Promise<unknown> => {
    if (!CHANNELS.has(channel)) {
      return Promise.resolve({ ok: false, error: `Unknown channel: ${channel}` })
    }
    return ipcRenderer.invoke(channel, payload)
  }
})
