import type { Role, User } from '@/api/types'

/** Route access per README §7 (access column). */
export type RouteKey =
  | 'dashboard'
  | 'assets'
  | 'assets.new'
  | 'assets.edit'
  | 'assets.detail'
  | 'assignments'
  | 'accounts'
  | 'employees'
  | 'rooms'
  | 'departments'
  | 'reports'
  | 'settings.categories'
  | 'settings.users'

const ALL: Role[] = ['ADMIN', 'MANAGER', 'TEAM_LEADER']
const ADMIN: Role[] = ['ADMIN']
const MGR: Role[] = ['ADMIN', 'MANAGER']

// NOTE: README §7 lists /reports as Manager/Admin, but §9 + contract §11 say Team Leaders can view
// reports within their own room scope (no export). We follow §9/§11 (R10): the route is open to ALL,
// and the ReportsPage hides scope pickers + export for TEAM_LEADER (server enforces the room scope).
export const ROUTE_ACCESS: Record<RouteKey, Role[]> = {
  dashboard: ALL,
  assets: ALL,
  'assets.new': ADMIN,
  'assets.edit': ADMIN,
  'assets.detail': ALL,
  assignments: ALL,
  accounts: ADMIN,
  employees: ALL,
  rooms: MGR,
  departments: ALL,
  reports: ALL,
  'settings.categories': ADMIN,
  'settings.users': ADMIN,
}

export function can(role: Role | undefined | null, key: RouteKey): boolean {
  return !!role && ROUTE_ACCESS[key].includes(role)
}

export const isAdmin = (u?: User | null) => u?.role === 'ADMIN'

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  TEAM_LEADER: 'Team Leader',
}

/** Role-aware landing page. Everyone lands on the dashboard; kept as a function so it can diverge per role. */
export function homeFor(role: Role | undefined | null): string {
  switch (role) {
    case 'ADMIN':
    case 'MANAGER':
    case 'TEAM_LEADER':
      return '/dashboard'
    default:
      return '/login'
  }
}
