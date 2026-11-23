import { useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Camera, Pencil, Search, Trash2 } from 'lucide-react'
import { useAsset, useAssetHandoverHistory, useAssetTimeline, useCategories, useDeleteAsset, useUploadAssetPhotos } from '@/api/hooks'
import type { DeleteAssetResult } from '@/api/hooks'
import AssignmentDrawer from './AssignmentDrawer'
import type { Asset, HandoverChange, HandoverHistoryRow, LastConditionCheck, PhotoHistoryEntry, TimelineEntry } from '@/api/types'
import { useAuthStore } from '@/store/auth'
import { can } from '@/lib/permissions'
import { useDebounce } from '@/lib/useDebounce'
import { fmtDate, titleCase } from '@/lib/utils'
import {
  Badge, Button, ConditionBadge, EmptyState, ErrorState, Input, Pagination, Select, Spinner, StatusBadge, Tabs,
} from '@/components/ui'

const PHOTO_TYPES = ['FRONT', 'BACK', 'CONDITION', 'GENERAL'] as const
const ACCEPT = 'image/jpeg,image/png,image/webp'
const MAX_MB = 5 // server default MAX_UPLOAD_MB=5 (server/.env)

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 break-words text-slate-900">{children || '—'}</dd>
    </div>
  )
}

function PhotosPanel({ asset, canUpload }: { asset: Asset; canUpload: boolean }) {
  const upload = useUploadAssetPhotos(asset.id)
  const inputRef = useRef<HTMLInputElement>(null)
  const [type, setType] = useState<(typeof PHOTO_TYPES)[number]>('GENERAL')
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  const onFiles = (list: FileList | null) => {
    setError(null)
    const files = Array.from(list ?? [])
    if (!files.length) return
    const bad = files.find((f) => !ACCEPT.split(',').includes(f.type))
    if (bad) return setError(`“${bad.name}” is not a JPEG, PNG or WebP image.`)
    const big = files.find((f) => f.size > MAX_MB * 1024 * 1024)
    if (big) return setError(`“${big.name}” is larger than ${MAX_MB} MB.`)
    upload.mutate({ files, type }, { onError: (e) => setError((e as Error).message) })
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div className="card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Asset photos</h2>
        {canUpload && (
          <div className="flex items-center gap-2">
            <Select value={type} onChange={(e) => setType(e.target.value as typeof type)} className="!w-auto !py-1.5 text-xs" aria-label="Photo type">
              {PHOTO_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
            </Select>
            <input ref={inputRef} type="file" accept={ACCEPT} multiple capture="environment" className="hidden" onChange={(e) => onFiles(e.target.files)} />
            <Button size="sm" variant="secondary" loading={upload.isPending} onClick={() => inputRef.current?.click()}>
              <Camera className="h-4 w-4" /> Upload
            </Button>
          </div>
        )}
      </div>
      {error && <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
      {asset.photos.length === 0 ? (
        <EmptyState title="No photos yet" hint={canUpload ? 'Upload front, back or condition photos (JPEG/PNG/WebP).' : undefined} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {asset.photos.map((p) => (
            <button key={p.id} onClick={() => setPreview(p.url)} className="group relative overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
              <img src={p.url} alt={`${p.type} of ${asset.code}`} loading="lazy" className="aspect-square w-full object-cover transition group-hover:scale-105" />
              <span className="absolute bottom-1 left-1"><Badge>{titleCase(p.type)}</Badge></span>
            </button>
          ))}
        </div>
      )}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setPreview(null)} role="dialog" aria-modal="true">
          <img src={preview} alt="Preview" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </div>
  )
}

const SOURCE_TEXT: Record<string, string> = { created: 'at creation', delivery: 'at delivery', return: 'at return', manual: 'manual edit' }

/** "Condition last recorded: Fair — at return A-000012 on 12 Nov 2026" (R4/R5). */
export function LastConditionLine({ check }: { check?: LastConditionCheck | null }) {
  if (!check) return null
  const src = SOURCE_TEXT[check.source] ?? check.source
  return (
    <p className="mt-3 text-xs text-slate-500">
      Condition last recorded: <b className="text-slate-700">{titleCase(check.condition)}</b> — {src}
      {check.assignmentCode ? ` ${check.assignmentCode}` : ''}{check.at ? ` on ${fmtDate(check.at)}` : ''}
    </p>
  )
}

function ThumbRow({ label, photos, code, onPreview }: { label: string; photos: Asset['photos']; code: string; onPreview: (url: string) => void }) {
  if (photos.length === 0) return null
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <div className="flex flex-wrap gap-2">
        {photos.map((p) => (
          <button key={p.id} onClick={() => onPreview(p.url)} className="group relative h-20 w-20 overflow-hidden rounded-lg border border-slate-200 bg-slate-100" aria-label={`${titleCase(p.type)} photo ${label.toLowerCase()}`}>
            <img src={p.url} alt={`${p.type} of ${code}`} loading="lazy" className="h-full w-full object-cover transition group-hover:scale-105" />
            <span className="absolute bottom-0.5 left-0.5"><Badge>{titleCase(p.type)}</Badge></span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Per-assignment photo timeline (R5). `onOpenAssignment` is optional (the drawer has none). */
export function PhotoHistory({ history, assetCode, onOpenAssignment }: { history: PhotoHistoryEntry[]; assetCode: string; onOpenAssignment?: (assignmentId: string) => void }) {
  const [preview, setPreview] = useState<string | null>(null)
  return (
    <div className="card p-5">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Photo history</h2>
      {history.length === 0 ? (
        <EmptyState title="No handover photos yet" hint="Photos taken at delivery or return will appear here, grouped per assignment." />
      ) : (
        <ol className="space-y-4">
          {history.map((h) => (
            <li key={h.assignmentId} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                {onOpenAssignment
                  ? <button onClick={() => onOpenAssignment(h.assignmentId)} className="font-mono text-sm font-semibold text-brand-700 hover:underline">{h.assignmentCode}</button>
                  : <span className="font-mono text-sm font-semibold text-brand-700">{h.assignmentCode}</span>}
                <StatusBadge value={h.status} />
                {h.role && <Badge>{titleCase(h.role)}</Badge>}
              </div>
              <p className="mt-1 text-sm text-slate-700">{h.employeeName || '—'}</p>
              <p className="text-xs text-slate-500">
                assigned {fmtDate(h.assignedAt)} → {h.returnedAt ? `returned ${fmtDate(h.returnedAt)}` : 'still with employee'}
              </p>
              <ThumbRow label="At handover" photos={h.handover} code={assetCode} onPreview={setPreview} />
              <ThumbRow label="At return" photos={h.return} code={assetCode} onPreview={setPreview} />
            </li>
          ))}
        </ol>
      )}
      {preview && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4" onClick={() => setPreview(null)} role="dialog" aria-modal="true">
          <img src={preview} alt="Preview" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </div>
  )
}

export function TimelineList({ assetId, embedded, onOpenAssignment }: { assetId: string; embedded?: TimelineEntry[] | null; onOpenAssignment: (assignmentId: string) => void }) {
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const dq = useDebounce(q)
  const tl = useAssetTimeline(assetId, page, dq)

  // Prefer the dedicated, paginated endpoint; fall back to a timeline embedded in the asset detail.
  const notImplemented = tl.isError && (tl.error as { status?: number })?.status === 404
  const useEmbedded = notImplemented || (tl.isError && !!embedded?.length)
  const needle = dq.trim().toLowerCase()
  const entries = useEmbedded
    ? (embedded ?? []).filter((e) => !needle || JSON.stringify(e).toLowerCase().includes(needle))
    : tl.data?.items ?? []

  return (
    <div className="card p-5">
      <div className="relative mb-4 max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder="Search history…" className="pl-9" aria-label="Search timeline" />
      </div>
      {tl.isLoading ? <Spinner /> : tl.isError && !useEmbedded ? <ErrorState error={tl.error} onRetry={() => tl.refetch()} /> : entries.length === 0 ? (
        <EmptyState title="No history yet" hint="Assignments, returns and updates for this asset will appear here." />
      ) : (
        <ol className="relative ml-2 space-y-5 border-l border-slate-200 pl-6">
          {entries.map((e) => <TimelineItem key={e.id} e={e} onOpenAssignment={onOpenAssignment} />)}
        </ol>
      )}
      {tl.data && !useEmbedded && <Pagination page={tl.data.page} pageSize={tl.data.pageSize} total={tl.data.total} onChange={setPage} />}
    </div>
  )
}

const eventTone: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'violet' | 'slate'> = {
  ASSIGNED: 'blue', RETURNED: 'green', REASSIGNED: 'violet', UPDATED: 'slate', DISCREPANCY: 'red', NOTE: 'amber',
}

function TimelineItem({ e, onOpenAssignment }: { e: TimelineEntry; onOpenAssignment: (assignmentId: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="relative">
      <span className="absolute -left-[31px] top-1 h-3 w-3 rounded-full border-2 border-white bg-brand-500 ring-2 ring-brand-200" />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={eventTone[e.eventType] ?? 'slate'}>{titleCase(e.eventType)}</Badge>
        <span className="text-xs text-slate-500">{fmtDate(e.createdAt, true)}</span>
        {e.createdBy && <span className="text-xs text-slate-400">by {e.createdBy.fullName}</span>}
      </div>
      <p className="mt-1 text-sm text-slate-700">
        {e.employee ? <>Employee <b>{e.employee.fullName}</b></> : null}
        {e.workIdentity ? <> · identity <b>{e.workIdentity.name}</b></> : null}
        {e.assignmentId ? <> · <button onClick={() => onOpenAssignment(e.assignmentId!)} className="text-brand-700 hover:underline">assignment</button></> : null}
      </p>
      {e.eventType === 'UPDATED' && e.snapshot?.field === 'condition' && (
        <p className="mt-1 text-sm text-slate-800">
          Condition changed <b>{titleCase(String(e.snapshot.from ?? '—'))}</b> → <b>{titleCase(String(e.snapshot.to ?? '—'))}</b>
          {e.snapshot.assignmentCode ? ` (at ${e.snapshot.reason === 'handover' || e.snapshot.reason === 'delivery' ? 'delivery' : 'return'} ${String(e.snapshot.assignmentCode)})` : ''}
        </p>
      )}
      {e.snapshot && (
        <>
          <button onClick={() => setOpen((o) => !o)} className="mt-1 text-xs font-medium text-brand-700 hover:underline">{open ? 'Hide' : 'Show'} snapshot</button>
          {open && <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{JSON.stringify(e.snapshot, null, 2)}</pre>}
        </>
      )}
    </li>
  )
}

const CHANGE_STYLE: Record<HandoverChange, { icon: string; cls: string; label: string }> = {
  worse: { icon: '▼', cls: 'text-red-600', label: 'worse' },
  better: { icon: '▲', cls: 'text-emerald-600', label: 'better' },
  same: { icon: '=', cls: 'text-slate-500', label: 'unchanged' },
  unknown: { icon: '—', cls: 'text-slate-400', label: 'unknown' },
}

function ReturnCondition({ row }: { row: HandoverHistoryRow }) {
  const st = CHANGE_STYLE[row.change]
  if (!row.returnCondition) return <span className="text-slate-400" aria-label="not recorded">—</span>
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${st.cls}`}>
      <span aria-hidden="true">{st.icon}</span>
      {titleCase(row.returnCondition)}
      <span className="sr-only">({st.label})</span>
    </span>
  )
}

/** Third tab: condition at each handover/return of this asset (Phase 9 P5b). */
export function ConditionHistory({ assetId }: { assetId: string }) {
  const nav = useNavigate()
  const q = useAssetHandoverHistory(assetId)
  if (q.isLoading) return <div className="card p-5"><Spinner /></div>
  if (q.isError || !q.data) return <div className="card p-5"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>
  const { current, rows } = q.data
  const open = (id: string) => nav(`/assignments/${id}`)
  return (
    <div className="card p-5">
      {current && (
        <p className="mb-4 text-sm text-slate-600">
          Now: <b className="text-slate-900">{titleCase(current.condition)}</b> — last recorded {SOURCE_TEXT[current.source] ?? current.source}
          {current.assignmentCode ? ` ${current.assignmentCode}` : ''}{current.at ? ` on ${fmtDate(current.at)}` : ''}
        </p>
      )}
      {rows.length === 0 ? (
        <EmptyState title="This asset has never been handed over" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr className="border-b border-slate-200">
                <th className="px-2 py-2 font-medium">Assignment</th>
                <th className="px-2 py-2 font-medium">Employee</th>
                <th className="px-2 py-2 font-medium">Assigned → returned</th>
                <th className="px-2 py-2 font-medium">Role</th>
                <th className="px-2 py-2 font-medium">At handover</th>
                <th className="px-2 py-2 font-medium">At return</th>
                <th className="px-2 py-2 font-medium">Return notes</th>
                <th className="px-2 py-2 font-medium">Flags</th>
                <th className="px-2 py-2 text-right font-medium">Photos</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.assignmentId}
                  tabIndex={0}
                  onClick={() => open(r.assignmentId)}
                  onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(r.assignmentId) } }}
                  className={`cursor-pointer border-b border-slate-100 align-top focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${r.change === 'worse' ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-slate-50'}`}
                >
                  <td className="px-2 py-2.5">
                    <Link to={`/assignments/${r.assignmentId}`} onClick={(e) => e.stopPropagation()} className="font-mono font-semibold text-brand-700 hover:underline">{r.assignmentCode}</Link>
                  </td>
                  <td className="px-2 py-2.5 text-slate-900">{r.employee?.fullName || '—'}</td>
                  <td className="whitespace-nowrap px-2 py-2.5 text-slate-700">{fmtDate(r.assignedAt)} → {r.returnedAt ? fmtDate(r.returnedAt) : 'still with employee'}</td>
                  <td className="px-2 py-2.5">{r.role ? <Badge>{titleCase(r.role)}</Badge> : '—'}</td>
                  <td className="px-2 py-2.5">{r.conditionAtHandover ? <ConditionBadge value={r.conditionAtHandover} /> : '—'}</td>
                  <td className="px-2 py-2.5"><ReturnCondition row={r} /></td>
                  <td className="max-w-[16rem] break-words px-2 py-2.5 text-slate-600">{r.returnNotes || '—'}</td>
                  <td className="px-2 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {r.discrepancyCount > 0 && <Badge tone="red">{r.discrepancyCount} discrepanc{r.discrepancyCount === 1 ? 'y' : 'ies'}</Badge>}
                      {r.unreturnedOpen && <Badge tone="amber">Not returned</Badge>}
                      {r.discrepancyCount === 0 && !r.unreturnedOpen && <span className="text-slate-400">—</span>}
                    </div>
                  </td>
                  <td className="px-2 py-2.5 text-right text-slate-700">{r.photoCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function AssetDetailPage({ timelineOnly = false }: { timelineOnly?: boolean }) {
  const { id } = useParams()
  const nav = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const user = useAuthStore((s) => s.user)
  const { data, isLoading, isError, error, refetch } = useAsset(id)
  const categories = useCategories()
  const [baseTab, setTab] = useState<'details' | 'timeline'>(timelineOnly ? 'timeline' : 'details')
  const tab: 'details' | 'timeline' | 'conditions' = searchParams.get('tab') === 'conditions' && !timelineOnly ? 'conditions' : baseTab
  const deleteAsset = useDeleteAsset(id ?? '')
  const [deleteMsg, setDeleteMsg] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null)

  const drawerId = searchParams.get('assignment')
  const openDrawer = (assignmentId: string) => {
    // Keep the route on /assets/:id/timeline — only the query param changes, so the
    // phone timeline scroll position is preserved while the drawer is open.
    const next = new URLSearchParams(searchParams)
    next.set('assignment', assignmentId)
    setSearchParams(next, { replace: true })
  }
  const closeDrawer = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('assignment')
    setSearchParams(next, { replace: true })
  }

  if (isLoading) return <Spinner />
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />
  const a = data.asset
  const cat = a.category?.name ?? categories.data?.find((c) => c.id === a.categoryId)?.name
  const labelFor = (k: string) => a.fieldDefinitions?.find((f) => f.key === k)?.label ?? titleCase(k)
  const customEntries = Object.entries(a.customFields).filter(([, v]) => v !== null && v !== '' && v !== undefined)
  const isAdmin = can(user?.role, 'assets.edit')

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${a.name}" (${a.code})?\n\nIf it has assignment history it will be soft-disposed (status → Disposed) so history is preserved. This cannot be undone.`)) return
    setDeleteMsg(null)
    try {
      const res: DeleteAssetResult = await deleteAsset.mutateAsync()
      const msg = res.softDeleted
        ? { kind: 'warn' as const, text: `${a.code} had history and was soft-deleted (status → Disposed).` }
        : { kind: 'ok' as const, text: `${a.code} was permanently deleted.` }
      setDeleteMsg(msg)
      nav('/assets', { state: { notice: msg }, replace: true })
    } catch (err) {
      const status = (err as { status?: number }).status
      setDeleteMsg(status === 409
        ? { kind: 'warn', text: `${a.code} is part of an active assignment; return it first before deleting.` }
        : { kind: 'warn', text: `Delete failed: ${(err as Error).message}` })
    }
  }

  return (
    <>
      <Link to="/assets" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Assets</Link>
      {deleteMsg && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-xs ${deleteMsg.kind === 'warn' ? 'border-red-200 bg-red-50 text-red-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>
          {deleteMsg.text}
          <button className="ml-auto text-slate-400 hover:text-slate-600" onClick={() => setDeleteMsg(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs font-semibold text-brand-700">{a.code}</p>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{a.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {cat && <Badge>{cat}</Badge>}<ConditionBadge value={a.condition} /><StatusBadge value={a.status} />
          </div>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <Button variant="danger" onClick={handleDelete} loading={deleteAsset.isPending}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
            <Button variant="secondary" onClick={() => nav(`/assets/${a.id}/edit`)}><Pencil className="h-4 w-4" /> Edit</Button>
          </div>
        )}
      </div>

      <Tabs
        tabs={[{ id: 'details', label: 'Details' }, { id: 'timeline', label: 'Timeline' }, { id: 'conditions', label: 'Condition over handovers' }]}
        value={tab}
        onChange={(t) => {
          if (t === 'conditions') { nav(`/assets/${a.id}?tab=conditions`, { replace: true }); return }
          setTab(t)
          nav(t === 'timeline' ? `/assets/${a.id}/timeline` : `/assets/${a.id}`, { replace: true })
        }}
      />

      {tab === 'conditions' ? <ConditionHistory assetId={a.id} /> : tab === 'timeline' ? <TimelineList assetId={a.id} embedded={data.timeline} onOpenAssignment={openDrawer} /> : (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-6 lg:col-span-3">
            <div className="card p-5">
              <h2 className="mb-1 text-sm font-semibold text-slate-900">Information</h2>
              <dl className="divide-y divide-slate-100">
                <Row label="IMEI">{a.imei && <span className="font-mono">{a.imei}</span>}</Row>
                {a.phone && <>
                  <Row label="Make / model">{[a.phone.make, a.phone.model].filter(Boolean).join(' ')}</Row>
                  <Row label="Color">{a.phone.color}</Row>
                  <Row label="Storage">{a.phone.storage}</Row>
                  <Row label="App binary">{a.phone.appBinary && titleCase(a.phone.appBinary)}</Row>
                </>}
                <Row label="Serial number">{a.serialNumber && <span className="font-mono">{a.serialNumber}</span>}</Row>
                <Row label="Quantity">{a.qty}</Row>
                <Row label="Room">{a.room?.code}</Row>
                <Row label="Current holder">{a.currentHolder ? <Link to={`/employees`} className="text-brand-700 hover:underline">{a.currentHolder.fullName}</Link> : null}</Row>
                <Row label="Notes">{a.notes}</Row>
                <Row label="Created">{fmtDate(a.createdAt, true)}</Row>
                <Row label="Updated">{fmtDate(a.updatedAt, true)}</Row>
              </dl>
              <LastConditionLine check={a.lastConditionCheck} />
            </div>
            {customEntries.length > 0 && (
              <div className="card p-5">
                <h2 className="mb-1 text-sm font-semibold text-slate-900">Category details</h2>
                <dl className="divide-y divide-slate-100">
                  {customEntries.map(([k, v]) => <Row key={k} label={labelFor(k)}>{typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)}</Row>)}
                </dl>
              </div>
            )}
          </div>
          <div className="space-y-6 lg:col-span-2">
            <PhotosPanel asset={a} canUpload={isAdmin} />
            <PhotoHistory history={a.photoHistory ?? []} assetCode={a.code} onOpenAssignment={openDrawer} />
          </div>
        </div>
      )}
      {drawerId && <AssignmentDrawer assignmentId={drawerId} onClose={closeDrawer} />}
    </>
  )
}
