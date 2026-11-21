import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Camera, ChevronDown, ChevronRight } from 'lucide-react'
import type { AssignmentDetail, AssignmentItem, PhoneAssignmentDetail, Photo } from '@/api/types'
import { fmtDate, titleCase } from '@/lib/utils'
import { EmptyState } from '@/components/ui'

/* Shared by AssignmentDetailPage and AssignmentDrawer (Phase 8, R3 + R5). */

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 break-words text-slate-900">{children || '—'}</dd>
    </div>
  )
}

/** Custom-field value → text. Booleans become Yes/No; empty returns null (caller skips). */
export function fmtCustomValue(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  const s = String(v).trim()
  return s === '' ? null : s
}

/** Print/display order: PRIMARY first (API already sorts, this keeps it stable). */
export function orderedItems(a: AssignmentDetail): AssignmentItem[] {
  return [...a.items].sort((x, y) => Number(y.role === 'PRIMARY') - Number(x.role === 'PRIMARY'))
}

export const itemLabel = (it: AssignmentItem | undefined | null): string =>
  it?.asset ? `${it.asset.code} · ${it.asset.name}` : '—'

/** Resolve a photo's assetId to an item label ('Whole assignment' when null). */
export function photoItemLabel(a: AssignmentDetail, p: Photo): string {
  if (!p.assetId) return 'Whole assignment'
  const it = a.items.find((i) => i.asset?.id === p.assetId)
  return it ? itemLabel(it) : 'Item'
}

const hasText = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== ''

/** Phone detail rows for WhatsApp / chats / backup only appear when that line actually has data. */
export function hasWhatsApp(pd: PhoneAssignmentDetail, which: 1 | 2): boolean {
  const g = (k: string) => (pd as unknown as Record<string, unknown>)[`wa${which}${k}`]
  return (
    hasText(g('PhoneNumber')) || hasText(g('AppVariant')) || hasText(g('BackupEmail')) || hasText(g('BackupDate')) ||
    g('BackupUsedGB') != null || g('BackupTotalGB') != null ||
    Number(g('ChatNormalCount') ?? 0) > 0 || Number(g('ChatArchivedCount') ?? 0) > 0
  )
}

const backupStr = (used: number | null, total: number | null) => {
  if (used === null && total === null) return 'not recorded'
  return `${used ?? '—'} GB of ${total ?? '—'} GB`
}

function WaRows({ pd, which }: { pd: PhoneAssignmentDetail; which: 1 | 2 }) {
  const w = which === 1
  const business = w ? pd.wa1Business : pd.wa2Business
  const number = w ? pd.wa1PhoneNumber : pd.wa2PhoneNumber
  const email = w ? pd.wa1BackupEmail : pd.wa2BackupEmail
  const date = w ? pd.wa1BackupDate : pd.wa2BackupDate
  const used = w ? pd.wa1BackupUsedGB : pd.wa2BackupUsedGB
  const total = w ? pd.wa1BackupTotalGB : pd.wa2BackupTotalGB
  const normal = w ? pd.wa1ChatNormalCount : pd.wa2ChatNormalCount
  const archived = w ? pd.wa1ChatArchivedCount : pd.wa2ChatArchivedCount
  const variant = w ? pd.wa1AppVariant : pd.wa2AppVariant
  const hasBackup = !!date || used != null || total != null
  const hasChats = normal != null || archived != null
  return (
    <>
      <Row label={`WhatsApp ${which}`}>{[business ? 'Business' : 'Normal', number].filter(Boolean).join(' · ')}</Row>
      {email && <Row label={`Backup email ${which}`}>{email}</Row>}
      {hasBackup && <Row label={`Last backup ${which}`}>{[date ? fmtDate(date) : null, backupStr(used, total)].filter(Boolean).join(' · ')}</Row>}
      {hasChats && <Row label={`Chats ${which}`}>normal {normal ?? 0} · archived {archived ?? 0}</Row>}
      {variant && <Row label={`App variant ${which}`}>{titleCase(variant)}</Row>}
    </>
  )
}

export function PhoneDetailPanel({ pd }: { pd: PhoneAssignmentDetail }) {
  const bitrix = pd.bitrixAccount ? (pd.bitrixAccount.email || pd.bitrixAccount.identifier || pd.bitrixAccountId) : pd.bitrixAccountId
  const cable = pd.chargerCableAsset ? `${pd.chargerCableAsset.code} · ${pd.chargerCableAsset.name}` : pd.chargerCableAssetId
  const adapter = pd.chargerAdapterAsset ? `${pd.chargerAdapterAsset.code} · ${pd.chargerAdapterAsset.name}` : pd.chargerAdapterAssetId
  if (!pd.sim1Number && !pd.sim2Number && !bitrix && !cable && !adapter && !hasWhatsApp(pd, 1) && !hasWhatsApp(pd, 2)) return null
  return (
    <div className="card p-5">
      <h2 className="mb-1 text-sm font-semibold text-slate-900">Phone assignment detail</h2>
      <dl className="divide-y divide-slate-100">
        {pd.sim1Number && <Row label="SIM 1"><span className="font-mono">{pd.sim1Number}</span></Row>}
        {hasWhatsApp(pd, 1) && <WaRows pd={pd} which={1} />}
        {pd.sim2Number && <Row label="SIM 2"><span className="font-mono">{pd.sim2Number}</span></Row>}
        {pd.sim2Number && hasWhatsApp(pd, 2) && <WaRows pd={pd} which={2} />}
        {bitrix && <Row label="Bitrix account"><span className="font-mono">{bitrix}</span></Row>}
        {cable && <Row label="Charger cable"><span className="font-mono">{cable}</span></Row>}
        {adapter && <Row label="Charger adapter"><span className="font-mono">{adapter}</span></Row>}
      </dl>
    </div>
  )
}

function ItemBlock({ it, defaultOpen, a }: { it: AssignmentItem; defaultOpen: boolean; a: AssignmentDetail }) {
  const [open, setOpen] = useState(defaultOpen)
  const as = it.asset
  if (!as) return null
  const ph = as.phone
  const custom = (as.customFields ?? []).map((f) => ({ ...f, text: fmtCustomValue(f.value) })).filter((f) => f.text !== null)
  const handover = a.photos.filter((p) => p.context !== 'RETURN' && p.assetId === as.id)
  return (
    <div className="rounded-lg border border-slate-200">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left" aria-expanded={open}>
        {open ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-slate-600">{titleCase(it.role)}</span>
        <Link to={`/assets/${as.id}`} onClick={(e) => e.stopPropagation()} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{as.code}</Link>
        <span className="min-w-0 flex-1 truncate text-sm text-slate-900">{as.name}</span>
        {handover.length > 0 && <span className="text-xs text-slate-400">{handover.length} photo{handover.length > 1 ? 's' : ''}</span>}
      </button>
      {open && (
        <dl className="divide-y divide-slate-100 border-t border-slate-100 px-3">
          <Row label="Category">{as.category?.name}</Row>
          <Row label="Serial number">{as.serialNumber && <span className="font-mono">{as.serialNumber}</span>}</Row>
          {(as.qty ?? 1) > 1 && <Row label="Quantity">{as.qty}</Row>}
          <Row label="Condition at handover">{it.conditionAtHandover && titleCase(it.conditionAtHandover)}</Row>
          {it.returnCondition && <Row label="Condition at return">{titleCase(it.returnCondition)}</Row>}
          {as.room && <Row label="Room">{as.room.code}</Row>}
          {as.notes && <Row label="Asset notes">{as.notes}</Row>}
          {ph?.imei && <Row label="IMEI"><span className="font-mono">{ph.imei}</span></Row>}
          {ph?.make && <Row label="Make">{ph.make}</Row>}
          {ph?.model && <Row label="Model">{ph.model}</Row>}
          {ph?.color && <Row label="Colour">{ph.color}</Row>}
          {ph?.storage && <Row label="Storage">{ph.storage}</Row>}
          {custom.map((f) => <Row key={f.key} label={f.label}>{f.text}</Row>)}
        </dl>
      )}
    </div>
  )
}

export function ItemBlocks({ a }: { a: AssignmentDetail }) {
  const items = orderedItems(a)
  if (items.length === 0) return null
  return (
    <div className="card p-5">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Items ({items.length})</h2>
      <div className="space-y-2">
        {items.map((it, i) => <ItemBlock key={it.id} it={it} a={a} defaultOpen={i === 0 || items.length <= 3} />)}
      </div>
    </div>
  )
}

function PhotoGrid({ a, photos }: { a: AssignmentDetail; photos: Photo[] }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {photos.map((p) => (
        <div key={p.id} className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
          <img src={p.url} alt={`${p.type} photo`} loading="lazy" className="aspect-square w-full object-cover" />
          <span className="block px-2 pt-1 text-xs font-medium text-slate-600">{titleCase(p.type)}</span>
          <span className="block truncate px-2 pb-1 text-xs text-slate-500">{photoItemLabel(a, p)}</span>
        </div>
      ))}
    </div>
  )
}

/** Assignment photos split by context: at handover vs at return. */
export function AssignmentPhotos({ a }: { a: AssignmentDetail }) {
  const handover = a.photos.filter((p) => p.context !== 'RETURN')
  const ret = a.photos.filter((p) => p.context === 'RETURN')
  return (
    <div className="card p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900"><Camera className="h-4 w-4" /> Photos</h2>
      {a.photos.length === 0 ? (
        <EmptyState title="No photos" hint="Photos captured at handover or return appear here." />
      ) : (
        <div className="space-y-4">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">At handover</h3>
            {handover.length === 0 ? <p className="text-xs text-slate-400">None</p> : <PhotoGrid a={a} photos={handover} />}
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">At return</h3>
            {ret.length === 0 ? <p className="text-xs text-slate-400">None</p> : <PhotoGrid a={a} photos={ret} />}
          </div>
        </div>
      )}
    </div>
  )
}
