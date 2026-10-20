import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRightLeft, Camera, X } from 'lucide-react'
import { useAssignmentDetail, useAssignmentTimeline } from '@/api/hooks'
import type { PhoneAssignmentDetail } from '@/api/types'
import { useAuthStore } from '@/store/auth'
import { can } from '@/lib/permissions'
import { fmtDate, titleCase } from '@/lib/utils'
import { Badge, Button, EmptyState, ErrorState, Pagination, Spinner, StatusBadge } from '@/components/ui'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 break-words text-slate-900">{children || '—'}</dd>
    </div>
  )
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

interface AssignmentDrawerProps {
  assignmentId: string
  onClose: () => void
}

export default function AssignmentDrawer({ assignmentId, onClose }: AssignmentDrawerProps) {
  const user = useAuthStore((s) => s.user)
  const { data, isLoading, isError, error, refetch } = useAssignmentDetail(assignmentId)
  const [tlPage, setTlPage] = useState(1)
  const tl = useAssignmentTimeline(assignmentId, tlPage)
  const isAdmin = can(user?.role, 'assets.new')

  // Lock background scroll while the drawer is open so the phone timeline keeps its position.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Close on Escape, mirroring an accessible dialog.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Assignment detail">
      <div
        className="absolute inset-0 bg-slate-900/50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-5">
          <div className="min-w-0">
            {isLoading ? <Spinner /> : isError || !data ? (
              <ErrorState error={error} onRetry={() => refetch()} />
            ) : (
              <>
                <p className="font-mono text-xs font-semibold text-brand-700">{data.assignmentCode}</p>
                <h2 className="text-lg font-semibold text-slate-900">{data.asset?.name ?? 'Assignment'}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge>{titleCase(data.type)}</Badge><StatusBadge value={data.status} />
                  {data.employee && <span className="text-sm text-slate-600">{data.employee.fullName}</span>}
                  {data.workIdentity && <span className="text-sm text-slate-500">· {data.workIdentity.name}</span>}
                </div>
                {isAdmin && data.status === 'ACTIVE' && (
                  <Link to={`/assignments/${data.id}/return`} className="mt-3 inline-block">
                    <Button size="sm"><ArrowRightLeft className="h-4 w-4" /> Return</Button>
                  </Link>
                )}
              </>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {isLoading ? (
          <div className="p-5"><Spinner /></div>
        ) : isError || !data ? (
          <div className="p-5"><ErrorState error={error} onRetry={() => refetch()} /></div>
        ) : (
          <div className="flex-1 space-y-6 overflow-y-auto p-5">
            <div className="card p-5">
              <h2 className="mb-1 text-sm font-semibold text-slate-900">Information</h2>
              <dl className="divide-y divide-slate-100">
                <Row label="Employee">{data.employee?.fullName}</Row>
                <Row label="Work identity">{data.workIdentity?.name}</Row>
                <Row label="Asset">{data.asset ? <Link to={`/assets/${data.asset.id}`} className="text-brand-700 hover:underline">{data.asset.code} · {data.asset.name}</Link> : '—'}</Row>
                <Row label="Assigned">{fmtDate(data.assignedAt, true)}</Row>
                <Row label="Expected return">{fmtDate(data.expectedReturnAt)}</Row>
                <Row label="Returned">{fmtDate(data.returnedAt, true)}</Row>
                <Row label="Notes">{data.notes}</Row>
              </dl>
            </div>

            {data.phoneDetail && <PhoneDetailPanel pd={data.phoneDetail} />}

            {data.items.length > 0 && (
              <div className="card p-5">
                <h2 className="mb-1 text-sm font-semibold text-slate-900">Items</h2>
                <dl className="divide-y divide-slate-100">
                  {data.items.map((it) => (
                    <Row key={it.id} label={titleCase(it.role)}>
                      {it.asset ? `${it.asset.code} · ${it.asset.name}` : '—'}
                      {it.conditionAtHandover && <span className="ml-2 text-xs text-slate-500">handover {titleCase(it.conditionAtHandover)}</span>}
                      {it.returnCondition && <span className="ml-2 text-xs text-slate-500">return {titleCase(it.returnCondition)}</span>}
                    </Row>
                  ))}
                </dl>
              </div>
            )}

            <div className="card p-5">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900"><Camera className="h-4 w-4" /> Photos</h2>
              {data.photos.length === 0 ? (
                <EmptyState title="No photos" hint="Front/back photos captured at handover appear here." />
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {data.photos.map((p) => (
                    <div key={p.id} className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                      <img src={p.url} alt={`${p.type} photo`} loading="lazy" className="aspect-square w-full object-cover" />
                      <span className="block px-2 py-1 text-xs text-slate-500">{titleCase(p.type)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold text-slate-900">Timeline</h2>
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
          </div>
        )}
      </div>
    </div>
  )
}
