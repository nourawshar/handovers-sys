import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, CheckCircle2, FileText, Printer, TriangleAlert, X } from 'lucide-react'
import { useResolveUnreturned, useReturnRecord } from '@/api/hooks'
import type { ComparisonField, Photo, ReturnRecord, UnreturnedEntry } from '@/api/types'
import { CONDITIONS } from '@/api/types'
import { useAuthStore } from '@/store/auth'
import { can } from '@/lib/permissions'
import { fmtDate, titleCase } from '@/lib/utils'
import { Badge, Button, ConditionBadge, EmptyState, ErrorState, Field, Select, Spinner, Textarea } from '@/components/ui'

const severityTone: Record<string, 'red' | 'amber' | 'slate'> = { CRITICAL: 'red', WARNING: 'amber', INFO: 'slate' }

/** Rank best → worst; a higher number is a worse condition. */
export const conditionRank = (c?: string | null): number => (c ? (CONDITIONS as readonly string[]).indexOf(c.toUpperCase()) : -1)

/** worse = red, better = green, same/unknown = slate. */
export function conditionChange(from?: string | null, to?: string | null): 'worse' | 'better' | 'same' | 'unknown' {
  const a = conditionRank(from)
  const b = conditionRank(to)
  if (a < 0 || b < 0) return 'unknown'
  return b > a ? 'worse' : b < a ? 'better' : 'same'
}

export const changeColour = { worse: 'text-red-600', better: 'text-emerald-600', same: 'text-slate-500', unknown: 'text-slate-400' } as const

const fmtVal = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v))

function ConditionArrow({ from, to }: { from?: string | null; to?: string | null }) {
  const ch = conditionChange(from, to)
  return (
    <span className="inline-flex items-center gap-1.5" data-change={ch}>
      {from ? titleCase(from) : '—'}
      <ArrowRight className={`h-3.5 w-3.5 ${changeColour[ch]}`} aria-hidden="true" />
      <span className={`font-medium ${ch === 'worse' ? 'text-red-600' : ch === 'better' ? 'text-emerald-600' : 'text-slate-900'}`}>{to ? titleCase(to) : '—'}</span>
      {ch === 'worse' && <span className="sr-only">(worse)</span>}
      {ch === 'better' && <span className="sr-only">(better)</span>}
    </span>
  )
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <span>{title}</span>{right}
      </div>
      {children}
    </div>
  )
}

function PhotoGroup({ heading, photos, record }: { heading: string; photos: Photo[]; record: ReturnRecord }) {
  const label = (p: Photo) => {
    if (!p.assetId) return 'Whole assignment'
    const it = record.items.find((i) => i.assetId === p.assetId)
    return it ? `${it.code} · ${it.name}` : 'Item'
  }
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{heading}</h3>
      {photos.length === 0 ? <p className="text-xs text-slate-400">None</p> : (
        <div className="grid grid-cols-2 gap-3">
          {photos.map((p) => (
            <div key={p.id} className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
              <img src={p.url} alt={`${heading} ${p.type} photo`} loading="lazy" className="aspect-square w-full object-cover" />
              <span className="block px-2 pt-1 text-xs font-medium text-slate-600">{titleCase(p.type)}</span>
              <span className="block truncate px-2 pb-1 text-xs text-slate-500">{label(p)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Mark as returned / lost modal. The condition select only applies to a returned ASSET. */
function ResolveModal({ assignmentId, entry, resolution, onClose }: {
  assignmentId: string
  entry: UnreturnedEntry
  resolution: 'RETURNED' | 'LOST'
  onClose: () => void
}) {
  const resolve = useResolveUnreturned(assignmentId)
  const [condition, setCondition] = useState('')
  const [notes, setNotes] = useState('')
  const showCondition = resolution === 'RETURNED' && entry.kind === 'ASSET'
  const submit = () => {
    resolve.mutate(
      {
        ...(entry.assetId ? { assetId: entry.assetId } : { accountId: entry.accountId! }),
        resolution,
        ...(showCondition && condition ? { condition } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      },
      { onSuccess: onClose },
    )
  }
  const title = resolution === 'RETURNED' ? 'Mark as returned' : 'Mark as lost'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"><X className="h-5 w-5" /></button>
        </div>
        <p className="mb-4 text-sm text-slate-600"><span className="font-mono text-xs font-semibold">{entry.code}</span> · {entry.name}</p>
        {resolution === 'LOST' && (
          <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            The {entry.kind === 'ASSET' ? 'asset is written off (Disposed) and released from the employee' : 'account is deactivated and unbound'}. This cannot be undone here.
          </p>
        )}
        <div className="grid gap-4">
          {showCondition && (
            <Field label="Condition now" hint="Optional — written onto the asset.">
              <Select value={condition} onChange={(e) => setCondition(e.target.value)} aria-label="Condition now">
                <option value="">Keep current condition</option>
                {CONDITIONS.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Notes">
            <Textarea value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. found in the supply room" />
          </Field>
          {resolve.isError && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{(resolve.error as Error).message}</div>}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={submit} loading={resolve.isPending} disabled={resolve.isPending}>{title}</Button>
        </div>
      </div>
    </div>
  )
}

function UnreturnedPanel({ record, canEdit }: { record: ReturnRecord; canEdit: boolean }) {
  const [target, setTarget] = useState<{ entry: UnreturnedEntry; resolution: 'RETURNED' | 'LOST' } | null>(null)
  const open = record.unreturned.filter((u) => u.status === 'OPEN')
  if (record.unreturned.length === 0) return null
  return (
    <Section
      title="Unreturned items"
      right={open.length > 0 ? <Badge tone="amber">{open.length} open</Badge> : <Badge tone="green">All settled</Badge>}
    >
      <ul className="divide-y divide-slate-100 text-sm" data-testid="unreturned-list">
        {record.unreturned.map((u) => {
          const key = u.assetId ?? u.accountId ?? u.code
          return (
            <li key={key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-slate-700">{u.code}</span>
                  <span className="text-slate-700">{u.name}</span>
                  <Badge>{titleCase(u.role || u.kind)}</Badge>
                  {u.status === 'OPEN'
                    ? <Badge tone="amber">Not returned</Badge>
                    : <Badge tone={u.resolution?.kind === 'LOST' ? 'red' : 'green'}>{u.resolution?.kind === 'LOST' ? 'Lost' : 'Returned late'}</Badge>}
                </div>
                {u.status === 'RESOLVED' && u.resolution && (
                  <p className="mt-1 text-xs text-slate-500">
                    {u.resolution.by ? `by ${u.resolution.by.fullName} · ` : ''}{fmtDate(u.resolution.at, true)}
                    {u.resolution.condition ? ` · condition ${titleCase(u.resolution.condition)}` : ''}
                    {u.resolution.notes ? ` · ${u.resolution.notes}` : ''}
                  </p>
                )}
              </div>
              {u.status === 'OPEN' && canEdit && (
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => setTarget({ entry: u, resolution: 'RETURNED' })}>Mark as returned</Button>
                  <Button type="button" size="sm" variant="secondary" onClick={() => setTarget({ entry: u, resolution: 'LOST' })}>Mark as lost</Button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {target && <ResolveModal assignmentId={record.assignmentId} entry={target.entry} resolution={target.resolution} onClose={() => setTarget(null)} />}
    </Section>
  )
}

function ComparisonTable({ comparison }: { comparison: ComparisonField[] }) {
  return (
    <Section title="Comparison">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr><th className="th">Field</th><th className="th">At handover</th><th className="th">At return</th><th className="th">Severity</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {comparison.map((c) => (
              <tr key={c.fieldKey} className={c.isDiscrepancy ? 'bg-amber-50/40' : ''}>
                <td className="td font-medium text-slate-900">{c.label}</td>
                <td className="td">{fmtVal(c.valueAtHandover)}</td>
                <td className="td">{fmtVal(c.valueAtReturn)}</td>
                <td className="td"><Badge tone={severityTone[c.severity] ?? 'slate'}>{c.severity}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

export default function ReturnRecordPage() {
  const { id } = useParams()
  const user = useAuthStore((s) => s.user)
  const { data, isLoading, isError, error, refetch } = useReturnRecord(id)
  const canEdit = can(user?.role, 'assets.new')

  if (isLoading) return <Spinner />
  if (isError || !data) {
    const status = (error as { status?: number } | null)?.status
    return (
      <>
        <Link to={`/assignments/${id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Back to assignment</Link>
        {status === 404
          ? <div className="card"><EmptyState title="No return record" hint="This assignment has not been returned." /></div>
          : <ErrorState error={error} onRetry={() => refetch()} />}
      </>
    )
  }
  const r = data
  const openCount = r.unreturned.filter((u) => u.status === 'OPEN').length
  const discrepancies = r.comparison.filter((c) => c.isDiscrepancy).length

  return (
    <>
      <Link to="/assignments" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Assignments</Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs font-semibold text-brand-700">{r.assignmentCode}</p>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Return record</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone="violet">Return</Badge>
            {r.hasDiscrepancies
              ? <Badge tone="red"><TriangleAlert className="mr-1 h-3 w-3" /> {discrepancies} discrepanc{discrepancies === 1 ? 'y' : 'ies'}</Badge>
              : <Badge tone="green"><CheckCircle2 className="mr-1 h-3 w-3" /> No discrepancies</Badge>}
            {openCount > 0 && <Badge tone="amber">{openCount} unreturned</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/assignments/${r.assignmentId}/return-receipt`}><Button type="button" variant="secondary"><Printer className="h-4 w-4" /> Print return receipt</Button></Link>
          <Link to={`/assignments/${r.assignmentId}`}><Button type="button" variant="secondary"><FileText className="h-4 w-4" /> View delivery</Button></Link>
        </div>
      </div>

      <div className="space-y-4">
        <div className="card p-5">
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {([
              ['Employee', r.employee?.fullName],
              ['Department', r.employee?.department?.name],
              ['Room', r.employee?.room?.code],
              ['Work identity', r.workIdentity?.name],
              ['Returned by', r.returnedBy?.fullName],
              ['Returned on', fmtDate(r.returnedAt, true)],
            ] as [string, string | null | undefined][]).map(([k, v]) => (
              <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="font-medium text-slate-900">{v || '—'}</dd></div>
            ))}
          </dl>
        </div>

        <UnreturnedPanel record={r} canEdit={canEdit} />

        <Section title={`Items (${r.items.length})`}>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr><th className="th">Item</th><th className="th">Role</th><th className="th">Serial</th><th className="th">Condition: handover → return</th><th className="th">Returned</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {r.items.map((i) => (
                  <tr key={i.assetId} className={i.returned ? '' : 'bg-amber-50/40'}>
                    <td className="td"><Link to={`/assets/${i.assetId}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{i.code}</Link> <span className="text-slate-700">{i.name}</span></td>
                    <td className="td">{titleCase(i.role)}</td>
                    <td className="td font-mono text-xs">{i.serialNumber ?? '—'}</td>
                    <td className="td">{i.returned ? <ConditionArrow from={i.conditionAtHandover} to={i.returnCondition} /> : <span className="text-slate-500">{i.conditionAtHandover ? titleCase(i.conditionAtHandover) : '—'} <ArrowRight className="inline h-3.5 w-3.5 text-slate-400" /> not recorded</span>}</td>
                    <td className="td">{i.returned ? <Badge tone="green">Yes</Badge> : <Badge tone="amber">No</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {r.comparison.length > 0 && <ComparisonTable comparison={r.comparison} />}

        {(r.returnNotes || r.returnCondition) && (
          <Section title="Return notes">
            <div className="space-y-2 p-4 text-sm">
              {r.returnCondition && <p><span className="text-slate-500">Overall condition: </span><ConditionBadge value={r.returnCondition} /></p>}
              {r.returnNotes && <p className="whitespace-pre-wrap text-slate-900">{r.returnNotes}</p>}
            </div>
          </Section>
        )}

        <Section title="Photos">
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <PhotoGroup heading="At handover" photos={r.photos.handover} record={r} />
            <PhotoGroup heading="At return" photos={r.photos.return} record={r} />
          </div>
        </Section>
      </div>
    </>
  )
}
