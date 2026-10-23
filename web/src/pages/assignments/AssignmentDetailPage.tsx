import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRightLeft, Camera, Printer } from 'lucide-react'
import { useAssignmentDetail, useAssignmentTimeline } from '@/api/hooks'
import type { PhoneAssignmentDetail } from '@/api/types'
import { useAuthStore } from '@/store/auth'
import { can } from '@/lib/permissions'
import { fmtDate, titleCase } from '@/lib/utils'
import { Badge, Button, EmptyState, ErrorState, Pagination, Spinner, StatusBadge, Tabs } from '@/components/ui'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 break-words text-slate-900">{children || '—'}</dd>
    </div>
  )
}

/** Safely convert an unknown value to a display string. */
function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return '—'
  return String(v)
}

/** Shape of the `returnState` captured in a RETURNED timeline entry snapshot. */
interface ReturnStateData {
  condition?: string | null
  returnCondition?: string | null
  wa1ChatNormalCount?: unknown
  wa1ChatArchivedCount?: unknown
  wa1BackupDate?: string | null
  wa1BackupUsedGB?: unknown
  wa1BackupTotalGB?: unknown
  wa2ChatNormalCount?: unknown
  wa2ChatArchivedCount?: unknown
  wa2BackupDate?: string | null
  wa2BackupUsedGB?: unknown
  wa2BackupTotalGB?: unknown
  sim1Number?: string | null
  sim2Number?: string | null
  bitrixAccountId?: string | null
  chargerCableAssetId?: string | null
  chargerAdapterAssetId?: string | null
}

const backupStr = (used: number | null, total: number | null) => {
  if (used === null && total === null) return 'not recorded'
  return `${used ?? '—'} GB of ${total ?? '—'} GB`
}

function PhoneDetailPanel({ pd }: { pd: PhoneAssignmentDetail }) {
  return (
    <div className="card p-5">
      <h2 className="mb-1 text-sm font-semibold text-slate-900">Phone assignment detail</h2>
      <dl className="divide-y divide-slate-100">
        <Row label="SIM 1">{pd.sim1Number && <span className="font-mono">{pd.sim1Number}</span>}</Row>
        <Row label="WhatsApp 1">{pd.wa1Business ? 'Business' : 'Normal'} · {pd.wa1PhoneNumber}</Row>
        <Row label="Backup email 1">{pd.wa1BackupEmail}</Row>
        <Row label="Last backup 1">{pd.wa1BackupDate ? fmtDate(pd.wa1BackupDate) : '—'} · {backupStr(pd.wa1BackupUsedGB, pd.wa1BackupTotalGB)}</Row>
        <Row label="Chats 1">normal {pd.wa1ChatNormalCount ?? 0} · archived {pd.wa1ChatArchivedCount ?? 0}</Row>
        <Row label="App variant 1">{pd.wa1AppVariant && titleCase(pd.wa1AppVariant)}</Row>
        {pd.sim2Number && (
          <>
            <Row label="SIM 2">{pd.sim2Number && <span className="font-mono">{pd.sim2Number}</span>}</Row>
            <Row label="WhatsApp 2">{pd.wa2Business ? 'Business' : 'Normal'} · {pd.wa2PhoneNumber}</Row>
            <Row label="Backup email 2">{pd.wa2BackupEmail}</Row>
            <Row label="Last backup 2">{pd.wa2BackupDate ? fmtDate(pd.wa2BackupDate) : '—'} · {backupStr(pd.wa2BackupUsedGB, pd.wa2BackupTotalGB)}</Row>
            <Row label="Chats 2">normal {pd.wa2ChatNormalCount ?? 0} · archived {pd.wa2ChatArchivedCount ?? 0}</Row>
            <Row label="App variant 2">{pd.wa2AppVariant && titleCase(pd.wa2AppVariant)}</Row>
          </>
        )}
        <Row label="Bitrix account">{pd.bitrixAccountId && <span className="font-mono">{pd.bitrixAccountId}</span>}</Row>
        <Row label="Charger cable">{pd.chargerCableAssetId && <span className="font-mono">{pd.chargerCableAssetId}</span>}</Row>
        <Row label="Charger adapter">{pd.chargerAdapterAssetId && <span className="font-mono">{pd.chargerAdapterAssetId}</span>}</Row>
      </dl>
    </div>
  )
}

const eventTone: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'violet' | 'slate'> = {
  ASSIGNED: 'blue', RETURNED: 'green', REASSIGNED: 'violet', UPDATED: 'slate', DISCREPANCY: 'red', NOTE: 'amber',
}

function TimelineItem({ e }: { e: { id: string; eventType: string; createdAt?: string; createdBy?: { fullName: string } | null; snapshot?: Record<string, unknown> | null } }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="relative">
      <span className="absolute -left-[31px] top-1 h-3 w-3 rounded-full border-2 border-white bg-brand-500 ring-2 ring-brand-200" />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={eventTone[e.eventType] ?? 'slate'}>{titleCase(e.eventType)}</Badge>
        <span className="text-xs text-slate-500">{fmtDate(e.createdAt, true)}</span>
        {e.createdBy && <span className="text-xs text-slate-400">by {e.createdBy.fullName}</span>}
      </div>
      {e.snapshot && (
        <>
          <button onClick={() => setOpen((o) => !o)} className="mt-1 text-xs font-medium text-brand-700 hover:underline">{open ? 'Hide' : 'Show'} snapshot</button>
          {open && <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{JSON.stringify(e.snapshot, null, 2)}</pre>}
        </>
      )}
    </li>
  )
}

export default function AssignmentDetailPage() {
  const { id } = useParams()
  const user = useAuthStore((s) => s.user)
  const { data, isLoading, isError, error, refetch } = useAssignmentDetail(id)
  const [tab, setTab] = useState<'details' | 'timeline'>('details')
  const [tlPage, setTlPage] = useState(1)
  const tl = useAssignmentTimeline(id, tlPage)
  const isAdmin = can(user?.role, 'assets.new')

  if (isLoading) return <Spinner />
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />
  const a = data

  // Find the latest RETURNED timeline entry to show the return record (delivery + return data).
  const retEntry = tl.data?.items?.find((e) => e.eventType === 'RETURNED') ?? null
  const retState: ReturnStateData | null = retEntry?.snapshot
    ? ((retEntry.snapshot as Record<string, unknown>).returnState as ReturnStateData)
    : null

  /** Safely convert an unknown value to a display string. */

  return (
    <>
      <Link to="/assignments" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Assignments</Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs font-semibold text-brand-700">{a.assignmentCode}</p>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{a.asset?.name ?? 'Assignment'}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge>{titleCase(a.type)}</Badge><StatusBadge value={a.status} />
            {a.employee && <span className="text-sm text-slate-600">{a.employee.fullName}</span>}
            {a.workIdentity && <span className="text-sm text-slate-500">· {a.workIdentity.name}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/assignments/${a.id}/receipt`}><Button variant="secondary"><Printer className="h-4 w-4" /> Print receipt</Button></Link>
          {isAdmin && a.status === 'ACTIVE' && (
            <Link to={`/assignments/${a.id}/return`}><Button><ArrowRightLeft className="h-4 w-4" /> Return device</Button></Link>
          )}
        </div>
      </div>

      <Tabs
        tabs={[{ id: 'details', label: 'Details' }, { id: 'timeline', label: 'Timeline' }]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'timeline' ? (
        <div className="card p-5">
          {tl.isLoading ? <Spinner /> : tl.isError ? <ErrorState error={tl.error} onRetry={() => tl.refetch()} /> : tl.data?.items.length === 0 ? (
            <EmptyState title="No history yet" hint="Assignment events will appear here." />
          ) : (
            <>
              <ol className="relative ml-2 space-y-5 border-l border-slate-200 pl-6">
                {tl.data?.items.map((e) => <TimelineItem key={e.id} e={e} />)}
              </ol>
              <Pagination page={tl.data?.page ?? 1} pageSize={tl.data?.pageSize ?? 20} total={tl.data?.total ?? 0} onChange={setTlPage} />
            </>
          )}
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-6 lg:col-span-3">
            <div className="card p-5">
              <h2 className="mb-1 text-sm font-semibold text-slate-900">Information</h2>
              <dl className="divide-y divide-slate-100">
                <Row label="Employee">{a.employee?.fullName}</Row>
                <Row label="Work identity">{a.workIdentity?.name}</Row>
                <Row label="Asset">{a.asset ? <Link to={`/assets/${a.asset.id}`} className="text-brand-700 hover:underline">{a.asset.code} · {a.asset.name}</Link> : '—'}</Row>
                <Row label="Assigned">{fmtDate(a.assignedAt, true)}</Row>
                <Row label="Expected return">{fmtDate(a.expectedReturnAt)}</Row>
                <Row label="Returned">{fmtDate(a.returnedAt, true)}</Row>
                <Row label="Notes">{a.notes}</Row>
              </dl>
            </div>
            {a.phoneDetail && <PhoneDetailPanel pd={a.phoneDetail} />}
            {a.items.length > 0 && (
              <div className="card p-5">
                <h2 className="mb-1 text-sm font-semibold text-slate-900">Items</h2>
                <dl className="divide-y divide-slate-100">
                  {a.items.map((it) => (
                    <Row key={it.id} label={titleCase(it.role)}>
                      {it.asset ? `${it.asset.code} · ${it.asset.name}` : '—'}
                      {it.conditionAtHandover && <span className="ml-2 text-xs text-slate-500">handover {titleCase(it.conditionAtHandover)}</span>}
                      {it.returnCondition && <span className="ml-2 text-xs text-slate-500">return {titleCase(it.returnCondition)}</span>}
                    </Row>
                  ))}
                </dl>
              </div>
            )}
            {a.status === 'RETURNED' && retState && (
              <div className="card p-5">
                <h2 className="mb-1 text-sm font-semibold text-slate-900">Return record</h2>
                <dl className="divide-y divide-slate-100 text-sm">
                  <Row label="Condition">{retEntry?.snapshot ? (retEntry.snapshot as Record<string, unknown>).returnCondition ? titleCase(String((retEntry.snapshot as Record<string, unknown>).returnCondition)) : '—' : '—'}</Row>
                  <Row label="Chats 1 (normal)">{fmtVal(retState?.wa1ChatNormalCount as string)}</Row>
                  <Row label="Chats 1 (archived)">{fmtVal(retState?.wa1ChatArchivedCount as string)}</Row>
                  <Row label="Backup date 1">{retState?.wa1BackupDate ? fmtDate(retState.wa1BackupDate as string) : '—'}</Row>
                  <Row label="Backup size 1">{fmtVal(retState?.wa1BackupUsedGB as string)} GB of {fmtVal(retState?.wa1BackupTotalGB as string)} GB</Row>
                  <Row label="Chats 2 (normal)">{fmtVal(retState?.wa2ChatNormalCount as string)}</Row>
                  <Row label="Chats 2 (archived)">{fmtVal(retState?.wa2ChatArchivedCount as string)}</Row>
                  <Row label="Backup date 2">{retState?.wa2BackupDate ? fmtDate(retState.wa2BackupDate as string) : '—'}</Row>
                  <Row label="Backup size 2">{fmtVal(retState?.wa2BackupUsedGB as string)} GB of {fmtVal(retState?.wa2BackupTotalGB as string)} GB</Row>
                  <Row label="SIM 1">{fmtVal(retState?.sim1Number as string)}</Row>
                  <Row label="SIM 2">{fmtVal(retState?.sim2Number as string)}</Row>
                  <Row label="Bitrix">{fmtVal(retState?.bitrixAccountId as string)}</Row>
                  <Row label="Charger cable">{fmtVal(retState?.chargerCableAssetId as string)}</Row>
                  <Row label="Charger adapter">{fmtVal(retState?.chargerAdapterAssetId as string)}</Row>
                </dl>
              </div>
            )}
          </div>
          <div className="lg:col-span-2">
            <div className="card p-5">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900"><Camera className="h-4 w-4" /> Photos</h2>
              {a.photos.length === 0 ? (
                <EmptyState title="No photos" hint="Front/back photos captured at handover appear here." />
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {a.photos.map((p) => (
                    <div key={p.id} className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                      <img src={p.url} alt={`${p.type} photo`} loading="lazy" className="aspect-square w-full object-cover" />
                      <span className="block px-2 py-1 text-xs text-slate-500">{titleCase(p.type)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
