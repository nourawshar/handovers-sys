import { useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Camera, Pencil, Search } from 'lucide-react'
import { useAsset, useAssetTimeline, useCategories, useUploadAssetPhotos } from '@/api/hooks'
import type { Asset, TimelineEntry } from '@/api/types'
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
        <h2 className="text-sm font-semibold text-slate-900">Photos</h2>
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

export function TimelineList({ assetId, embedded }: { assetId: string; embedded?: TimelineEntry[] | null }) {
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
          {entries.map((e) => <TimelineItem key={e.id} e={e} />)}
        </ol>
      )}
      {tl.data && !useEmbedded && <Pagination page={tl.data.page} pageSize={tl.data.pageSize} total={tl.data.total} onChange={setPage} />}
    </div>
  )
}

const eventTone: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'violet' | 'slate'> = {
  ASSIGNED: 'blue', RETURNED: 'green', REASSIGNED: 'violet', UPDATED: 'slate', DISCREPANCY: 'red', NOTE: 'amber',
}

function TimelineItem({ e }: { e: TimelineEntry }) {
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
        {e.assignmentId ? <> · <Link to={`/assignments/${e.assignmentId}`} className="text-brand-700 hover:underline">assignment</Link></> : null}
      </p>
      {e.snapshot && (
        <>
          <button onClick={() => setOpen((o) => !o)} className="mt-1 text-xs font-medium text-brand-700 hover:underline">{open ? 'Hide' : 'Show'} snapshot</button>
          {open && <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{JSON.stringify(e.snapshot, null, 2)}</pre>}
        </>
      )}
    </li>
  )
}

export default function AssetDetailPage({ timelineOnly = false }: { timelineOnly?: boolean }) {
  const { id } = useParams()
  const nav = useNavigate()
  const user = useAuthStore((s) => s.user)
  const { data, isLoading, isError, error, refetch } = useAsset(id)
  const categories = useCategories()
  const [tab, setTab] = useState<'details' | 'timeline'>(timelineOnly ? 'timeline' : 'details')

  if (isLoading) return <Spinner />
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />
  const a = data.asset
  const cat = a.category?.name ?? categories.data?.find((c) => c.id === a.categoryId)?.name
  const labelFor = (k: string) => a.fieldDefinitions?.find((f) => f.key === k)?.label ?? titleCase(k)
  const customEntries = Object.entries(a.customFields).filter(([, v]) => v !== null && v !== '' && v !== undefined)
  const isAdmin = can(user?.role, 'assets.edit')

  return (
    <>
      <Link to="/assets" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Assets</Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs font-semibold text-brand-700">{a.code}</p>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{a.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {cat && <Badge>{cat}</Badge>}<ConditionBadge value={a.condition} /><StatusBadge value={a.status} />
          </div>
        </div>
        {isAdmin && <Button variant="secondary" onClick={() => nav(`/assets/${a.id}/edit`)}><Pencil className="h-4 w-4" /> Edit</Button>}
      </div>

      <Tabs
        tabs={[{ id: 'details', label: 'Details' }, { id: 'timeline', label: 'Timeline' }]}
        value={tab}
        onChange={(t) => { setTab(t); nav(t === 'timeline' ? `/assets/${a.id}/timeline` : `/assets/${a.id}`, { replace: true }) }}
      />

      {tab === 'timeline' ? <TimelineList assetId={a.id} embedded={data.timeline} /> : (
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
          <div className="lg:col-span-2"><PhotosPanel asset={a} canUpload={isAdmin} /></div>
        </div>
      )}
    </>
  )
}
