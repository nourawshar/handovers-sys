import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { useAuditLogs, useUsers } from '@/api/hooks'
import type { AuditLogEntry } from '@/api/types'
import { useDebounce } from '@/lib/useDebounce'
import { fmtDate, titleCase } from '@/lib/utils'
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, Select, Spinner, TableWrap } from '@/components/ui'

const PAGE_SIZE = 25

/** Collapsible JSON "meta" cell — stays unstyled/pre so deep payloads are readable. */
function MetaCell({ entry }: { entry: AuditLogEntry }) {
  const [open, setOpen] = useState(false)
  if (entry.meta) {
    return (
      <>
        <Button size="sm" variant="ghost" className="text-xs text-brand-700" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'} meta
        </Button>
        {open && <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] text-slate-100">{JSON.stringify(entry.meta, null, 2)}</pre>}
      </>
    )
  }
  return <span className="text-slate-400">—</span>
}

export default function LogsPage() {
  const [actorId, setActorId] = useState('')
  const [action, setAction] = useState('')
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)

  const dAction = useDebounce(action)
  const dQ = useDebounce(q)
  useEffect(() => setPage(1), [actorId, dAction, dQ, from, to])

  // Actor dropdown is built from the (ADMIN-only) users list.
  const users = useUsers({ pageSize: 100 })
  const list = useAuditLogs({
    actorId: actorId || undefined,
    action: dAction || undefined,
    q: dQ || undefined,
    from: from || undefined,
    to: to || undefined,
    page,
    pageSize: PAGE_SIZE,
  })

  return (
    <>
      <PageHeader
        title="Logs"
        subtitle="Audit trail of who did what, when and from where (Admin only)"
      />
      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search action/target…" className="pl-9" aria-label="Search logs" />
        </div>
        <Select value={actorId} onChange={(e) => setActorId(e.target.value)} aria-label="Actor">
          <option value="">All actors</option>
          {users.data?.items.map((u) => <option key={u.id} value={u.id}>{u.fullName} (@{u.username})</option>)}
        </Select>
        <Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="Action, e.g. asset.create" aria-label="Filter by action" />
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        </Field>
      </div>

      <div className="card overflow-hidden">
        {list.isLoading ? <Spinner /> : list.isError ? (
          <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div>
        ) : !list.data?.items.length ? (
          <EmptyState title="No log entries match your filters" hint="Try clearing the search or widening the date range." />
        ) : (
          <>
            <TableWrap>
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Date</th><th className="th">Actor</th><th className="th">Action</th>
                  <th className="th">Target</th><th className="th">Meta</th><th className="th">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.items.map((e) => (
                  <tr key={e.id} className="align-top hover:bg-slate-50">
                    <td className="td whitespace-nowrap text-xs">{fmtDate(e.createdAt, true)}</td>
                    <td className="td">
                      {e.actor
                        ? <><div className="font-medium text-slate-900">{e.actor.fullName}</div><div className="font-mono text-xs text-slate-400">@{e.actor.username}</div></>
                        : <span className="text-slate-400">System / deleted</span>}
                    </td>
                    <td className="td"><Badge tone="blue">{titleCase(e.action)}</Badge></td>
                    <td className="td text-xs">
                      {e.targetType && <div className="text-slate-700">{titleCase(e.targetType)}</div>}
                      {e.targetId && <div className="font-mono text-slate-400">{e.targetId.slice(0, 8)}…</div>}
                    </td>
                    <td className="td"><MetaCell entry={e} /></td>
                    <td className="td font-mono text-xs text-slate-500">{e.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onChange={setPage} />
          </>
        )}
      </div>
    </>
  )
}
