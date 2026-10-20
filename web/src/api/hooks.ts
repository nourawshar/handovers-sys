import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { api } from './client'
import {
  normAccount, normAsset, normAssignment, normAssignmentDetail, normCategories, normDepartment, normEmployee, normEmployeeHistory, normField, normList,
  normPhoto, normReportRows, normReturnForm, normReturnResult, normRoom, normTimeline, normUser,
  normWorkIdentity, unwrap,
} from './normalize'
import type {
  Account, AccountSavePayload, Asset, AssignmentDetail, Category, CategoryField, Department, DepartmentSavePayload, Employee, EmployeeHistoryEntry, ExportFormat, GenericAssignmentPayload, ListResult, PhoneAssignmentPayload, Photo, ReportFilters,
  ReportRow, ReportSlug, ReturnResult, Room, TimelineEntry,
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
export function useAccounts(filters: { q?: string; kind?: string; identifier?: string; subcategory?: string; isWhatsAppBackup?: boolean; page?: number; pageSize?: number }, enabled = true) {
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

/** Create (id absent) or update (id present) an account. Invalidates the list on save. */
export function useSaveAccount(id?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (p: AccountSavePayload): Promise<Account> => {
      const raw = id ? await api.patch<R>(`/accounts/${id}`, p) : await api.post<R>('/accounts', p)
      return normAccount(unwrap(raw) as R)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] })
    },
  })
}

export interface DeleteAccountResult {
  id: string
  /** true when the account had assignment history and was soft-deleted (deactivated) instead of hard-deleted. */
  softDeleted: boolean
}

/**
 * Delete an account. Hard-deletes (204) or soft-deletes via `{data:{softDeleted:true}}` (200) when
 * history exists. A 409 is thrown by the client when the account is in use by an active assignment —
 * the caller surfaces that distinctly from a normal delete.
 */
export function useDeleteAccount(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<DeleteAccountResult> => {
      const raw = await api.del<R>(`/accounts/${id}`)
      const d = unwrap(raw) as R | null
      return { id, softDeleted: d?.softDeleted === true }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] })
    },
  })
}

/* ---------- People & places ---------- */
export function useEmployees(filters: { q?: string; roomId?: string; departmentTeamId?: string; page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: ['employees', filters],
    placeholderData: keepPreviousData,
    queryFn: async () => normList(await api.get('/employees', filters as any), normEmployee),
  })
}

/** Write payload for POST /employees and PATCH /employees/:id (BE-6; `status` is edit-only). */
export interface EmployeeSavePayload {
  fullName: string
  departmentTeamId?: string | null
  roomId?: string | null
  phoneContact?: string | null
  internalEmail?: string | null
  notes?: string | null
  /** Sent only when editing (create defaults to ACTIVE server-side). */
  status?: string | null
}

export interface EmployeeDetail {
  employee: Employee
  history: EmployeeHistoryEntry[]
}

/** Single employee + device history (GET /employees/:id, §5.4). */
export function useEmployee(id?: string) {
  return useQuery({
    queryKey: ['employee', id],
    enabled: !!id,
    queryFn: async (): Promise<EmployeeDetail> => {
      const d = unwrap((await api.get<R>(`/employees/${id}`)) as R) as R
      return {
        employee: normEmployee(d),
        history: (Array.isArray(d.history) ? d.history : []).map(normEmployeeHistory),
      }
    },
  })
}

/** Create (id absent) or update (id present) an employee. Invalidates the list + detail on save. */
export function useSaveEmployee(id?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (p: EmployeeSavePayload): Promise<Employee> => {
      const raw = id ? await api.patch<R>(`/employees/${id}`, p) : await api.post<R>('/employees', p)
      return normEmployee(unwrap(raw) as R)
    },
    onSuccess: (e) => {
      qc.invalidateQueries({ queryKey: ['employees'] })
      qc.invalidateQueries({ queryKey: ['employee', id ?? e.id] })
    },
  })
}

export interface DeleteEmployeeResult {
  id: string
  /** true when the employee had history and was soft-deleted (status → LEFT) instead of hard-deleted. */
  softDeleted: boolean
}

/**
 * Delete an employee. Hard-deletes (204) or soft-deletes via `{status:'LEFT'}` (200 `{data:{softDeleted:true}}`).
 * A 409 is thrown by the client when the employee is a room manager / holds active assets — the caller
 * surfaces that distinctly from a normal soft delete.
 */
export function useDeleteEmployee(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<DeleteEmployeeResult> => {
      const raw = await api.del<R>(`/employees/${id}`)
      const d = unwrap(raw) as R | null
      return { id, softDeleted: d?.softDeleted === true }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employees'] })
      qc.removeQueries({ queryKey: ['employee', id] })
      if (typeof id === 'string') qc.invalidateQueries({ queryKey: ['rooms'] })
    },
  })
}

export function useRooms() {
  return useQuery({
    queryKey: ['rooms'],
    staleTime: 5 * 60_000,
    queryFn: async () => normList(await api.get('/rooms'), normRoom).items,
  })
}

/** Write payload for POST /rooms and PATCH /rooms/:id (BE-7; `teamType` defaults CALLCENTER server-side). */
export interface RoomPayload {
  code?: string
  teamType?: 'CALLCENTER' | 'HOSPITAL'
  managerEmployeeId?: string | null
}

export function useRoom(id?: string) {
  return useQuery({
    queryKey: ['room', id],
    enabled: !!id,
    queryFn: async () => normRoom(unwrap((await api.get<R>(`/rooms/${id}`)) as R) as R),
  })
}

export function useSaveRoom(id?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (p: RoomPayload): Promise<Room> => {
      const raw = id ? await api.patch<R>(`/rooms/${id}`, p) : await api.post<R>('/rooms', p)
      return normRoom(unwrap(raw) as R)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rooms'] })
      if (id) qc.invalidateQueries({ queryKey: ['room', id] })
    },
  })
}

export function useDeleteRoom(id?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      await api.del(`/rooms/${id}`)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rooms'] })
      if (id) qc.invalidateQueries({ queryKey: ['room', id] })
    },
  })
}

export function useDepartments() {
  return useQuery({
    queryKey: ['departments'],
    staleTime: 5 * 60_000,
    queryFn: async () => normList(await api.get('/departments'), normDepartment).items,
  })
}

/** Write payload for POST /departments and PATCH /departments/:id (BE-9). */
export function useSaveDepartment(id?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (p: DepartmentSavePayload): Promise<Department> => {
      const raw = id ? await api.patch<R>(`/departments/${id}`, p) : await api.post<R>('/departments', p)
      return normDepartment(unwrap(raw) as R)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['departments'] })
    },
  })
}

export function useDeleteDepartment(id?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      await api.del(`/departments/${id}`)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['departments'] })
    },
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

/** Generic assign → POST /assignments/generic (CHANGE 1, BE-5). Assigns any non-phone asset in one call. */
export function useCreateGenericAssignment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (p: GenericAssignmentPayload): Promise<AssignmentDetail> => {
      const raw = (await api.post<R>('/assignments/generic', p)) as R
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

/** Upload return context photos (front/back) — POST /assignments/:id/return/photos (BE-1). */
export function useUploadReturnPhotos(assignmentId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ files, type }: { files: File[]; type: string }): Promise<Photo[]> => {
      const form = new FormData()
      form.append('type', type) // text fields must precede files for multer to see them
      files.forEach((f) => form.append('photos', f))
      const raw = await api.upload<R>(`/assignments/${assignmentId}/return/photos`, form)
      const d = unwrap(raw)
      return (Array.isArray(d) ? d : []).map(normPhoto)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assignment-return-form', assignmentId] })
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

/* ---------- Reports (contract §10) ---------- */

/** Fetch one report's rows. Keyed by slug + filters so scope changes refetch. */
export function useReport<T extends ReportRow = ReportRow>(slug: ReportSlug, filters: ReportFilters, enabled = true) {
  return useQuery({
    queryKey: ['report', slug, filters],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<ListResult<T>> => normReportRows<T>(await api.get(`/reports/${slug}`, filters as any), slug),
  })
}

const EXPORT_ACCEPT: Record<ExportFormat, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/**
 * Export a report as CSV/XLSX. Fetches the file as a blob and triggers a browser download via a
 * temporary `<a download>`. Returns the chosen filename (or null if the server didn't send one).
 */
export function useExportReport() {
  return useMutation({
    mutationFn: async ({ slug, filters, format }: { slug: ReportSlug; filters: ReportFilters; format: ExportFormat }): Promise<string | null> => {
      const blob = await api.download(`/reports/${slug}/export`, filters as any, EXPORT_ACCEPT[format])
      const ext = format === 'xlsx' ? 'xlsx' : 'csv'
      const fallback = `${slug}-${new Date().toISOString().slice(0, 10)}.${ext}`
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement('a')
        a.href = url
        a.download = fallback
        document.body.appendChild(a)
        a.click()
        a.remove()
      } finally {
        URL.revokeObjectURL(url)
      }
      return fallback
    },
  })
}
