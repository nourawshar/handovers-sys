import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Plus, Pencil, Search, Trash2 } from 'lucide-react'
import { useAssets, useCategories, useDeleteAsset, useEmployees } from '@/api/hooks'
import type { DeleteAssetResult } from '@/api/hooks'
import { CONDITIONS, type Asset } from '@/api/types'
import { useAuthStore } from '@/store/auth'
import { can } from '@/lib/permissions'
import { useDebounce } from '@/lib/useDebounce'
import { titleCase } from '@/lib/utils'
import {
  Button, ConditionBadge, EmptyState, ErrorState, Input, PageHeader, Pagination, SearchableSelect, Select, Spinner, StatusBadge, TableWrap,
} from '@/components/ui'
import { ASSET_STATUSES } from '@/api/types'

const PAGE_SIZE = 25

/** Per-row delete button. The 409 (active assignment) case is reported distinctly from a normal delete. */
function DeleteAssetButton({ asset, onMessage }: { asset: Asset; onMessage: (m: { kind: 'info' | 'warn'; text: string }) => void }) {
  const del = useDeleteAsset(asset.id)
  const handle = async () => {
    if (!window.confirm(`Delete "${asset.name}" (${asset.code})?\n\nIf it has assignment history it will be soft-disposed (status → Disposed) so history is preserved. This cannot be undone.`)) return
    try {
      const res: DeleteAssetResult = await del.mutateAsync()
      onMessage(res.softDeleted
        ? { kind: 'info', text: `${asset.code} had history and was soft-deleted (status → Disposed).` }
        : { kind: 'info', text: `${asset.code} was permanently deleted.` })
    } catch (err) {
      const status = (err as { status?: number }).status
      onMessage(status === 409
        ? { kind: 'warn', text: `Cannot delete ${asset.code} — it is part of an active assignment; return it first.` }
        : { kind: 'warn', text: `Delete failed: ${(err as Error).message}` })
    }
  }
  return (
    <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={handle} loading={del.isPending} aria-label={`Delete ${asset.code}`}>
      <Trash2 className="h-4 w-4" />
    </Button>
  )
}

export default function AssetListPage() {
  const user = useAuthStore((s) => s.user)
  const location = useLocation()
  const nav = useNavigate()
  const [banner, setBanner] = useState<{ kind: 'info' | 'warn'; text: string } | null>(null)
  useEffect(() => {
    // Carry the delete outcome banner across navigation from the asset detail page.
    const notice = (location.state as { notice?: { kind: 'info' | 'warn'; text: string } } | null)?.notice
    if (notice) {
      setBanner(notice)
      nav(location.pathname + location.search, { replace: true, state: undefined })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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
  const isAdmin = can(user?.role, 'assets.edit')

  return (
    <>
      <PageHeader
        title="Assets"
        subtitle="Every IT asset: search by code, IMEI, name, serial or holder"
        actions={can(user?.role, 'assets.new') && (
          <Link to="/assets/new"><Button><Plus className="h-4 w-4" /> New asset</Button></Link>
        )}
      />
      {banner && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-xs ${banner.kind === 'warn' ? 'border-red-200 bg-red-50 text-red-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>
          {banner.text}
          <button className="ml-auto text-slate-400 hover:text-slate-600" onClick={() => setBanner(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      <div className="card mb-4 grid items-start gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code, IMEI, name, serial…" className="pl-9" aria-label="Search assets" />
        </div>
        <SearchableSelect
          options={(categories.data ?? []).map((c) => ({ value: c.id, label: `${c.parentId ? '— ' : ''}${c.name}` }))}
          value={categoryId}
          onChange={(v) => set({ categoryId: v })}
          placeholder="Type to filter categories…"
          selectPlaceholder="All categories"
        />
        <Select value={condition} onChange={(e) => set({ condition: e.target.value })} aria-label="Condition">
          <option value="">Any condition</option>
          {CONDITIONS.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
        </Select>
        <Select value={status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
          <option value="">Any status</option>
          {ASSET_STATUSES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
        </Select>
        <SearchableSelect
          options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: e.fullName }))}
          value={holderId}
          onChange={(v) => set({ holderId: v })}
          placeholder="Type to filter holders…"
          selectPlaceholder="Any holder"
        />
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
                  <th className="th">IMEI / Serial</th><th className="th">Condition</th><th className="th">Status</th><th className="th">Holder</th><th className="th">View</th>{isAdmin && <th className="th">Actions</th>}
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
                    {isAdmin && (
                      <td className="td">
                        <div className="flex gap-1">
                          <Link to={`/assets/${a.id}/edit`}><Button size="sm" variant="ghost" aria-label={`Edit ${a.code}`}><Pencil className="h-4 w-4" /></Button></Link>
                          <DeleteAssetButton asset={a} onMessage={setBanner} />
                        </div>
                      </td>
                    )}
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
