import { useAuthStore } from '@/store/auth'

export const API_BASE = '/api/v1'

export class ApiError extends Error {
  status: number
  details?: unknown
  constructor(status: number, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.details = details
  }
}

type Query = Record<string, string | number | boolean | null | undefined>

function qs(query?: Query) {
  if (!query) return ''
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue
    p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

async function parse(res: Response) {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    const err = b.error
    if (typeof b.message === 'string') return b.message
    if (typeof err === 'string') return err
    if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
      return (err as Record<string, string>).message
    }
  }
  return fallback
}

// Single-flight refresh so parallel 401s trigger only one rotation of the refresh cookie.
let refreshing: Promise<boolean> | null = null
function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshing = null
      })
  }
  return refreshing
}

interface RequestOpts {
  method?: string
  query?: Query
  body?: unknown
  form?: FormData
  /** skip the automatic refresh/logout handling (used by auth endpoints) */
  noAuthRetry?: boolean
}

export async function request<T = unknown>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { method = 'GET', query, body, form, noAuthRetry } = opts
  const doFetch = () =>
    fetch(`${API_BASE}${path}${qs(query)}`, {
      method,
      credentials: 'include', // HttpOnly access/refresh cookies
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    })

  let res: Response
  try {
    res = await doFetch()
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection or the backend.')
  }

  if (res.status === 401 && !noAuthRetry) {
    const ok = await refreshSession()
    if (ok) {
      res = await doFetch()
    }
    if (res.status === 401) {
      useAuthStore.getState().clear()
      throw new ApiError(401, 'Your session has expired. Please sign in again.')
    }
  }

  const data = await parse(res)
  if (!res.ok) {
    throw new ApiError(res.status, errorMessage(data, `Request failed (${res.status})`), data)
  }
  return data as T
}

export const api = {
  get: <T = unknown>(path: string, query?: Query) => request<T>(path, { query }),
  post: <T = unknown>(path: string, body?: unknown, opts?: RequestOpts) =>
    request<T>(path, { ...opts, method: 'POST', body: body ?? (opts?.form ? undefined : {}) }),
  patch: <T = unknown>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  del: <T = unknown>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T = unknown>(path: string, form: FormData) => request<T>(path, { method: 'POST', form }),
  /**
   * Fetch a file (blob) endpoint — the export endpoints return a download, not JSON, so the normal
   * `request`/`get` JSON parser can't be used. Handles the 401 refresh like `request` does.
   */
  download: async (path: string, query: Query, accept: string): Promise<Blob> => {
    const doFetch = () =>
      fetch(`${API_BASE}${path}${qs(query)}`, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: accept },
      })
    let res: Response
    try {
      res = await doFetch()
    } catch {
      throw new ApiError(0, 'Cannot reach the server. Check your connection or the backend.')
    }
    if (res.status === 401) {
      const ok = await refreshSession()
      if (ok) res = await doFetch()
      if (res.status === 401) {
        useAuthStore.getState().clear()
        throw new ApiError(401, 'Your session has expired. Please sign in again.')
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ApiError(res.status, errorMessage(text, `Export failed (${res.status})`), text)
    }
    return res.blob()
  },
}
