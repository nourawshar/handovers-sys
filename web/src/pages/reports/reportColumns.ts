import { createElement, type ReactNode } from 'react'
import type { ReportRow, ReportSlug } from '@/api/types'
import { ConditionBadge, StatusBadge } from '@/components/ui'
import { fmtDate, titleCase } from '@/lib/utils'

/**
 * Per-report column definitions (contract §10). `key` is the row field name (used for the export
 * header too), `header` is the humanised label, `render` produces the cell content.
 * (This file is `.ts` per the plan, so cells are built with `createElement` rather than JSX.)
 */
export interface ReportColumn {
  key: string
  header: string
  render: (row: ReportRow) => ReactNode
}

const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v))
const date = (v: unknown) => (v ? fmtDate(String(v)) : '—')
const mono = (v: unknown) => createElement('span', { className: 'font-mono text-xs' }, dash(v))
const red = (v: unknown) => createElement('span', { className: 'font-semibold text-red-600' }, dash(v))

export const REPORT_COLUMNS: Record<ReportSlug, ReportColumn[]> = {
  'who-has-what': [
    { key: 'employeeFullName', header: 'Employee', render: (r) => dash((r as { employeeFullName?: string }).employeeFullName) },
    { key: 'workIdentityName', header: 'Work identity', render: (r) => dash((r as { workIdentityName?: string }).workIdentityName) },
    { key: 'roomCode', header: 'Room', render: (r) => dash((r as { roomCode?: string }).roomCode) },
    { key: 'assetCode', header: 'Asset code', render: (r) => mono((r as { assetCode?: string }).assetCode) },
    { key: 'assetName', header: 'Asset', render: (r) => dash((r as { assetName?: string }).assetName) },
    { key: 'categoryName', header: 'Category', render: (r) => dash((r as { categoryName?: string }).categoryName) },
    { key: 'assignmentCode', header: 'Assignment', render: (r) => mono((r as { assignmentCode?: string }).assignmentCode) },
    { key: 'assignedAt', header: 'Assigned', render: (r) => date((r as { assignedAt?: string | null }).assignedAt) },
    { key: 'expectedReturnAt', header: 'Expected return', render: (r) => date((r as { expectedReturnAt?: string | null }).expectedReturnAt) },
  ],
  condition: [
    { key: 'categoryName', header: 'Category', render: (r) => dash((r as { categoryName?: string }).categoryName) },
    { key: 'condition', header: 'Condition', render: (r) => createElement(ConditionBadge, { value: (r as { condition?: string }).condition }) },
    { key: 'count', header: 'Count', render: (r) => createElement('span', { className: 'font-semibold' }, dash((r as { count?: number }).count)) },
  ],
  'backup-staleness': [
    { key: 'assetCode', header: 'Asset code', render: (r) => mono((r as { assetCode?: string }).assetCode) },
    { key: 'assetName', header: 'Asset', render: (r) => dash((r as { assetName?: string }).assetName) },
    { key: 'wa1PhoneNumber', header: 'WA1 phone', render: (r) => mono((r as { wa1PhoneNumber?: string | null }).wa1PhoneNumber) },
    { key: 'wa1BackupDate', header: 'Last backup', render: (r) => date((r as { wa1BackupDate?: string | null }).wa1BackupDate) },
    { key: 'wa1BackupUsedGB', header: 'Backup (GB)', render: (r) => dash((r as { wa1BackupUsedGB?: number | null }).wa1BackupUsedGB) },
    { key: 'daysSinceBackup', header: 'Days since backup', render: (r) => red((r as { daysSinceBackup?: number }).daysSinceBackup) },
    { key: 'employeeFullName', header: 'Employee', render: (r) => dash((r as { employeeFullName?: string }).employeeFullName) },
    { key: 'workIdentityName', header: 'Work identity', render: (r) => dash((r as { workIdentityName?: string }).workIdentityName) },
  ],
  'outstanding-assignments': [
    { key: 'assignmentCode', header: 'Assignment', render: (r) => mono((r as { assignmentCode?: string }).assignmentCode) },
    { key: 'type', header: 'Type', render: (r) => titleCase(String((r as { type?: string }).type ?? '')) },
    { key: 'status', header: 'Status', render: (r) => createElement(StatusBadge, { value: (r as { status?: string }).status }) },
    { key: 'employeeFullName', header: 'Employee', render: (r) => dash((r as { employeeFullName?: string }).employeeFullName) },
    { key: 'assetCode', header: 'Asset code', render: (r) => mono((r as { assetCode?: string }).assetCode) },
    { key: 'assignedAt', header: 'Assigned', render: (r) => date((r as { assignedAt?: string | null }).assignedAt) },
    { key: 'expectedReturnAt', header: 'Expected return', render: (r) => date((r as { expectedReturnAt?: string | null }).expectedReturnAt) },
    { key: 'daysOverdue', header: 'Days overdue', render: (r) => red((r as { daysOverdue?: number }).daysOverdue) },
  ],
  'room-composition': [
    { key: 'roomCode', header: 'Room', render: (r) => dash((r as { roomCode?: string }).roomCode) },
    { key: 'managerFullName', header: 'Manager', render: (r) => dash((r as { managerFullName?: string }).managerFullName) },
    { key: 'employeeFullName', header: 'Employee', render: (r) => dash((r as { employeeFullName?: string }).employeeFullName) },
    { key: 'workIdentityName', header: 'Work identity', render: (r) => dash((r as { workIdentityName?: string }).workIdentityName) },
    {
      key: 'assignedAssetCodes',
      header: 'Assigned assets',
      render: (r) => {
        const codes = (r as { assignedAssetCodes?: string[] }).assignedAssetCodes ?? []
        return codes.length ? createElement('span', { className: 'font-mono text-xs' }, codes.join(', ')) : '—'
      },
    },
  ],
}
