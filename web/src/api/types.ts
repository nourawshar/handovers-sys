// Domain types. Field names follow README §5 (data model) until docs/API_CONTRACT.md exists.
// Any divergence is isolated in src/api/normalize.ts so the contract can be reconciled in one place.

export type Role = 'ADMIN' | 'MANAGER' | 'TEAM_LEADER'

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
  workIdentityId: string
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
