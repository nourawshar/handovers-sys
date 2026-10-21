// Domain types. Field names follow README §5 (data model) until docs/API_CONTRACT.md exists.
// Any divergence is isolated in src/api/normalize.ts so the contract can be reconciled in one place.

export type Role = 'ADMIN' | 'MANAGER' | 'TEAM_LEADER' | 'CALL_CENTER_MANAGER'

export const CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'DISPOSED'] as const
export type Condition = (typeof CONDITIONS)[number]

export const ASSET_STATUSES = ['AVAILABLE', 'ASSIGNED', 'RETURNED', 'DISPOSED', 'IN_REPAIR'] as const
export type AssetStatus = (typeof ASSET_STATUSES)[number]

export type FieldType = 'string' | 'number' | 'date' | 'boolean' | 'select' | 'textarea'

export interface RoomRef {
  id: string
  code: string
}

export interface User {
  id: string
  username: string
  fullName: string
  role: Role
  roomId: string | null
  room?: RoomRef | null
  isActive?: boolean
  lastLoginAt?: string | null
}

/**
 * Write payload for POST /users and PATCH /users/:id (BE-17). `username` + `password` are create-only
 * (the server's PATCH body is strict and accepts only fullName/role/roomId/scope/isActive); `roomId` is
 * required when role is TEAM_LEADER; password min length 10.
 */
export interface UserSavePayload {
  username?: string
  password?: string
  fullName: string
  role: Role
  roomId?: string | null
  isActive?: boolean
}

/** One row of the audit trail (GET /audit-logs, contract §8 extension). */
export interface AuditLogEntry {
  id: string
  actor: { id: string; fullName: string; username: string } | null
  action: string
  targetType: string | null
  targetId: string | null
  meta: Record<string, unknown> | null
  ip: string | null
  createdAt: string
}

export interface Category {
  id: string
  name: string
  parentId: string | null
  kind: 'physical' | 'digital' | 'account' | string
  isActive: boolean
  fields?: CategoryField[]
}

export interface SelectOption {
  value: string
  label: string
}

export interface CategoryField {
  id: string
  categoryId: string
  key: string
  label: string
  type: FieldType
  options: SelectOption[]
  required: boolean
  isSearchable: boolean
  isIdentifier: boolean
  sortOrder: number
}

export interface Photo {
  id: string
  type: 'FRONT' | 'BACK' | 'CONDITION' | 'GENERAL' | string
  url: string
  fileName: string
  createdAt?: string
}

export interface PhoneInfo {
  imei: string | null
  make: string | null
  model: string | null
  color: string | null
  storage: string | null
  appBinary: string | null
  carrier: string | null
}

export interface Asset {
  id: string
  code: string
  name: string
  categoryId: string
  category?: { id: string; name: string } | null
  serialNumber: string | null
  imei: string | null
  /** PhoneDetail (only for phone assets). Server field name is `phone` on write, `phoneDetail` on read. */
  phone: PhoneInfo | null
  qty: number
  condition: Condition
  status: AssetStatus
  roomId: string | null
  room?: RoomRef | null
  currentHolderEmployeeId: string | null
  currentHolder?: { id: string; fullName: string } | null
  notes: string | null
  customFields: Record<string, unknown>
  /** Field definitions embedded in GET /assets/:id (detail only). */
  fieldDefinitions?: CategoryField[]
  photos: Photo[]
  createdAt?: string
  updatedAt?: string
}

export interface TimelineEntry {
  id: string
  eventType: string
  assignmentId?: string | null
  employee?: { id: string; fullName: string } | null
  workIdentity?: { id: string; name: string } | null
  createdBy?: { id: string; fullName: string } | null
  snapshot: Record<string, unknown> | null
  createdAt: string
}

export interface Account {
  id: string
  kind: 'GMAIL' | 'WHATSAPP' | 'BITRIX' | 'OTHER' | string
  subcategory: string | null
  identifier: string
  email: string | null
  /** Server returns a mask (or nothing); we never receive the real password in list responses. */
  passwordMasked: string
  isWhatsAppBackup: boolean
  isActive: boolean
  currentAssignmentId: string | null
  notes: string | null
}

/** Write payload for POST /accounts and PATCH /accounts/:id (FE-10). `password` is required on
 * create for GMAIL/WHATSAPP/BITRIX (server enforces, contract §6.2); on edit it is optional and
 * sent only to rotate. `isActive` is edit-only (create defaults to true server-side). */
export interface AccountSavePayload {
  kind: 'GMAIL' | 'WHATSAPP' | 'BITRIX' | 'OTHER'
  subcategory?: string | null
  identifier: string
  email?: string | null
  password?: string
  isWhatsAppBackup?: boolean
  isActive?: boolean
  assetId?: string | null
  notes?: string | null
}

export interface Employee {
  id: string
  fullName: string
  departmentTeamId: string | null
  departmentTeam?: { id: string; name: string } | null
  roomId: string | null
  room?: RoomRef | null
  phoneContact: string | null
  internalEmail: string | null
  status: 'ACTIVE' | 'LEFT' | 'ON_LEAVE' | string
  notes: string | null
}

export const EMPLOYEE_STATUSES = ['ACTIVE', 'LEFT', 'ON_LEAVE'] as const
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number]

/** A single device assignment a person has been part of (from GET /employees/:id → `history`). */
export interface EmployeeHistoryEntry {
  assignmentId: string
  assignmentCode: string
  assetCode: string
  assetName: string
  workIdentityName: string | null
  status: string
  assignedAt: string | null
  returnedAt: string | null
}

export interface Room {
  id: string
  code: string
  teamType?: string
  managerEmployeeId?: string | null
  manager?: { id: string; fullName: string } | null
  employeeCount?: number
  workIdentityCount?: number
}

export interface WorkIdentity {
  id: string
  name: string
  roomId: string | null
  room?: RoomRef | null
  departmentTeam?: { id: string; name: string } | null
  isActive: boolean
  notes: string | null
}

export interface Assignment {
  id: string
  assignmentCode: string
  type: string
  status: string
  employee?: { id: string; fullName: string } | null
  workIdentity?: { id: string; name: string } | null
  asset?: { id: string; code: string; name: string } | null
  assignedAt?: string | null
  expectedReturnAt?: string | null
  returnedAt?: string | null
}

export interface Department {
  id: string
  name: string
  type?: string
  parentId?: string | null
  sortOrder?: number
  parent?: { id: string; name: string } | null
  employeeCount?: number
  workIdentityCount?: number
  childCount?: number
}

/** Write payload for POST /departments and PATCH /departments/:id (BE-9). */
export interface DepartmentSavePayload {
  name: string
  type: 'CALLCENTER' | 'HOSPITAL'
  parentId?: string | null
  sortOrder?: number
}

/** On-the-fly work identity (CHANGE 4). Sent to POST /assignments/phone + /assignments/generic to upsert the seat. */
export interface WorkIdentityInput {
  name: string
  departmentTeamId?: string | null
  roomId?: string | null
}

/* ---------- Phone assignment (contract §7.2, §7.6, README §3.2) ---------- */

export const WA_VARIANTS = ['BUSINESS', 'NORMAL'] as const
export type WaVariant = (typeof WA_VARIANTS)[number]

/** `PhoneAssignmentDetail` — the phone-specific fields on an assignment (§7.2). */
export interface PhoneAssignmentDetail {
  sim1Number: string | null
  sim1AssetId?: string | null
  wa1Business: boolean
  wa1PhoneNumber: string | null
  wa1BackupEmail: string | null
  wa1BackupDate: string | null
  wa1BackupUsedGB: number | null
  wa1BackupTotalGB: number | null
  wa1ChatNormalCount: number | null
  wa1ChatArchivedCount: number | null
  wa1AppVariant: WaVariant | null

  sim2Number: string | null
  sim2AssetId?: string | null
  wa2Business: boolean
  wa2PhoneNumber: string | null
  wa2BackupEmail: string | null
  wa2BackupDate: string | null
  wa2BackupUsedGB: number | null
  wa2BackupTotalGB: number | null
  wa2ChatNormalCount: number | null
  wa2ChatArchivedCount: number | null
  wa2AppVariant: WaVariant | null

  bitrixAccountId: string | null
  chargerCableAssetId: string | null
  chargerAdapterAssetId: string | null
  /** Hydrated relations (BE-16). Absent on older backends → receipt falls back to the raw ids above. */
  bitrixAccount?: { id: string; identifier: string | null; email: string | null } | null
  chargerCableAsset?: { id: string; code: string; name: string } | null
  chargerAdapterAsset?: { id: string; code: string; name: string } | null
  notes?: string | null
}

export interface AssignmentItem {
  id: string
  role: string
  conditionAtHandover?: string | null
  returnCondition?: string | null
  asset?: { id: string; code: string; name: string } | null
}

/** Full assignment detail incl. items + phone detail + photos (§7.2). */
export interface AssignmentDetail extends Assignment {
  notes?: string | null
  items: AssignmentItem[]
  phoneDetail: PhoneAssignmentDetail | null
  photos: Photo[]
  timelineEntries?: TimelineEntry[]
}

/** Request body for the core wizard submit, `POST /assignments/phone` (§7.6). */
export interface PhoneAssignmentPayload {
  employeeId: string
  workIdentityId?: string | null
  phoneAssetId: string
  imei: string | null
  sim1Number?: string | null
  sim1AssetId?: string | null
  wa1Business: boolean
  wa1PhoneNumber?: string | null
  wa1BackupEmail?: string | null
  wa1BackupDate?: string | null // "YYYY-MM-DD"
  wa1BackupUsedGB?: number | null
  wa1BackupTotalGB?: number | null
  wa1ChatNormalCount?: number | null
  wa1ChatArchivedCount?: number | null
  wa1AppVariant?: WaVariant | null
  sim2Number?: string | null
  sim2AssetId?: string | null
  wa2Business?: boolean | null
  wa2PhoneNumber?: string | null
  wa2BackupEmail?: string | null
  wa2BackupDate?: string | null
  wa2BackupUsedGB?: number | null
  wa2BackupTotalGB?: number | null
  wa2ChatNormalCount?: number | null
  wa2ChatArchivedCount?: number | null
  wa2AppVariant?: WaVariant | null
  bitrixAccountId?: string | null
  chargerCableAssetId?: string | null
  chargerAdapterAssetId?: string | null
  expectedReturnAt?: string | null
  notes?: string | null
  /** On-the-fly work identity (CHANGE 4) — a manually typed name + department (+ room for call-centers). */
  workIdentity?: WorkIdentityInput
}

/** Request body for `POST /assignments/generic` — any non-phone asset (CHANGE 1, BE-5). */
export interface GenericAssignmentPayload {
  type: string
  employeeId: string
  workIdentityId?: string | null
  workIdentity?: WorkIdentityInput
  assetId: string
  /** Optional bundled accessories (monitor/mouse/keyboard/headphone…) — created as BUNDLED items (BE-18). */
  accessoryAssetIds?: string[]
  conditionAtHandover: string
  expectedReturnAt?: string | null
  notes?: string | null
}

/* ---------- Return / handback (contract §8) ---------- */

/** Pre-filled out-state for the two-column comparison (§8.1). */
export interface ReturnOutState {
  employeeFullName: string
  workIdentityName: string
  assetCode: string
  assetName: string
  condition: Condition | string
  wa1ChatNormalCount: number | null
  wa1ChatArchivedCount: number | null
  wa1BackupDate: string | null
  wa1BackupUsedGB: number | null
  wa1BackupTotalGB: number | null
  wa1BackupEmail?: string | null
  wa2ChatNormalCount: number | null
  wa2ChatArchivedCount: number | null
  wa2BackupDate: string | null
  wa2BackupUsedGB: number | null
  wa2BackupTotalGB: number | null
  wa2BackupEmail?: string | null
  sim1Number: string | null
  sim2Number: string | null
  bitrixAccountId: string | null
  chargerCableAssetId: string | null
  chargerAdapterAssetId: string | null
  /** Readable dropdown options for the id fields (BE-1). Absent on older backends. */
  options?: {
    bitrixAccounts: SelectOption[]
    chargerCables: SelectOption[]
    chargerAdapters: SelectOption[]
  }
}

export interface ReturnForm {
  assignmentId: string
  assignmentCode: string
  out: ReturnOutState
  /** Photos taken at handover (BE-1) — shown old-vs-new against return photos. */
  handoverPhotos?: Photo[]
}

/** Return-state submit body (§8.2). Omitted keys = unchanged (copied from out). */
export interface ReturnPayload {
  returnCondition: string
  returnNotes?: string | null
  return: {
    wa1ChatNormalCount?: number | null
    wa1ChatArchivedCount?: number | null
    wa1BackupDate?: string | null
    wa1BackupUsedGB?: number | null
    wa1BackupTotalGB?: number | null
    wa1BackupEmail?: string | null
    wa2ChatNormalCount?: number | null
    wa2ChatArchivedCount?: number | null
    wa2BackupDate?: string | null
    wa2BackupUsedGB?: number | null
    wa2BackupTotalGB?: number | null
    wa2BackupEmail?: string | null
    sim1Number?: string | null
    sim2Number?: string | null
    bitrixAccountId?: string | null
    chargerCableAssetId?: string | null
    chargerAdapterAssetId?: string | null
    newPhotos?: string[]
  }
}

export const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const
export type Severity = (typeof SEVERITIES)[number]

export interface ComparisonField {
  fieldKey: string
  label: string
  valueAtHandover: unknown
  valueAtReturn: unknown
  isDiscrepancy: boolean
  severity: Severity
}

export interface ReturnResult {
  assignmentId: string
  assignmentCode: string
  status: string
  returnedAt?: string | null
  hasDiscrepancies: boolean
  discrepancies?: ComparisonField[]
  comparison: ComparisonField[]
  /** Old (handover) vs new (return) image sets (BE-1) — `{handover, return}`. */
  photos?: { handover?: Photo[]; return?: Photo[] }
}

export interface ListResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

/* ---------- Reports (contract §10) ---------- */

export const REPORT_SLUGS = [
  'who-has-what',
  'condition',
  'backup-staleness',
  'outstanding-assignments',
  'room-composition',
] as const
export type ReportSlug = (typeof REPORT_SLUGS)[number]

/** §10.1 — current holder + device for a scope. */
export interface WhoHasWhatRow {
  employeeFullName: string
  workIdentityName: string
  roomCode: string
  assetCode: string
  assetName: string
  categoryName: string
  assignmentCode: string
  assignedAt: string | null
  expectedReturnAt: string | null
}

/** §10.2 — asset condition distribution per category. */
export interface ConditionRow {
  categoryName: string
  condition: string
  count: number
}

/** §10.3 — phones whose last WhatsApp backup is stale. */
export interface BackupStalenessRow {
  assetCode: string
  assetName: string
  wa1PhoneNumber: string | null
  wa1BackupDate: string | null
  wa1BackupUsedGB: number | null
  daysSinceBackup: number
  employeeFullName: string
  workIdentityName: string
}

/** §10.4 — open assignments past expected return. */
export interface OutstandingAssignmentRow {
  assignmentCode: string
  type: string
  status: string
  employeeFullName: string
  assetCode: string
  assignedAt: string | null
  expectedReturnAt: string | null
  daysOverdue: number
}

/** §10.5 — employees + work identities per room. */
export interface RoomCompositionRow {
  roomCode: string
  managerFullName: string
  employeeFullName: string
  workIdentityName: string
  assignedAssetCodes: string[]
}

export type ReportRow =
  | WhoHasWhatRow
  | ConditionRow
  | BackupStalenessRow
  | OutstandingAssignmentRow
  | RoomCompositionRow

/** Query filters accepted by the report endpoints (contract §10). */
export interface ReportFilters {
  scope?: string
  roomId?: string
  departmentTeamId?: string
  categoryId?: string
  status?: string
  days?: number
  page?: number
  pageSize?: number
}

export type ExportFormat = 'csv' | 'xlsx'
