import type {
  Budget,
  Card,
  CardholderSpend,
  Category,
  CategoryRule,
  ColumnMapping,
  CommitRow,
  DashboardExportResult,
  ExpenseType,
  ExportFormat,
  ExportResult,
  ImportBatch,
  ImportPreview,
  ImportProfile,
  ImportResult,
  IpcResult,
  Kpis,
  KpiFilters,
  ParsedFile,
  ReconConfig,
  ReconConfigInput,
  ReconLedger,
  ReconMatchResult,
  ReconReviewItem,
  ReconSyncResult,
  ReconTestResult,
  ReconUnmatchedCharge,
  AssignmentCardholder,
  AssignmentImportResult,
  AssignmentMergeResult,
  AssignmentPickResult,
  AssignmentReturnableCard,
  TransactionClearRequest,
  TransactionDeleteResult,
  Txn,
  UpdateStatus,
  TxnFilters,
  TxnPage
} from '@shared/types'

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const result = (await window.api.invoke(channel, payload)) as IpcResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.data
}

export const api = {
  cards: {
    list: () => call<Card[]>('cards.list'),
    create: (name: string) => call<Card>('cards.create', { name }),
    update: (id: number, name: string) => call<Card>('cards.update', { id, name }),
    remove: (id: number) => call<boolean>('cards.delete', { id })
  },
  profiles: {
    get: (cardId: number) => call<ImportProfile | null>('profiles.get', { cardId }),
    save: (cardId: number, mapping: ColumnMapping) => call<boolean>('profiles.save', { cardId, mapping })
  },
  categories: {
    list: () => call<Category[]>('categories.list'),
    create: (name: string, color: string | null) => call<Category>('categories.create', { name, color }),
    update: (id: number, name: string, color: string | null) => call<Category>('categories.update', { id, name, color }),
    setHotkey: (id: number, hotkey: string | null) => call<Category>('categories.setHotkey', { id, hotkey }),
    setRequiresClient: (id: number, requires_client: boolean) =>
      call<Category>('categories.setRequiresClient', { id, requires_client }),
    remove: (id: number) => call<boolean>('categories.delete', { id })
  },
  rules: {
    list: () => call<CategoryRule[]>('rules.list'),
    create: (rule: Omit<CategoryRule, 'id'>) => call<CategoryRule>('rules.create', rule),
    update: (rule: CategoryRule) => call<CategoryRule>('rules.update', rule),
    remove: (id: number) => call<boolean>('rules.delete', { id }),
    rerun: () => call<{ categorized: number; retyped: number }>('rules.rerun')
  },
  budgets: {
    list: () => call<Budget[]>('budgets.list'),
    upsert: (category_id: number, expense_type: ExpenseType, monthly_limit: number) =>
      call<boolean>('budgets.upsert', { category_id, expense_type, monthly_limit }),
    remove: (id: number) => call<boolean>('budgets.delete', { id })
  },
  transactions: {
    list: (filters: TxnFilters) => call<TxnPage>('transactions.list', filters),
    cardholderSpend: (filters: TxnFilters) => call<CardholderSpend[]>('transactions.cardholderSpend', filters),
    categorizeQueue: () => call<Txn[]>('transactions.categorizeQueue'),
    missingClientCount: () => call<number>('transactions.missingClientCount'),
    update: (
      id: number,
      fields: {
        category_id?: number | null
        expense_type?: ExpenseType | null
        client?: string | null
        business_purpose?: string | null
        comment?: string | null
      }
    ) => call<Txn>('transactions.update', { id, ...fields }),
    bulkUpdate: (
      ids: number[],
      fields: {
        category_id?: number | null
        expense_type?: ExpenseType | null
        client?: string | null
        business_purpose?: string | null
        comment?: string | null
      }
    ) => call<number>('transactions.bulkUpdate', { ids, ...fields }),
    clear: (request: TransactionClearRequest) => call<TransactionDeleteResult>('transactions.clear', request),
    exportRows: (filters: TxnFilters) => call<Txn[]>('transactions.exportRows', filters),
    export: (filters: TxnFilters, format: ExportFormat, fileNameBase?: string) =>
      call<ExportResult | null>('transactions.export', { filters, format, fileNameBase }),
    exportPdf: (filters: TxnFilters, fileNameBase?: string) =>
      call<ExportResult | null>('transactions.export', { filters, format: 'pdf', fileNameBase })
  },
  import: {
    pickFile: () => call<ParsedFile | null>('import.pickFile'),
    preview: (cardId: number, rows: Record<string, string>[], mapping: ColumnMapping) =>
      call<ImportPreview>('import.preview', { cardId, rows, mapping }),
    commit: (cardId: number, filename: string, rows: CommitRow[]) =>
      call<ImportResult>('import.commit', { cardId, filename, rows }),
    batches: () => call<ImportBatch[]>('import.batches'),
    deleteBatch: (id: number) => call<TransactionDeleteResult>('import.deleteBatch', { id })
  },
  assignment: {
    cardholders: () => call<AssignmentCardholder[]>('assignment.cardholders'),
    export: (cardholder: string, dateFrom?: string, dateTo?: string) =>
      call<ExportResult | null>('assignment.export', { cardholder, dateFrom, dateTo }),
    returnableCards: () => call<AssignmentReturnableCard[]>('assignment.returnableCards'),
    exportReturn: (cardId: number) => call<ExportResult | null>('assignment.exportReturn', { cardId }),
    pick: () => call<AssignmentPickResult | null>('assignment.pick'),
    import: (path: string) => call<AssignmentImportResult>('assignment.import', { path }),
    merge: (path: string) => call<AssignmentMergeResult>('assignment.merge', { path })
  },
  dashboard: {
    getKpis: (filters: KpiFilters) => call<Kpis>('dashboard.getKpis', filters),
    exportPdf: (filters: KpiFilters) => call<DashboardExportResult | null>('dashboard.exportPdf', { filters })
  },
  db: {
    getPath: () => call<string>('db.getPath'),
    backup: () => call<string | null>('db.backup'),
    restore: () => call<string | null>('db.restore')
  },
  recon: {
    getConfig: () => call<ReconConfig>('recon.getConfig'),
    setConfig: (input: ReconConfigInput) => call<ReconConfig>('recon.setConfig', input),
    testConnection: () => call<ReconTestResult>('recon.testConnection'),
    sync: () => call<ReconSyncResult>('recon.sync'),
    match: () => call<ReconMatchResult>('recon.match'),
    queue: () => call<ReconReviewItem[]>('recon.queue'),
    confirm: (linkId: number) => call<boolean>('recon.confirm', { linkId }),
    reject: (linkId: number) => call<boolean>('recon.reject', { linkId }),
    ledger: () => call<ReconLedger>('recon.ledger'),
    unmatchedCharges: () => call<ReconUnmatchedCharge[]>('recon.unmatchedCharges')
  },
  app: {
    version: () => call<string>('app.version')
  },
  updates: {
    check: () => call<UpdateStatus>('updates.check')
  }
}

export const fmtMoney = (n: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
