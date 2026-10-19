import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { normList, normUser } from '@/api/normalize'
import { ROLE_LABEL } from '@/lib/permissions'
import { fmtDate } from '@/lib/utils'
import { Badge, EmptyState, ErrorState, PageHeader, Spinner, TableWrap } from '@/components/ui'

/** Read-only user list (GET /users). Create/edit/reset-password UI is a follow-up. */
export default function UsersSettingsPage() {
  const q = useQuery({ queryKey: ['users'], queryFn: async () => normList(await api.get('/users'), normUser) })
  return (
    <>
      <PageHeader title="Users" subtitle="System accounts and roles (read-only view; management coming next)" />
      <div className="card overflow-hidden">
        {q.isLoading ? <Spinner /> : q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div> : !q.data?.items.length ? <EmptyState title="No users" /> : (
          <TableWrap>
            <thead className="bg-slate-50"><tr><th className="th">Name</th><th className="th">Username</th><th className="th">Role</th><th className="th">Room</th><th className="th">Status</th><th className="th">Last login</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {q.data.items.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50">
                  <td className="td font-medium text-slate-900">{u.fullName}</td>
                  <td className="td font-mono text-xs">{u.username}</td>
                  <td className="td"><Badge tone="blue">{ROLE_LABEL[u.role] ?? u.role}</Badge></td>
                  <td className="td">{u.room?.code ?? '—'}</td>
                  <td className="td">{u.isActive === false ? <Badge>Inactive</Badge> : <Badge tone="green">Active</Badge>}</td>
                  <td className="td">{fmtDate(u.lastLoginAt, true)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </div>
    </>
  )
}
