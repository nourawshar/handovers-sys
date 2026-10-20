import { useEffect, useState } from 'react'
import { Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useAssets, useDeleteEmployee, useDepartments, useEmployees, useRooms, useSaveEmployee } from '@/api/hooks'
import type { DeleteEmployeeResult, EmployeeSavePayload } from '@/api/hooks'
import type { Employee } from '@/api/types'
import { Link } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { isAdmin } from '@/lib/permissions'
import { useDebounce } from '@/lib/useDebounce'
import { Button, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, Select, Spinner, StatusBadge, TableWrap, Textarea } from '@/components/ui'

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

/** Per-row delete button. The 409 (blocked) case is reported distinctly from a normal soft delete. */
function DeleteEmployeeButton({ employee, onMessage }: { employee: Employee; onMessage: (m: { kind: 'info' | 'warn'; text: string }) => void }) {
  const del = useDeleteEmployee(employee.id)
  const handle = async () => {
    if (!window.confirm(`Delete "${employee.fullName}"? If they have assignment history they will be soft-removed (status → Left).`)) return
    try {
      const res: DeleteEmployeeResult = await del.mutateAsync()
      onMessage(res.softDeleted
        ? { kind: 'info', text: `${employee.fullName} has assignment history and was soft-deleted (status set to Left).` }
        : { kind: 'info', text: `${employee.fullName} was permanently deleted.` })
    } catch (err) {
      const status = (err as { status?: number }).status
      onMessage(status === 409
        ? { kind: 'warn', text: `Cannot delete ${employee.fullName}: they are a room manager or still hold active assets. Reassign or archive them first.` }
        : { kind: 'warn', text: `Delete failed: ${(err as Error).message}` })
    }
  }
  return (
    <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={handle} loading={del.isPending} aria-label={`Delete ${employee.fullName}`}>
      <Trash2 className="h-4 w-4" />
    </Button>
  )
}

/** Create/edit modal. `employee` null → create; otherwise edit. `status` only applies when editing. */
function EmployeeFormModal({ employee, onClose }: { employee: Employee | null; onClose: () => void }) {
  const isEdit = !!employee
  const depts = useDepartments()
  const rooms = useRooms()

  const [roomId, setRoomId] = useState(employee?.roomId ?? '')
  const [departmentTeamId, setDept] = useState(employee?.departmentTeamId ?? '')

  const selectedDept = (depts.data ?? []).find((d) => d.id === departmentTeamId)
  // Filter rooms to match the chosen team type (Call-Center teams live in Call-Center rooms).
  const visibleRooms = (rooms.data ?? []).filter((r) => {
    if (!selectedDept) return r.id === roomId // keep the saved room selectable before a team is chosen
    const callCenter = selectedDept.type === 'CALLCENTER'
    const teamType = r.teamType ?? 'HOSPITAL'
    return callCenter ? teamType === 'CALLCENTER' : teamType !== 'CALLCENTER'
  })
  const effectiveRoomId = roomId === '' || visibleRooms.some((r) => r.id === roomId) ? roomId : ''
  useEffect(() => {
    if (roomId !== '' && !visibleRooms.some((r) => r.id === roomId)) setRoomId('')
  }, [departmentTeamId]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = useSaveEmployee(employee?.id)
  const [fullName, setFullName] = useState(employee?.fullName ?? '')
  const [phoneContact, setPhone] = useState(employee?.phoneContact ?? '')
  const [internalEmail, setEmail] = useState(employee?.internalEmail ?? '')
  const [notes, setNotes] = useState(employee?.notes ?? '')
  const [status, setStatus] = useState<string>(employee?.status ?? 'ACTIVE')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const name = fullName.trim()
    if (!name) { setError('Full name is required.'); return }
    if (!departmentTeamId) { setError('Please choose a team.'); return }
    const payload: EmployeeSavePayload = {
      fullName: name,
      departmentTeamId,
      roomId: effectiveRoomId || null,
      phoneContact: phoneContact.trim() || null,
      internalEmail: internalEmail.trim() || null,
      notes: notes.trim() || null,
      ...(isEdit ? { status: status || 'ACTIVE' } : {}),
    }
    try {
      await save.mutateAsync(payload)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-8" role="dialog" aria-modal aria-label={isEdit ? `Edit ${employee?.fullName}` : 'New employee'}>
      <form onSubmit={submit} className="card mt-4 w-full max-w-lg gap-4">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-900">{isEdit ? `Edit ${employee?.fullName}` : 'New employee'}</h2>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close">✕</Button>
        </div>
        <div className="grid gap-4 px-5 py-4">
          <Field label="Full name" required>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Staff member name" autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Team" required>
              <Select value={departmentTeamId} onChange={(e) => setDept(e.target.value)} aria-label="Team">
                <option value="">Select team…</option>
                {(depts.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </Field>
            <Field label="Room" hint={!selectedDept ? 'Appears once a team is chosen' : selectedDept.type === 'CALLCENTER' ? 'Call-Center room' : 'Hospital room'}>
              <Select value={effectiveRoomId} onChange={(e) => setRoomId(e.target.value)} aria-label="Room" disabled={!selectedDept}>
                <option value="">No room</option>
                {visibleRooms.map((r) => <option key={r.id} value={r.id}>{r.code}{r.teamType ? ` · ${r.teamType}` : ''}</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Phone contact">
              <Input value={phoneContact} onChange={(e) => setPhone(e.target.value)} placeholder="+90…" />
            </Field>
            <Field label="Internal email">
              <Input value={internalEmail} onChange={(e) => setEmail(e.target.value)} placeholder="name@clinic…" />
            </Field>
          </div>
          <Field label="Notes">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" />
          </Field>
          {isEdit && (
            <Field label="Status" hint="Status can only be changed when editing an existing employee.">
              <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
                <option value="ACTIVE">Active</option>
                <option value="ON_LEAVE">On leave</option>
                <option value="LEFT">Left</option>
              </Select>
            </Field>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
          {error && <p className="mr-auto text-xs text-red-600">{error}</p>}
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{isEdit ? 'Save changes' : 'Create employee'}</Button>
        </div>
      </form>
    </div>
  )
}

export default function EmployeesPage() {
  const user = useAuthStore((s) => s.user)
  const admin = isAdmin(user)
  const rooms = useRooms()
  const depts = useDepartments()
  const [q, setQ] = useState('')
  const [roomId, setRoomId] = useState('')
  const [departmentTeamId, setDept] = useState('')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [form, setForm] = useState<{ open: boolean; editing: Employee | null }>({ open: false, editing: null })
  const [deleteResult, setDeleteResult] = useState<{ kind: 'info' | 'warn'; text: string } | null>(null)
  const dq = useDebounce(q)
  useEffect(() => setPage(1), [dq, roomId, departmentTeamId])

  // Team leaders are scoped server-side (their room only); we hide the room filter for them.
  const leader = user?.role === 'TEAM_LEADER'
  const list = useEmployees({ q: dq || undefined, roomId: (!leader && roomId) || undefined, departmentTeamId: departmentTeamId || undefined, page, pageSize: 25 })

  return (
    <>
      <PageHeader
        title="Employees"
        subtitle={leader && user?.room ? `Employees in room ${user.room.code}` : 'Directory of staff and the devices they hold'}
        actions={admin ? <Button variant="primary" onClick={() => setForm({ open: true, editing: null })}><Plus className="h-4 w-4" />New employee</Button> : undefined}
      />
      {deleteResult && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-xs ${deleteResult.kind === 'warn' ? 'border-red-200 bg-red-50 text-red-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>
          {deleteResult.text}
          <button className="ml-auto text-slate-400 hover:text-slate-600" onClick={() => setDeleteResult(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
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
        {list.isLoading ? <Spinner /> : list.isError ? <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div> : !list.data?.items.length ? (
          <EmptyState title="No employees found" action={admin ? <Button variant="secondary" size="sm" onClick={() => setForm({ open: true, editing: null })}><Plus className="h-4 w-4" />New employee</Button> : undefined} />
        ) : (
          <>
            <TableWrap>
              <thead className="bg-slate-50"><tr>
                <th className="th">Name</th><th className="th">Team</th><th className="th">Room</th><th className="th">Contact</th><th className="th">Status</th><th className="th">Devices</th>
                {admin && <th className="th">Actions</th>}
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.items.map((e) => (
                  <tr key={e.id} className="align-top hover:bg-slate-50">
                    <td className="td">
                      <Link to={`/employees/${e.id}`} className="font-medium text-slate-900 hover:text-brand-700">{e.fullName}</Link>
                    </td>
                    <td className="td">{e.departmentTeam?.name ?? '—'}</td>
                    <td className="td">{e.room?.code ?? '—'}</td>
                    <td className="td text-xs">{e.internalEmail ?? e.phoneContact ?? '—'}</td>
                    <td className="td"><StatusBadge value={e.status} /></td>
                    <td className="td">
                      {open.has(e.id)
                        ? <Devices employeeId={e.id} />
                        : <Button size="sm" variant="ghost" onClick={() => setOpen((s) => new Set(s).add(e.id))}>View devices</Button>}
                    </td>
                    {admin && (
                      <td className="td">
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setForm({ open: true, editing: e })} aria-label={`Edit ${e.fullName}`}><Pencil className="h-4 w-4" /></Button>
                          <DeleteEmployeeButton employee={e} onMessage={setDeleteResult} />
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onChange={setPage} />
          </>
        )}
      </div>
      {form.open && <EmployeeFormModal employee={form.editing} onClose={() => setForm({ open: false, editing: null })} />}
    </>
  )
}