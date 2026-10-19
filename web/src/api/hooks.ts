import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { api } from './client'
import {
  normAccount, normAsset, normAssignment, normAssignmentDetail, normCategories, normEmployee, normField, normList,
  normPhoto, normReturnForm, normReturnResult, normRoom, normTimeline, normUser,
  normWorkIdentity, unwrap,
} from './normalize'
import type {
  Asset, AssignmentDetail, Category, CategoryField, Department, PhoneAssignmentPayload, Photo, ReturnResult,
  TimelineEntry,
} from './types'

/* eslint-disable @typescript-eslint/no-explicit-any */
type R = Record<string, any>

/* ---------- Auth ---------- */
export const authApi = {
  login: async (username: string, password: string) =>
    normUser((await api.post<R>('/auth/login', { username, password }, { noAuthRetry: true })) as R),
  me: async () => normUser((await api.get<R>('/auth/me')) as R),
  logout: () => api.post('/auth/logout', {}, { noAuthRetry: true }),
}

/* ---------- Categories ---------- */
export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: async (): Promise<Category[]> => normCategories(await api.get('/asset-categories')),
    staleTime: 5 * 60_000,
  })
}

/** All categories incl. their field definitions (used by the read-only designer view). */
export function useCategoriesWithFields() {
  return useQuery({
    queryKey: ['categories', 'with-fields'],
    queryFn: async (): Promise<Category[]> => normCategories(await api.get('/asset-categories', { includeFields: true, includeInactive: true })),
  })
}

export function useCategoryFields(categoryId?: string) {
  return useQuery({
    queryKey: ['category-fields', categoryId],
    enabled: !!categoryId,
    queryFn: async () => {
      const raw = await api.get(`/asset-categories/${categoryId}/fields`)
      return normList(raw, normField).items.sort((a: CategoryField, b: CategoryField) => a.sortOrder - b.sortOrder)
    },
  })
}

/* ---------- Assets ---------- */
export interface AssetFilters {
  q?: string
  imei?: string
  categoryId?: string
  condition?: string
  status?: string
  holderId?: string
  roomId?: string
  page?: number
  pageSize?: number
}

export function useAssets(filters: AssetFilters, enabled = true) {
  return useQuery({
    queryKey: ['assets', filters],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async () => normList(await api.get('/assets', filters as any), normAsset),
  })
}

export function useAsset(id?: string) {
  return useQuery({
    queryKey: ['asset', id],
    enabled: !!id,
    queryFn: async () => {
      const raw = (await api.get<R>(`/assets/${id}`)) as R
      const d = unwrap(raw) as R
      return {
        asset: normAsset(d),
        // The detail endpoint embeds the latest timeline entries (server `timelineEntries`, contract `timeline`).
        timeline: (Array.isArray(d.timelineEntries) ? d.timelineEntries : Array.isArray(d.timeline) ? d.timeline : []).map(normTimeline) as TimelineEntry[],
      }
    },
  })
}

export interface PhonePayload {
  imei: string
  make?: string | null
  model?: string | null
  color?: string | null
  storage?: string | null
  appBinary?: 'BUSINESS' | 'NORMAL' | null
}

export interface AssetPayload {
  name: string
  categoryId?: string
  serialNumber?: string | null
  qty: number
  condition: string
  roomId?: string | null
  notes?: string | null
  customFields: Record<string, unknown>
  phone?: PhonePayload | null
}

export function useSaveAsset(id?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (p: AssetPayload): Promise<Asset> => {
      const raw = id ? await api.patch<R>(`/assets/${id}`, p) : await api.post<R>('/assets', p)
      return normAsset(unwrap(raw) as R)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assets'] })
      if (id) qc.invalidateQueries({ queryKey: ['asset', id] })
    },
  })
}

export function useUploadAssetPhotos(assetId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ files, type }: { files: File[]; type: string }): Promise<Photo[]> => {
      const form = new FormData()
      form.append('type', type) // text fields must precede files for multer to see them
      files.forEach((f) => form.append('photos', f))
      const raw = await api.upload<R>(`/assets/${assetId}/photos`, form)
      const d = unwrap(raw)
      return (Array.isArray(d) ? d : []).map(normPhoto)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['asset', assetId] }),
  })
}

/** Dedicated paginated timeline (contract §9.1). Not implemented server-side yet → callers fall back to the entries embedded in GET /assets/:id. */
export function useAssetTimeline(assetId: string | undefined, page = 1, search = '') {
  return useQuery({
    queryKey: ['asset-timeline', assetId, page, search],
    enabled: !!assetId,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async () =>
      normList(await api.get(`/assets/${assetId}/timeline`, { page, pageSize: 20, q: search }), normTimeline),
  })
}

/* ---------- Accounts ---------- */
export function useAccounts(filters: { q?: string; kind?: string; page?: number; pageSize?: number }, enabled = true) {
  return useQuery({
    queryKey: ['accounts', filters],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async () => normList(await api.get('/accounts', filters as any), normAccount),
  })
}

export function decryptAccount(id: string) {
  return api.get<R>(`/accounts/${id}/decrypt`).then((r) => String((unwrap(r) as R).password ?? ''))
}

/* ---------- People & places ---------- */
export function useEmployees(filters: { q?: string; roomId?: string; departmentTeamId?: string; page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: ['employees', filters],
    placeholderData: keepPreviousData,
    queryFn: async () => normList(await api.get('/employees', filters as any), normEmployee),
  })
}

export function useRooms() {
  return useQuery({
    queryKey: ['rooms'],
    staleTime: 5 * 60_000,
    queryFn: async () => normList(await api.get('/rooms'), normRoom).items,
  })
}

export function useDepartments() {
  return useQuery({
    queryKey: ['departments'],
    staleTime: 5 * 60_000,
    queryFn: async () => normList(await api.get('/departments'), (d: R): Department => ({ id: String(d.id), name: d.name, type: d.type })).items,
  })
}

export function useWorkIdentities(filters: { q?: string; roomId?: string } = {}) {
  return useQuery({
    queryKey: ['work-identities', filters],
    queryFn: async () => normList(await api.get('/work-identities', filters as any), normWorkIdentity),
  })
}

/** Phase 2 endpoint — not implemented on the server yet; callers handle the 404. */
export function useAssignments(filters: { status?: string; type?: string; q?: string; page?: number; pageSize?: number } = {}) {
  return useQuery({
    queryKey: ['assignments', filters],
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: async () => normList(await api.get('/assignments', filters as any), normAssignment),
  })
}

/* ---------- Assignments: detail + return + phone wizard (contract §7, §8) ---------- */

export function useAssignmentDetail(id?: string) {
  return useQuery({
    queryKey: ['assignment', id],
    enabled: !!id,
    retry: false,
    queryFn: async (): Promise<AssignmentDetail> => normAssignmentDetail(await api.get(`/assignments/${id}`)),
  })
}

/** Assignment-scoped timeline (contract §9.2). */
export function useAssignmentTimeline(id: string | undefined, page = 1) {
  return useQuery({
    queryKey: ['assignment-timeline', id, page],
    enabled: !!id,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async () =>
      normList(await api.get(`/assignments/${id}/timeline`, { page, pageSize: 20 }), normTimeline),
  })
}

/** Pre-filled out-state snapshot for the two-column return comparison (contract §8.1). */
export function useAssignmentReturnForm(id?: string) {
  return useQuery({
    queryKey: ['assignment-return-form', id],
    enabled: !!id,
    retry: false,
    queryFn: async () => normReturnForm(await api.get(`/assignments/${id}/return-form`)),
  })
}

/** Core wizard submit → POST /assignments/phone. Returns the activated assignment (§7.6). */
export function useCreatePhoneAssignment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (p: PhoneAssignmentPayload): Promise<AssignmentDetail> => {
      const raw = (await api.post<R>('/assignments/phone', p)) as R
      return normAssignmentDetail(unwrap(raw) as R)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assignments'] }),
  })
}

/** Upload photos to an assignment after it exists (contract §4.12 pattern) — used post-create. */
export function useUploadAssignmentPhotos(assignmentId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ files, type }: { files: File[]; type: string }): Promise<Photo[]> => {
      const form = new FormData()
      form.append('type', type) // text fields must precede files for multer to see them
      files.forEach((f) => form.append('photos', f))
      const raw = await api.upload<R>(`/assignments/${assignmentId}/photos`, form)
      const d = unwrap(raw)
      return (Array.isArray(d) ? d : []).map(normPhoto)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assignment', assignmentId] })
      qc.invalidateQueries({ queryKey: ['assignments'] })
    },
  })
}

/** Return submit → POST /assignments/:id/return (contract §8.2). */
export function useSubmitPhoneReturn(assignmentId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (p: unknown): Promise<ReturnResult> => {
      const raw = (await api.post<R>(`/assignments/${assignmentId}/return`, p)) as R
      return normReturnResult(unwrap(raw) as R)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assignment', assignmentId] })
      qc.invalidateQueries({ queryKey: ['assignments'] })
      qc.invalidateQueries({ queryKey: ['assignment-timeline', assignmentId] })
    },
  })
}
