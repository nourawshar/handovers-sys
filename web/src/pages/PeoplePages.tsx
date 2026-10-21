import { Link } from 'react-router-dom'
import { useState } from 'react'
import { Pencil, Plus, X } from 'lucide-react'
import { useAssignments, useDeleteDepartment, useDeleteRoom, useDepartments, useEmployees, useRooms, useSaveDepartment, useSaveRoom } from '@/api/hooks'
import type { Department, Employee, Room } from '@/api/types'
import { ApiError } from '@/api/client'
import { useAuthStore } from '@/store/auth'
import { can, isAdmin } from '@/lib/permissions'
import { fmtDate, titleCase } from '@/lib/utils'
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, Select, Spinner, StatusBadge, TableWrap } from '@/components/ui'

export function AssignmentsPage() {
  const [status, setStatus] = useState('')
  const [type, setType] = useState('')
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const user = useAuthStore((s) => s.user)
  const list = useAssignments({
    status: status || undefined,
    type: type || undefined,
    q: search || undefined,
    page,
    pageSize: 25,
  })
  return (
    <>
      <PageHeader
        title="Assignments"
        subtitle="Device handovers and their lifecycle"
        actions={can(user?.role, 'assets.new') && (
          <>
            <Link to="/phones/assign"><Button><Plus className="h-4 w-4" /> Assign phone</Button></Link>
            <Link to="/assignments/new"><Button variant="secondary"><Plus className="h-4 w-4" /> Assign other asset</Button></Link>
          </>
        )}
      />
      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Search">
          <Input
            value={q}
            placeholder="Name, work name, SIM, IMEI, model, code…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setSearch(q.trim()); setPage(1) } }}
          />
        </Field>
        <Field label="Type">
          <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1) }} aria-label="Type">
            <option value="">Any type</option>
            {['PHONE', 'LAPTOP', 'PRINTER', 'SIM', 'COMPUTERS', 'MONITORS', 'MOUSE', 'KEYBOARDS', 'HEADPHONES', 'GENERAL'].map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} aria-label="Status">
            <option value="">Any status</option>
            {['DRAFT', 'ACTIVE', 'RETURNED', 'CLOSED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
        </Field>
        <div className="flex items-end gap-2">
          <Button variant="secondary" className="w-full" onClick={() => { setQ(''); setSearch(''); setStatus(''); setType(''); setPage(1) }}>Clear</Button>
        </div>
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

const TEAM_TYPES = ['CALLCENTER', 'HOSPITAL'] as const
type TeamType = (typeof TEAM_TYPES)[number]

/** Shared manager picker options (fetched once via React Query's cache). */
function managerOptions(employees: Employee[]) {
  return employees
    .slice()
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)
}

/** Create/edit modal (New room / Edit). Writes Admin-only in the caller. */
function RoomFormModal({ room, employees, onClose }: { room: Room | null; employees: Employee[]; onClose: () => void }) {
  const isEdit = !!room
  const save = useSaveRoom(room?.id)
  const [code, setCode] = useState(room?.code ?? '')
  const [teamType, setTeamType] = useState<TeamType>(room?.teamType === 'HOSPITAL' ? 'HOSPITAL' : 'CALLCENTER')
  const [managerEmployeeId, setManagerId] = useState(room?.managerEmployeeId ?? '')
  const [err, setErr] = useState<string | null>(null)

  const submit = () => {
    setErr(null)
    save.mutate(
      { code: code.trim(), teamType, managerEmployeeId: managerEmployeeId || null },
      { onError: (e) => setErr((e as Error).message), onSuccess: onClose },
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={isEdit ? `Edit room ${room?.code}` : 'New room'}>
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">{isEdit ? 'Edit room' : 'New room'}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"><X className="h-5 w-5" /></button>
        </div>
        <div className="grid gap-4">
          <Field label="Code" required>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. TR1" autoFocus />
          </Field>
          <Field label="Team type" required>
            <Select value={teamType} onChange={(e) => setTeamType(e.target.value as TeamType)} aria-label="Team type">
              {TEAM_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
            </Select>
          </Field>
          <Field label="Manager">
            <Select value={managerEmployeeId} onChange={(e) => setManagerId(e.target.value)} aria-label="Manager">
              <option value="">— No manager —</option>
              {managerOptions(employees)}
            </Select>
          </Field>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={save.isPending} disabled={!code.trim()}>{isEdit ? 'Save changes' : 'Create room'}</Button>
        </div>
      </div>
    </div>
  )
}

/** Quick inline manager setter on each card → PATCH managerEmployeeId. Admin-only in the caller. */
function SetManagerSelect({ room, employees }: { room: Room; employees: Employee[] }) {
  const save = useSaveRoom(room.id)
  const [err, setErr] = useState<string | null>(null)
  return (
    <div>
      <Select
        value={room.managerEmployeeId ?? ''}
        onChange={(e) => {
          setErr(null)
          save.mutate(
            { managerEmployeeId: e.target.value || null },
            { onError: (er) => setErr((er as Error).message) },
          )
        }}
        disabled={save.isPending}
        aria-label={`Set manager for ${room.code}`}
        className="text-xs"
      >
        <option value="">— No manager —</option>
        {managerOptions(employees)}
      </Select>
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
    </div>
  )
}

/** Delete with confirmation; surfaces a 409 (room still referenced) clearly. Admin-only caller. */
function DeleteRoomButton({ room }: { room: Room }) {
  const del = useDeleteRoom(room.id)
  const [err, setErr] = useState<string | null>(null)
  const confirm = () => {
    if (!window.confirm(`Delete room "${room.code}"?\n\nThis cannot be undone.`)) return
    setErr(null)
    del.mutate(undefined, {
      onError: (e) => {
        const status = (e as ApiError).status
        setErr(status === 409
          ? `Cannot delete "${room.code}" — it is still referenced by employees, work identities, users or assets.`
          : (e as Error).message)
      },
    })
  }
  return (
    <div>
      <Button size="sm" variant="danger" onClick={confirm} loading={del.isPending}>Delete</Button>
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
    </div>
  )
}

export function RoomsPage() {
  const user = useAuthStore((s) => s.user)
  const rooms = useRooms()
  const employees = useEmployees({ pageSize: 100 })
  // Reads stay MGR via the route (RequireRole access="rooms"); writes are Admin-only (people:write).
  const admin = isAdmin(user)
  const [form, setForm] = useState<Room | 'new' | null>(null)

  return (
    <>
      <PageHeader
        title="Rooms"
        subtitle="Call-center and hospital rooms and their managers"
        actions={admin && <Button onClick={() => setForm('new')}><Plus className="h-4 w-4" /> New room</Button>}
      />
      {admin && (
        <p className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
          Creating, editing, setting a manager and deleting rooms are Admin-only actions. Managers and team leaders can view rooms read-only.
        </p>
      )}
      {rooms.isLoading ? <Spinner /> : rooms.isError ? <ErrorState error={rooms.error} onRetry={() => rooms.refetch()} /> : !rooms.data?.length ? <div className="card"><EmptyState title="No rooms" hint="Admins can create a room with the New room button." /></div> : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {rooms.data.map((r) => (
            <div key={r.id} className="card flex flex-col gap-3 p-5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xl font-semibold text-slate-900">{r.code}</p>
                <Badge tone={r.teamType === 'HOSPITAL' ? 'blue' : 'violet'}>{titleCase(r.teamType ?? 'CALLCENTER')}</Badge>
              </div>
              <div className="text-sm">
                <p className="text-slate-500"><span className="font-medium text-slate-700">Manager:</span> {r.manager?.fullName ?? '—'}</p>
                {r.employeeCount !== undefined && <p className="mt-0.5 text-slate-500">{r.employeeCount} employees · {r.workIdentityCount ?? 0} identities</p>}
              </div>
              {admin && (
                <div className="mt-auto space-y-3 border-t border-slate-100 pt-3">
                  <div>
                    <p className="mb-1 text-xs font-medium text-slate-600">Set manager</p>
                    <SetManagerSelect room={r} employees={employees.data?.items ?? []} />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setForm(r)}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
                    <DeleteRoomButton room={r} />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {form && <RoomFormModal room={form === 'new' ? null : form} employees={employees.data?.items ?? []} onClose={() => setForm(null)} />}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Departments (BE-9) — grouped by type, Admin-only writes            */
/* ------------------------------------------------------------------ */

const DEPT_TYPES = ['CALLCENTER', 'HOSPITAL'] as const
type DeptType = (typeof DEPT_TYPES)[number]

/** Create/edit modal (New department / Edit). Writes Admin-only in the caller. */
function DepartmentFormModal({ dept, departments, onClose }: { dept: Department | null; departments: Department[]; onClose: () => void }) {
  const isEdit = !!dept
  const save = useSaveDepartment(dept?.id)
  const [name, setName] = useState(dept?.name ?? '')
  const [type, setType] = useState<DeptType>(dept?.type === 'HOSPITAL' ? 'HOSPITAL' : 'CALLCENTER')
  const [parentId, setParentId] = useState(dept?.parentId ?? '')
  const [sortOrder, setSortOrder] = useState(dept?.sortOrder != null ? String(dept.sortOrder) : '')
  const [err, setErr] = useState<string | null>(null)

  // Parent options exclude the department itself (self-parent is rejected server-side anyway).
  const parentOptions = departments.filter((d) => d.id !== dept?.id)

  const submit = () => {
    setErr(null)
    save.mutate(
      {
        name: name.trim(),
        type,
        parentId: parentId || null,
        sortOrder: sortOrder === '' ? undefined : Number(sortOrder),
      },
      { onError: (e) => setErr((e as Error).message), onSuccess: onClose },
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={isEdit ? `Edit department ${dept?.name}` : 'New department'}>
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">{isEdit ? 'Edit department' : 'New department'}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"><X className="h-5 w-5" /></button>
        </div>
        <div className="grid gap-4">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Reception" autoFocus />
          </Field>
          <Field label="Type" required>
            <Select value={type} onChange={(e) => setType(e.target.value as DeptType)} aria-label="Type">
              {DEPT_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
            </Select>
          </Field>
          <Field label="Parent department">
            <Select value={parentId} onChange={(e) => setParentId(e.target.value)} aria-label="Parent department">
              <option value="">— No parent —</option>
              {parentOptions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>
          <Field label="Sort order">
            <Input type="number" min={0} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} placeholder="0" />
          </Field>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={save.isPending} disabled={!name.trim()}>{isEdit ? 'Save changes' : 'Create department'}</Button>
        </div>
      </div>
    </div>
  )
}

/** Delete with confirmation; surfaces a 409 (department still referenced) clearly. Admin-only caller. */
function DeleteDepartmentButton({ dept }: { dept: Department }) {
  const del = useDeleteDepartment(dept.id)
  const [err, setErr] = useState<string | null>(null)
  const confirm = () => {
    if (!window.confirm(`Delete department "${dept.name}"?\n\nThis cannot be undone.`)) return
    setErr(null)
    del.mutate(undefined, {
      onError: (e) => {
        const status = (e as ApiError).status
        setErr(status === 409
          ? `Cannot delete "${dept.name}" — it is still referenced by an employee, work identity, or child department.`
          : (e as Error).message)
      },
    })
  }
  return (
    <div>
      <Button size="sm" variant="danger" onClick={confirm} loading={del.isPending}>Delete</Button>
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
    </div>
  )
}

export function DepartmentsPage() {
  const user = useAuthStore((s) => s.user)
  const departments = useDepartments()
  // Reads stay open to ALL via the route (RequireRole access="departments"); writes are Admin-only (people:write).
  const admin = isAdmin(user)
  const [form, setForm] = useState<Department | 'new' | null>(null)

  const depts = departments.data ?? []
  const byType = (t: string) => depts.filter((d) => (d.type ?? 'CALLCENTER') === t)

  return (
    <>
      <PageHeader
        title="Departments"
        subtitle="Call-center and hospital departments"
        actions={admin && <Button onClick={() => setForm('new')}><Plus className="h-4 w-4" /> New department</Button>}
      />
      {admin && (
        <p className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
          Creating, editing and deleting departments are Admin-only actions. Managers and team leaders can view departments read-only.
        </p>
      )}
      {departments.isLoading ? <Spinner /> : departments.isError ? <ErrorState error={departments.error} onRetry={() => departments.refetch()} /> : !depts.length ? <div className="card"><EmptyState title="No departments" hint="Admins can create a department with the New department button." /></div> : (
        <div className="space-y-6">
          {DEPT_TYPES.map((t) => {
            const list = byType(t)
            if (!list.length) return null
            return (
              <section key={t}>
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{titleCase(t)}</h2>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((d) => (
                    <div key={d.id} className="card flex flex-col gap-3 p-5">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-lg font-semibold text-slate-900">{d.name}</p>
                        <Badge tone={d.type === 'HOSPITAL' ? 'blue' : 'violet'}>{titleCase(d.type ?? 'CALLCENTER')}</Badge>
                      </div>
                      <div className="text-sm">
                        {d.parent && <p className="text-slate-500"><span className="font-medium text-slate-700">Parent:</span> {d.parent.name}</p>}
                        <p className="text-slate-500"><span className="font-medium text-slate-700">Sort order:</span> {d.sortOrder ?? 0}</p>
                        <p className="mt-0.5 text-slate-500">{d.employeeCount ?? 0} employees · {d.workIdentityCount ?? 0} identities{d.childCount ? ` · ${d.childCount} sub-departments` : ''}</p>
                      </div>
                      {admin && (
                        <div className="mt-auto flex gap-2 border-t border-slate-100 pt-3">
                          <Button size="sm" variant="secondary" onClick={() => setForm(d)}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
                          <DeleteDepartmentButton dept={d} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
      {form && <DepartmentFormModal dept={form === 'new' ? null : form} departments={depts} onClose={() => setForm(null)} />}
    </>
  )
}
