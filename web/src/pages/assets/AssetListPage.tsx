import { Link, useSearchParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { useAssets, useCategories, useEmployees } from '@/api/hooks'
import { CONDITIONS } from '@/api/types'
import { useAuthStore } from '@/store/auth'
import { can } from '@/lib/permissions'
import { useDebounce } from '@/lib/useDebounce'
import { titleCase } from '@/lib/utils'
import {
  Button, ConditionBadge, EmptyState, ErrorState, Input, PageHeader, Pagination, Select, Spinner, StatusBadge, TableWrap,
} from '@/components/ui'
import { ASSET_STATUSES } from '@/api/types'

const PAGE_SIZE = 25

export default function AssetListPage() {
  const user = useAuthStore((s) => s.user)
  const [sp, setSp] = useSearchParams()
  const categories = useCategories()
  const employees = useEmployees({ pageSize: 100 })

  const [q, setQ] = useState(sp.get('q') ?? '')
  const dq = useDebounce(q)
  const categoryId = sp.get('categoryId') ?? ''
  const condition = sp.get('condition') ?? ''
  const status = sp.get('status') ?? ''
  const holderId = sp.get('holderId') ?? ''
  const page = Number(sp.get('page') ?? 1)

  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k))
    if (!('page' in patch)) next.delete('page')
    setSp(next, { replace: true })
  }
  useEffect(() => {
    if (dq !== (sp.get('q') ?? '')) set({ q: dq })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq])

  const isImei = /^\d{6,17}$/.test(dq)
  const list = useAssets(
    {
      q: isImei ? undefined : dq || undefined,
      imei: isImei ? dq : undefined,
      categoryId: categoryId || undefined,
      condition: condition || undefined,
      status: status || undefined,
      holderId: holderId || undefined,
      page,
      pageSize: PAGE_SIZE,
    },
    categories.isSuccess,
  )
  const data = list.data

  return (
    <>
      <PageHeader
        title="Assets"
        subtitle="Every IT asset: search by code, IMEI, name, serial or holder"
        actions={can(user?.role, 'assets.new') && (
          <Link to="/assets/new"><Button><Plus className="h-4 w-4" /> New asset</Button></Link>
        )}
      />

      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code, IMEI, name, serial…" className="pl-9" aria-label="Search assets" />
        </div>
        <Select value={categoryId} onChange={(e) => set({ categoryId: e.target.value })} aria-label="Category">
          <option value="">All categories</option>
          {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.parentId ? '— ' : ''}{c.name}</option>)}
        </Select>
        <Select value={condition} onChange={(e) => set({ condition: e.target.value })} aria-label="Condition">
          <option value="">Any condition</option>
          {CONDITIONS.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
        </Select>
        <Select value={status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
          <option value="">Any status</option>
          {ASSET_STATUSES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
        </Select>
        <Select value={holderId} onChange={(e) => set({ holderId: e.target.value })} aria-label="Current holder">
          <option value="">Any holder</option>
          {employees.data?.items.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}
        </Select>
      </div>

      <div className="card overflow-hidden">
        {list.isLoading ? <Spinner /> : list.isError ? <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div> : !data?.items.length ? (
          <EmptyState title="No assets match your filters" hint="Try clearing the search or filters." />
        ) : (
          <>
            <TableWrap>
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Code</th><th className="th">Name</th><th className="th">Category</th>
                  <th className="th">IMEI / Serial</th><th className="th">Condition</th><th className="th">Status</th><th className="th">Holder</th><th className="th">View</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="td font-mono text-xs font-semibold"><Link to={`/assets/${a.id}`} className="text-brand-700 hover:underline">{a.code}</Link></td>
                    <td className="td">{a.name}{a.qty > 1 && <span className="ml-1 text-xs text-slate-400">×{a.qty}</span>}</td>
                    <td className="td">{a.category?.name ?? '—'}</td>
                    <td className="td font-mono text-xs">{a.imei ?? a.serialNumber ?? '—'}</td>
                    <td className="td"><ConditionBadge value={a.condition} /></td>
                    <td className="td"><StatusBadge value={a.status} /></td>
                    <td className="td">{a.currentHolder?.fullName ?? '—'}</td>
                    <td className="td"><Link to={`/assets/${a.id}`}><Button size="sm" variant="secondary">View</Button></Link></td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={(p) => set({ page: String(p) })} />
          </>
        )}
      </div>
    </>
  )
}
