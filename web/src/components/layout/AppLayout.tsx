import { useEffect } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  BarChart3, Boxes, DoorOpen, FolderTree, IdCard, KeyRound, LayoutDashboard, LogOut, Menu, Smartphone,
  ClipboardList, Users, UserCog, X, type LucideIcon,
} from 'lucide-react'
import { useAuthStore, useUiStore } from '@/store/auth'
import { can, ROLE_LABEL, type RouteKey } from '@/lib/permissions'
import { signOut, useResetCacheOnLogout } from '@/features/auth/auth'
import { cn } from '@/lib/utils'

interface NavItem { to: string; label: string; icon: LucideIcon; access: RouteKey }
interface NavGroup { title: string; items: NavItem[] }

const NAV: NavGroup[] = [
  {
    title: 'Overview',
    items: [{ to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, access: 'dashboard' }],
  },
  {
    title: 'Inventory',
    items: [
      { to: '/assets', label: 'Assets', icon: Boxes, access: 'assets' },
      { to: '/phones', label: 'Phones', icon: Smartphone, access: 'phones' },
      { to: '/accounts', label: 'Accounts', icon: KeyRound, access: 'accounts' },
    ],
  },
  {
    title: 'Handover',
    items: [{ to: '/assignments', label: 'Assignments', icon: ClipboardList, access: 'assignments' }],
  },
  {
    title: 'People & places',
    items: [
      { to: '/employees', label: 'Employees', icon: Users, access: 'employees' },
      { to: '/rooms', label: 'Rooms', icon: DoorOpen, access: 'rooms' },
      { to: '/work-identities', label: 'Work identities', icon: IdCard, access: 'workIdentities' },
    ],
  },
  {
    title: 'Insights',
    items: [{ to: '/reports', label: 'Reports', icon: BarChart3, access: 'reports' }],
  },
  {
    title: 'Settings',
    items: [
      { to: '/settings/categories', label: 'Categories', icon: FolderTree, access: 'settings.categories' },
      { to: '/settings/users', label: 'Users', icon: UserCog, access: 'settings.users' },
    ],
  },
]

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const user = useAuthStore((s) => s.user)
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => can(user?.role, i.access)) })).filter((g) => g.items.length)
  return (
    <div className="flex h-full flex-col bg-brand-900 text-brand-50">
      <div className="flex h-16 items-center gap-2 px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/20"><Boxes className="h-4 w-4" /></div>
        <span className="text-base font-semibold tracking-tight">Handovers</span>
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4" aria-label="Main">
        {groups.map((g) => (
          <div key={g.title}>
            <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-brand-300/80">{g.title}</p>
            <ul className="space-y-0.5">
              {g.items.map((i) => (
                <li key={i.to}>
                  <NavLink
                    to={i.to}
                    onClick={onNavigate}
                    className={({ isActive }) => cn(
                      'flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition',
                      isActive ? 'bg-white/15 text-white' : 'text-brand-100 hover:bg-white/10 hover:text-white')}
                  >
                    <i.icon className="h-4 w-4 shrink-0" /> {i.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  )
}

export default function AppLayout() {
  const user = useAuthStore((s) => s.user)
  const demo = useAuthStore((s) => s.demo)
  const { sidebarOpen, setSidebarOpen, toggleSidebar } = useUiStore()
  const nav = useNavigate()
  const loc = useLocation()
  useResetCacheOnLogout()

  useEffect(() => { setSidebarOpen(false) }, [loc.pathname, setSidebarOpen])

  const logout = async () => {
    await signOut()
    nav('/login', { replace: true })
  }

  return (
    <div className="flex h-full">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 lg:block"><SidebarContent /></aside>

      {/* Mobile drawer */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setSidebarOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64 shadow-xl">
            <SidebarContent onNavigate={() => setSidebarOpen(false)} />
            <button onClick={() => setSidebarOpen(false)} aria-label="Close menu" className="absolute right-2 top-4 rounded p-1 text-brand-100 hover:bg-white/10"><X className="h-5 w-5" /></button>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
          <button onClick={toggleSidebar} aria-label="Open menu" className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"><Menu className="h-5 w-5" /></button>
          <div className="hidden text-sm text-slate-500 lg:block">
            {user?.role === 'TEAM_LEADER' && user.room ? <>Scoped to room <span className="font-semibold text-slate-800">{user.room.code}</span></> : 'Clinic IT department'}
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right leading-tight">
              <p className="text-sm font-medium text-slate-900">{user?.fullName}</p>
              <p className="text-xs text-slate-500">{user && ROLE_LABEL[user.role]}</p>
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800">
              {user?.fullName?.slice(0, 1).toUpperCase()}
            </div>
            <button onClick={logout} aria-label="Sign out" title="Sign out" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><LogOut className="h-4 w-4" /></button>
          </div>
        </header>
        {demo && <div className="bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-900">Demo session — backend unreachable. Data screens will show connection errors.</div>}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8"><Outlet /></div>
        </main>
      </div>
    </div>
  )
}
