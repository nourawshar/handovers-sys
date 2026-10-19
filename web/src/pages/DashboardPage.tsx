import { Link } from 'react-router-dom'
import { Boxes, ClipboardList, KeyRound, Plus, Smartphone, Users, type LucideIcon } from 'lucide-react'
import { useAccounts, useAssets, useEmployees } from '@/api/hooks'
import { useAuthStore } from '@/store/auth'
import { can, type RouteKey } from '@/lib/permissions'
import { PageHeader, ConditionBadge, StatusBadge, Spinner } from '@/components/ui'

function Stat({ label, value, icon: Icon, to, loading, error }: { label: string; value?: number; icon: LucideIcon; to: string; loading: boolean; error: boolean }) {
  return (
    <Link to={to} className="card flex items-center gap-4 p-5 transition hover:border-brand-300 hover:shadow-md">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-700"><Icon className="h-5 w-5" /></div>
      <div>
        <p className="text-2xl font-semibold text-slate-900">{loading ? '…' : error ? '—' : value}</p>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      </div>
    </Link>
  )
}

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user)
  const role = user?.role
  const assets = useAssets({ pageSize: 8 })
  const available = useAssets({ status: 'AVAILABLE', pageSize: 1 })
  const assigned = useAssets({ status: 'ASSIGNED', pageSize: 1 })
  const employees = useEmployees({ pageSize: 1 })
  const accountsAllowed = can(role, 'accounts')
  const accounts = useAccounts({ pageSize: 1 }, accountsAllowed)

  const actions: { to: string; label: string; icon: LucideIcon; access: RouteKey }[] = [
    { to: '/assets/new', label: 'Register asset', icon: Plus, access: 'assets.new' },
    { to: '/assets', label: 'Browse assets', icon: Boxes, access: 'assets' },
    { to: '/phones', label: 'Phones by IMEI', icon: Smartphone, access: 'phones' },
    { to: '/employees', label: 'Employee directory', icon: Users, access: 'employees' },
  ]

  return (
    <>
      <PageHeader title={`Welcome, ${user?.fullName?.split(' ')[0] ?? ''}`} subtitle={role === 'TEAM_LEADER' && user?.room ? `Showing data for room ${user.room.code}` : 'Overview of the clinic group’s IT inventory'} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total assets" value={assets.data?.total} icon={Boxes} to="/assets" loading={assets.isLoading} error={assets.isError} />
        <Stat label="Available" value={available.data?.total} icon={Boxes} to="/assets?status=AVAILABLE" loading={available.isLoading} error={available.isError} />
        <Stat label="Assigned" value={assigned.data?.total} icon={ClipboardList} to="/assignments" loading={assigned.isLoading} error={assigned.isError} />
        <Stat label="Employees" value={employees.data?.total} icon={Users} to="/employees" loading={employees.isLoading} error={employees.isError} />
        {accountsAllowed && <Stat label="Accounts" value={accounts.data?.total} icon={KeyRound} to="/accounts" loading={accounts.isLoading} error={accounts.isError} />}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Recent assets</h2>
            <Link to="/assets" className="text-xs font-medium text-brand-700 hover:underline">View all</Link>
          </div>
          {assets.isLoading ? <Spinner /> : assets.isError ? <p className="p-5 text-sm text-slate-500">{(assets.error as Error).message}</p> : (
            <ul className="divide-y divide-slate-100">
              {assets.data?.items.map((a) => (
                <li key={a.id}>
                  <Link to={`/assets/${a.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 hover:bg-slate-50">
                    <div><p className="text-sm font-medium text-slate-900">{a.name}</p><p className="font-mono text-xs text-slate-500">{a.code}</p></div>
                    <div className="flex gap-2"><ConditionBadge value={a.condition} /><StatusBadge value={a.status} /></div>
                  </Link>
                </li>
              ))}
              {!assets.data?.items.length && <li className="p-5 text-sm text-slate-500">No assets registered yet.</li>}
            </ul>
          )}
        </div>
        <div className="card p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Quick actions</h2>
          <div className="space-y-2">
            {actions.filter((a) => can(role, a.access)).map((a) => (
              <Link key={a.to} to={a.to} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700 transition hover:border-brand-300 hover:bg-brand-50">
                <a.icon className="h-4 w-4 text-brand-700" /> {a.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
