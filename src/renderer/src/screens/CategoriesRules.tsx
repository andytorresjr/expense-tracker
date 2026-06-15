import { useCallback, useEffect, useState } from 'react'
import type { Budget, Category, CategoryRule, ExpenseType } from '@shared/types'
import { api } from '../api'
import RuleModal, { type RuleDraft } from '../components/RuleModal'

const MATCH_LABEL: Record<CategoryRule['match_type'], string> = {
  contains: 'contains',
  starts_with: 'starts with',
  regex: 'regex'
}

export default function CategoriesRules(): React.JSX.Element {
  const [categories, setCategories] = useState<Category[]>([])
  const [rules, setRules] = useState<CategoryRule[]>([])
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [newCatName, setNewCatName] = useState('')
  const [newCatColor, setNewCatColor] = useState('#64748b')

  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null)
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null)

  const load = useCallback((): void => {
    Promise.all([api.categories.list(), api.rules.list(), api.budgets.list()])
      .then(([c, r, b]) => {
        setCategories(c)
        setRules(r)
        setBudgets(b)
      })
      .catch((e) => setError(e.message))
  }, [])

  useEffect(load, [load])

  const run = async (fn: () => Promise<void>, msg?: string): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
      if (msg) setNotice(msg)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const catName = (id: number | null): string =>
    id === null ? '—' : (categories.find((c) => c.id === id)?.name ?? '(deleted)')

  // ---- categories ----
  const addCategory = (): Promise<void> =>
    run(async () => {
      if (!newCatName.trim()) throw new Error('Enter a category name.')
      await api.categories.create(newCatName.trim(), newCatColor)
      setNewCatName('')
      load()
    })

  const deleteCategory = (c: Category): Promise<void> =>
    run(async () => {
      await api.categories.remove(c.id)
      load()
    })

  // ---- rules ----
  const openNewRule = (): void => {
    setEditingRuleId(null)
    setRuleDraft({ pattern: '', match_type: 'contains', expense_type: null, category_id: null, priority: 0 })
  }

  const openEditRule = (r: CategoryRule): void => {
    setEditingRuleId(r.id)
    setRuleDraft({
      pattern: r.pattern,
      match_type: r.match_type,
      expense_type: r.expense_type,
      category_id: r.category_id,
      priority: r.priority
    })
  }

  const saveRule = (): Promise<void> =>
    run(async () => {
      if (!ruleDraft) return
      if (editingRuleId !== null) {
        await api.rules.update({ id: editingRuleId, ...ruleDraft })
      } else {
        await api.rules.create(ruleDraft)
      }
      setRuleDraft(null)
      setEditingRuleId(null)
      load()
    })

  const deleteRule = (r: CategoryRule): Promise<void> =>
    run(async () => {
      await api.rules.remove(r.id)
      load()
    })

  const rerun = (): Promise<void> =>
    run(async () => {
      await api.rules.rerun()
      load()
    }, 'Rules re-applied to existing transactions.')

  // ---- budgets ----
  const budgetFor = (categoryId: number, type: ExpenseType): Budget | undefined =>
    budgets.find((b) => b.category_id === categoryId && b.expense_type === type)

  const setBudget = (categoryId: number, type: ExpenseType, raw: string): Promise<void> =>
    run(async () => {
      const value = parseFloat(raw)
      const existing = budgetFor(categoryId, type)
      if (!raw.trim() || Number.isNaN(value) || value <= 0) {
        if (existing) await api.budgets.remove(existing.id)
      } else {
        await api.budgets.upsert(categoryId, type, value)
      }
      load()
    })

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">{error}</div>}
      {notice && <div className="rounded-lg bg-green-50 border border-green-200 text-green-700 px-4 py-3 text-sm">{notice}</div>}

      {/* Rules */}
      <section className="card-panel p-6 space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="font-semibold text-slate-800 mr-auto">Rules</h2>
          <button className="btn-secondary !py-1" onClick={rerun} disabled={busy} title="Re-apply rules to existing transactions (manual edits are kept)">
            Re-run on existing
          </button>
          <button className="btn-primary !py-1" onClick={openNewRule} disabled={busy}>
            + New rule
          </button>
        </div>
        <p className="text-sm text-slate-500">
          Rules split each statement into business vs. personal and assign categories automatically by matching the
          merchant text. Higher priority wins when two rules match.
        </p>
        <div className="overflow-auto rounded-lg border border-slate-200">
          <table className="text-sm w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-slate-600">When description</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Set type</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Set category</th>
                <th className="px-4 py-2 text-right font-medium text-slate-600">Priority</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <span className="text-slate-500">{MATCH_LABEL[r.match_type]}</span>{' '}
                    <span className="font-medium text-slate-800">{r.pattern}</span>
                  </td>
                  <td className="px-4 py-2 capitalize">
                    {r.expense_type ? (
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          r.expense_type === 'business' ? 'bg-blue-100 text-blue-700' : 'bg-violet-100 text-violet-700'
                        }`}
                      >
                        {r.expense_type}
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">{r.category_id ? catName(r.category_id) : <span className="text-slate-400">—</span>}</td>
                  <td className="px-4 py-2 text-right text-slate-500">{r.priority}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <button className="text-blue-600 hover:underline mr-3" onClick={() => openEditRule(r)}>Edit</button>
                    <button className="text-red-500 hover:underline" onClick={() => deleteRule(r)}>Delete</button>
                  </td>
                </tr>
              ))}
              {rules.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                    No rules yet. Add one here, or click <strong>+ rule</strong> on a row in the import preview.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Categories + budgets */}
      <section className="card-panel p-6 space-y-4">
        <h2 className="font-semibold text-slate-800">Categories &amp; budgets</h2>
        <p className="text-sm text-slate-500">
          Monthly budgets are tracked separately for business and personal so the two reports never mix.
        </p>
        <div className="overflow-auto rounded-lg border border-slate-200">
          <table className="text-sm w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Category</th>
                <th className="px-4 py-2 text-right font-medium text-slate-600">Business budget / mo</th>
                <th className="px-4 py-2 text-right font-medium text-slate-600">Personal budget / mo</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id} className="border-t border-slate-100">
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full" style={{ background: c.color ?? '#cbd5e1' }} />
                      {c.name}
                    </span>
                  </td>
                  {(['business', 'personal'] as ExpenseType[]).map((type) => (
                    <td key={type} className="px-4 py-2 text-right">
                      <input
                        type="number"
                        min="0"
                        step="50"
                        defaultValue={budgetFor(c.id, type)?.monthly_limit ?? ''}
                        placeholder="—"
                        className="input w-28 text-right"
                        onBlur={(e) => {
                          const current = budgetFor(c.id, type)?.monthly_limit
                          if (String(current ?? '') !== e.target.value) setBudget(c.id, type, e.target.value)
                        }}
                      />
                    </td>
                  ))}
                  <td className="px-4 py-2 text-right">
                    <button className="text-red-500 hover:underline" onClick={() => deleteCategory(c)}>
                      Archive
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-end gap-3 border-t border-slate-200 pt-4">
          <label className="text-sm text-slate-600">
            New category
            <input
              className="input block w-56 mt-1"
              placeholder="e.g. Marketing"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCategory()}
            />
          </label>
          <label className="text-sm text-slate-600">
            Color
            <input
              type="color"
              className="block w-16 h-9 mt-1 rounded border border-slate-300"
              value={newCatColor}
              onChange={(e) => setNewCatColor(e.target.value)}
            />
          </label>
          <button className="btn-secondary" onClick={addCategory} disabled={busy}>
            Add category
          </button>
        </div>
      </section>

      {ruleDraft && (
        <RuleModal
          draft={ruleDraft}
          categories={categories}
          busy={busy}
          onChange={setRuleDraft}
          onCancel={() => {
            setRuleDraft(null)
            setEditingRuleId(null)
          }}
          onSave={saveRule}
        />
      )}
    </div>
  )
}
