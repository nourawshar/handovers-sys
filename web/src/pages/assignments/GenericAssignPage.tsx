import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Loader2, Search } from 'lucide-react'
import { z } from 'zod'
import { useAssets, useCategories, useCreateGenericAssignment, useDepartments, useEmployees, useRooms } from '@/api/hooks'
import type { GenericAssignmentPayload, WorkIdentityInput } from '@/api/types'
import { CONDITIONS } from '@/api/types'
import { useDebounce } from '@/lib/useDebounce'
import { titleCase } from '@/lib/utils'
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Select, Spinner } from '@/components/ui'
import { WorkIdentityFields, type WorkIdentityValue } from './WorkIdentityFields'

/** Non-phone asset types assignable via /assignments/generic (CHANGE 1). */
export const GENERIC_ASSET_TYPES = ['LAPTOP', 'PRINTER', 'SIM', 'GENERAL'] as const
export type GenericAssetType = (typeof GENERIC_ASSET_TYPES)[number]

export interface GenericDraft {
  employeeId: string
  workIdentity: WorkIdentityValue
  type: GenericAssetType | ''
  assetId: string
  conditionAtHandover: string
  expectedReturnAt: string
  notes: string
}

const emptyDraft = (): GenericDraft => ({
  employeeId: '', workIdentity: { name: '', departmentTeamId: '', roomId: '' }, type: '',
  assetId: '', conditionAtHandover: '', expectedReturnAt: '', notes: '',
})

const dateOrEmpty = () => z.string().trim().refine((v) => v === '' || !Number.isNaN(new Date(`${v}T00:00:00`).getTime()), 'Enter a valid date')

const stepSchemas: z.ZodTypeAny[] = [
  // 1. Employee + work identity (name/room validated in `next` for call-centers)
  z.object({
    employeeId: z.string().min(1, 'Select an employee'),
    workIdentity: z.object({
      name: z.string().trim(),
      departmentTeamId: z.string().min(1, 'Select a department'),
      roomId: z.string(),
    }),
  }),
  // 2. Asset (type + pick)
  z.object({
    type: z.enum(GENERIC_ASSET_TYPES, { message: 'Select an asset type' }),
    assetId: z.string().min(1, 'Select an asset'),
  }),
  // 3. Details
  z.object({
    conditionAtHandover: z.string().min(1, 'Select the condition at handover'),
    expectedReturnAt: dateOrEmpty(),
    notes: z.string(),
  }),
  // 4. Review — no further validation
  z.object({}),
]

export function validateGenericStep(schema: z.ZodTypeAny, draft: GenericDraft): Record<string, string> {
  const res = schema.safeParse(draft)
  if (res.success) return {}
  const out: Record<string, string> = {}
  for (const issue of res.error.issues) {
    const key = issue.path.join('.')
    if (!(key in out)) out[key] = issue.message
  }
  return out
}

export function buildGenericPayload(draft: GenericDraft, isCallCenter: boolean): GenericAssignmentPayload {
  const wi = draft.workIdentity
  // Non-call-center identities use the employee's real name — no work identity is sent.
  const workIdentity: WorkIdentityInput | undefined = isCallCenter
    ? {
        name: wi.name.trim(),
        departmentTeamId: wi.departmentTeamId || null,
        roomId: wi.roomId || null,
      }
    : undefined
  return {
    type: draft.type as string,
    employeeId: draft.employeeId,
    workIdentityId: undefined,
    workIdentity,
    assetId: draft.assetId,
    conditionAtHandover: draft.conditionAtHandover,
    expectedReturnAt: draft.expectedReturnAt || null,
    notes: draft.notes || null,
  }
}

/** Available-asset picker for non-phone types. Phones are filtered out (they go through /phones/assign). */
function AssetPicker({ draft, setDraft, errors }: {
  draft: GenericDraft; setDraft: (d: GenericDraft) => void; errors: Record<string, string>
}) {
  const categories = useCategories()
  // Phones category subtree (root "Phone"-named category + its children).
  const phoneCatIds = useMemo(() => {
    const c = categories.data ?? []
    const root = c.find((x) => !x.parentId && /phone/i.test(x.name))
    if (!root) return new Set<string>()
    return new Set(c.filter((x) => x.parentId === root.id || x.id === root.id).map((x) => x.id))
  }, [categories.data])

  // Resolve the root category for the chosen asset type (LAPTOP→"Laptops", PRINTER→"Printers",
  // SIM→"SIM Cards"). GENERAL and empty type have no category filter (all non-phone assets).
  const typeCategoryId = useMemo(() => {
    if (!draft.type || draft.type === 'GENERAL') return undefined
    const c = categories.data ?? []
    const root = c.find((x) => !x.parentId && new RegExp(draft.type, 'i').test(x.name))
    return root?.id
  }, [categories.data, draft.type])

  const [q, setQ] = useState('')
  const dq = useDebounce(q)
  const list = useAssets(
    { q: dq || undefined, categoryId: typeCategoryId, status: 'AVAILABLE', pageSize: 100 },
    !!draft.type,
  )
  const candidates = (list.data?.items ?? []).filter((a) => !phoneCatIds.has(a.categoryId))
  const selected = candidates.find((a) => a.id === draft.assetId)

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search available assets by code, serial or name…" className="pl-9" aria-label="Search assets" />
      </div>
      {!draft.type ? (
        <EmptyState title="Pick an asset type first" hint="Choose LAPTOP, PRINTER, SIM or GENERAL above to see matching available assets." />
      ) : list.isLoading ? <Spinner /> : list.isError ? <ErrorState error={list.error} /> : candidates.length === 0 ? (
        <EmptyState title="No available assets" hint="Create an available asset under Assets before assigning it." action={<Link to="/assets/new"><Button size="sm" variant="secondary">New asset</Button></Link>} />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {candidates.map((a) => (
            <label key={a.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm transition ${draft.assetId === a.id ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
              <input type="radio" name="asset" className="accent-brand-600" checked={draft.assetId === a.id}
                onChange={() => setDraft({ ...draft, assetId: a.id })} />
              <span className="flex-1">
                <span className="block font-medium text-slate-900">{a.name}</span>
                <span className="block font-mono text-xs text-slate-500">{a.code} · {a.category?.name?.toString() ?? '—'} · {a.serialNumber ?? 'no serial'}</span>
              </span>
              <Badge>{a.condition}</Badge>
            </label>
          ))}
        </div>
      )}
      {errors.assetId && <p className="text-xs text-red-600">{errors.assetId}</p>}
      {selected && (
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          <p className="font-semibold text-slate-900">Selected: {selected.name}</p>
          <p className="mt-0.5 font-mono text-xs text-slate-500">{selected.code} · {selected.condition}</p>
        </div>
      )}
    </div>
  )
}

export default function GenericAssignPage() {
  const nav = useNavigate()
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<GenericDraft>(emptyDraft)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const employees = useEmployees({ pageSize: 100 })
  const departments = useDepartments()
  const rooms = useRooms()
  // Availability lookup for the review step's asset name (AssetPicker fetches its own for the picker UI).
  const availability = useAssets({ status: 'AVAILABLE', pageSize: 100 }, true)
  const assetName = availability.data?.items.find((a) => a.id === draft.assetId)?.name

  const next = () => {
    const e = validateGenericStep(stepSchemas[step], draft)
    if (step === 0) {
      const dept = departments.data?.find((d) => d.id === draft.workIdentity.departmentTeamId)
      if (dept?.type === 'CALLCENTER') {
        if (!draft.workIdentity.name.trim()) e['workIdentity.name'] = 'Work identity name is required for call-center'
        if (!draft.workIdentity.roomId) e['workIdentity.roomId'] = 'Select a room for call-center identity'
      }
    }
    setErrors(e)
    if (Object.keys(e).length) return
    setStep((s) => Math.min(s + 1, 3))
  }
  const back = () => setStep((s) => Math.max(s - 1, 0))

  const create = useCreateGenericAssignment()

  const submit = () => {
    const dept = departments.data?.find((d) => d.id === draft.workIdentity.departmentTeamId)
    const isCallCenter = dept?.type === 'CALLCENTER'
    create.mutate(buildGenericPayload(draft, isCallCenter), {
      onSuccess: (assignment) => nav(`/assignments/${assignment.id}`, { replace: true }),
    })
  }

  const STEP_TITLES = ['Employee & identity', 'Asset', 'Details', 'Review']

  return (
    <>
      <Link to="/assignments" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Assignments</Link>
      <PageHeader title="Assign an asset" subtitle="Hand over any laptop, printer, SIM or other asset" />
      <ol className="mb-1 flex flex-wrap items-center gap-1 text-xs">
        {STEP_TITLES.map((t, i) => (
          <li key={t} className="flex items-center gap-1">
            <button type="button" onClick={() => i < step && setStep(i)} className={`flex items-center gap-1 rounded-full px-2 py-1 font-medium transition ${i === step ? 'bg-brand-600 text-white' : i < step ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
              {i < step ? <Check className="h-3 w-3" /> : <span className="h-3 w-3 rounded-full bg-current opacity-40" />}
              <span className="hidden sm:inline">{i + 1}. {t}</span>
              <span className="sm:hidden">{i + 1}</span>
            </button>
            {i < STEP_TITLES.length - 1 && <span className="h-px w-3 bg-slate-300" />}
          </li>
        ))}
      </ol>

      <div className="card p-5 sm:p-6">
        {step === 0 && (
          <div className="space-y-4">
            <Field label="Employee" required error={errors.employeeId} className="sm:max-w-sm">
              <Select value={draft.employeeId} onChange={(e) => setDraft({ ...draft, employeeId: e.target.value })}>
                <option value="">— select employee —</option>
                {employees.data?.items.map((emp) => <option key={emp.id} value={emp.id}>{emp.fullName}</option>)}
              </Select>
            </Field>
            <WorkIdentityFields
              value={draft.workIdentity}
              onChange={(patch) => setDraft({ ...draft, workIdentity: { ...draft.workIdentity, ...patch } })}
              errors={errors}
            />
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <Field label="Asset type" required error={errors.type}>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {GENERIC_ASSET_TYPES.map((t) => (
                  <button key={t} type="button" onClick={() => setDraft({ ...draft, type: t })}
                    className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition ${draft.type === t ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}>
                    {titleCase(t)}
                  </button>
                ))}
              </div>
            </Field>
            <AssetPicker draft={draft} setDraft={setDraft} errors={errors} />
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Condition at handover" required error={errors.conditionAtHandover}>
              <Select value={draft.conditionAtHandover} onChange={(e) => setDraft({ ...draft, conditionAtHandover: e.target.value })}>
                <option value="">— select —</option>
                {CONDITIONS.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
              </Select>
            </Field>
            <Field label="Expected return date" error={errors.expectedReturnAt}>
              <Input type="date" value={draft.expectedReturnAt} onChange={(e) => setDraft({ ...draft, expectedReturnAt: e.target.value })} />
            </Field>
            <Field label="Notes" className="sm:col-span-2">
              <Input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Optional notes about the handover" />
            </Field>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <h2 className="text-base font-semibold text-slate-900">Review the handover</h2>
            <dl className="divide-y divide-slate-100">
              {reviewRow('Employee', employees.data?.items.find((e) => e.id === draft.employeeId)?.fullName)}
              {reviewRow('Work identity', draft.workIdentity.name)}
              {reviewRow('Department', departments.data?.find((d) => d.id === draft.workIdentity.departmentTeamId)?.name)}
              {reviewRow('Room', rooms.data?.find((r) => r.id === draft.workIdentity.roomId)?.code)}
              {reviewRow('Asset type', draft.type && titleCase(draft.type))}
              {reviewRow('Asset', assetName ? <span className="inline-flex items-center gap-2">{assetName} <span className="font-mono text-xs text-slate-500">({draft.assetId.slice(0, 8)})</span></span> : draft.assetId)}
              {reviewRow('Condition', draft.conditionAtHandover)}
              {reviewRow('Expected return', draft.expectedReturnAt)}
              {reviewRow('Notes', draft.notes)}
            </dl>
            {create.isError && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {(create.error as Error).message}
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4">
          <div>
            <Button variant="secondary" onClick={back} disabled={step === 0}><ChevronLeft className="h-4 w-4" /> Back</Button>
          </div>
          <div className="flex items-center gap-2">
            {step > 0 && <Button variant="ghost" size="sm" onClick={() => setStep(0)}>Start over</Button>}
            {step < 3 ? (
              <Button onClick={next}>Next <ChevronRight className="h-4 w-4" /></Button>
            ) : (
              <Button onClick={submit} loading={create.isPending} disabled={create.isPending}>
                {create.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Assigning…</> : <>Assign asset</>}
              </Button>
            )}
          </div>
        </div>
        {Object.keys(errors).length > 0 && (
          <div role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <p className="font-semibold">Please fix the highlighted fields to continue:</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              {Object.values(errors).map((m, i) => <li key={i}>{m}</li>)}
            </ul>
          </div>
        )}
      </div>
    </>
  )
}

const reviewRow = (label: string, value?: React.ReactNode) => (
  <div className="grid grid-cols-3 gap-2 py-2 text-sm">
    <dt className="text-slate-500">{label}</dt><dd className="col-span-2 break-words text-slate-900">{value || '—'}</dd>
  </div>
)
