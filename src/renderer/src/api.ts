import type {
  Budget,
  Card,
  Category,
  CategoryRule,
  ColumnMapping,
  CommitRow,
  ExpenseType,
  ImportPreview,
  ImportProfile,
  ImportResult,
  IpcResult,
  Kpis,
  KpiFilters,
  ParsedFile,
  Txn,
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
    update: (id: number, fields: { category_id?: number | null; expense_type?: ExpenseType }) =>
      call<Txn>('transactions.update', { id, ...fields }),
    bulkUpdate: (ids: number[], fields: { category_id?: number | null; expense_type?: ExpenseType }) =>
      call<number>('transactions.bulkUpdate', { ids, ...fields })
  },
  import: {
    pickFile: () => call<ParsedFile | null>('import.pickFile'),
    preview: (cardId: number, rows: Record<string, string>[], mapping: ColumnMapping) =>
      call<ImportPreview>('import.preview', { cardId, rows, mapping }),
    commit: (cardId: number, filename: string, rows: CommitRow[]) =>
      call<ImportResult>('import.commit', { cardId, filename, rows })
  },
  dashboard: {
    getKpis: (filters: KpiFilters) => call<Kpis>('dashboard.getKpis', filters)
  },
  db: {
    getPath: () => call<string>('db.getPath'),
    backup: () => call<string | null>('db.backup'),
    restore: () => call<string | null>('db.restore')
  },
  app: {
    version: () => call<string>('app.version')
  }
}

export const fmtMoney = (n: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
