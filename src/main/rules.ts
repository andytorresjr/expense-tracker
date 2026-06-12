import type Database from 'better-sqlite3'
import type { CategoryRule, ExpenseType } from '@shared/types'

export function ruleMatches(rule: CategoryRule, description: string): boolean {
  const desc = description.toLowerCase()
  const pattern = rule.pattern.toLowerCase()
  switch (rule.match_type) {
    case 'contains':
      return desc.includes(pattern)
    case 'starts_with':
      return desc.startsWith(pattern)
    case 'regex':
      try {
        return new RegExp(rule.pattern, 'i').test(description)
      } catch {
        return false
      }
  }
}

export function loadRules(db: Database.Database): CategoryRule[] {
  return db
    .prepare('SELECT * FROM category_rules ORDER BY priority DESC, id ASC')
    .all() as CategoryRule[]
}

/**
 * Category and expense type are matched independently: the highest-priority
 * matching rule that sets a category wins the category; the highest-priority
 * matching rule that sets a type wins the type.
 */
export function applyRules(
  rules: CategoryRule[],
  description: string
): { category_id: number | null; expense_type: ExpenseType | null } {
  let category_id: number | null = null
  let expense_type: ExpenseType | null = null
  for (const rule of rules) {
    if (category_id !== null && expense_type !== null) break
    if (!ruleMatches(rule, description)) continue
    if (category_id === null && rule.category_id !== null) category_id = rule.category_id
    if (expense_type === null && rule.expense_type !== null) expense_type = rule.expense_type
  }
  return { category_id, expense_type }
}

/** Re-run all rules over existing transactions, respecting both locks. */
export function rerunRules(db: Database.Database): { categorized: number; retyped: number } {
  const rules = loadRules(db)
  const txns = db
    .prepare(
      'SELECT id, description, expense_type, category_id FROM transactions WHERE category_locked = 0 OR type_locked = 0'
    )
    .all() as { id: number; description: string; expense_type: ExpenseType; category_id: number | null }[]
  const lockFlags = db
    .prepare('SELECT id, category_locked, type_locked FROM transactions')
    .all() as { id: number; category_locked: 0 | 1; type_locked: 0 | 1 }[]
  const locks = new Map(lockFlags.map((t) => [t.id, t]))

  const updCategory = db.prepare('UPDATE transactions SET category_id = ? WHERE id = ?')
  const updType = db.prepare('UPDATE transactions SET expense_type = ? WHERE id = ?')

  let categorized = 0
  let retyped = 0
  const run = db.transaction(() => {
    for (const txn of txns) {
      const lock = locks.get(txn.id)!
      const result = applyRules(rules, txn.description)
      if (!lock.category_locked && result.category_id !== null && result.category_id !== txn.category_id) {
        updCategory.run(result.category_id, txn.id)
        categorized++
      }
      if (!lock.type_locked && result.expense_type !== null && result.expense_type !== txn.expense_type) {
        updType.run(result.expense_type, txn.id)
        retyped++
      }
    }
  })
  run()
  return { categorized, retyped }
}
