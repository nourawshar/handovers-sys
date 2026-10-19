import { Link } from 'react-router-dom'
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useAssignments, useRooms, useWorkIdentities } from '@/api/hooks'
import { useAuthStore } from '@/store/auth'
import { can } from '@/lib/permissions'
import { fmtDate, titleCase } from '@/lib/utils'
import { Badge, Button, EmptyState, ErrorState, PageHeader, Pagination, Select, Spinner, StatusBadge, TableWrap } from '@/components/ui'

export function AssignmentsPage() {
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const user = useAuthStore((s) => s.user)
  const list = useAssignments({ status: status || undefined, page, pageSize: 25 })
  return (
    <>
      <PageHeader
        title="Assignments"
        subtitle="Device handovers and their lifecycle"
        actions={can(user?.role, 'assets.new') && (
          <Link to="/phones/assign"><Button><Plus className="h-4 w-4" /> Assign phone</Button></Link>
        )}
      />
      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-3">
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} aria-label="Status">
          <option value="">Any status</option>
          {['DRAFT', 'ACTIVE', 'RETURNED', 'CLOSED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </Select>
      </div>
      <div className="card overflow-hidden">
        {list.isLoading ? <Spinner /> : list.isError && (list.error as { status?: number }).status === 404 ? (
          <EmptyState title="Assignments are coming in Phase 2" hint="The backend endpoint (GET /assignments) is not available yet." />
        ) : list.isError ? <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div> : !list.data?.items.length ? <EmptyState title="No assignments yet" hint="The phone assignment wizard arrives in Phase 2." /> : (
          <>
            <TableWrap>
              <thead className="bg-slate-50"><tr>
                <th className="th">Code</th><th className="th">Type</th><th className="th">Employee</th><th className="th">Identity</th><th className="th">Asset</th><th className="th">Assigned</th><th className="th">Due</th><th className="th">Status</th><th className="th">View</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.items.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="td font-mono text-xs font-semibold"><Link to={`/assignments/${a.id}`} className="text-brand-700 hover:underline">{a.assignmentCode}</Link></td>
                    <td className="td">{titleCase(a.type)}</td>
                    <td className="td">{a.employee?.fullName ?? '—'}</td>
                    <td className="td">{a.workIdentity?.name ?? '—'}</td>
                    <td className="td">{a.asset ? <Link to={`/assets/${a.asset.id}`} className="text-brand-700 hover:underline">{a.asset.code}</Link> : '—'}</td>
                    <td className="td">{fmtDate(a.assignedAt)}</td>
                    <td className="td">{fmtDate(a.expectedReturnAt)}</td>
                    <td className="td"><StatusBadge value={a.status} /></td>
                    <td className="td"><Link to={`/assignments/${a.id}`}><Button size="sm" variant="secondary">View</Button></Link></td>
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

export function RoomsPage() {
  const rooms = useRooms()
  return (
    <>
      <PageHeader title="Rooms" subtitle="Call-center rooms and their managers" />
      {rooms.isLoading ? <Spinner /> : rooms.isError ? <ErrorState error={rooms.error} onRetry={() => rooms.refetch()} /> : !rooms.data?.length ? <div className="card"><EmptyState title="No rooms" /></div> : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {rooms.data.map((r) => (
            <div key={r.id} className="card p-5">
              <p className="text-xl font-semibold text-slate-900">{r.code}</p>
              <p className="mt-1 text-sm text-slate-500">Manager: {r.manager?.fullName ?? '—'}</p>
              {r.employeeCount !== undefined && <p className="mt-0.5 text-sm text-slate-500">{r.employeeCount} employees · {r.workIdentityCount ?? 0} identities</p>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

export function WorkIdentitiesPage() {
  const list = useWorkIdentities()
  return (
    <>
      <PageHeader title="Work identities" subtitle="Seat labels attached to phones during an assignment" />
      <div className="card overflow-hidden">
        {list.isLoading ? <Spinner /> : list.isError ? <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div> : !list.data?.items.length ? <EmptyState title="No work identities" /> : (
          <TableWrap>
            <thead className="bg-slate-50"><tr><th className="th">Name</th><th className="th">Room</th><th className="th">Status</th><th className="th">Notes</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.items.map((w) => (
                <tr key={w.id} className="hover:bg-slate-50">
                  <td className="td font-medium text-slate-900">{w.name}</td>
                  <td className="td">{w.room?.code ?? '—'}</td>
                  <td className="td">{w.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                  <td className="td">{w.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </div>
    </>
  )
}
