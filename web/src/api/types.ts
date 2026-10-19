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

export interface ListResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}
