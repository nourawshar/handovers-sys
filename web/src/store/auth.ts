import { create } from 'zustand'
import type { User } from '@/api/types'

type Status = 'unknown' | 'authenticated' | 'anonymous'

interface AuthState {
  user: User | null
  status: Status
  /** true when signed in through the dev-only fallback (backend unreachable) */
  demo: boolean
  setUser: (u: User, demo?: boolean) => void
  clear: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  status: 'unknown',
  demo: false,
  setUser: (user, demo = false) => set({ user, status: 'authenticated', demo }),
  clear: () => set({ user: null, status: 'anonymous', demo: false }),
}))

interface UiState {
  sidebarOpen: boolean
  setSidebarOpen: (v: boolean) => void
  toggleSidebar: () => void
}

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: false,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}))
