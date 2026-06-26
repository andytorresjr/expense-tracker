import type { ExpenseTypeFilter, Txn } from '@shared/types'
import { fmtMoney } from '../api'

export interface ReportMeta {
  scope: ExpenseTypeFilter
  categoryLabel: string
  cardLabel: string
  search: string
  generatedAt: string
  /** Explicit report title (Quick Reports); otherwise derived from the category. */
  title?: string
}

const scopeText = (scope: ExpenseTypeFilter): string =>
  scope === 'business' ? 'Business' : scope === 'personal' ? 'Personal' : 'Business & Personal'

/**
 * Print/PDF view of a filtered transaction set. Hidden on screen (see the
 * #print-root rules in main.css); only shown while printing. Styling is plain
 * black-on-white with explicit borders so it renders predictably on paper and
 * in "Save as PDF" without depending on background-color printing.
 */
export default function PrintableReport({ rows, meta }: { rows: Txn[]; meta: ReportMeta }): React.JSX.Element {
  const total = rows.reduce((sum, txn) => sum + txn.amount, 0)
  const hasCategory = meta.categoryLabel !== 'All categories'
  const title = meta.title ?? (hasCategory ? `${meta.categoryLabel} — spending report` : 'Transactions report')
  // Client / business purpose columns appear only when the filtered set carries
  // them, so a plain report stays compact. Client substantiates business meals
  // for the IRS, so it's the more important of the two to surface on paper.
  const hasClient = rows.some((txn) => txn.client)
  const hasPurpose = rows.some((txn) => txn.business_purpose)
  // Left-aligned columns before the trailing Amount column; the footer spans them.
  const leftColumnCount = 5 + (hasClient ? 1 : 0) + (hasPurpose ? 1 : 0)

  return (
    <div id="print-root" style={{ color: '#000', fontFamily: 'Arial, Helvetica, sans-serif', padding: '24px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 4px' }}>{title}</h1>
      <div style={{ fontSize: '12px', color: '#333', marginBottom: '16px', lineHeight: 1.6 }}>
        <div>Reporting view: {scopeText(meta.scope)}</div>
        {hasCategory && <div>Category: {meta.categoryLabel}</div>}
        {meta.cardLabel !== 'All cards' && <div>Card: {meta.cardLabel}</div>}
        {meta.search && <div>Search: “{meta.search}”</div>}
        <div>Generated: {meta.generatedAt}</div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead>
          <tr>
            {[
              'Date',
              'Description',
              'Type',
              'Category',
              'Card',
              ...(hasClient ? ['Client'] : []),
              ...(hasPurpose ? ['Business Purpose'] : [])
            ].map((h) => (
              <th key={h} style={{ textAlign: 'left', borderBottom: '2px solid #000', padding: '6px 8px' }}>
                {h}
              </th>
            ))}
            <th style={{ textAlign: 'right', borderBottom: '2px solid #000', padding: '6px 8px' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((txn) => (
            <tr key={txn.id}>
              <td style={{ borderBottom: '1px solid #ccc', padding: '5px 8px', whiteSpace: 'nowrap' }}>{txn.txn_date}</td>
              <td style={{ borderBottom: '1px solid #ccc', padding: '5px 8px' }}>{txn.description}</td>
              <td style={{ borderBottom: '1px solid #ccc', padding: '5px 8px', textTransform: 'capitalize' }}>
                {txn.expense_type ?? 'Unassigned'}
              </td>
              <td style={{ borderBottom: '1px solid #ccc', padding: '5px 8px' }}>{txn.category_name ?? 'Uncategorized'}</td>
              <td style={{ borderBottom: '1px solid #ccc', padding: '5px 8px' }}>{txn.card_name}</td>
              {hasClient && (
                <td style={{ borderBottom: '1px solid #ccc', padding: '5px 8px' }}>{txn.client ?? ''}</td>
              )}
              {hasPurpose && (
                <td style={{ borderBottom: '1px solid #ccc', padding: '5px 8px' }}>{txn.business_purpose ?? ''}</td>
              )}
              <td style={{ borderBottom: '1px solid #ccc', padding: '5px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {fmtMoney(txn.amount)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={leftColumnCount} style={{ padding: '8px', fontWeight: 700, borderTop: '2px solid #000' }}>
              Total — {rows.length} transaction{rows.length === 1 ? '' : 's'}
            </td>
            <td style={{ padding: '8px', fontWeight: 700, borderTop: '2px solid #000', textAlign: 'right', whiteSpace: 'nowrap' }}>
              {fmtMoney(total)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
