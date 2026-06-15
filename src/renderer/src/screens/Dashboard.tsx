import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { Kpis } from '@shared/types'
import { api, fmtMoney } from '../api'
import { useGlobalFilter } from '../App'

type RangeKey = 'this_month' | 'last_month' | 'last_3' | 'this_year' | 'custom'

const RANGES: { id: RangeKey; label: string }[] = [
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'last_3', label: 'Last 3 months' },
  { id: 'this_year', label: 'This year' },
  { id: 'custom', label: 'Custom' }
]

const PALETTE = ['#2563eb', '#7c3aed', '#0891b2', '#16a34a', '#ea580c', '#db2777', '#ca8a04', '#475569', '#dc2626']

const iso = (d: Date): string => d.toISOString().slice(0, 10)

function rangeFor(key: RangeKey): { from: string; to: string } {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  switch (key) {
    case 'this_month':
      return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) }
    case 'last_month':
      return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) }
    case 'last_3':
      return { from: iso(new Date(y, m - 2, 1)), to: iso(new Date(y, m + 1, 0)) }
    case 'this_year':
      return { from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)) }
    case 'custom':
      return { from: iso(new Date(y, m, 1)), to: iso(now) }
  }
}

function StatCard({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="card-panel p-5">
      <h3 className="text-sm font-medium text-slate-500 mb-3">{title}</h3>
      {children}
    </div>
  )
}

export default function Dashboard(): React.JSX.Element {
  const { expenseType } = useGlobalFilter()
  const [rangeKey, setRangeKey] = useState<RangeKey>('this_month')
  const [custom, setCustom] = useState(() => rangeFor('this_month'))
  const [kpis, setKpis] = useState<Kpis | null>(null)
  const [error, setError] = useState<string | null>(null)

  const range = useMemo(() => (rangeKey === 'custom' ? custom : rangeFor(rangeKey)), [rangeKey, custom])

  const load = useCallback((): void => {
    api.dashboard
      .getKpis({ expenseType, dateFrom: range.from, dateTo: range.to })
      .then(setKpis)
      .catch((e) => setError(e.message))
  }, [expenseType, range.from, range.to])

  useEffect(load, [load])

  const pctChange = useMemo(() => {
    if (!kpis || kpis.prevPeriodSpend === 0) return null
    return ((kpis.totalSpend - kpis.prevPeriodSpend) / kpis.prevPeriodSpend) * 100
  }, [kpis])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-slate-300 overflow-hidden">
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRangeKey(r.id)}
              className={`px-3 py-1.5 text-sm font-medium ${
                rangeKey === r.id ? 'bg-slate-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        {rangeKey === 'custom' && (
          <div className="flex items-center gap-2 text-sm">
            <input type="date" className="input !py-1" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            <span className="text-slate-400">to</span>
            <input type="date" className="input !py-1" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </div>
        )}
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">{error}</div>}

      {kpis && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard title="Total spend">
              <div className="text-3xl font-semibold text-slate-800">{fmtMoney(kpis.totalSpend)}</div>
              {pctChange !== null ? (
                <div className={`text-sm mt-1 ${pctChange > 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {pctChange > 0 ? '▲' : '▼'} {Math.abs(pctChange).toFixed(1)}% vs. previous period
                </div>
              ) : (
                <div className="text-sm mt-1 text-slate-400">No comparable prior period</div>
              )}
            </StatCard>
            <StatCard title="Uncategorized">
              <div className="text-3xl font-semibold text-slate-800">{kpis.uncategorizedCount}</div>
              <div className="text-sm mt-1 text-slate-400">transaction{kpis.uncategorizedCount === 1 ? '' : 's'} need a category</div>
            </StatCard>
            <StatCard title="Categories with spend">
              <div className="text-3xl font-semibold text-slate-800">{kpis.byCategory.length}</div>
              <div className="text-sm mt-1 text-slate-400">in this range</div>
            </StatCard>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <StatCard title="Spend by category">
              {kpis.byCategory.length === 0 ? (
                <p className="text-sm text-slate-400 py-12 text-center">No spending in this range.</p>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie
                      data={kpis.byCategory}
                      dataKey="total"
                      nameKey="category"
                      innerRadius={55}
                      outerRadius={90}
                      paddingAngle={1}
                    >
                      {kpis.byCategory.map((entry, i) => (
                        <Cell key={i} fill={entry.color ?? PALETTE[i % PALETTE.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v) => fmtMoney(Number(v))} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </StatCard>

            <StatCard title="Monthly trend">
              {kpis.monthlyTrend.length === 0 ? (
                <p className="text-sm text-slate-400 py-12 text-center">No spending in this range.</p>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={kpis.monthlyTrend}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="month" fontSize={12} />
                    <YAxis fontSize={12} tickFormatter={(v) => `$${v}`} />
                    <Tooltip formatter={(v) => fmtMoney(Number(v))} />
                    <Bar dataKey="total" fill="#2563eb" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </StatCard>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <StatCard title="Top vendors">
              <table className="text-sm w-full">
                <tbody>
                  {kpis.topVendors.map((v, i) => (
                    <tr key={i} className="border-t border-slate-100 first:border-0">
                      <td className="py-1.5 pr-2 max-w-64 truncate" title={v.vendor}>{v.vendor}</td>
                      <td className="py-1.5 text-slate-400 text-right whitespace-nowrap">{v.count}×</td>
                      <td className="py-1.5 text-right font-medium whitespace-nowrap">{fmtMoney(v.total)}</td>
                    </tr>
                  ))}
                  {kpis.topVendors.length === 0 && (
                    <tr><td className="py-8 text-center text-slate-400">No vendors in this range.</td></tr>
                  )}
                </tbody>
              </table>
            </StatCard>

            <StatCard title="Budget vs. actual">
              {expenseType === 'all' ? (
                <p className="text-sm text-slate-400 py-8 text-center">
                  Switch to Business or Personal to see budgets — mixing both makes over/under ambiguous.
                </p>
              ) : kpis.budgetVsActual.length === 0 ? (
                <p className="text-sm text-slate-400 py-8 text-center">
                  No budgets set for {expenseType}. Add them in Categories &amp; Rules.
                </p>
              ) : (
                <div className="space-y-3">
                  {kpis.budgetVsActual.map((b) => {
                    const pct = b.limit > 0 ? (b.actual / b.limit) * 100 : 0
                    const over = b.actual > b.limit
                    return (
                      <div key={b.category}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-slate-700">{b.category}</span>
                          <span className={over ? 'text-red-600 font-medium' : 'text-slate-500'}>
                            {fmtMoney(b.actual)} / {fmtMoney(b.limit)}
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                          <div
                            className={`h-full ${over ? 'bg-red-500' : 'bg-blue-500'}`}
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </StatCard>
          </div>
        </>
      )}
    </div>
  )
}
