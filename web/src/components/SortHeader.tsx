/**
 * SortHeader — shared sortable table header + URL-backed sort state (Phase 9 P2).
 *
 * Usage:
 *   const { sort, order, toggle } = useSort('createdAt', 'desc')
 *   const list = useAccounts({ ...sortParams(sort, order), page, pageSize: 25 })
 *   <thead><tr>
 *     <SortTh label="Identifier" sortKey="identifier" sort={sort} order={order} onSort={toggle} />
 *     <SortTh label="Created" sortKey="createdAt" sort={sort} order={order} onSort={toggle} />
 *   </tr></thead>
 *
 * - useSort(defaultKey, defaultOrder): keeps `sort` / `order` in the URL query (replace: true,
 *   so back/forward are not polluted), deletes the `page` param when the sort changes (back to
 *   page 1), and returns { sort, order, toggle(key, natural?) }. Clicking the active key flips the
 *   order; clicking a new key starts at its natural order: 'asc' for text, 'desc' for dates
 *   (keys ending in "At" or "Date", e.g. createdAt / assignedAt). Pages that keep their page
 *   number in the URL must use the `page` param name to benefit from the reset.
 * - sortParams(sort, order): `{ sort, order }` to spread into list hook filters. Always send both.
 * - <SortTh>: renders <th className="th" aria-sort> containing a button (▲ / ▼ active, faint ⇅ idle).
 *   Props: label, sortKey, sort, order, onSort, className?, natural? (override the natural order).
 */
import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

export type SortOrder = 'asc' | 'desc'

/** Natural first order for a key: dates newest first, everything else A→Z. */
export function naturalOrder(key: string): SortOrder {
  return /(At|Date)$/.test(key) ? 'desc' : 'asc'
}

export function sortParams(sort: string, order: SortOrder): { sort: string; order: SortOrder } {
  return { sort, order }
}

export function useSort(defaultKey: string, defaultOrder: SortOrder) {
  const [sp, setSp] = useSearchParams()
  const sort = sp.get('sort') || defaultKey
  const rawOrder = sp.get('order')
  const order: SortOrder = rawOrder === 'asc' || rawOrder === 'desc' ? rawOrder : sort === defaultKey ? defaultOrder : naturalOrder(sort)

  const toggle = useCallback((key: string, natural?: SortOrder) => {
    const nextOrder: SortOrder = key === sort ? (order === 'asc' ? 'desc' : 'asc') : natural ?? naturalOrder(key)
    setSp((prev) => {
      const n = new URLSearchParams(prev)
      n.set('sort', key)
      n.set('order', nextOrder)
      n.delete('page')
      return n
    }, { replace: true })
  }, [sort, order, setSp])

  return { sort, order, toggle }
}

export function SortTh({ label, sortKey, sort, order, onSort, className = '', natural }: {
  label: string
  sortKey: string
  sort: string
  order: SortOrder
  onSort: (key: string, natural?: SortOrder) => void
  className?: string
  natural?: SortOrder
}) {
  const active = sort === sortKey
  return (
    <th className={`th ${className}`.trim()} aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(sortKey, natural)}
        className="inline-flex items-center gap-1 rounded uppercase hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        title={`Sort by ${label}`}
      >
        {label}
        <span aria-hidden="true" className={active ? 'text-slate-900' : 'text-slate-300'}>{active ? (order === 'asc' ? '▲' : '▼') : '⇅'}</span>
      </button>
    </th>
  )
}
