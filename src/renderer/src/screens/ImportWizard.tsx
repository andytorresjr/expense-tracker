import { useEffect, useMemo, useState } from 'react'
import type {
  Card,
  Category,
  ColumnMapping,
  ExpenseType,
  ImportPreview,
  ImportResult,
  ParsedFile,
  PreviewRow
} from '@shared/types'
import { api, fmtMoney } from '../api'
import RuleModal, { type RuleDraft } from '../components/RuleModal'

const EMPTY_MAPPING: ColumnMapping = {
  date_col: '',
  amount_col: '',
  amount_col_secondary: null,
  description_col: '',
  date_format: 'auto',
  amount_sign: 'expense_positive'
}

function guessMapping(headers: string[]): ColumnMapping {
  const find = (...needles: string[]): string =>
    headers.find((h) => needles.some((n) => h.toLowerCase().includes(n))) ?? ''
  return {
    date_col: find('transaction date', 'date'),
    amount_col: find('amount', 'debit'),
    amount_col_secondary: find('credit') || null,
    description_col: find('description', 'merchant', 'payee', 'name'),
    date_format: 'auto',
    amount_sign: 'expense_positive'
  }
}

function TypePill({ value, onToggle }: { value: ExpenseType; onToggle?: () => void }): React.JSX.Element {
  const styles =
    value === 'business' ? 'bg-blue-100 text-blue-700 border-blue-200' : 'bg-violet-100 text-violet-700 border-violet-200'
  return (
    <button
      onClick={onToggle}
      disabled={!onToggle}
      title={onToggle ? 'Click to switch business/personal' : undefined}
      className={`px-2 py-0.5 rounded-full border text-xs font-medium capitalize ${styles} ${onToggle ? 'hover:opacity-75' : ''}`}
    >
      {value}
    </button>
  )
}

const STEPS = ['Choose file', 'Choose card', 'Map columns', 'Preview & confirm']

export default function ImportWizard({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [cards, setCards] = useState<Card[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [cardId, setCardId] = useState<number | null>(null)
  const [newCardName, setNewCardName] = useState('')
  const [mapping, setMapping] = useState<ColumnMapping>(EMPTY_MAPPING)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [typeOverrides, setTypeOverrides] = useState<Record<number, ExpenseType>>({})
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)

  useEffect(() => {
    api.cards.list().then(setCards).catch((e) => setError(e.message))
    api.categories.list().then(setCategories).catch((e) => setError(e.message))
  }, [])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const pickFile = (): Promise<void> =>
    run(async () => {
      const file = await api.import.pickFile()
      if (!file) return
      setParsed(file)
      setMapping(guessMapping(file.headers))
      setStep(1)
    })

  const chooseCard = (id: number): Promise<void> =>
    run(async () => {
      setCardId(id)
      const profile = await api.profiles.get(id)
      if (profile && parsed && parsed.headers.includes(profile.date_col)) {
        setMapping({
          date_col: profile.date_col,
          amount_col: profile.amount_col,
          amount_col_secondary: profile.amount_col_secondary,
          description_col: profile.description_col,
          date_format: profile.date_format ?? 'auto',
          amount_sign: profile.amount_sign
        })
      }
      setStep(2)
    })

  const createCard = (): Promise<void> =>
    run(async () => {
      if (!newCardName.trim()) throw new Error('Give the card a name first.')
      const card = await api.cards.create(newCardName.trim())
      setCards([...cards, card])
      setNewCardName('')
      await chooseCard(card.id)
    })

  const refreshPreview = async (): Promise<ImportPreview | null> => {
    if (!parsed || !cardId) return null
    const p = await api.import.preview(cardId, parsed.rows, mapping)
    setPreview(p)
    return p
  }

  const buildPreview = (): Promise<void> =>
    run(async () => {
      if (!mapping.date_col || !mapping.amount_col || !mapping.description_col) {
        throw new Error('Map the Date, Amount and Description columns first.')
      }
      await refreshPreview()
      setTypeOverrides({})
      setSelected(new Set())
      setStep(3)
    })

  const effectiveType = (index: number, fallback: ExpenseType): ExpenseType => typeOverrides[index] ?? fallback

  const saveRule = (draft: RuleDraft): Promise<void> =>
    run(async () => {
      await api.rules.create({
        category_id: draft.category_id,
        expense_type: draft.expense_type,
        match_type: draft.match_type,
        pattern: draft.pattern,
        priority: draft.priority
      })
      setRuleDraft(null)
      // re-run the engine so the new rule re-classifies the rest of this statement,
      // then drop manual overrides for rows the rule now covers so its result shows through
      await refreshPreview()
      setTypeOverrides({})
      setSelected(new Set())
    })

  const commit = (): Promise<void> =>
    run(async () => {
      if (!parsed || !cardId || !preview) return
      const rows = preview.rows
        .filter((r) => !r.error && !r.duplicate)
        .map((r) => ({
          txn_date: r.txn_date!,
          description: r.description,
          amount: r.amount!,
          expense_type: effectiveType(r.index, r.expense_type),
          category_id: r.category_id
        }))
      const res = await api.import.commit(cardId, parsed.filename, rows)
      await api.profiles.save(cardId, mapping)
      setResult(res)
    })

  const reset = (): void => {
    setStep(0)
    setParsed(null)
    setCardId(null)
    setPreview(null)
    setResult(null)
    setTypeOverrides({})
    setSelected(new Set())
  }

  const bulkSet = (type: ExpenseType): void => {
    const next = { ...typeOverrides }
    for (const i of selected) next[i] = type
    setTypeOverrides(next)
    setSelected(new Set())
  }

  const openRuleFor = (row: PreviewRow): void => {
    setRuleDraft({
      pattern: row.description,
      match_type: 'contains',
      expense_type: effectiveType(row.index, row.expense_type),
      category_id: row.category_id,
      priority: 0
    })
  }

  const previewRows = useMemo(() => preview?.rows.slice(0, 300) ?? [], [preview])
  const reviewCount = useMemo(
    () => preview?.rows.filter((r) => !r.error && !r.duplicate && r.needsReview).length ?? 0,
    [preview]
  )

  if (result) {
    return (
      <div className="card-panel max-w-xl mx-auto p-8 text-center space-y-4">
        <div className="text-4xl">✅</div>
        <h2 className="text-xl font-semibold text-slate-800">Import complete</h2>
        <p className="text-slate-600">
          <strong>{result.inserted}</strong> transaction{result.inserted === 1 ? '' : 's'} imported,{' '}
          <strong>{result.skipped}</strong> duplicate{result.skipped === 1 ? '' : 's'} skipped.
        </p>
        <p className="text-sm text-slate-500">Your column mapping was saved — next time this card&apos;s statement imports in two clicks.</p>
        <div className="flex justify-center gap-3 pt-2">
          <button className="btn-secondary" onClick={reset}>Import another file</button>
          <button className="btn-primary" onClick={onDone}>View transactions</button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <ol className="flex gap-2">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={`flex-1 text-center text-sm rounded-lg py-2 border ${
              i === step
                ? 'bg-blue-600 text-white border-blue-600'
                : i < step
                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : 'bg-white text-slate-400 border-slate-200'
            }`}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">{error}</div>}

      {step === 0 && (
        <div className="card-panel p-10 text-center space-y-4">
          <div className="text-4xl">📥</div>
          <h2 className="text-xl font-semibold text-slate-800">Import a card statement</h2>
          <p className="text-slate-600">Choose the CSV or Excel file you downloaded from your card&apos;s website.</p>
          <button className="btn-primary mx-auto" onClick={pickFile} disabled={busy}>
            {busy ? 'Reading file…' : 'Choose file…'}
          </button>
        </div>
      )}

      {step === 1 && parsed && (
        <div className="card-panel p-6 space-y-4">
          <h2 className="font-semibold text-slate-800">
            Which card is <span className="text-blue-700">{parsed.filename}</span> from?
          </h2>
          <div className="space-y-2">
            {cards.map((card) => (
              <button
                key={card.id}
                onClick={() => chooseCard(card.id)}
                disabled={busy}
                className="w-full flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3 hover:border-blue-400 hover:bg-blue-50 text-left"
              >
                <span className="font-medium text-slate-700">💳 {card.name}</span>
              </button>
            ))}
            {cards.length === 0 && <p className="text-sm text-slate-500">No cards yet — add the first one below.</p>}
          </div>
          <div className="border-t border-slate-200 pt-4 flex flex-wrap items-end gap-3">
            <label className="text-sm text-slate-600 flex-1 min-w-48">
              New card name
              <input
                className="input w-full mt-1"
                placeholder="e.g. Owner Personal Visa"
                value={newCardName}
                onChange={(e) => setNewCardName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createCard()}
              />
            </label>
            <button className="btn-secondary" onClick={createCard} disabled={busy}>
              Add card
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Statements mix business and personal charges — the split is decided per transaction by your merchant rules,
            not by the card.
          </p>
        </div>
      )}

      {step === 2 && parsed && (
        <div className="card-panel p-6 space-y-5">
          <h2 className="font-semibold text-slate-800">Tell us which column is which</h2>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {(
              [
                ['date_col', 'Date column', false],
                ['amount_col', 'Amount column', false],
                ['description_col', 'Description column', false],
                ['amount_col_secondary', 'Credit / refund column (optional)', true]
              ] as const
            ).map(([key, label, optional]) => (
              <label key={key} className="text-sm text-slate-600">
                {label}
                <select
                  className="input block w-full mt-1"
                  value={mapping[key] ?? ''}
                  onChange={(e) => setMapping({ ...mapping, [key]: e.target.value || (optional ? null : '') })}
                >
                  <option value="">{optional ? '— none —' : '— choose —'}</option>
                  {parsed.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label className="text-sm text-slate-600">
              Date format
              <select
                className="input block w-full mt-1"
                value={mapping.date_format}
                onChange={(e) => setMapping({ ...mapping, date_format: e.target.value })}
              >
                <option value="auto">Detect automatically</option>
                <option value="MM/DD/YYYY">MM/DD/YYYY (US)</option>
                <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                <option value="YYYY-MM-DD">YYYY-MM-DD</option>
              </select>
            </label>
            <label className="text-sm text-slate-600">
              How are charges written?
              <select
                className="input block w-full mt-1"
                value={mapping.amount_sign}
                onChange={(e) => setMapping({ ...mapping, amount_sign: e.target.value as ColumnMapping['amount_sign'] })}
              >
                <option value="expense_positive">Charges are positive (12.34)</option>
                <option value="expense_negative">Charges are negative (-12.34)</option>
              </select>
            </label>
          </div>

          <div>
            <h3 className="text-sm font-medium text-slate-600 mb-2">First rows of your file</h3>
            <div className="overflow-auto rounded-lg border border-slate-200 max-h-64">
              <table className="text-xs w-full">
                <thead className="bg-slate-50 sticky top-0">
                  <tr>
                    {parsed.headers.map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-medium text-slate-600 whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 10).map((row, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      {parsed.headers.map((h) => (
                        <td key={h} className="px-3 py-1.5 whitespace-nowrap text-slate-700">
                          {row[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex justify-between">
            <button className="btn-secondary" onClick={() => setStep(1)}>Back</button>
            <button className="btn-primary" onClick={buildPreview} disabled={busy}>
              {busy ? 'Checking…' : 'Preview import'}
            </button>
          </div>
        </div>
      )}

      {step === 3 && preview && (
        <div className="card-panel p-6 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-semibold text-slate-800 mr-auto">Ready to import</h2>
            <span className="text-sm rounded-full bg-green-100 text-green-700 px-3 py-1">{preview.newCount} new</span>
            <span className="text-sm rounded-full bg-amber-100 text-amber-700 px-3 py-1">{preview.duplicateCount} duplicates (skipped)</span>
            {preview.errorCount > 0 && (
              <span className="text-sm rounded-full bg-red-100 text-red-700 px-3 py-1">{preview.errorCount} unreadable (skipped)</span>
            )}
          </div>

          {reviewCount > 0 && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-4 py-2.5 text-sm">
              <strong>{reviewCount}</strong> row{reviewCount === 1 ? '' : 's'} matched no rule and defaulted to{' '}
              <em>business</em>. Toggle the ones that are personal, or click <strong>+ rule</strong> on a row so this
              merchant classifies itself on every future import.
            </div>
          )}

          {selected.size > 0 && (
            <div className="flex items-center gap-3 rounded-lg bg-slate-50 border border-slate-200 px-4 py-2 text-sm">
              <span className="text-slate-600">{selected.size} selected:</span>
              <button className="btn-secondary !py-1" onClick={() => bulkSet('business')}>Mark business</button>
              <button className="btn-secondary !py-1" onClick={() => bulkSet('personal')}>Mark personal</button>
            </div>
          )}

          <div className="overflow-auto rounded-lg border border-slate-200 max-h-96">
            <table className="text-sm w-full">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  <th className="px-3 py-2 w-8"></th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Date</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Description</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-600">Amount</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Category</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Type</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row) => {
                  const skippedRow = !!row.error || row.duplicate
                  const review = !skippedRow && row.needsReview && typeOverrides[row.index] === undefined
                  return (
                    <tr
                      key={row.index}
                      className={`border-t border-slate-100 ${skippedRow ? 'opacity-50' : review ? 'bg-amber-50' : ''}`}
                    >
                      <td className="px-3 py-1.5">
                        {!skippedRow && (
                          <input
                            type="checkbox"
                            checked={selected.has(row.index)}
                            onChange={(e) => {
                              const next = new Set(selected)
                              if (e.target.checked) next.add(row.index)
                              else next.delete(row.index)
                              setSelected(next)
                            }}
                          />
                        )}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{row.txn_date ?? '—'}</td>
                      <td className="px-3 py-1.5 max-w-72 truncate" title={row.description}>{row.description}</td>
                      <td className="px-3 py-1.5 text-right whitespace-nowrap">{row.amount !== null ? fmtMoney(row.amount) : '—'}</td>
                      <td className="px-3 py-1.5">{row.category_name ?? <span className="text-slate-400">Uncategorized</span>}</td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <TypePill
                            value={effectiveType(row.index, row.expense_type)}
                            onToggle={
                              skippedRow
                                ? undefined
                                : () =>
                                    setTypeOverrides({
                                      ...typeOverrides,
                                      [row.index]: effectiveType(row.index, row.expense_type) === 'business' ? 'personal' : 'business'
                                    })
                            }
                          />
                          {!skippedRow && (
                            <button
                              onClick={() => openRuleFor(row)}
                              title="Create a rule from this merchant"
                              className="text-xs text-slate-400 hover:text-blue-600"
                            >
                              + rule
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-xs whitespace-nowrap">
                        {row.error ? (
                          <span className="text-red-600" title={row.error}>⚠ {row.error}</span>
                        ) : row.duplicate ? (
                          <span className="text-amber-600">Already imported</span>
                        ) : review ? (
                          <span className="text-amber-600">Needs review</span>
                        ) : (
                          <span className="text-green-600">New</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {preview.rows.length > previewRows.length && (
              <div className="px-3 py-2 text-xs text-slate-500 bg-slate-50">
                Showing first {previewRows.length} of {preview.rows.length} rows — all {preview.newCount} new rows will be imported.
              </div>
            )}
          </div>

          <div className="flex justify-between">
            <button className="btn-secondary" onClick={() => setStep(2)}>Back</button>
            <button className="btn-primary" onClick={commit} disabled={busy || preview.newCount === 0}>
              {busy ? 'Importing…' : `Import ${preview.newCount} transaction${preview.newCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

      {ruleDraft && (
        <RuleModal
          draft={ruleDraft}
          categories={categories}
          busy={busy}
          onChange={setRuleDraft}
          onCancel={() => setRuleDraft(null)}
          onSave={() => saveRule(ruleDraft)}
        />
      )}
    </div>
  )
}
