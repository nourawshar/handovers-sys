// Response normalisers. Shapes here were verified against the running server (server/src/routes/*)
// and docs/API_CONTRACT.md. Where the server deviates from the contract, the deviation is handled
// here (and listed in the handoff) so a future reconciliation is a one-file change.
import type {
  Account, Asset, BackupStalenessRow, Category, CategoryField, Assignment, AssignmentDetail, ComparisonField, ConditionRow,
  Employee, EmployeeHistoryEntry, ListResult, OutstandingAssignmentRow, PhoneAssignmentDetail, Photo, ReportRow, ReturnForm, ReturnResult, Room,
    RoomCompositionRow, SelectOption, TimelineEntry, User, WhoHasWhatRow, WorkIdentity, Department,
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

/** A person's device history row from `GET /employees/:id` (§5.4). Tolerant of nested vs flat fields. */
export function normEmployeeHistory(h: R): EmployeeHistoryEntry {
  const asset = obj(h.asset) ?? {}
  const work = obj(h.workIdentity) ?? {}
  return {
    assignmentId: String(h.assignmentId ?? ''),
    assignmentCode: h.assignmentCode ?? String(h.assignmentId ?? ''),
    assetCode: h.assetCode ?? asset.code ?? '',
    assetName: h.assetName ?? asset.name ?? '',
    workIdentityName: h.workIdentityName ?? work.name ?? str(h.workIdentityId),
    status: h.status ?? '',
    assignedAt: str(h.assignedAt),
    returnedAt: str(h.returnedAt),
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

export const normDepartment = (d: R): Department => ({
  id: String(d.id),
  name: d.name,
  type: d.type,
  parentId: d.parentId ?? null,
  sortOrder: d.sortOrder ?? 0,
  parent: d.parent ?? null,
  employeeCount: d._count?.employees ?? d.employeeCount,
  workIdentityCount: d._count?.workIdentities ?? d.workIdentityCount,
  childCount: d._count?.children ?? d.childCount,
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

const num = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Number(v))
const bool = (v: unknown): boolean => v === true || v === 'true'

/** `PhoneAssignmentDetail` (§7.2) — tolerant of nulls and string numerics. */
export function normPhoneAssignmentDetail(p: R): PhoneAssignmentDetail {
  const x = obj(p) ?? {}
  return {
    sim1Number: str(x.sim1Number), sim1AssetId: str(x.sim1AssetId),
    wa1Business: bool(x.wa1Business), wa1PhoneNumber: str(x.wa1PhoneNumber),
    wa1BackupEmail: str(x.wa1BackupEmail), wa1BackupDate: str(x.wa1BackupDate),
    wa1BackupUsedGB: num(x.wa1BackupUsedGB), wa1BackupTotalGB: num(x.wa1BackupTotalGB),
    wa1ChatNormalCount: num(x.wa1ChatNormalCount), wa1ChatArchivedCount: num(x.wa1ChatArchivedCount),
    wa1AppVariant: x.wa1AppVariant ?? null,
    sim2Number: str(x.sim2Number), sim2AssetId: str(x.sim2AssetId),
    wa2Business: bool(x.wa2Business), wa2PhoneNumber: str(x.wa2PhoneNumber),
    wa2BackupEmail: str(x.wa2BackupEmail), wa2BackupDate: str(x.wa2BackupDate),
    wa2BackupUsedGB: num(x.wa2BackupUsedGB), wa2BackupTotalGB: num(x.wa2BackupTotalGB),
    wa2ChatNormalCount: num(x.wa2ChatNormalCount), wa2ChatArchivedCount: num(x.wa2ChatArchivedCount),
    wa2AppVariant: x.wa2AppVariant ?? null,
    bitrixAccountId: str(x.bitrixAccountId), chargerCableAssetId: str(x.chargerCableAssetId),
    chargerAdapterAssetId: str(x.chargerAdapterAssetId),
    bitrixAccount: obj(x.bitrixAccount)
      ? { id: String(x.bitrixAccount.id), identifier: str(x.bitrixAccount.identifier), email: str(x.bitrixAccount.email) }
      : null,
    chargerCableAsset: obj(x.chargerCableAsset)
      ? { id: String(x.chargerCableAsset.id), code: x.chargerCableAsset.code, name: x.chargerCableAsset.name }
      : null,
    chargerAdapterAsset: obj(x.chargerAdapterAsset)
      ? { id: String(x.chargerAdapterAsset.id), code: x.chargerAdapterAsset.code, name: x.chargerAdapterAsset.name }
      : null,
    notes: str(x.notes),
  }
}

/** Full assignment detail (§7.2) — flat or nested employee/workIdentity/asset accepted. */
export function normAssignmentDetail(d: R): AssignmentDetail {
  const x = obj(d.data) ?? d
  return {
    ...normAssignment(x),
    notes: str(x.notes),
    items: Array.isArray(x.items) ? x.items.map((it: R) => ({
      id: String(it.id), role: it.role ?? 'PRIMARY',
      conditionAtHandover: it.conditionAtHandover ?? null, returnCondition: it.returnCondition ?? null,
      asset: it.asset ?? null,
    })) : [],
    phoneDetail: obj(x.phoneDetail) ? normPhoneAssignmentDetail(x.phoneDetail) : null,
    photos: Array.isArray(x.photos) ? x.photos.map(mapPhoto) : [],
    timelineEntries: Array.isArray(x.timelineEntries) ? x.timelineEntries.map(normTimeline) : undefined,
  }
}

/** Return-form out-state (§8.1). */
export function normReturnForm(raw: unknown): ReturnForm {
  const x = obj(obj(raw)?.data ?? raw) ?? {}
  const o = obj(x.out) ?? {}
  return {
    assignmentId: String(x.assignmentId),
    assignmentCode: x.assignmentCode,
    out: {
      employeeFullName: o.employeeFullName ?? '', workIdentityName: o.workIdentityName ?? '',
      assetCode: o.assetCode ?? '', assetName: o.assetName ?? '', condition: o.condition ?? '',
      wa1ChatNormalCount: num(o.wa1ChatNormalCount), wa1ChatArchivedCount: num(o.wa1ChatArchivedCount),
      wa1BackupDate: str(o.wa1BackupDate), wa1BackupUsedGB: num(o.wa1BackupUsedGB), wa1BackupTotalGB: num(o.wa1BackupTotalGB),
      wa1BackupEmail: str(o.wa1BackupEmail),
      wa2ChatNormalCount: num(o.wa2ChatNormalCount), wa2ChatArchivedCount: num(o.wa2ChatArchivedCount),
      wa2BackupDate: str(o.wa2BackupDate), wa2BackupUsedGB: num(o.wa2BackupUsedGB), wa2BackupTotalGB: num(o.wa2BackupTotalGB),
      wa2BackupEmail: str(o.wa2BackupEmail),
      sim1Number: str(o.sim1Number), sim2Number: str(o.sim2Number),
      bitrixAccountId: str(o.bitrixAccountId),
      chargerCableAssetId: str(o.chargerCableAssetId), chargerAdapterAssetId: str(o.chargerAdapterAssetId),
      options: normReturnOptions(x.options),
    },
    handoverPhotos: Array.isArray(x.handoverPhotos)
      ? x.handoverPhotos.map(mapPhoto)
      : Array.isArray(x.photos?.handover) ? x.photos.handover.map(mapPhoto) : [],
  }
}

/**
 * BE-1 `options` arrive at the top of the return-form payload as raw rows:
 * bitrixAccounts `{id, identifier, email}` → `{value:id, label: email || identifier}`;
 * charger cable/adapter assets `{id, code, name}` → `{value:id, label: "code — name"}`.
 */
export function normReturnOptions(o: R): { bitrixAccounts: SelectOption[]; chargerCables: SelectOption[]; chargerAdapters: SelectOption[] } {
  const opt = (rows: unknown, labelFn: (r: R) => string): SelectOption[] =>
    (Array.isArray(rows) ? rows : []).map((r) => ({ value: String(r.id), label: labelFn(r as R) }))
  return {
    bitrixAccounts: opt(o?.bitrixAccounts, (r) => (r.email || r.identifier) as string),
    chargerCables: opt(o?.chargerCables, (r) => `${r.code} — ${r.name}`),
    chargerAdapters: opt(o?.chargerAdapters, (r) => `${r.code} — ${r.name}`),
  }
}

const normComparisonField = (c: R): ComparisonField => ({
  fieldKey: c.fieldKey, label: c.label ?? c.fieldKey,
  valueAtHandover: c.valueAtHandover, valueAtReturn: c.valueAtReturn,
  isDiscrepancy: !!c.isDiscrepancy, severity: c.severity ?? 'INFO',
})

/** Return result (§8.2) — tolerates either `comparison` or legacy `discrepancies`. */
export function normReturnResult(raw: unknown): ReturnResult {
  const x = obj(obj(raw)?.data ?? raw) ?? {}
  const comp = Array.isArray(x.comparison) ? x.comparison.map(normComparisonField)
    : Array.isArray(x.discrepancies) ? x.discrepancies.map(normComparisonField) : []
  const ps = obj(x.photos)
  return {
    assignmentId: String(x.assignmentId), assignmentCode: x.assignmentCode,
    status: x.status ?? 'RETURNED', returnedAt: x.returnedAt ?? null,
    hasDiscrepancies: !!x.hasDiscrepancies, comparison: comp,
    photos: {
      handover: Array.isArray(ps?.handover) ? ps!.handover.map(mapPhoto) : [],
      return: Array.isArray(ps?.return) ? ps!.return.map(mapPhoto) : [],
    },
  }
}

/* ---------- Reports (contract §10) ---------- */

const normWhoHasWhat = (r: R): WhoHasWhatRow => ({
  employeeFullName: r.employeeFullName ?? '',
  workIdentityName: r.workIdentityName ?? '',
  roomCode: r.roomCode ?? '',
  assetCode: r.assetCode ?? '',
  assetName: r.assetName ?? '',
  categoryName: r.categoryName ?? '',
  assignmentCode: r.assignmentCode ?? '',
  assignedAt: str(r.assignedAt),
  expectedReturnAt: str(r.expectedReturnAt),
})

const normCondition = (r: R): ConditionRow => ({
  categoryName: r.categoryName ?? '',
  condition: r.condition ?? '',
  count: Number(r.count ?? 0),
})

const normBackupStaleness = (r: R): BackupStalenessRow => ({
  assetCode: r.assetCode ?? '',
  assetName: r.assetName ?? '',
  wa1PhoneNumber: str(r.wa1PhoneNumber),
  wa1BackupDate: str(r.wa1BackupDate),
  wa1BackupUsedGB: num(r.wa1BackupUsedGB),
  daysSinceBackup: Number(r.daysSinceBackup ?? 0),
  employeeFullName: r.employeeFullName ?? '',
  workIdentityName: r.workIdentityName ?? '',
})

const normOutstanding = (r: R): OutstandingAssignmentRow => ({
  assignmentCode: r.assignmentCode ?? '',
  type: r.type ?? '',
  status: r.status ?? '',
  employeeFullName: r.employeeFullName ?? '',
  assetCode: r.assetCode ?? '',
  assignedAt: str(r.assignedAt),
  expectedReturnAt: str(r.expectedReturnAt),
  daysOverdue: Number(r.daysOverdue ?? 0),
})

const normRoomComposition = (r: R): RoomCompositionRow => ({
  roomCode: r.roomCode ?? '',
  managerFullName: r.managerFullName ?? '',
  employeeFullName: r.employeeFullName ?? '',
  workIdentityName: r.workIdentityName ?? '',
  assignedAssetCodes: Array.isArray(r.assignedAssetCodes) ? r.assignedAssetCodes.map(String) : [],
})

/** Per-report row normaliser keyed by report slug. */
export const REPORT_ROW_MAPPERS: Record<string, (r: R) => ReportRow> = {
  'who-has-what': normWhoHasWhat,
  condition: normCondition,
  'backup-staleness': normBackupStaleness,
  'outstanding-assignments': normOutstanding,
  'room-composition': normRoomComposition,
}

/**
 * Normalise a report list response. Reports return a bare `{ "data": [...] }` array (no `meta`,
 * contract §10 preamble) — `normList` already tolerates that, so we reuse it and map each row.
 */
export function normReportRows<T extends ReportRow>(raw: unknown, slug: string): ListResult<T> {
  const mapper = REPORT_ROW_MAPPERS[slug] ?? ((r: R) => r as unknown as ReportRow)
  return normList<T>(raw, mapper as (x: R) => T)
}
