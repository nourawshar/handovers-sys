import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, X } from 'lucide-react'
import { useAsset } from '@/api/hooks'
import { fmtDate, titleCase } from '@/lib/utils'
import { Badge, Button, ConditionBadge, ErrorState, Spinner, StatusBadge } from '@/components/ui'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 break-words text-slate-900">{children || '—'}</dd>
    </div>
  )
}

/**
 * Lightweight inline asset overlay (CHANGE 4, FE-17). Opens from the employees page / employee detail
 * so a device can be inspected without navigating away to /assets — closing returns to the same page.
 * Reuses the AssignmentDrawer overlay pattern (right-hand slide-over, background scroll lock, Escape).
 */
export default function AssetDrawer({ assetId, onClose }: { assetId: string; onClose: () => void }) {
  const { data, isLoading, isError, error, refetch } = useAsset(assetId)
  const asset = data?.asset

  // Lock background scroll while the drawer is open so the list keeps its position.
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
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Asset detail">
      <div className="absolute inset-0 bg-slate-900/50" onClick={onClose} aria-hidden="true" />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-5">
          <div className="min-w-0">
            {isLoading ? <Spinner /> : isError || !asset ? (
              <ErrorState error={error} onRetry={() => refetch()} />
            ) : (
              <>
                <p className="font-mono text-xs font-semibold text-brand-700">{asset.code}</p>
                <h2 className="text-lg font-semibold text-slate-900">{asset.name}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <ConditionBadge value={asset.condition} />
                  <StatusBadge value={asset.status} />
                  {asset.category && <Badge>{asset.category.name}</Badge>}
                </div>
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
        ) : isError || !asset ? (
          <div className="p-5"><ErrorState error={error} onRetry={() => refetch()} /></div>
        ) : (
          <div className="flex-1 space-y-6 overflow-y-auto p-5">
            <div className="card p-5">
              <h2 className="mb-1 text-sm font-semibold text-slate-900">Information</h2>
              <dl className="divide-y divide-slate-100">
                <Row label="Code">{asset.code}</Row>
                <Row label="Category">{asset.category?.name}</Row>
                <Row label="Serial / IMEI">{asset.serialNumber ?? asset.imei}</Row>
                <Row label="Quantity">{asset.qty > 1 ? `×${asset.qty}` : '1'}</Row>
                <Row label="Condition">{titleCase(asset.condition)}</Row>
                <Row label="Status">{titleCase(asset.status)}</Row>
                <Row label="Holder">{asset.currentHolder?.fullName}</Row>
                <Row label="Room">{asset.room?.code}</Row>
                <Row label="Notes">{asset.notes}</Row>
                <Row label="Created">{fmtDate(asset.createdAt, true)}</Row>
              </dl>
            </div>

            {asset.photos.length > 0 && (
              <div className="card p-5">
                <h2 className="mb-3 text-sm font-semibold text-slate-900">Photos</h2>
                <div className="grid grid-cols-2 gap-3">
                  {asset.photos.map((p) => (
                    <div key={p.id} className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                      <img src={p.url} alt={`${p.type} photo`} loading="lazy" className="aspect-square w-full object-cover" />
                      <span className="block px-2 py-1 text-xs text-slate-500">{titleCase(p.type)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <Link to={`/assets/${asset.id}`}>
                <Button variant="secondary"><ExternalLink className="h-4 w-4" /> Open full page</Button>
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
