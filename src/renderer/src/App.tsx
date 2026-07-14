import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ExpenseTypeFilter } from '@shared/types'
import ImportWizard from './screens/ImportWizard'
import Transactions from './screens/Transactions'
import CategoriesRules from './screens/CategoriesRules'
import Dashboard from './screens/Dashboard'
import QuickReports from './screens/QuickReports'
import Reconciliation from './screens/Reconciliation'
import Assignments from './screens/Assignments'
import Settings from './screens/Settings'
import LockScreen from './components/LockScreen'
import { getLockConfig } from './lock'

type Screen =
  | 'dashboard'
  | 'transactions'
  | 'import'
  | 'categories'
  | 'reports'
  | 'reconciliation'
  | 'assignments'
  | 'settings'

const NAV: { id: Screen; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'transactions', label: 'Transactions', icon: '🧾' },
  { id: 'import', label: 'Import Statement', icon: '📥' },
  { id: 'categories', label: 'Categories & Rules', icon: '🏷️' },
  { id: 'reports', label: 'Quick Reports', icon: '⚡' },
  { id: 'reconciliation', label: 'PO Matching', icon: '🔗' },
  { id: 'assignments', label: 'Cardholder Assignments', icon: '📨' },
  { id: 'settings', label: 'Settings', icon: '⚙️' }
]

interface GlobalFilterCtx {
  expenseType: ExpenseTypeFilter
  setExpenseType: (t: ExpenseTypeFilter) => void
}

const FilterContext = createContext<GlobalFilterCtx>({ expenseType: 'all', setExpenseType: () => {} })
export const useGlobalFilter = (): GlobalFilterCtx => useContext(FilterContext)

interface LockCtx {
  /** Lock the app immediately (Settings "Lock now" button). */
  lockNow: () => void
  /** Re-read lock settings after they change so the idle timer picks them up. */
  refreshLockConfig: () => void
}

const LockContext = createContext<LockCtx>({ lockNow: () => {}, refreshLockConfig: () => {} })
export const useLock = (): LockCtx => useContext(LockContext)

const TABS: { id: ExpenseTypeFilter; label: string }[] = [
  { id: 'business', label: 'Business' },
  { id: 'personal', label: 'Personal' },
  { id: 'all', label: 'All' }
]

const isExpenseTypeFilter = (value: string | null): value is ExpenseTypeFilter =>
  value === 'business' || value === 'personal' || value === 'all'

export default function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('import')
  const [expenseType, setExpenseTypeState] = useState<ExpenseTypeFilter>(() => {
    const stored = localStorage.getItem('expenseTypeFilter')
    return isExpenseTypeFilter(stored) ? stored : 'all'
  })
  const setExpenseType = (t: ExpenseTypeFilter): void => {
    localStorage.setItem('expenseTypeFilter', t)
    setExpenseTypeState(t)
  }

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem('sidebarCollapsed') === '1'
  )
  const toggleSidebar = (): void =>
    setSidebarCollapsed((v) => {
      const next = !v
      localStorage.setItem('sidebarCollapsed', next ? '1' : '0')
      return next
    })

  const [locked, setLocked] = useState(false)
  const [lockConfig, setLockConfig] = useState(getLockConfig)
  const refreshLockConfig = useCallback(() => setLockConfig(getLockConfig()), [])
  const lockNow = useCallback(() => {
    // Only lockable when a PIN exists, otherwise the lock screen can't be cleared.
    if (getLockConfig().hasPin) setLocked(true)
  }, [])

  // Idle auto-lock: while enabled and unlocked, lock after timeoutMs of no input.
  // Any activity resets the countdown. When locked, listeners are torn down (the
  // overlay owns input) and re-armed on unlock.
  useEffect(() => {
    if (!lockConfig.enabled || locked) return
    let timer: ReturnType<typeof setTimeout>
    const reset = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => setLocked(true), lockConfig.timeoutMs)
    }
    const events = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll']
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }))
    reset()
    return () => {
      clearTimeout(timer)
      events.forEach((e) => window.removeEventListener(e, reset))
    }
  }, [lockConfig.enabled, lockConfig.timeoutMs, locked])

  return (
    <LockContext.Provider value={{ lockNow, refreshLockConfig }}>
    <FilterContext.Provider value={{ expenseType, setExpenseType }}>
      <div className="flex h-screen">
        <aside
          className={`${sidebarCollapsed ? 'w-16' : 'w-56'} shrink-0 bg-slate-900 text-slate-200 flex flex-col transition-[width] duration-200`}
        >
          <div
            className={`flex items-center py-5 ${sidebarCollapsed ? 'justify-center px-0' : 'justify-between px-5'}`}
          >
            {!sidebarCollapsed && <span className="text-lg font-semibold text-white">Expense Tracker</span>}
            <button
              onClick={toggleSidebar}
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="text-slate-400 hover:text-white rounded-lg p-1.5 hover:bg-slate-800"
            >
              {sidebarCollapsed ? '»' : '«'}
            </button>
          </div>
          <nav className="flex-1 px-2 space-y-1">
            {NAV.map((item) => (
              <button
                key={item.id}
                onClick={() => setScreen(item.id)}
                title={sidebarCollapsed ? item.label : undefined}
                className={`w-full px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${
                  sidebarCollapsed ? 'justify-center' : 'text-left'
                } ${screen === item.id ? 'bg-slate-700 text-white' : 'hover:bg-slate-800'}`}
              >
                <span>{item.icon}</span>
                {!sidebarCollapsed && item.label}
              </button>
            ))}
          </nav>
          {!sidebarCollapsed && (
            <div className="px-5 py-4 text-xs text-slate-500">100% local — your data never leaves this PC</div>
          )}
        </aside>

        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-16 shrink-0 bg-white border-b border-slate-200 flex items-center justify-between px-6">
            <h1 className="text-lg font-semibold text-slate-800">{NAV.find((n) => n.id === screen)?.label}</h1>
            <div className="flex rounded-lg border border-slate-300 overflow-hidden" title="Switch reporting view">
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
            {screen === 'reports' && <QuickReports />}
            {screen === 'reconciliation' && <Reconciliation />}
            {screen === 'assignments' && <Assignments />}
            {screen === 'settings' && <Settings />}
          </main>
        </div>
      </div>
      {locked && <LockScreen onUnlock={() => setLocked(false)} />}
    </FilterContext.Provider>
    </LockContext.Provider>
  )
}
