import { useEffect, type ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { authApi } from '@/api/hooks'
import { ApiError } from '@/api/client'
import type { Role, User } from '@/api/types'
import { useAuthStore } from '@/store/auth'
import { can, homeFor, type RouteKey } from '@/lib/permissions'
import { Spinner } from '@/components/ui'

const DEMO_KEY = 'handovers.demoUser'

/** Dev-only fallback so the UI shell can be explored when the backend is not running. */
const DEMO_USERS: Record<string, User> = {
  admin: { id: 'demo-admin', username: 'admin', fullName: 'Demo Admin', role: 'ADMIN', roomId: null },
  manager: { id: 'demo-manager', username: 'manager', fullName: 'Demo Manager', role: 'MANAGER', roomId: null },
  leader: { id: 'demo-leader', username: 'leader', fullName: 'Demo Team Leader', role: 'TEAM_LEADER', roomId: 'demo-room', room: { id: 'demo-room', code: 'TR1' } },
}
export const demoEnabled = import.meta.env.DEV && import.meta.env.VITE_DEMO_LOGIN !== 'false'

export async function signIn(username: string, password: string): Promise<User> {
  try {
    const user = await authApi.login(username, password)
    // Cookies are set by the server; /auth/me is the source of truth for role + room scope.
    let full = user
    try {
      full = await authApi.me()
    } catch { /* keep login payload */ }
    useAuthStore.getState().setUser(full)
    return full
  } catch (e) {
    if (demoEnabled && e instanceof ApiError && (e.status === 0 || e.status >= 502) && password === 'demo' && DEMO_USERS[username]) {
      const u = DEMO_USERS[username]
      sessionStorage.setItem(DEMO_KEY, JSON.stringify(u))
      useAuthStore.getState().setUser(u, true)
      return u
    }
    throw e
  }
}

export async function signOut() {
  sessionStorage.removeItem(DEMO_KEY)
  if (!useAuthStore.getState().demo) {
    try { await authApi.logout() } catch { /* ignore */ }
  }
  useAuthStore.getState().clear()
}

/** Restores the session from the HttpOnly cookie via /auth/me on first load. */
export function AuthBootstrap({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status)
  useEffect(() => {
    if (useAuthStore.getState().status !== 'unknown') return
    const demo = demoEnabled ? sessionStorage.getItem(DEMO_KEY) : null
    if (demo) {
      useAuthStore.getState().setUser(JSON.parse(demo) as User, true)
      return
    }
    authApi.me().then((u) => useAuthStore.getState().setUser(u)).catch(() => useAuthStore.getState().clear())
  }, [])
  if (status === 'unknown') return <div className="flex h-full items-center justify-center"><Spinner label="Restoring session…" /></div>
  return <>{children}</>
}

/** Clears cached server data whenever the signed-in identity changes (prevents cross-user leakage). */
export function useResetCacheOnLogout() {
  const qc = useQueryClient()
  const status = useAuthStore((s) => s.status)
  useEffect(() => {
    if (status === 'anonymous') qc.clear()
  }, [status, qc])
}

export function RequireAuth() {
  const { user, status } = useAuthStore()
  const loc = useLocation()
  if (status !== 'authenticated' || !user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />
  return <Outlet />
}

export function RequireRole({ access, children }: { access: RouteKey; children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  if (!can(user?.role as Role | undefined, access)) return <Navigate to="/forbidden" replace />
  return <>{children}</>
}

export function HomeRedirect() {
  const user = useAuthStore((s) => s.user)
  return <Navigate to={homeFor(user?.role)} replace />
}
