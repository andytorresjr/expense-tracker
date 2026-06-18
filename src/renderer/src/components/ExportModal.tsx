import { useState } from 'react'
import type { ExpenseTypeFilter, ExportFormat } from '@shared/types'

type SpreadsheetExportFormat = Exclude<ExportFormat, 'pdf'>

const SCOPES: { id: ExpenseTypeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'business', label: 'Business only' },
  { id: 'personal', label: 'Personal only' }
]

/**
 * Choose what to export: the business/personal/all scope, plus the
 * category/card/search filters already active on the screen carry through (so
 * filtering to "Dining" then exporting yields a Dining report). Output is a CSV
 * file, an Excel file, or a PDF report.
 */
export default function ExportModal({
  busy,
  defaultScope,
  categoryLabel,
  cardLabel,
  search,
  onCancel,
  onExport,
  onPdf
}: {
  busy: boolean
  defaultScope: ExpenseTypeFilter
  categoryLabel: string
  cardLabel: string
  search: string
  onCancel: () => void
  onExport: (scope: ExpenseTypeFilter, format: SpreadsheetExportFormat) => void
  onPdf: (scope: ExpenseTypeFilter) => void
}): React.JSX.Element {
  const [scope, setScope] = useState<ExpenseTypeFilter>(defaultScope)

  const activeFilters = [
    categoryLabel !== 'All categories' ? `Category: ${categoryLabel}` : null,
    cardLabel !== 'All cards' ? `Card: ${cardLabel}` : null,
    search ? `Search: “${search}”` : null
  ].filter(Boolean) as string[]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={busy ? undefined : onCancel}>
      <div className="card-panel w-full max-w-md p-6 space-y-5" onClick={(event) => event.stopPropagation()}>
        <div>
          <h2 className="font-semibold text-slate-800">Export transactions</h2>
          <p className="mt-1 text-sm text-slate-500">
            Download the filtered list as a CSV, Excel workbook, or PDF report.
          </p>
        </div>

        <div>
          <div className="text-sm font-medium text-slate-600 mb-1.5">What to include</div>
          <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-100 p-1">
            {SCOPES.map((option) => (
              <button
                key={option.id}
                className={`rounded-md px-3 py-2 text-sm font-medium ${
                  scope === option.id ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'
                }`}
                onClick={() => setScope(option.id)}
                disabled={busy}
              >
                {option.label}
              </button>
            ))}
          </div>
          {activeFilters.length > 0 && (
            <p className="mt-2 text-xs text-slate-500">
              Current filters also apply — {activeFilters.join(' · ')}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium text-slate-600">Output</div>
          <div className="grid grid-cols-3 gap-2">
            <button className="btn-secondary justify-center" onClick={() => onExport(scope, 'csv')} disabled={busy}>
              CSV
            </button>
            <button className="btn-secondary justify-center" onClick={() => onExport(scope, 'xlsx')} disabled={busy}>
              Excel
            </button>
            <button className="btn-primary justify-center" onClick={() => onPdf(scope)} disabled={busy}>
              PDF
            </button>
          </div>
        </div>

        <div className="flex justify-end pt-1">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
