import { createContext, useContext, useState } from 'react'
import type { ExpenseTypeFilter } from '@shared/types'
import ImportWizard from './screens/ImportWizard'
import Transactions from './screens/Transactions'
import CategoriesRules from './screens/CategoriesRules'
import Dashboard from './screens/Dashboard'
import Cards from './screens/Cards'
import Settings from './screens/Settings'

type Screen = 'dashboard' | 'transactions' | 'import' | 'categories' | 'cards' | 'settings'

const NAV: { id: Screen; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'transactions', label: 'Transactions', icon: '🧾' },
  { id: 'import', label: 'Import Statement', icon: '📥' },
  { id: 'categories', label: 'Categories & Rules', icon: '🏷️' },
  { id: 'cards', label: 'Cards', icon: '💳' },
  { id: 'settings', label: 'Settings', icon: '⚙️' }
]

interface GlobalFilterCtx {
  expenseType: ExpenseTypeFilter
  setExpenseType: (t: ExpenseTypeFilter) => void
}

const FilterContext = createContext<GlobalFilterCtx>({ expenseType: 'business', setExpenseType: () => {} })
export const useGlobalFilter = (): GlobalFilterCtx => useContext(FilterContext)

const TABS: { id: ExpenseTypeFilter; label: string }[] = [
  { id: 'business', label: 'Business' },
  { id: 'personal', label: 'Personal' },
  { id: 'all', label: 'All' }
]

export default function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('import')
  const [expenseType, setExpenseTypeState] = useState<ExpenseTypeFilter>(
    () => (localStorage.getItem('expenseTypeFilter') as ExpenseTypeFilter) || 'business'
  )
  const setExpenseType = (t: ExpenseTypeFilter): void => {
    localStorage.setItem('expenseTypeFilter', t)
    setExpenseTypeState(t)
  }

  return (
    <FilterContext.Provider value={{ expenseType, setExpenseType }}>
      <div className="flex h-screen">
        <aside className="w-56 shrink-0 bg-slate-900 text-slate-200 flex flex-col">
          <div className="px-5 py-5 text-lg font-semibold text-white">Expense Tracker</div>
          <nav className="flex-1 px-2 space-y-1">
            {NAV.map((item) => (
              <button
                key={item.id}
                onClick={() => setScreen(item.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${
                  screen === item.id ? 'bg-slate-700 text-white' : 'hover:bg-slate-800'
                }`}
              >
                <span>{item.icon}</span> {item.label}
              </button>
            ))}
          </nav>
          <div className="px-5 py-4 text-xs text-slate-500">100% local — your data never leaves this PC</div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-16 shrink-0 bg-white border-b border-slate-200 flex items-center justify-between px-6">
            <h1 className="text-lg font-semibold text-slate-800">{NAV.find((n) => n.id === screen)?.label}</h1>
            <div className="flex rounded-lg border border-slate-300 overflow-hidden" title="Switch between business and personal reporting">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setExpenseType(tab.id)}
                  className={`px-4 py-1.5 text-sm font-medium ${
                    expenseType === tab.id
                      ? tab.id === 'personal'
                        ? 'bg-violet-600 text-white'
                        : tab.id === 'business'
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-700 text-white'
                      : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </header>

          <main className="flex-1 overflow-auto p-6">
            {screen === 'import' && <ImportWizard onDone={() => setScreen('transactions')} />}
            {screen === 'transactions' && <Transactions />}
            {screen === 'dashboard' && <Dashboard />}
            {screen === 'categories' && <CategoriesRules />}
            {screen === 'cards' && <Cards />}
            {screen === 'settings' && <Settings />}
          </main>
        </div>
      </div>
    </FilterContext.Provider>
  )
}
