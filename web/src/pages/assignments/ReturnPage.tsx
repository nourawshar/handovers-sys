import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, TriangleAlert } from 'lucide-react'
import { useAssignmentReturnForm, useSubmitPhoneReturn } from '@/api/hooks'
import type { ComparisonField, ReturnOutState } from '@/api/types'
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

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

export default function ReturnPage() {
  const { id } = useParams()
  const { data, isLoading, isError, error, refetch } = useAssignmentReturnForm(id)
  const submit = useSubmitPhoneReturn(id ?? '')
  const [form, setForm] = useState<ReturnFormState | null>(null)
  const [result, setResult] = useState<{ comparison: ComparisonField[]; hasDiscrepancies: boolean; assignmentCode: string } | null>(null)

  const out = data?.out
  const formState = useMemo(() => (out ? fromOut(out) : null), [out])
  const active = form ?? formState

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

  const doSubmit = () => {
    submit.mutate(buildReturnPayload(form ?? formState!), {
      onSuccess: (r) => setResult({ comparison: r.comparison, hasDiscrepancies: r.hasDiscrepancies, assignmentCode: r.assignmentCode }),
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
        <ComparisonTable comparison={result.comparison} />
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
            {out.wa2ChatNormalCount !== null && (
              <>
                <Row label="Chats 2 (normal)">{out.wa2ChatNormalCount}</Row>
                <Row label="Chats 2 (archived)">{out.wa2ChatArchivedCount}</Row>
                <Row label="Backup date 2">{out.wa2BackupDate ? fmtDate(out.wa2BackupDate) : '—'}</Row>
                <Row label="Backup size 2">{out.wa2BackupUsedGB ?? '—'} GB of {out.wa2BackupTotalGB ?? '—'} GB</Row>
              </>
            )}
            <Row label="SIM 1">{out.sim1Number}</Row>
            <Row label="SIM 2">{out.sim2Number}</Row>
            <Row label="Bitrix">{out.bitrixAccountId ? 'present' : '—'}</Row>
            <Row label="Charger cable">{out.chargerCableAssetId ? 'present' : '—'}</Row>
            <Row label="Charger adapter">{out.chargerAdapterAssetId ? 'present' : '—'}</Row>
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
            {out.wa2ChatNormalCount !== null && (
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
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="SIM 1">
                <Input value={active!.sim1Number} onChange={(e) => set({ sim1Number: e.target.value })} />
              </Field>
              <Field label="SIM 2">
                <Input value={active!.sim2Number} onChange={(e) => set({ sim2Number: e.target.value })} />
              </Field>
              <Field label="Bitrix account">
                <Input value={active!.bitrixAccountId} onChange={(e) => set({ bitrixAccountId: e.target.value })} placeholder="Leave empty if missing" />
              </Field>
              <Field label="Charger cable">
                <Input value={active!.chargerCableAssetId} onChange={(e) => set({ chargerCableAssetId: e.target.value })} placeholder="Leave empty if missing" />
              </Field>
              <Field label="Charger adapter">
                <Input value={active!.chargerAdapterAssetId} onChange={(e) => set({ chargerAdapterAssetId: e.target.value })} placeholder="Leave empty if missing" />
              </Field>
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
