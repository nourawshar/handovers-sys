// Response normalisers. Shapes here were verified against the running server (server/src/routes/*)
// and docs/API_CONTRACT.md. Where the server deviates from the contract, the deviation is handled
// here (and listed in the handoff) so a future reconciliation is a one-file change.
import type {
  Account, Asset, Category, CategoryField, Employee, ListResult, Photo, Room, SelectOption,
  TimelineEntry, User, WorkIdentity, Assignment,
} from './types'

/* eslint-disable @typescript-eslint/no-explicit-any */
type R = Record<string, any>

const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v))
const obj = (v: unknown): R | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as R) : null)

/** `{data: X}` → X (leaves lists with `meta` alone). */
export function unwrap(raw: unknown): unknown {
  const o = obj(raw)
  return o && 'data' in o ? o.data : raw
}

/** Handles `{data: [...], meta}` (contract), bare arrays (rooms/work-identities) and legacy `{items,total}`. */
export function normList<T>(raw: unknown, mapper: (x: R) => T): ListResult<T> {
  const o = obj(raw)
  const arr: R[] = Array.isArray(raw) ? raw : Array.isArray(o?.data) ? o!.data : Array.isArray(o?.items) ? o!.items : []
  const meta = obj(o?.meta) ?? {}
  const items = arr.map(mapper)
  return {
    items,
    total: Number(meta.total ?? o?.total ?? items.length),
    page: Number(meta.page ?? 1),
    pageSize: Number(meta.pageSize ?? (items.length || 25)),
  }
}

export const photoUrl = (p: R): string => p.url ?? `/api/v1/photos/${p.id}/file`

const mapPhoto = (p: R): Photo => ({
  id: String(p.id),
  type: p.type ?? 'GENERAL',
  url: photoUrl(p),
  fileName: p.fileName ?? '',
  createdAt: p.createdAt,
})
export { mapPhoto as normPhoto }

export function normUser(raw: R): User {
  const x = obj(raw.user) ?? obj(raw.data) ?? raw
  return {
    id: String(x.id),
    username: x.username ?? '',
    fullName: x.fullName ?? x.username ?? '',
    role: x.role,
    roomId: x.roomId ?? x.room?.id ?? null,
    room: x.room ?? null,
    isActive: x.isActive,
    lastLoginAt: x.lastLoginAt,
  }
}

export function normOptions(o: unknown): SelectOption[] {
  if (!Array.isArray(o)) return []
  return o.map((x) =>
    typeof x === 'object' && x
      ? { value: String((x as R).value), label: String((x as R).label ?? (x as R).value) }
      : { value: String(x), label: String(x) })
}

export function normField(f: R): CategoryField {
  return {
    id: String(f.id),
    categoryId: String(f.categoryId ?? ''),
    key: f.key,
    label: f.label ?? f.key,
    type: f.type ?? 'string',
    options: normOptions(f.options),
    required: !!f.required,
    isSearchable: !!f.isSearchable,
    isIdentifier: !!f.isIdentifier,
    sortOrder: Number(f.sortOrder ?? 0),
  }
}

export function normCategory(c: R): Category {
  return {
    id: String(c.id),
    name: c.name,
    parentId: c.parentId ?? null,
    kind: c.kind ?? 'physical',
    isActive: c.isActive !== false,
    fields: Array.isArray(c.fields) ? c.fields.map(normField).sort((a: CategoryField, b: CategoryField) => a.sortOrder - b.sortOrder) : undefined,
  }
}

/** Server returns a nested tree in `data` plus a `flat` list. Flatten in tree order (parent, then children). */
export function normCategories(raw: unknown): Category[] {
  const o = obj(raw)
  if (Array.isArray(o?.flat)) {
    const flat = (o!.flat as R[]).map(normCategory)
    const roots = flat.filter((c) => !c.parentId).sort((a, b) => a.name.localeCompare(b.name))
    return roots.flatMap((r) => [r, ...flat.filter((c) => c.parentId === r.id).sort((a, b) => a.name.localeCompare(b.name))])
  }
  const out: Category[] = []
  const walk = (list: R[]) => list.forEach((c) => { out.push(normCategory(c)); if (Array.isArray(c.children)) walk(c.children) })
  walk(Array.isArray(unwrap(raw)) ? (unwrap(raw) as R[]) : [])
  return out
}

export function normAsset(raw: R): Asset {
  const x = obj(raw.data) ?? raw
  const pd = obj(x.phoneDetail)
  return {
    id: String(x.id),
    code: x.code,
    name: x.name ?? '',
    categoryId: String(x.categoryId ?? x.category?.id ?? ''),
    category: x.category ? { id: String(x.category.id), name: x.category.name } : null,
    serialNumber: str(x.serialNumber),
    imei: str(pd?.imei),
    phone: pd
      ? { imei: str(pd.imei), make: str(pd.make), model: str(pd.model), color: str(pd.color), storage: str(pd.storage), appBinary: str(pd.appBinary), carrier: str(pd.carrier) }
      : null,
    qty: Number(x.qty ?? 1),
    condition: x.condition,
    status: x.status,
    roomId: x.roomId ?? x.room?.id ?? null,
    room: x.room ?? null,
    currentHolderEmployeeId: x.currentHolderEmployeeId ?? x.currentHolder?.id ?? null,
    currentHolder: x.currentHolder ?? null,
    notes: str(x.notes),
    customFields: obj(x.customFields) ?? {},
    fieldDefinitions: Array.isArray(x.customFieldDefinitions) ? x.customFieldDefinitions.map(normField) : undefined,
    photos: Array.isArray(x.photos) ? x.photos.map(mapPhoto) : [],
    createdAt: x.createdAt,
    updatedAt: x.updatedAt,
  }
}

export function normTimeline(t: R): TimelineEntry {
  return {
    id: String(t.id),
    eventType: t.eventType ?? 'NOTE',
    assignmentId: t.assignmentId ?? null,
    employee: t.employee ?? (t.employeeId ? { id: t.employeeId, fullName: (t.snapshot as R | null)?.employeeFullName ?? '' } : null),
    workIdentity: t.workIdentity ?? null,
    createdBy: t.createdBy ?? null,
    snapshot: obj(t.snapshot),
    createdAt: t.createdAt,
  }
}

export function normAccount(a: R): Account {
  return {
    id: String(a.id),
    kind: a.kind ?? 'OTHER',
    subcategory: str(a.subcategory),
    identifier: a.identifier ?? '',
    email: str(a.email),
    passwordMasked: a.password ?? '••••••••', // server always sends a mask, never ciphertext
    isWhatsAppBackup: !!a.isWhatsAppBackup,
    isActive: a.isActive !== false,
    currentAssignmentId: a.currentAssignmentId ?? null,
    notes: str(a.notes),
  }
}

export function normEmployee(x: R): Employee {
  return {
    id: String(x.id),
    fullName: x.fullName ?? '',
    departmentTeamId: x.departmentTeamId ?? null,
    departmentTeam: x.departmentTeam ?? x.department ?? null,
    roomId: x.roomId ?? x.room?.id ?? null,
    room: x.room ?? null,
    phoneContact: str(x.phoneContact),
    internalEmail: str(x.internalEmail),
    status: x.status ?? 'ACTIVE',
    notes: str(x.notes),
  }
}

export const normRoom = (r: R): Room => ({
  id: String(r.id),
  code: r.code,
  teamType: r.teamType,
  managerEmployeeId: r.managerEmployeeId ?? null,
  manager: r.managerEmployee ?? r.manager ?? null,
  employeeCount: r._count?.employees ?? r.employeeCount,
  workIdentityCount: r._count?.workIdentities,
})

export const normWorkIdentity = (w: R): WorkIdentity => ({
  id: String(w.id), name: w.name, roomId: w.roomId ?? w.room?.id ?? null, room: w.room ?? null,
  departmentTeam: w.departmentTeam ?? null, isActive: w.isActive !== false, notes: str(w.notes),
})

/** Contract §7.1 returns flat `employeeName`/`assetCode`…; §7.2 returns nested objects. Accept both. */
export const normAssignment = (a: R): Assignment => ({
  id: String(a.id),
  assignmentCode: a.assignmentCode ?? String(a.id),
  type: a.type,
  status: a.status,
  employee: a.employee ?? (a.employeeId ? { id: a.employeeId, fullName: a.employeeName ?? '' } : null),
  workIdentity: a.workIdentity ?? (a.workIdentityId ? { id: a.workIdentityId, name: a.workIdentityName ?? '' } : null),
  asset: a.asset ?? (a.assetId ? { id: a.assetId, code: a.assetCode ?? '', name: a.assetName ?? '' } : null),
  assignedAt: a.assignedAt, expectedReturnAt: a.expectedReturnAt, returnedAt: a.returnedAt,
})
