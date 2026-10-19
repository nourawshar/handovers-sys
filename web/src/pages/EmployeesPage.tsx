import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { useAssets, useDepartments, useEmployees, useRooms } from '@/api/hooks'
import { Link } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { useDebounce } from '@/lib/useDebounce'
import { Button, EmptyState, ErrorState, Input, PageHeader, Pagination, Select, Spinner, StatusBadge, TableWrap } from '@/components/ui'

/** Devices currently held by an employee, from GET /assets?holderId=… (loaded on demand). */
function Devices({ employeeId }: { employeeId: string }) {
  const { data, isLoading, isError } = useAssets({ holderId: employeeId, pageSize: 20 })
  if (isLoading) return <span className="text-xs text-slate-400">Loading…</span>
  if (isError) return <span className="text-xs text-red-600">Could not load devices</span>
  if (!data?.items.length) return <span className="text-xs text-slate-400">No devices</span>
  return (
    <div className="flex flex-wrap gap-1.5">
      {data.items.map((d) => (
        <Link key={d.id} to={`/assets/${d.id}`} className="rounded-md bg-brand-50 px-2 py-0.5 font-mono text-xs text-brand-800 hover:bg-brand-100" title={d.name}>{d.code}</Link>
      ))}
    </div>
  )
}

export default function EmployeesPage() {
  const user = useAuthStore((s) => s.user)
  const rooms = useRooms()
  const depts = useDepartments()
  const [q, setQ] = useState('')
  const [roomId, setRoomId] = useState('')
  const [departmentTeamId, setDept] = useState('')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const dq = useDebounce(q)
  useEffect(() => setPage(1), [dq, roomId, departmentTeamId])

  // Team leaders are scoped server-side (their room only); we hide the room filter for them.
  const leader = user?.role === 'TEAM_LEADER'
  const list = useEmployees({ q: dq || undefined, roomId: (!leader && roomId) || undefined, departmentTeamId: departmentTeamId || undefined, page, pageSize: 25 })

  return (
    <>
      <PageHeader title="Employees" subtitle={leader && user?.room ? `Employees in room ${user.room.code}` : 'Directory of staff and the devices they hold'} />
      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name…" className="pl-9" aria-label="Search employees" />
        </div>
        {!leader && (
          <Select value={roomId} onChange={(e) => setRoomId(e.target.value)} aria-label="Room">
            <option value="">All rooms</option>
            {rooms.data?.map((r) => <option key={r.id} value={r.id}>{r.code}</option>)}
          </Select>
        )}
        <Select value={departmentTeamId} onChange={(e) => setDept(e.target.value)} aria-label="Team">
          <option value="">All teams</option>
          {depts.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      </div>
      <div className="card overflow-hidden">
        {list.isLoading ? <Spinner /> : list.isError ? <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div> : !list.data?.items.length ? <EmptyState title="No employees found" /> : (
          <>
            <TableWrap>
              <thead className="bg-slate-50"><tr>
                <th className="th">Name</th><th className="th">Team</th><th className="th">Room</th><th className="th">Contact</th><th className="th">Status</th><th className="th">Devices</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.items.map((e) => (
                  <tr key={e.id} className="align-top hover:bg-slate-50">
                    <td className="td font-medium text-slate-900">{e.fullName}</td>
                    <td className="td">{e.departmentTeam?.name ?? '—'}</td>
                    <td className="td">{e.room?.code ?? '—'}</td>
                    <td className="td text-xs">{e.internalEmail ?? e.phoneContact ?? '—'}</td>
                    <td className="td"><StatusBadge value={e.status} /></td>
                    <td className="td">
                      {open.has(e.id)
                        ? <Devices employeeId={e.id} />
                        : <Button size="sm" variant="ghost" onClick={() => setOpen((s) => new Set(s).add(e.id))}>View devices</Button>}
                    </td>
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
