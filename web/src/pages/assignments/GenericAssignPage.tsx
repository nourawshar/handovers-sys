import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Camera, Check, ChevronLeft, ChevronRight, Loader2, Search, X } from 'lucide-react'
import { z } from 'zod'
import { api } from '@/api/client'
import { useAsset, useAssets, useCategories, useCreateGenericAssignment, useDepartments, useEmployees, useRooms } from '@/api/hooks'
import type { Asset, GenericAssignmentPayload, LastConditionCheck, WorkIdentityInput } from '@/api/types'
import { CONDITIONS } from '@/api/types'
import { useDebounce } from '@/lib/useDebounce'
import { fmtDate, titleCase } from '@/lib/utils'
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, SearchableSelect, Select, Spinner } from '@/components/ui'
import { WorkIdentityFields, type WorkIdentityValue } from './WorkIdentityFields'

/** Non-phone asset types assignable via /assignments/generic (CHANGE 1, BE-5 + computers BE-18/CHANGE 3). */
export const GENERIC_ASSET_TYPES = ['LAPTOP', 'PRINTER', 'SIM', 'GENERAL', 'COMPUTERS', 'MONITORS', 'MOUSE', 'KEYBOARDS', 'HEADPHONES'] as const
export type GenericAssetType = (typeof GENERIC_ASSET_TYPES)[number]

/** Compact view of an asset kept in the draft (review step, condition prefill, accessory filtering). */
export interface AssetBrief { id: string; code: string; name: string; categoryId: string; categoryName: string; condition: string }
export interface AccessoryPick extends AssetBrief { chosenCondition: string }
const briefOf = (a: Asset): AssetBrief => ({
  id: a.id, code: a.code, name: a.name, categoryId: a.categoryId, categoryName: a.category?.name?.toString() ?? '', condition: a.condition,
})

export interface GenericDraft {
  employeeId: string
  workIdentity: WorkIdentityValue
  type: GenericAssetType | ''
  assetId: string
  /** The chosen main asset. */
  assetInfo: AssetBrief | null
  /** Optional accessories — sent as accessoryAssetIds + accessoryConditions (Phase 8 R2). */
  accessories: AccessoryPick[]
  conditionAtHandover: string
  expectedReturnAt: string
  notes: string
}

const emptyDraft = (): GenericDraft => ({
  employeeId: '', workIdentity: { name: '', departmentTeamId: '', roomId: '' }, type: '',
  assetId: '', assetInfo: null, accessories: [], conditionAtHandover: '', expectedReturnAt: '', notes: '',
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
  // 2. Asset (type + pick; accessories are optional)
  z.object({
    type: z.enum(GENERIC_ASSET_TYPES, { message: 'Select an asset type' }),
    assetId: z.string().min(1, 'Select an asset'),
    accessories: z.array(z.object({ id: z.string() })),
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
    accessoryAssetIds: draft.accessories.length ? draft.accessories.map((a) => a.id) : undefined,
    accessoryConditions: draft.accessories.length ? draft.accessories.map((a) => ({ assetId: a.id, condition: a.chosenCondition })) : undefined,
    conditionAtHandover: draft.conditionAtHandover || undefined,
    expectedReturnAt: draft.expectedReturnAt || null,
    notes: draft.notes || null,
  }
}

/** Conditions offered at handover (DISPOSED makes no sense for an asset going out — unless it already is the value). */
export const handoverConditions = (current?: string): string[] => CONDITIONS.filter((c) => c !== 'DISPOSED' || c === current)

const sourceLabel = (c: LastConditionCheck): string => {
  const code = c.assignmentCode
  if (c.source === 'return') return code ? `return ${code}` : 'a return'
  if (c.source === 'delivery') return code ? `delivery ${code}` : 'a delivery'
  if (c.source === 'created') return 'when it was created'
  return 'the asset record'
}

/** "Last recorded: Fair — from return A-000012 on 3 Nov 2026", plus the write-back note once the user changes it. */
export function ConditionHint({ assetId, fallbackCondition, chosen }: { assetId: string; fallbackCondition?: string; chosen: string }) {
  const asset = useAsset(assetId || undefined)
  const last = asset.data?.asset?.lastConditionCheck
  const current = asset.data?.asset?.condition ?? fallbackCondition
  return (
    <div className="mt-1 space-y-0.5 text-xs">
      {last ? (
        <p className="text-slate-500">Last recorded: {titleCase(last.condition)} — from {sourceLabel(last)}{last.at ? ` on ${fmtDate(last.at)}` : ''}</p>
      ) : current ? (
        <p className="text-slate-500">Last recorded: {titleCase(current)}</p>
      ) : null}
      {current && chosen && chosen !== current && (
        <p className="text-amber-700">The asset's condition will be updated to {titleCase(chosen)} on handover.</p>
      )}
    </div>
  )
}

export type GenericPhotoType = 'FRONT' | 'BACK' | 'CONDITION'
/** `target` = id of the asset the photo is tagged to ('' = the main asset). */
export interface GenericPhotoPick { type: GenericPhotoType; file: File; url: string; target: string }

const PHOTO_ACCEPT = ['image/jpeg', 'image/png', 'image/webp']
const PHOTO_MAX_MB = 5
const PHOTO_SLOTS: { type: GenericPhotoType; label: string }[] = [
  { type: 'FRONT', label: 'Front photo' }, { type: 'BACK', label: 'Back photo' }, { type: 'CONDITION', label: 'Condition photo' },
]

/** Front / back / condition photo slots (one image each). Files upload after the assignment is created. */
function GenericPhotoPicker({ photos, setPhotos, main, accessories }: {
  photos: GenericPhotoPick[]; setPhotos: (p: GenericPhotoPick[]) => void; main: AssetBrief | null; accessories: AccessoryPick[]
}) {
  const inputs = useRef<Partial<Record<GenericPhotoType, HTMLInputElement | null>>>({})
  const [err, setErr] = useState<string | null>(null)

  const pick = (type: GenericPhotoType, list: FileList | null) => {
    setErr(null)
    const file = list?.[0]
    if (!file) return
    if (!PHOTO_ACCEPT.includes(file.type)) return setErr(`“${file.name}” is not a JPEG/PNG/WebP image.`)
    if (file.size > PHOTO_MAX_MB * 1024 * 1024) return setErr(`“${file.name}” is larger than ${PHOTO_MAX_MB} MB.`)
    const old = photos.find((p) => p.type === type)
    if (old) URL.revokeObjectURL(old.url)
    setPhotos([...photos.filter((p) => p.type !== type), { type, file, url: URL.createObjectURL(file), target: old?.target ?? '' }])
    const el = inputs.current[type]
    if (el) el.value = ''
  }
  const remove = (type: GenericPhotoType) => {
    const old = photos.find((p) => p.type === type)
    if (old) URL.revokeObjectURL(old.url)
    setPhotos(photos.filter((p) => p.type !== type))
  }

  return (
    <div className="space-y-3 sm:col-span-2">
      <div>
        <p className="text-sm font-medium text-slate-800">Photos <span className="font-normal text-slate-500">(optional — JPEG/PNG/WebP, max {PHOTO_MAX_MB} MB each)</span></p>
        <p className="text-xs text-slate-500">
          Front, back and a condition close-up. They upload after the assignment is created{accessories.length > 0 ? ' — tag each photo to the main asset or an accessory' : ''}.
        </p>
      </div>
      {err && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>}
      <div className="grid gap-3 sm:grid-cols-3">
        {PHOTO_SLOTS.map(({ type, label }) => {
          const p = photos.find((x) => x.type === type)
          return (
            <div key={type} className="space-y-1">
              <input ref={(el) => { inputs.current[type] = el }} type="file" accept={PHOTO_ACCEPT.join(',')} capture="environment" className="hidden"
                onChange={(e) => pick(type, e.target.files)} />
              <button type="button" onClick={() => inputs.current[type]?.click()}
                className={`relative flex aspect-square w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border-2 border-dashed text-sm transition ${p ? 'border-emerald-400 bg-emerald-50/40' : 'border-slate-300 text-slate-400 hover:border-slate-400'}`}>
                {p ? <img src={p.url} alt={label} className="h-full w-full object-cover" /> : <><Camera className="h-8 w-8" /><span>{label}</span></>}
              </button>
              {p && (
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span className="truncate">{p.file.name}</span>
                  <button type="button" onClick={() => remove(type)} aria-label={`Remove ${label}`} className="text-slate-400 hover:text-red-600"><X className="h-4 w-4" /></button>
                </div>
              )}
              {p && accessories.length > 0 && (
                <Select aria-label={`${label} belongs to`} value={accessories.some((a) => a.id === p.target) ? p.target : ''}
                  onChange={(e) => setPhotos(photos.map((x) => (x.type === type ? { ...x, target: e.target.value } : x)))}>
                  <option value="">{main ? `${main.code} (main asset)` : 'Main asset'}</option>
                  {accessories.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                </Select>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
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
  // SIM→"SIM Cards", COMPUTERS→"Computers", MONITORS→"Monitors", …). GENERAL and empty type have no
  // category filter (all non-phone assets). The regex matches the seeded category names case-insensitively.
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
  const selected = candidates.find((a) => a.id === draft.assetId) ?? (draft.assetInfo?.id === draft.assetId ? draft.assetInfo : undefined)

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search available assets by code, serial or name…" className="pl-9" aria-label="Search assets" />
      </div>
      {!draft.type ? (
        <EmptyState title="Pick an asset type first" hint="Choose LAPTOP, PRINTER, SIM, GENERAL or a computer type (COMPUTERS / MONITORS / MOUSE / KEYBOARDS / HEADPHONES) above to see matching available assets." />
      ) : list.isLoading ? <Spinner /> : list.isError ? <ErrorState error={list.error} /> : candidates.length === 0 ? (
        <EmptyState title="No available assets" hint="Create an available asset under Assets before assigning it." action={<Link to="/assets/new"><Button size="sm" variant="secondary">New asset</Button></Link>} />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {candidates.map((a) => (
            <label key={a.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm transition ${draft.assetId === a.id ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
              <input type="radio" name="asset" className="accent-brand-600" checked={draft.assetId === a.id}
                onChange={() => setDraft({
                  ...draft,
                  assetId: a.id,
                  assetInfo: briefOf(a),
                  // Condition at handover starts as the asset's own condition (never empty).
                  conditionAtHandover: a.condition,
                  accessories: draft.accessories.filter((x) => x.id !== a.id && x.categoryId !== a.categoryId),
                })} />
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

const isPhoneRoot = (n: string) => /^phones?$/i.test(n.trim())
const isSimRoot = (n: string) => /^sim(\s|-)?(cards?)?$/i.test(n.trim())

/**
 * "Add accessories" (Phase 8 R2): pick ANY physical category except Phones, SIM Cards and the main asset's own,
 * tick available assets → removable chips with a per-item condition. Several categories can be used in turn,
 * and categories created by the user show up automatically (no hard-coded names).
 */
function AccessoryPicker({ draft, setDraft }: { draft: GenericDraft; setDraft: (d: GenericDraft) => void }) {
  const categories = useCategories()
  const [catId, setCatId] = useState('')
  const mainCategoryId = draft.assetInfo?.categoryId

  const options = useMemo(() => {
    const all = categories.data ?? []
    const byId = new Map(all.map((c) => [c.id, c]))
    return all
      .filter((c) => {
        if (c.isActive === false || c.kind !== 'physical' || c.id === mainCategoryId) return false
        const root = c.parentId ? byId.get(c.parentId) ?? c : c
        return !(isPhoneRoot(root.name) || isSimRoot(root.name))
      })
      .map((c) => ({ value: c.id, label: c.parentId && byId.get(c.parentId) ? `${byId.get(c.parentId)!.name} › ${c.name}` : c.name }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [categories.data, mainCategoryId])
  const activeCat = options.some((o) => o.value === catId) ? catId : ''

  const list = useAssets({ categoryId: activeCat || undefined, status: 'AVAILABLE', pageSize: 100 }, !!activeCat)
  const items = (list.data?.items ?? []).filter((a) => a.id !== draft.assetId)
  const picked = (id: string) => draft.accessories.some((x) => x.id === id)
  const toggle = (a: Asset) => setDraft({
    ...draft,
    accessories: picked(a.id)
      ? draft.accessories.filter((x) => x.id !== a.id)
      : [...draft.accessories, { ...briefOf(a), chosenCondition: a.condition }],
  })
  const setCond = (id: string, chosenCondition: string) =>
    setDraft({ ...draft, accessories: draft.accessories.map((x) => (x.id === id ? { ...x, chosenCondition } : x)) })

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-slate-300 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-800">
          Add accessories <span className="font-normal text-slate-500">(optional — handed over together with the main asset)</span>
        </p>
        {draft.accessories.length > 0 && (
          <button type="button" onClick={() => setDraft({ ...draft, accessories: [] })} className="text-xs font-medium text-slate-500 hover:text-red-600">
            Clear ({draft.accessories.length})
          </button>
        )}
      </div>

      {draft.accessories.length > 0 && (
        <ul className="space-y-2" aria-label="Selected accessories">
          {draft.accessories.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 py-1.5 pl-3 pr-2 text-sm">
              <span className="font-mono text-xs text-slate-700">{a.code}</span>
              <span className="text-slate-400">·</span>
              <span className="min-w-0 flex-1 truncate font-medium text-slate-900">{a.name}</span>
              <Select aria-label={`Condition of ${a.code}`} className="!w-auto text-xs" value={a.chosenCondition} onChange={(e) => setCond(a.id, e.target.value)}>
                {handoverConditions(a.chosenCondition).map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
              </Select>
              <button type="button" onClick={() => setDraft({ ...draft, accessories: draft.accessories.filter((x) => x.id !== a.id) })}
                aria-label={`Remove ${a.code}`} className="rounded-full p-1 text-slate-400 hover:bg-white hover:text-red-600"><X className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
      )}

      {categories.isLoading ? <Spinner /> : options.length === 0 ? (
        <p className="text-xs text-slate-500">No other physical categories exist yet — create one under Settings → Categories.</p>
      ) : (
        <>
          <SearchableSelect
            ariaLabel="Accessory category"
            options={options}
            value={activeCat}
            onChange={setCatId}
            placeholder="Type to filter categories…"
            selectPlaceholder="— choose a category to add accessories from —"
          />
          {activeCat && (list.isLoading ? <Spinner /> : list.isError ? <ErrorState error={list.error} /> : items.length === 0 ? (
            <p className="text-xs text-slate-500">No available assets in this category.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {items.map((a) => (
                <label key={a.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm transition ${picked(a.id) ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                  <input type="checkbox" className="accent-brand-600" checked={picked(a.id)} onChange={() => toggle(a)} />
                  <span className="flex-1">
                    <span className="block font-medium text-slate-900">{a.name}</span>
                    <span className="block font-mono text-xs text-slate-500">{a.code} · {a.serialNumber ?? 'no serial'}</span>
                  </span>
                  <Badge>{a.condition}</Badge>
                </label>
              ))}
            </div>
          ))}
          {!activeCat && draft.accessories.length === 0 && (
            <p className="text-xs text-slate-400">Pick a category, tick the assets to add, then pick another category to add more.</p>
          )}
        </>
      )}
    </div>
  )
}

export default function GenericAssignPage() {
  const nav = useNavigate()
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<GenericDraft>(emptyDraft)
  const [photos, setPhotos] = useState<GenericPhotoPick[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})

  const employees = useEmployees({ pageSize: 100 })
  const departments = useDepartments()
  const rooms = useRooms()

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
      onSuccess: async (assignment) => {
        const failed: string[] = []
        for (const p of photos) {
          try {
            // Tag each photo to the main asset (default) or its accessory, context HANDOVER (Phase 8 R5).
            const target = draft.accessories.some((a) => a.id === p.target) ? p.target : draft.assetId
            const f = new FormData()
            f.append('type', p.type); f.append('assetId', target); f.append('context', 'HANDOVER'); f.append('photos', p.file)
            await api.upload(`/assignments/${assignment.id}/photos`, f)
          } catch { failed.push(p.type) }
        }
        // Assignment exists either way — go to it; failed photos can be re-added from its page.
        void failed
        nav(`/assignments/${assignment.id}`, { replace: true })
      },
    })
  }

  const STEP_TITLES = ['Employee & identity', 'Asset', 'Details', 'Review']

  return (
    <>
      <Link to="/assignments" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Assignments</Link>
      <PageHeader title="Assign an asset" subtitle="Hand over any laptop, printer, SIM, computer or other asset" />
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
              <SearchableSelect
                options={(employees.data?.items ?? []).map((emp) => ({ value: emp.id, label: emp.fullName }))}
                value={draft.employeeId}
                onChange={(employeeId) => setDraft({ ...draft, employeeId })}
                placeholder="Type to filter employees…"
                selectPlaceholder="— select employee —"
              />
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
            <AccessoryPicker draft={draft} setDraft={setDraft} />
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Condition at handover" required error={errors.conditionAtHandover}>
              <Select value={draft.conditionAtHandover} onChange={(e) => setDraft({ ...draft, conditionAtHandover: e.target.value })}>
                {handoverConditions(draft.conditionAtHandover).map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
              </Select>
              <ConditionHint assetId={draft.assetId} fallbackCondition={draft.assetInfo?.condition} chosen={draft.conditionAtHandover} />
            </Field>
            <Field label="Expected return date" error={errors.expectedReturnAt}>
              <Input type="date" value={draft.expectedReturnAt} onChange={(e) => setDraft({ ...draft, expectedReturnAt: e.target.value })} />
            </Field>
            <Field label="Notes" className="sm:col-span-2">
              <Input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Optional notes about the handover" />
            </Field>
            <GenericPhotoPicker photos={photos} setPhotos={setPhotos} main={draft.assetInfo} accessories={draft.accessories} />
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
              {reviewRow('Asset', draft.assetInfo ? <span><span className="font-mono text-xs font-semibold">{draft.assetInfo.code}</span> · {draft.assetInfo.name}</span> : draft.assetId)}
              {reviewRow('Accessories', draft.accessories.length ? (
                <ul className="space-y-0.5">
                  {draft.accessories.map((a) => (
                    <li key={a.id}><span className="font-mono text-xs font-semibold">{a.code}</span> · {a.name} <span className="text-slate-500">— {titleCase(a.chosenCondition)}</span></li>
                  ))}
                </ul>
              ) : undefined)}
              {reviewRow('Condition', draft.conditionAtHandover && titleCase(draft.conditionAtHandover))}
              {reviewRow('Expected return', draft.expectedReturnAt)}
              {reviewRow('Notes', draft.notes)}
              {reviewRow('Photos', photos.length ? (
                <span className="flex flex-wrap gap-2">
                  {photos.map((p) => (
                    <span key={p.type} className="inline-flex flex-col items-center gap-0.5 text-xs text-slate-500">
                      <img src={p.url} alt={`${p.type} thumbnail`} className="h-16 w-16 rounded-md border border-slate-200 object-cover" />
                      {titleCase(p.type)}
                      <span className="font-mono">{draft.accessories.find((a) => a.id === p.target)?.code ?? draft.assetInfo?.code}</span>
                    </span>
                  ))}
                </span>
              ) : undefined)}
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
