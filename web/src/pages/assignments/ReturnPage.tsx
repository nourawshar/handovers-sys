import { useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Camera, CheckCircle2, TriangleAlert, X } from 'lucide-react'
import { useAssignmentReturnForm, useSubmitPhoneReturn, useUploadReturnPhotos } from '@/api/hooks'
import type { ComparisonField, Photo, ReturnOutState, SelectOption } from '@/api/types'
import { CONDITIONS } from '@/api/types'
import { fmtDate, titleCase } from '@/lib/utils'
import { Badge, Button, EmptyState, ErrorState, Field, Input, Select, Spinner, Textarea } from '@/components/ui'

/* ------------------------------------------------------------------ */
/* Return-state form model (string-based inputs)                       */
/* ------------------------------------------------------------------ */

interface ReturnFormState {
  returnCondition: string
  returnNotes: string
  wa1ChatNormalCount: string
  wa1ChatArchivedCount: string
  wa1BackupDate: string
  wa1BackupUsedGB: string
  wa1BackupTotalGB: string
  wa2ChatNormalCount: string
  wa2ChatArchivedCount: string
  wa2BackupDate: string
  wa2BackupUsedGB: string
  wa2BackupTotalGB: string
  sim1Number: string
  sim2Number: string
  bitrixAccountId: string
  chargerCableAssetId: string
  chargerAdapterAssetId: string
}

const fromOut = (o: ReturnOutState): ReturnFormState => ({
  returnCondition: o.condition ?? '',
  returnNotes: '',
  wa1ChatNormalCount: o.wa1ChatNormalCount?.toString() ?? '',
  wa1ChatArchivedCount: o.wa1ChatArchivedCount?.toString() ?? '',
  wa1BackupDate: o.wa1BackupDate?.slice(0, 10) ?? '',
  wa1BackupUsedGB: o.wa1BackupUsedGB?.toString() ?? '',
  wa1BackupTotalGB: o.wa1BackupTotalGB?.toString() ?? '',
  wa2ChatNormalCount: o.wa2ChatNormalCount?.toString() ?? '',
  wa2ChatArchivedCount: o.wa2ChatArchivedCount?.toString() ?? '',
  wa2BackupDate: o.wa2BackupDate?.slice(0, 10) ?? '',
  wa2BackupUsedGB: o.wa2BackupUsedGB?.toString() ?? '',
  wa2BackupTotalGB: o.wa2BackupTotalGB?.toString() ?? '',
  sim1Number: o.sim1Number ?? '',
  sim2Number: o.sim2Number ?? '',
  bitrixAccountId: o.bitrixAccountId ?? '',
  chargerCableAssetId: o.chargerCableAssetId ?? '',
  chargerAdapterAssetId: o.chargerAdapterAssetId ?? '',
})

const toNum = (v: string): number | null => (v === '' ? null : Number(v))
const toStr = (v: string): string | null => (v === '' ? null : v)

/** Builds the §8.2 return body. Omitted keys = unchanged (server copies from out). */
function buildReturnPayload(f: ReturnFormState) {
  return {
    returnCondition: f.returnCondition,
    returnNotes: toStr(f.returnNotes) ?? undefined,
    return: {
      wa1ChatNormalCount: toNum(f.wa1ChatNormalCount),
      wa1ChatArchivedCount: toNum(f.wa1ChatArchivedCount),
      wa1BackupDate: toStr(f.wa1BackupDate),
      wa1BackupUsedGB: toNum(f.wa1BackupUsedGB),
      wa1BackupTotalGB: toNum(f.wa1BackupTotalGB),
      wa2ChatNormalCount: toNum(f.wa2ChatNormalCount),
      wa2ChatArchivedCount: toNum(f.wa2ChatArchivedCount),
      wa2BackupDate: toStr(f.wa2BackupDate),
      wa2BackupUsedGB: toNum(f.wa2BackupUsedGB),
      wa2BackupTotalGB: toNum(f.wa2BackupTotalGB),
      sim1Number: toStr(f.sim1Number),
      sim2Number: toStr(f.sim2Number),
      bitrixAccountId: toStr(f.bitrixAccountId),
      chargerCableAssetId: toStr(f.chargerCableAssetId),
      chargerAdapterAssetId: toStr(f.chargerAdapterAssetId),
    },
  }
}

/* ------------------------------------------------------------------ */
/* Dropdown option helpers (readable labels from BE-1 `out.options`)   */
/* ------------------------------------------------------------------ */

/** Human label for an id value; falls back to the raw value if no matching option is known. */
function optionLabel(value: string | null | undefined, options: SelectOption[]): string {
  if (!value) return '—'
  return options.find((o) => o.value === value)?.label ?? value
}

/**
 * Build the selectable option list for an id field.
 *
 * BE-1 resolves the *handover* value to a human label in `out` (e.g. Bitrix → email,
 * charger → `code — name`), so the pre-selected value is already readable. Keying the options
 * by that same label keeps the dropdown pre-selected and prevents any raw id from leaking into
 * the form or the submitted payload (which keeps BE-1's comparison clean). If the handover value
 * is not among the known options (older backend), prepend it so it is never blanked.
 */
function idFieldOptions(base: SelectOption[], current: string | null): SelectOption[] {
  const seen = new Set<string>()
  const list: SelectOption[] = []
  for (const o of base ?? []) {
    const lab = o.label || o.value
    if (seen.has(lab)) continue
    seen.add(lab)
    list.push({ value: lab, label: lab })
  }
  if (current && !seen.has(current)) list.unshift({ value: current, label: current })
  return list
}

/* ------------------------------------------------------------------ */
/* Comparison result rendering                                         */
/* ------------------------------------------------------------------ */

const severityTone: Record<string, 'red' | 'amber' | 'slate'> = { CRITICAL: 'red', WARNING: 'amber', INFO: 'slate' }

function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

function ComparisonTable({ comparison }: { comparison: ComparisonField[] }) {
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Comparison</div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">Field</th><th className="th">At handover</th><th className="th">At return</th><th className="th">Severity</th>
            </tr>
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
    </div>
  )
}

/** Old (handover) vs new (return) photos, front and back side by side. */
function PhotoComparison({ oldPhotos, newPhotos }: { oldPhotos: Photo[]; newPhotos: Photo[] }) {
  const tile = (t: 'FRONT' | 'BACK', list: Photo[]) => {
    const p = list.find((x) => x.type?.toUpperCase() === t)
    return p
      ? <img key={t} src={p.url} alt={`${titleCase(t)} ${p.type}`} className="aspect-square w-full rounded-lg border border-slate-200 object-cover" />
      : <div key={t} className="flex aspect-square w-full items-center justify-center rounded-lg border-2 border-dashed text-xs text-slate-400">{titleCase(t)}</div>
  }
  const side = (heading: string, list: Photo[]) => (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{heading}</p>
      <div className="grid grid-cols-2 gap-2">
        {(['FRONT', 'BACK'] as const).map((t) => tile(t, list))}
      </div>
    </div>
  )
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Photos</div>
      <div className="grid gap-4 p-4 sm:grid-cols-2">
        {side('At handover', oldPhotos)}
        {side('At return', newPhotos)}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Return photos (re-photograph at return) — pick + upload             */
/* ------------------------------------------------------------------ */

const ACCEPT = 'image/jpeg,image/png,image/webp'
const MAX_MB = 5

type ReturnPick = { type: 'FRONT' | 'BACK'; file: File; url: string }

function ReturnPhotoPicker({ photos, uploading, error, onPick, onRemove }: {
  photos: ReturnPick[]
  uploading: boolean
  error: string | null
  onPick: (list: FileList | null) => void
  onRemove: (type: 'FRONT' | 'BACK') => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">Re-photograph the phone: add a front and a back photo.</p>
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
      {uploading && <p className="text-xs text-slate-500">Uploading…</p>}
      <input ref={inputRef} type="file" accept={ACCEPT} capture="environment" className="hidden"
        onChange={(e) => { onPick(e.target.files); e.target.value = '' }} />
      <div className="grid cursor-pointer gap-4 sm:grid-cols-2" onClick={() => inputRef.current?.click()}>
        {(['FRONT', 'BACK'] as const).map((t) => {
          const pick = photos.find((p) => p.type === t)
          return (
            <div key={t} className={`relative flex aspect-square flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border-2 border-dashed text-sm transition ${pick ? 'border-emerald-400 bg-emerald-50/40' : 'border-slate-300 text-slate-400 hover:border-slate-400'}`}>
              {pick ? (
                <>
                  <img src={pick.url} alt={`${titleCase(t)} photo`} className="h-full w-full object-cover" />
                  <button type="button" onClick={(ev) => { ev.stopPropagation(); onRemove(t) }}
                    aria-label={`Remove ${t} photo`}
                    className="absolute right-2 top-2 rounded-full bg-red-600 p-1 text-white shadow hover:bg-red-700">
                    <X className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <><Camera className="h-8 w-8" /><span>{titleCase(t)} photo</span></>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

interface ReturnResultState {
  comparison: ComparisonField[]
  hasDiscrepancies: boolean
  assignmentCode: string
  oldPhotos: Photo[]
  newPhotos: Photo[]
}

function IdSelect({ value, label, options, onChange }: {
  value: string
  label: string
  options: SelectOption[]
  onChange: (v: string) => void
}) {
  return (
    <Field label={label}>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— none —</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </Field>
  )
}

export default function ReturnPage() {
  const { id } = useParams()
  const { data, isLoading, isError, error, refetch } = useAssignmentReturnForm(id)
  const submit = useSubmitPhoneReturn(id ?? '')
  const upload = useUploadReturnPhotos(id ?? '')
  const [form, setForm] = useState<ReturnFormState | null>(null)
  const [result, setResult] = useState<ReturnResultState | null>(null)
  const [returnPhotos, setReturnPhotos] = useState<ReturnPick[]>([])
  const [persistedPhotos, setPersistedPhotos] = useState<Photo[]>([])
  const [photoErr, setPhotoErr] = useState<string | null>(null)

  const out = data?.out
  const formState = useMemo(() => (out ? fromOut(out) : null), [out])
  const active = form ?? formState

  const bitrixOpts = useMemo(() => idFieldOptions(out?.options?.bitrixAccounts ?? [], out?.bitrixAccountId ?? null), [out])
  const cableOpts = useMemo(() => idFieldOptions(out?.options?.chargerCables ?? [], out?.chargerCableAssetId ?? null), [out])
  const adapterOpts = useMemo(() => idFieldOptions(out?.options?.chargerAdapters ?? [], out?.chargerAdapterAssetId ?? null), [out])

  if (isLoading) return <Spinner />
  if (isError || !data || !out) {
    const status = (error as { status?: number })?.status
    return (
      <>
        <Link to="/assignments" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Assignments</Link>
        {status === 409 ? (
          <div className="card"><EmptyState title="This assignment is not active" hint="Only active assignments can be returned." /></div>
        ) : (
          <ErrorState error={error} onRetry={() => refetch()} />
        )}
      </>
    )
  }

  const set = (patch: Partial<ReturnFormState>) => setForm({ ...(form ?? formState!), ...patch })

  const addPhoto = (list: FileList | null) => {
    setPhotoErr(null)
    const files = Array.from(list ?? [])
    if (!files.length) return
    const bad = files.find((f) => !ACCEPT.split(',').includes(f.type))
    if (bad) return setPhotoErr(`“${bad.name}” is not a JPEG/PNG/WebP image.`)
    const big = files.find((f) => f.size > MAX_MB * 1024 * 1024)
    if (big) return setPhotoErr(`“${big.name}” is larger than ${MAX_MB} MB.`)
    const t: 'FRONT' | 'BACK' = returnPhotos.some((p) => p.type === 'FRONT') ? 'BACK' : 'FRONT'
    const picks = files.map((f) => ({ type: t, file: f, url: URL.createObjectURL(f) }))
    setReturnPhotos([...returnPhotos.filter((p) => p.type !== t), ...picks])
    upload.mutate({ files, type: t }, {
      onSuccess: (up) => setPersistedPhotos((prev) => [...prev.filter((p) => p.type !== t), ...up]),
      onError: () => setPhotoErr('Saved locally, but the upload to the server failed — this photo will not appear in the comparison.'),
    })
  }

  const removePhoto = (t: 'FRONT' | 'BACK') => {
    const p = returnPhotos.find((x) => x.type === t)
    if (p) URL.revokeObjectURL(p.url)
    setReturnPhotos(returnPhotos.filter((x) => x.type !== t))
    setPersistedPhotos((prev) => prev.filter((x) => x.type !== t))
  }

  const doSubmit = () => {
    submit.mutate(buildReturnPayload(form ?? formState!), {
      onSuccess: (r) => setResult({
        comparison: r.comparison,
        hasDiscrepancies: r.hasDiscrepancies,
        assignmentCode: r.assignmentCode,
        oldPhotos: (r.photos?.handover?.length ? r.photos.handover : data?.handoverPhotos) ?? [],
        newPhotos: r.photos?.return?.length
          ? r.photos.return
          : persistedPhotos.length
            ? persistedPhotos
            : returnPhotos.map((p) => ({ id: p.url, type: p.type, url: p.url, fileName: p.file.name })),
      }),
    })
  }

  if (result) {
    return (
      <>
        <Link to={`/assignments/${id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Back to assignment</Link>
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-xs font-semibold text-brand-700">{result.assignmentCode}</p>
            <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Return complete</h1>
          </div>
          {result.hasDiscrepancies ? (
            <Badge tone="red"><TriangleAlert className="mr-1 h-3 w-3" /> {result.comparison.filter((c) => c.isDiscrepancy).length} discrepancies</Badge>
          ) : (
            <Badge tone="green"><CheckCircle2 className="mr-1 h-3 w-3" /> No discrepancies</Badge>
          )}
        </div>
        <div className="space-y-4">
          <ComparisonTable comparison={result.comparison} />
          <PhotoComparison oldPhotos={result.oldPhotos} newPhotos={result.newPhotos} />
        </div>
      </>
    )
  }

  return (
    <>
      <Link to={`/assignments/${id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Back to assignment</Link>
      <div className="mb-6">
        <p className="font-mono text-xs font-semibold text-brand-700">{data.assignmentCode}</p>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Return / handback</h1>
        <p className="mt-1 text-sm text-slate-500">{out.employeeFullName} · {out.workIdentityName} · {out.assetCode} {out.assetName}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Handover (out) — read-only */}
        <div className="card p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Handover</h2>
          <dl className="divide-y divide-slate-100 text-sm">
            <Row label="Condition">{titleCase(out.condition)}</Row>
            <Row label="Chats (normal)">{out.wa1ChatNormalCount ?? '—'}</Row>
            <Row label="Chats (archived)">{out.wa1ChatArchivedCount ?? '—'}</Row>
            <Row label="Backup date">{out.wa1BackupDate ? fmtDate(out.wa1BackupDate) : '—'}</Row>
            <Row label="Backup size">{out.wa1BackupUsedGB ?? '—'} GB of {out.wa1BackupTotalGB ?? '—'} GB</Row>
            <Row label="Chats 2 (normal)">{out.wa2ChatNormalCount ?? '—'}</Row>
            <Row label="Chats 2 (archived)">{out.wa2ChatArchivedCount ?? '—'}</Row>
            <Row label="Backup date 2">{out.wa2BackupDate ? fmtDate(out.wa2BackupDate) : '—'}</Row>
            <Row label="Backup size 2">{out.wa2BackupUsedGB ?? '—'} GB of {out.wa2BackupTotalGB ?? '—'} GB</Row>
            <Row label="SIM 1">{out.sim1Number}</Row>
            <Row label="SIM 2">{out.sim2Number}</Row>
            <Row label="Bitrix">{out.bitrixAccountId ? optionLabel(out.bitrixAccountId, bitrixOpts) : '—'}</Row>
            <Row label="Charger cable">{out.chargerCableAssetId ? optionLabel(out.chargerCableAssetId, cableOpts) : '—'}</Row>
            <Row label="Charger adapter">{out.chargerAdapterAssetId ? optionLabel(out.chargerAdapterAssetId, adapterOpts) : '—'}</Row>
          </dl>
        </div>

        {/* Return — editable */}
        <div className="card p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Return</h2>
          <div className="space-y-4">
            <Field label="Condition" required>
              <Select value={active!.returnCondition} onChange={(e) => set({ returnCondition: e.target.value })}>
                {CONDITIONS.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Chats (normal)">
                <Input type="number" min={0} value={active!.wa1ChatNormalCount} onChange={(e) => set({ wa1ChatNormalCount: e.target.value })} />
              </Field>
              <Field label="Chats (archived)">
                <Input type="number" min={0} value={active!.wa1ChatArchivedCount} onChange={(e) => set({ wa1ChatArchivedCount: e.target.value })} />
              </Field>
              <Field label="Backup date">
                <Input type="date" value={active!.wa1BackupDate} onChange={(e) => set({ wa1BackupDate: e.target.value })} />
              </Field>
              <Field label="Backup used (GB)">
                <Input type="number" min={0} step="0.1" value={active!.wa1BackupUsedGB} onChange={(e) => set({ wa1BackupUsedGB: e.target.value })} />
              </Field>
              <Field label="Backup total (GB)">
                <Input type="number" min={0} step="0.1" value={active!.wa1BackupTotalGB} onChange={(e) => set({ wa1BackupTotalGB: e.target.value })} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Chats 2 (normal)">
                <Input type="number" min={0} value={active!.wa2ChatNormalCount} onChange={(e) => set({ wa2ChatNormalCount: e.target.value })} />
              </Field>
              <Field label="Chats 2 (archived)">
                <Input type="number" min={0} value={active!.wa2ChatArchivedCount} onChange={(e) => set({ wa2ChatArchivedCount: e.target.value })} />
              </Field>
              <Field label="Backup date 2">
                <Input type="date" value={active!.wa2BackupDate} onChange={(e) => set({ wa2BackupDate: e.target.value })} />
              </Field>
              <Field label="Backup used 2 (GB)">
                <Input type="number" min={0} step="0.1" value={active!.wa2BackupUsedGB} onChange={(e) => set({ wa2BackupUsedGB: e.target.value })} />
              </Field>
              <Field label="Backup total 2 (GB)">
                <Input type="number" min={0} step="0.1" value={active!.wa2BackupTotalGB} onChange={(e) => set({ wa2BackupTotalGB: e.target.value })} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="SIM 1">
                <Input value={active!.sim1Number} onChange={(e) => set({ sim1Number: e.target.value })} />
              </Field>
              <Field label="SIM 2">
                <Input value={active!.sim2Number} onChange={(e) => set({ sim2Number: e.target.value })} />
              </Field>
              <IdSelect label="Bitrix account" value={active!.bitrixAccountId} options={bitrixOpts} onChange={(v) => set({ bitrixAccountId: v })} />
              <IdSelect label="Charger cable" value={active!.chargerCableAssetId} options={cableOpts} onChange={(v) => set({ chargerCableAssetId: v })} />
              <IdSelect label="Charger adapter" value={active!.chargerAdapterAssetId} options={adapterOpts} onChange={(v) => set({ chargerAdapterAssetId: v })} />
            </div>
            <div className="rounded-xl border border-slate-200 p-4">
              <h3 className="mb-1 text-sm font-semibold text-slate-900">Photos</h3>
              <ReturnPhotoPicker photos={returnPhotos} uploading={upload.isPending} error={photoErr} onPick={addPhoto} onRemove={removePhoto} />
            </div>
            <Field label="Return notes">
              <Textarea value={active!.returnNotes} onChange={(e) => set({ returnNotes: e.target.value })} placeholder="e.g. Charger cable missing" />
            </Field>
            {submit.isError && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{(submit.error as Error).message}</div>
            )}
            <Button onClick={doSubmit} loading={submit.isPending} disabled={submit.isPending} className="w-full sm:w-auto">
              Submit return
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 break-words text-slate-900">{children || '—'}</dd>
    </div>
  )
}
