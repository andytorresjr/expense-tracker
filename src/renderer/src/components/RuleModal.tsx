import type { Category, ExpenseType, MatchType } from '@shared/types'

export interface RuleDraft {
  pattern: string
  match_type: MatchType
  expense_type: ExpenseType | null
  category_id: number | null
  priority: number
}

interface Props {
  draft: RuleDraft
  categories: Category[]
  busy?: boolean
  onChange: (draft: RuleDraft) => void
  onCancel: () => void
  onSave: () => void
}

/**
 * Create/edit a categorization rule. A rule can set a category, an expense type,
 * or both — at least one is required. Used from the import preview ("create rule
 * from this row") and the Categories & Rules screen.
 */
export default function RuleModal({ draft, categories, busy, onChange, onCancel, onSave }: Props): React.JSX.Element {
  const valid = draft.pattern.trim().length > 0 && (draft.category_id !== null || draft.expense_type !== null)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div className="card-panel w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-semibold text-slate-800">Categorization rule</h2>
        <p className="text-sm text-slate-500">
          When a transaction&apos;s description matches, set its category and/or its business/personal type. Applied on
          import and when you re-run rules.
        </p>

        <label className="block text-sm text-slate-600">
          When description
          <div className="flex gap-2 mt-1">
            <select
              className="input w-36"
              value={draft.match_type}
              onChange={(e) => onChange({ ...draft, match_type: e.target.value as MatchType })}
            >
              <option value="contains">contains</option>
              <option value="starts_with">starts with</option>
              <option value="regex">matches regex</option>
            </select>
            <input
              className="input flex-1"
              placeholder="e.g. UBER"
              value={draft.pattern}
              onChange={(e) => onChange({ ...draft, pattern: e.target.value })}
            />
          </div>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm text-slate-600">
            Set type
            <select
              className="input block w-full mt-1"
              value={draft.expense_type ?? ''}
              onChange={(e) => onChange({ ...draft, expense_type: (e.target.value || null) as ExpenseType | null })}
            >
              <option value="">— leave unchanged —</option>
              <option value="business">Business</option>
              <option value="personal">Personal</option>
            </select>
          </label>
          <label className="block text-sm text-slate-600">
            Set category
            <select
              className="input block w-full mt-1"
              value={draft.category_id ?? ''}
              onChange={(e) => onChange({ ...draft, category_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">— leave unchanged —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block text-sm text-slate-600">
          Priority (higher wins when rules conflict)
          <input
            type="number"
            className="input block w-28 mt-1"
            value={draft.priority}
            onChange={(e) => onChange({ ...draft, priority: Number(e.target.value) || 0 })}
          />
        </label>

        {!valid && (
          <p className="text-xs text-amber-600">Enter a pattern and set a category or a type (or both).</p>
        )}

        <div className="flex justify-end gap-3 pt-1">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary" onClick={onSave} disabled={busy || !valid}>
            {busy ? 'Saving…' : 'Save rule'}
          </button>
        </div>
      </div>
    </div>
  )
}
