import { useEffect, useState } from 'react'
import { KeyRound, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useDeleteUser, useResetUserPassword, useRooms, useSaveUser, useUsers } from '@/api/hooks'
import type { UserSavePayload } from '@/api/types'
import type { User } from '@/api/types'
import type { Role } from '@/api/types'
import { useAuthStore } from '@/store/auth'
import { ROLE_LABEL } from '@/lib/permissions'
import { useDebounce } from '@/lib/useDebounce'
import { fmtDate } from '@/lib/utils'
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, Select, Spinner, TableWrap } from '@/components/ui'

const ROLES: Role[] = ['ADMIN', 'MANAGER', 'TEAM_LEADER', 'CALL_CENTER_MANAGER']

/** Create/edit modal. `user` null → create; otherwise edit (username + password are create-only). */
function UserFormModal({ user, onClose, currentUserId }: { user: User | null; onClose: () => void; currentUserId?: string }) {
  const isEdit = !!user
  const save = useSaveUser(user?.id)
  const rooms = useRooms()
  const isSelf = isEdit && user.id === currentUserId

  const [username, setUsername] = useState(user?.username ?? '')
  const [fullName, setFullName] = useState(user?.fullName ?? '')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>(user?.role ?? 'MANAGER')
  const [roomId, setRoomId] = useState(user?.roomId ?? '')
  const [isActive, setIsActive] = useState(user?.isActive ?? true)
  const [error, setError] = useState<string | null>(null)

  const needsRoom = role === 'TEAM_LEADER'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!fullName.trim()) { setError('Full name is required.'); return }
    if (needsRoom && !roomId) { setError('Room is required for a Team Leader.'); return }
    if (!isEdit && !password) { setError('Password is required on create.'); return }
    if (!isEdit && password.length < 10) { setError('Password must be at least 10 characters.'); return }
    const payload: UserSavePayload = {
      fullName: fullName.trim(),
      role,
      ...(needsRoom ? { roomId } : {}),
      ...(isEdit ? { isActive } : {}),
    }
    if (!isEdit) {
      payload.username = username.trim()
      payload.password = password
    }
    try {
      await save.mutateAsync(payload)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-8" role="dialog" aria-modal aria-label={isEdit ? `Edit ${user?.fullName}` : 'New user'}>
      <form onSubmit={submit} className="card mt-4 w-full max-w-lg gap-4">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-900">{isEdit ? `Edit ${user?.fullName}` : 'New user'}</h2>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close">✕</Button>
        </div>
        <div className="grid gap-4 px-5 py-4">
          {isEdit ? (
            <Field label="Username" hint="Usernames cannot be changed after creation.">
              <Input value={user.username} disabled className="bg-slate-50 font-mono text-xs" />
            </Field>
          ) : (
            <Field label="Username" required hint="Letters, digits, dots, dashes and underscores only.">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. jane.doe" autoFocus />
            </Field>
          )}
          <Field label="Full name" required>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Staff member name" />
          </Field>
          <Field label="Role" required hint={isSelf ? 'You cannot change your own role.' : undefined}>
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role" disabled={isSelf}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </Select>
          </Field>
          <Field
            label="Room"
            required={needsRoom}
            hint={needsRoom ? 'Team Leaders are scoped to their room.' : 'Only Team Leaders are assigned to a room.'}
          >
            <Select value={roomId} onChange={(e) => setRoomId(e.target.value)} aria-label="Room" disabled={!needsRoom}>
              <option value="">{needsRoom ? 'Select room…' : 'No room'}</option>
              {rooms.data?.map((r) => <option key={r.id} value={r.id}>{r.code}{r.teamType ? ` · ${r.teamType}` : ''}</option>)}
            </Select>
          </Field>
          {isEdit ? (
            <Field label="Active" hint={isSelf ? 'You cannot deactivate your own account.' : undefined}>
              <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
                <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600" checked={isActive} disabled={isSelf} onChange={(e) => setIsActive(e.target.checked)} />
                User can sign in
              </label>
            </Field>
          ) : (
            <Field label="Password" required hint="At least 10 characters. The user must use it on first login.">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••" />
            </Field>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
          {error && <p className="mr-auto text-xs text-red-600">{error}</p>}
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{isEdit ? 'Save changes' : 'Create user'}</Button>
        </div>
      </form>
    </div>
  )
}

/** Single password field → PATCH /users/:id/password (revokes the user's sessions server-side). */
function ResetPasswordModal({ user, onClose }: { user: User; onClose: () => void }) {
  const reset = useResetUserPassword(user.id)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password.length < 10) { setError('Password must be at least 10 characters.'); return }
    try {
      await reset.mutateAsync(password)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-8" role="dialog" aria-modal aria-label={`Reset password for ${user.fullName}`}>
      <form onSubmit={submit} className="card mt-4 w-full max-w-md gap-4">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-900">Reset password</h2>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close">✕</Button>
        </div>
        <div className="grid gap-4 px-5 py-4">
          <p className="text-sm text-slate-600">Set a new password for <b>{user.fullName}</b>. All of their active sessions will be signed out.</p>
          <Field label="New password" required hint="At least 10 characters.">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••" autoFocus />
          </Field>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
          {error && <p className="mr-auto text-xs text-red-600">{error}</p>}
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={reset.isPending}>Set password</Button>
        </div>
      </form>
    </div>
  )
}

/** Delete (deactivate) with confirmation. The 409 (self-deactivate guard) is surfaced distinctly. */
function DeleteUserButton({ user, currentUserId, onMessage }: { user: User; currentUserId?: string; onMessage: (m: { kind: 'info' | 'warn'; text: string }) => void }) {
  const del = useDeleteUser(user.id)
  const isSelf = user.id === currentUserId
  const handle = async () => {
    if (isSelf) { onMessage({ kind: 'warn', text: 'You cannot delete (deactivate) your own account.' }); return }
    if (!window.confirm(`Deactivate "${user.fullName}"? Their account is soft-deleted (inactive), all sessions are revoked, and audit history is kept.`)) return
    try {
      await del.mutateAsync()
      onMessage({ kind: 'info', text: `${user.fullName} was deactivated (account disabled and sessions revoked).` })
    } catch (err) {
      const status = (err as { status?: number }).status
      onMessage(status === 409
        ? { kind: 'warn', text: `Cannot deactivate ${user.fullName}: you cannot deactivate or demote your own account.` }
        : { kind: 'warn', text: `Deactivate failed: ${(err as Error).message}` })
    }
  }
  return (
    <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={handle} loading={del.isPending} disabled={isSelf} aria-label={`Delete ${user.fullName}`}>
      <Trash2 className="h-4 w-4" />
    </Button>
  )
}

export default function UsersSettingsPage() {
  const currentUser = useAuthStore((s) => s.user)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const dq = useDebounce(q)
  useEffect(() => setPage(1), [dq])
  const list = useUsers({ q: dq || undefined, page, pageSize: 25 })

  const [form, setForm] = useState<User | 'new' | null>(null)
  const [resetUser, setResetUser] = useState<User | null>(null)
  const [message, setMessage] = useState<{ kind: 'info' | 'warn'; text: string } | null>(null)

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="System accounts and roles. Creating, editing, resetting passwords and deleting are Admin-only."
        actions={<Button variant="primary" onClick={() => setForm('new')}><Plus className="h-4 w-4" /> New user</Button>}
      />
      {message && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-xs ${message.kind === 'warn' ? 'border-red-200 bg-red-50 text-red-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>
          {message.text}
          <button className="ml-auto text-slate-400 hover:text-slate-600" onClick={() => setMessage(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-3">
        <div className="relative sm:col-span-2">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users by name or username…" className="pl-9" aria-label="Search users" />
        </div>
      </div>
      <div className="card overflow-hidden">
        {list.isLoading ? <Spinner /> : list.isError ? (
          <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div>
        ) : !list.data?.items.length ? (
          <EmptyState title="No users found" action={<Button variant="secondary" size="sm" onClick={() => setForm('new')}><Plus className="h-4 w-4" /> New user</Button>} />
        ) : (
          <>
            <TableWrap>
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Name</th><th className="th">Username</th><th className="th">Role</th>
                  <th className="th">Room</th><th className="th">Status</th><th className="th">Last login</th><th className="th">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.items.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50">
                    <td className="td font-medium text-slate-900">{u.fullName}{u.id === currentUser?.id && <span className="ml-1 text-xs text-slate-400">(you)</span>}</td>
                    <td className="td font-mono text-xs">{u.username}</td>
                    <td className="td"><Badge tone="blue">{ROLE_LABEL[u.role] ?? u.role}</Badge></td>
                    <td className="td">{u.room?.code ?? '—'}</td>
                    <td className="td">{u.isActive === false ? <Badge>Inactive</Badge> : <Badge tone="green">Active</Badge>}</td>
                    <td className="td">{fmtDate(u.lastLoginAt, true)}</td>
                    <td className="td">
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setForm(u)} aria-label={`Edit ${u.fullName}`}><Pencil className="h-4 w-4" /></Button>
                        <Button size="sm" variant="ghost" onClick={() => setResetUser(u)} aria-label={`Reset password for ${u.fullName}`} title="Reset password"><KeyRound className="h-4 w-4" /></Button>
                        <DeleteUserButton user={u} currentUserId={currentUser?.id} onMessage={setMessage} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onChange={setPage} />
          </>
        )}
      </div>
      {form && <UserFormModal user={form === 'new' ? null : form} onClose={() => setForm(null)} currentUserId={currentUser?.id} />}
      {resetUser && <ResetPasswordModal user={resetUser} onClose={() => setResetUser(null)} />}
    </>
  )
}
