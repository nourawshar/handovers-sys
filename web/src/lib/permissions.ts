import type { Role, User } from '@/api/types'

/** Route access per README §7 (access column). */
export type RouteKey =
  | 'dashboard'
  | 'assets'
  | 'assets.new'
  | 'assets.edit'
  | 'assets.detail'
  | 'phones'
  | 'assignments'
  | 'accounts'
  | 'employees'
  | 'rooms'
  | 'workIdentities'
  | 'reports'
  | 'settings.categories'
  | 'settings.users'

const ALL: Role[] = ['ADMIN', 'MANAGER', 'TEAM_LEADER']
const ADMIN: Role[] = ['ADMIN']
const MGR: Role[] = ['ADMIN', 'MANAGER']

// NOTE: README §9 says Team Leaders can view reports within their room scope, but §7 lists /reports as
// Manager/Admin. We follow the §7 route table (task spec) and flag the mismatch in the handoff.
export const ROUTE_ACCESS: Record<RouteKey, Role[]> = {
  dashboard: ALL,
  assets: ALL,
  'assets.new': ADMIN,
  'assets.edit': ADMIN,
  'assets.detail': ALL,
  phones: ALL,
  assignments: ALL,
  accounts: ADMIN,
  employees: ALL,
  rooms: MGR,
  workIdentities: MGR,
  reports: MGR,
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
