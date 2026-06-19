import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from 'recharts'
import type { ExpenseTypeFilter, Kpis } from '@shared/types'
import { fmtMoney } from '../api'

export interface DashboardReportMeta {
  scope: ExpenseTypeFilter
  cardLabel: string
  dateFrom: string
  dateTo: string
  generatedAt: string
}

const PALETTE = ['#2563eb', '#7c3aed', '#0891b2', '#16a34a', '#ea580c', '#db2777', '#ca8a04', '#475569', '#dc2626']

const scopeText = (scope: ExpenseTypeFilter): string =>
  scope === 'business' ? 'Business' : scope === 'personal' ? 'Personal' : 'Business & Personal'

const colorFor = (color: string | null, i: number): string => color ?? PALETTE[i % PALETTE.length]

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ marginTop: '20px', pageBreakInside: 'avoid' }}>
      <h2 style={{ fontSize: '14px', fontWeight: 700, margin: '0 0 10px', borderBottom: '1px solid #ccc', paddingBottom: '4px' }}>
        {title}
      </h2>
      {children}
    </div>
  )
}

/**
 * Print/PDF view of the dashboard. Hidden on screen (see the #print-root rules
 * in main.css); only rendered into the page while generating the PDF. Charts use
 * fixed dimensions and disabled animation so they paint their final geometry
 * synchronously — ResponsiveContainer can't measure a hidden element, and the
 * PDF is captured a couple of frames after mount before any animation finishes.
 */
export default function PrintableDashboard({
  kpis,
  meta
}: {
  kpis: Kpis
  meta: DashboardReportMeta
}): React.JSX.Element {
  const netAfterIncome = kpis.totalSpend - kpis.totalIncome
  const pctChange =
    kpis.prevPeriodSpend === 0 ? null : ((kpis.totalSpend - kpis.prevPeriodSpend) / kpis.prevPeriodSpend) * 100
  const categoryTotal = kpis.byCategory.reduce((sum, c) => sum + c.total, 0)

  const cards: { label: string; value: string; note: string }[] = [
    {
      label: 'Total spend',
      value: fmtMoney(kpis.totalSpend),
      note: pctChange === null ? 'No comparable prior period' : `${pctChange > 0 ? '▲' : '▼'} ${Math.abs(pctChange).toFixed(1)}% vs. previous period`
    },
    { label: 'Income', value: fmtMoney(kpis.totalIncome), note: 'from Income category' },
    { label: 'Net after income', value: fmtMoney(netAfterIncome), note: 'spend minus income' },
    { label: 'Uncategorized', value: String(kpis.uncategorizedCount), note: `transaction${kpis.uncategorizedCount === 1 ? '' : 's'} need a category` },
    { label: 'Categories with spend', value: String(kpis.byCategory.length), note: 'in this range' }
  ]

  return (
    <div id="print-root" style={{ color: '#000', fontFamily: 'Arial, Helvetica, sans-serif', padding: '24px', maxWidth: '760px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 4px' }}>Dashboard report</h1>
      <div style={{ fontSize: '12px', color: '#333', marginBottom: '4px', lineHeight: 1.6 }}>
        <div>Reporting view: {scopeText(meta.scope)}</div>
        {meta.cardLabel !== 'All cards' && <div>Card: {meta.cardLabel}</div>}
        <div>Period: {meta.dateFrom} to {meta.dateTo}</div>
        <div>Generated: {meta.generatedAt}</div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '16px' }}>
        {cards.map((c) => (
          <div key={c.label} style={{ flex: '1 1 130px', border: '1px solid #ccc', borderRadius: '6px', padding: '8px 10px' }}>
            <div style={{ fontSize: '11px', color: '#555' }}>{c.label}</div>
            <div style={{ fontSize: '18px', fontWeight: 700, margin: '2px 0' }}>{c.value}</div>
            <div style={{ fontSize: '10px', color: '#777' }}>{c.note}</div>
          </div>
        ))}
      </div>

      <Section title="Spend by category">
        {kpis.byCategory.length === 0 ? (
          <p style={{ fontSize: '12px', color: '#777' }}>No spending in this range.</p>
        ) : (
          <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
            <PieChart width={240} height={220}>
              <Pie data={kpis.byCategory} dataKey="total" nameKey="category" innerRadius={50} outerRadius={85} paddingAngle={1} isAnimationActive={false}>
                {kpis.byCategory.map((entry, i) => (
                  <Cell key={i} fill={colorFor(entry.color, i)} />
                ))}
              </Pie>
            </PieChart>
            <table style={{ flex: 1, borderCollapse: 'collapse', fontSize: '12px' }}>
              <tbody>
                {kpis.byCategory.map((c, i) => (
                  <tr key={c.category}>
                    <td style={{ padding: '3px 6px 3px 0', whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', background: colorFor(c.color, i), marginRight: '6px' }} />
                      {c.category}
                    </td>
                    <td style={{ padding: '3px 0', textAlign: 'right', color: '#777', whiteSpace: 'nowrap' }}>
                      {categoryTotal > 0 ? `${((c.total / categoryTotal) * 100).toFixed(1)}%` : ''}
                    </td>
                    <td style={{ padding: '3px 0 3px 10px', textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {fmtMoney(c.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Monthly trend">
        {kpis.monthlyTrend.length === 0 ? (
          <p style={{ fontSize: '12px', color: '#777' }}>No spending in this range.</p>
        ) : (
          <BarChart width={700} height={240} data={kpis.monthlyTrend} margin={{ top: 4, right: 12, left: 12, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="month" fontSize={11} />
            <YAxis fontSize={11} tickFormatter={(v) => `$${v}`} />
            <Bar dataKey="total" fill="#2563eb" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        )}
      </Section>

      <Section title="Top vendors">
        {kpis.topVendors.length === 0 ? (
          <p style={{ fontSize: '12px', color: '#777' }}>No vendors in this range.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <tbody>
              {kpis.topVendors.map((v, i) => (
                <tr key={i}>
                  <td style={{ borderBottom: '1px solid #eee', padding: '4px 6px 4px 0' }}>{v.vendor}</td>
                  <td style={{ borderBottom: '1px solid #eee', padding: '4px 6px', textAlign: 'right', color: '#777', whiteSpace: 'nowrap' }}>{v.count}×</td>
                  <td style={{ borderBottom: '1px solid #eee', padding: '4px 0', textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtMoney(v.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {kpis.budgetVsActual.length > 0 && (
        <Section title="Budget vs. actual">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <tbody>
              {kpis.budgetVsActual.map((b) => {
                const over = b.actual > b.limit
                return (
                  <tr key={b.category}>
                    <td style={{ borderBottom: '1px solid #eee', padding: '4px 6px 4px 0' }}>{b.category}</td>
                    <td style={{ borderBottom: '1px solid #eee', padding: '4px 0', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: over ? 700 : 400, color: over ? '#dc2626' : '#000' }}>
                      {fmtMoney(b.actual)} / {fmtMoney(b.limit)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  )
}
