import { useSearchParams } from 'react-router-dom'
import { Download } from 'lucide-react'
import { useCategories, useDepartments, useExportReport, useReport, useRooms } from '@/api/hooks'
import { CONDITIONS, REPORT_SLUGS, type ExportFormat, type ReportFilters, type ReportSlug } from '@/api/types'
import { useAuthStore } from '@/store/auth'
import { isAdmin } from '@/lib/permissions'
import { titleCase } from '@/lib/utils'
import { Button, EmptyState, ErrorState, PageHeader, Pagination, Select, Spinner, TableWrap } from '@/components/ui'
import { REPORT_COLUMNS } from './reportColumns'

const PAGE_SIZE = 25

const REPORT_LABELS: Record<ReportSlug, string> = {
  'who-has-what': 'Who has what',
  condition: 'Condition',
  'backup-staleness': 'Backup staleness',
  'outstanding-assignments': 'Outstanding assignments',
  'room-composition': 'Room composition',
}

const REPORT_DESCRIPTIONS: Record<ReportSlug, string> = {
  'who-has-what': 'Current holder and device for a room, team or category.',
  condition: 'Asset condition distribution per category.',
  'backup-staleness': 'Phones whose last WhatsApp backup is stale (default > 7 days).',
  'outstanding-assignments': 'Open assignments past their expected return date.',
  'room-composition': 'Employees and work identities per room, with their assigned assets.',
}

export default function ReportsPage() {
  const user = useAuthStore((s) => s.user)
  const isLeader = user?.role === 'TEAM_LEADER'
  const canExport = isAdmin(user) || user?.role === 'MANAGER'

  const [sp, setSp] = useSearchParams()
  const report = (REPORT_SLUGS as readonly string[]).includes(sp.get('report') ?? '')
    ? (sp.get('report') as ReportSlug)
    : 'who-has-what'

  const scope = sp.get('scope') ?? 'room'
  const roomId = sp.get('roomId') ?? ''
  const departmentTeamId = sp.get('departmentTeamId') ?? ''
  const categoryId = sp.get('categoryId') ?? ''
  const status = sp.get('status') ?? ''
  const days = sp.get('days') ?? ''
  const page = Number(sp.get('page') ?? 1)
  const format = (sp.get('format') as ExportFormat) === 'xlsx' ? 'xlsx' : 'csv'

  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k))
    if (!('page' in patch)) next.delete('page')
    setSp(next, { replace: true })
  }

  // Lookup data for the scope pickers (ADMIN/MANAGER only).
  const rooms = useRooms()
  const departments = useDepartments()
  const categories = useCategories()

  // Build the query filters for the active report. TEAM_LEADER sends no scope filters — the server
  // enforces their own-room scope (contract §11, R3).
  const filters: ReportFilters = { page, pageSize: PAGE_SIZE }
  if (!isLeader) {
    if (report === 'who-has-what') {
      filters.scope = scope
      if (scope === 'room' && roomId) filters.roomId = roomId
      if (scope === 'team' && departmentTeamId) filters.departmentTeamId = departmentTeamId
      if (scope === 'category' && categoryId) filters.categoryId = categoryId
    } else if (report === 'condition') {
      if (categoryId) filters.categoryId = categoryId
      if (status) filters.status = status
    } else if (report === 'backup-staleness' || report === 'outstanding-assignments') {
      if (days) filters.days = Number(days)
    } else if (report === 'room-composition') {
      if (roomId) filters.roomId = roomId
    }
  }

  const list = useReport(report, filters)
  const exportMutation = useExportReport()
  const columns = REPORT_COLUMNS[report]

  const doExport = () => {
    exportMutation.mutate({ slug: report, filters, format })
  }

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Read-only operational reports"
        actions={canExport && (
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-lg border border-slate-300 text-xs">
              {(['csv', 'xlsx'] as ExportFormat[]).map((f) => (
                <button
                  key={f}
                  onClick={() => set({ format: f })}
                  className={format === f ? 'bg-brand-600 px-2.5 py-1.5 font-medium text-white' : 'bg-white px-2.5 py-1.5 text-slate-600 hover:bg-slate-50'}
                >{f.toUpperCase()}</button>
              ))}
            </div>
            <Button size="sm" onClick={doExport} loading={exportMutation.isPending}>
              <Download className="h-4 w-4" /> Export {format.toUpperCase()}
            </Button>
          </div>
        )}
      />

      {/* Report picker (segmented control) */}
      <div className="mb-4 flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1">
        {REPORT_SLUGS.map((slug) => (
          <button
            key={slug}
            onClick={() => set({ report: slug })}
            className={report === slug
              ? 'rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white'
              : 'rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100'}
          >{REPORT_LABELS[slug]}</button>
        ))}
      </div>

      <p className="mb-4 text-sm text-slate-500">{REPORT_DESCRIPTIONS[report]}</p>

      {isLeader && (
        <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm text-sky-800">
          Your room only — this report is scoped to <span className="font-semibold">{user?.room?.code ?? 'your room'}</span>.
        </div>
      )}

      {/* Scope filters (hidden for TEAM_LEADER) */}
      {!isLeader && (
        <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          {report === 'who-has-what' && (
            <>
              <Select value={scope} onChange={(e) => set({ scope: e.target.value })} aria-label="Scope">
                <option value="room">By room</option>
                <option value="team">By team</option>
                <option value="category">By category</option>
              </Select>
              {scope === 'room' && (
                <Select value={roomId} onChange={(e) => set({ roomId: e.target.value })} aria-label="Room">
                  <option value="">All rooms</option>
                  {rooms.data?.map((r) => <option key={r.id} value={r.id}>{r.code}</option>)}
                </Select>
              )}
              {scope === 'team' && (
                <Select value={departmentTeamId} onChange={(e) => set({ departmentTeamId: e.target.value })} aria-label="Team">
                  <option value="">All teams</option>
                  {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              )}
              {scope === 'category' && (
                <Select value={categoryId} onChange={(e) => set({ categoryId: e.target.value })} aria-label="Category">
                  <option value="">All categories</option>
                  {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              )}
            </>
          )}

          {report === 'condition' && (
            <>
              <Select value={categoryId} onChange={(e) => set({ categoryId: e.target.value })} aria-label="Category">
                <option value="">All categories</option>
                {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
              <Select value={status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
                <option value="">Any status</option>
                {CONDITIONS.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
              </Select>
            </>
          )}

          {(report === 'backup-staleness' || report === 'outstanding-assignments') && (
            <label className="flex flex-col gap-1">
              <span className="label">Days override</span>
              <input
                type="number"
                min={0}
                value={days}
                onChange={(e) => set({ days: e.target.value })}
                placeholder={report === 'backup-staleness' ? 'Default 7' : 'Any overdue'}
                className="input"
                aria-label="Days override"
              />
            </label>
          )}

          {report === 'room-composition' && (
            <Select value={roomId} onChange={(e) => set({ roomId: e.target.value })} aria-label="Room">
              <option value="">All rooms</option>
              {rooms.data?.map((r) => <option key={r.id} value={r.id}>{r.code}</option>)}
            </Select>
          )}
        </div>
      )}

      <div className="card overflow-hidden">
        {list.isLoading ? <Spinner /> : list.isError ? (
          <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div>
        ) : !list.data?.items.length ? (
          <EmptyState title="No rows for this report" hint="Try adjusting the filters or scope." />
        ) : (
          <>
            <TableWrap>
              <thead className="bg-slate-50">
                <tr>{columns.map((c) => <th key={c.key} className="th">{c.header}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.items.map((row, i) => (
                  <tr key={i} className="hover:bg-slate-50">
                    {columns.map((c) => <td key={c.key} className="td">{c.render(row)}</td>)}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onChange={(p) => set({ page: String(p) })} />
          </>
        )}
      </div>
    </>
  )
}
