import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Camera, ChevronLeft, ChevronRight, Check, Loader2, Search, X } from 'lucide-react'
import { z } from 'zod'
import { api } from '@/api/client'
import { useAccounts, useAsset, useAssets, useCategories, useCreatePhoneAssignment, useDepartments, useEmployees, useRooms } from '@/api/hooks'
import type { PhoneAssignmentPayload, WaVariant, WorkIdentityInput } from '@/api/types'
import { WA_VARIANTS } from '@/api/types'
import { useDebounce } from '@/lib/useDebounce'
import { fmtDate, titleCase } from '@/lib/utils'
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Select, Spinner } from '@/components/ui'
import { WorkIdentityFields, type WorkIdentityValue } from '@/pages/assignments/WorkIdentityFields'

/* ------------------------------------------------------------------ */
/* Draft state (form-shaped) + per-step Zod validation + payload       */
/* ------------------------------------------------------------------ */

export interface WaState {
  business: boolean
  phoneNumber: string
  backupEmail: string
  backupDate: string
  backupUsedGB: string
  backupTotalGB: string
  chatNormalCount: string
  chatArchivedCount: string
  appVariant: WaVariant | ''
}

export interface PhotoPick { type: 'FRONT' | 'BACK'; file: File; url: string }

export interface WizardDraft {
  employeeId: string
  workIdentity: WorkIdentityValue
  phoneAssetId: string
  imei: string
  sim1Number: string
  sim1AssetId: string
  wa1: WaState
  includeSim2: boolean
  sim2Number: string
  sim2AssetId: string
  wa2: WaState
  bitrixAccountId: string
  chargerCableAssetId: string
  chargerAdapterAssetId: string
  notes: string
}

const emptyWa = (): WaState => ({
  business: true, phoneNumber: '', backupEmail: '', backupDate: '', backupUsedGB: '',
  backupTotalGB: '', chatNormalCount: '', chatArchivedCount: '', appVariant: 'BUSINESS',
})

export const emptyDraft = (): WizardDraft => ({
  employeeId: '', workIdentity: { name: '', departmentTeamId: '', roomId: '' }, phoneAssetId: '', imei: '',
  sim1Number: '', sim1AssetId: '', wa1: emptyWa(),
  includeSim2: false, sim2Number: '', sim2AssetId: '', wa2: emptyWa(),
  bitrixAccountId: '', chargerCableAssetId: '', chargerAdapterAssetId: '', notes: '',
})

const reqInt = (label: string) => z.string().trim().min(1, `${label} is required`).refine((v) => /^\d+$/.test(v), `${label} must be a whole number`)
const optInt = () => z.string().trim().refine((v) => v === '' || /^\d+$/.test(v), 'Must be a whole number')
const optEmail = () => z.string().trim().refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email')
const dateOrEmpty = () => z.string().trim().refine((v) => v === '' || !Number.isNaN(new Date(`${v}T00:00:00`).getTime()), 'Enter a valid date')

const waSchema = (required: boolean) => ({
  business: z.boolean(),
  phoneNumber: required ? z.string().trim().min(1, 'Phone number is required') : z.string(),
  backupEmail: required ? optEmail().refine((v) => v !== '', 'Backup email is required') : optEmail(),
  backupDate: required ? dateOrEmpty().refine((v) => v !== '', 'Backup date is required') : dateOrEmpty(),
  backupUsedGB: required ? reqInt('Backup used (GB)') : optInt(),
  backupTotalGB: required ? reqInt('Backup total (GB)') : optInt(),
  chatNormalCount: required ? reqInt('Normal chat count') : optInt(),
  chatArchivedCount: required ? reqInt('Archived chat count') : optInt(),
  appVariant: z.enum(WA_VARIANTS),
})

export const stepSchemas: z.ZodTypeAny[] = [
  // 1. Employee + work identity (manual name + department; room validated in `next` for call-centers)
  z.object({
    employeeId: z.string().min(1, 'Select an employee'),
    workIdentity: z.object({
      name: z.string().trim().min(1, 'Work identity name is required'),
      departmentTeamId: z.string().min(1, 'Select a department'),
      roomId: z.string(),
    }),
  }),
  // 2. Phone
  z.object({ phoneAssetId: z.string().min(1, 'Select a phone') }),
  // 3. SIM1 + WhatsApp main
  z.object({
    sim1Number: z.string().trim().min(1, 'SIM 1 number is required'),
    sim1AssetId: z.string(), // SIM asset optional per README A9
    wa1: z.object(waSchema(true)),
  }),
  // 4. SIM2 + WhatsApp secondary (optional)
  z.object({
    includeSim2: z.boolean(),
    sim2Number: z.string(),
    wa2: z.object(waSchema(false)),
  }),
  // 5. Bitrix + chargers (all optional)
  z.object({
    bitrixAccountId: z.string(), chargerCableAssetId: z.string(), chargerAdapterAssetId: z.string(),
  }),
  // 6. Photos — both optional, need at least one front for a visible record
  z.object({}),
  // 7. Review — no additional validation
  z.object({}),
]

export function validateStep(schema: z.ZodTypeAny, draft: WizardDraft): Record<string, string> {
  const res = schema.safeParse(draft)
  if (res.success) return {}
  const out: Record<string, string> = {}
  for (const issue of res.error.issues) {
    const key = issue.path.join('.')
    if (!(key in out)) out[key] = issue.message
  }
  return out
}

const toNum = (v: string): number | null => (v === '' ? null : Number(v))
const toStr = (v: string): string | null => (v === '' ? null : v)

/** Builds the §7.6 request body from the draft + selected phone (CHANGE 4: workIdentity instead of workIdentityId). */
export function buildPhonePayload(draft: WizardDraft): PhoneAssignmentPayload {
  const w1 = draft.wa1
  const useSim2 = draft.includeSim2
  const w2 = draft.wa2
  const wi = draft.workIdentity
  const workIdentity: WorkIdentityInput = {
    name: wi.name.trim(),
    departmentTeamId: wi.departmentTeamId || null,
    roomId: wi.roomId || null,
  }
  return {
    employeeId: draft.employeeId,
    workIdentityId: undefined,
    workIdentity,
    phoneAssetId: draft.phoneAssetId,
    imei: draft.imei || null,
    sim1Number: toStr(draft.sim1Number),
    sim1AssetId: toStr(draft.sim1AssetId) ?? undefined,
    wa1Business: w1.business,
    wa1PhoneNumber: toStr(w1.phoneNumber),
    wa1BackupEmail: toStr(w1.backupEmail),
    wa1BackupDate: toStr(w1.backupDate),
    wa1BackupUsedGB: toNum(w1.backupUsedGB),
    wa1BackupTotalGB: toNum(w1.backupTotalGB),
    wa1ChatNormalCount: toNum(w1.chatNormalCount),
    wa1ChatArchivedCount: toNum(w1.chatArchivedCount),
    wa1AppVariant: w1.appVariant as WaVariant,
    sim2Number: useSim2 ? toStr(draft.sim2Number) : null,
    sim2AssetId: useSim2 ? toStr(draft.sim2AssetId) ?? undefined : null,
    wa2Business: w2.business,
    wa2PhoneNumber: useSim2 ? toStr(w2.phoneNumber) : null,
    wa2BackupEmail: useSim2 ? toStr(w2.backupEmail) : null,
    wa2BackupDate: useSim2 ? toStr(w2.backupDate) : null,
    wa2BackupUsedGB: useSim2 ? toNum(w2.backupUsedGB) : null,
    wa2BackupTotalGB: useSim2 ? toNum(w2.backupTotalGB) : null,
    wa2ChatNormalCount: useSim2 ? toNum(w2.chatNormalCount) : null,
    wa2ChatArchivedCount: useSim2 ? toNum(w2.chatArchivedCount) : null,
    wa2AppVariant: w2.appVariant as WaVariant | null,
    bitrixAccountId: toStr(draft.bitrixAccountId) ?? undefined,
    chargerCableAssetId: toStr(draft.chargerCableAssetId) ?? undefined,
    chargerAdapterAssetId: toStr(draft.chargerAdapterAssetId) ?? undefined,
    notes: toStr(draft.notes) ?? undefined,
  }
}

/* ------------------------------------------------------------------ */
/* Small presentational helpers                                        */
/* ------------------------------------------------------------------ */

const STEP_TITLES = [
  'Employee & identity', 'Phone', 'SIM 1 + WhatsApp', 'SIM 2 + WhatsApp', 'Bitrix & chargers', 'Photos', 'Review',
]

const ACCEPT = 'image/jpeg,image/png,image/webp'
const MAX_MB = 5

export function WaFields({ wa, onChange, required, title, backupEmailOptions = [] }: {
  wa: WaState; onChange: (w: WaState) => void; required: boolean; title: string; backupEmailOptions?: { value: string; label: string }[]
}) {
  const set = (patch: Partial<WaState>) => onChange({ ...wa, ...patch })
  return (
    <fieldset className="space-y-4 rounded-lg border border-slate-200 p-4">
      <legend className="px-1 text-sm font-semibold text-slate-900">{title}</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Business WhatsApp?" required={required}>
          <Select value={wa.business ? 'yes' : 'no'} onChange={(e) => set({ business: e.target.value === 'yes' })}>
            <option value="yes">Yes — business</option>
            <option value="no">No — personal</option>
          </Select>
        </Field>
        <Field label="Backup Gmail" hint="Gmail account used for WhatsApp backup" required={required}>
          <Select value={wa.backupEmail} onChange={(e) => set({ backupEmail: e.target.value })}>
            <option value="">— select backup Gmail —</option>
            {backupEmailOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </Field>
        <Field label="Backup date" required={required}>
          <Input type="date" value={wa.backupDate} onChange={(e) => set({ backupDate: e.target.value })} />
        </Field>
        <Field label="Backup used (GB)" required={required}>
          <Input type="number" min={0} step="0.1" value={wa.backupUsedGB} onChange={(e) => set({ backupUsedGB: e.target.value })} placeholder="12" />
        </Field>
        <Field label="Backup total (GB)" required={required}>
          <Input type="number" min={0} step="0.1" value={wa.backupTotalGB} onChange={(e) => set({ backupTotalGB: e.target.value })} placeholder="15" />
        </Field>
        <Field label="Chat count (normal)" required={required}>
          <Input type="number" min={0} value={wa.chatNormalCount} onChange={(e) => set({ chatNormalCount: e.target.value })} placeholder="4500" />
        </Field>
        <Field label="Chat count (archived)" required={required}>
          <Input type="number" min={0} value={wa.chatArchivedCount} onChange={(e) => set({ chatArchivedCount: e.target.value })} placeholder="210" />
        </Field>
        <Field label="App variant" required={required} className="sm:col-span-2">
          <Select value={wa.appVariant} onChange={(e) => set({ appVariant: e.target.value as WaVariant })}>
            <option value="">—</option>
            {WA_VARIANTS.map((v) => <option key={v} value={v}>{titleCase(v)}</option>)}
          </Select>
        </Field>
      </div>
    </fieldset>
  )
}

/** "12 GB of 15 GB" style string from used/total. */
export const backupSummary = (used: string, total: string, isWa2 = false) => {
  const label = isWa2 ? 'SIM 2 backup' : 'SIM 1 backup'
  if (!used && !total) return `${label}: not recorded`
  return `${label}: ${used || '—'} GB of ${total || '—'} GB`
}

/* ------------------------------------------------------------------ */
/* The wizard                                                          */
/* ------------------------------------------------------------------ */

function PhonePicker({ draft, setDraft, errors }: {
  draft: WizardDraft; setDraft: (d: WizardDraft) => void; errors: Record<string, string>
}) {
  const categories = useCategories()
  const phoneCat = categories.data?.find((c) => !c.parentId && /phone/i.test(c.name))
  const [q, setQ] = useState('')
  const dq = useDebounce(q)
  const list = useAssets(
    {
      q: dq || undefined, categoryId: phoneCat?.id, status: 'AVAILABLE', pageSize: 100,
    },
    !!phoneCat,
  )
  const phones = list.data?.items ?? []
  const selected = phones.find((p) => p.id === draft.phoneAssetId)

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search available phones by code, IMEI or name…" className="pl-9" aria-label="Search phones" />
      </div>
      {list.isLoading ? <Spinner /> : list.isError ? <ErrorState error={list.error} /> : phones.length === 0 ? (
        <EmptyState title="No available phones" hint="Create an available phone under Assets before assigning it." action={<Link to="/assets/new"><Button size="sm" variant="secondary">New asset</Button></Link>} />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {phones.map((p) => (
            <label key={p.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm transition ${draft.phoneAssetId === p.id ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
              <input type="radio" name="phone" className="accent-brand-600" checked={draft.phoneAssetId === p.id}
                onChange={() => setDraft({ ...draft, phoneAssetId: p.id, imei: p.imei ?? '' })} />
              <span className="flex-1">
                <span className="block font-medium text-slate-900">{p.name}</span>
                <span className="block font-mono text-xs text-slate-500">{p.code} · {p.imei ?? 'no IMEI'}</span>
              </span>
              {p.phone && <Badge>{[p.phone.make, p.phone.model].filter(Boolean).join(' ')}</Badge>}
            </label>
          ))}
        </div>
      )}
      {errors.phoneAssetId && <p className="text-xs text-red-600">{errors.phoneAssetId}</p>}
      {selected && (
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          <p className="font-semibold text-slate-900">Selected: {selected.name}</p>
          <p className="mt-0.5 font-mono text-xs text-slate-500">IMEI {selected.imei ?? '—'} · {selected.phone?.storage ?? '—'} · {selected.condition}</p>
        </div>
      )}
    </div>
  )
}

function PhotoStep({ photos, setPhotos }: {
  photos: PhotoPick[]; setPhotos: (p: PhotoPick[]) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [localErr, setLocalErr] = useState<string | null>(null)

  const add = (type: 'FRONT' | 'BACK', list: FileList | null) => {
    setLocalErr(null)
    const files = Array.from(list ?? [])
    if (!files.length) return
    const bad = files.find((f) => !ACCEPT.split(',').includes(f.type))
    if (bad) return setLocalErr(`“${bad.name}” is not a JPEG/PNG/WebP image.`)
    const big = files.find((f) => f.size > MAX_MB * 1024 * 1024)
    if (big) return setLocalErr(`“${big.name}” is larger than ${MAX_MB} MB.`)
    const picks = files.map((f) => ({ type, file: f, url: URL.createObjectURL(f) }))
    setPhotos([...photos.filter((p) => p.type !== type), ...picks])
    if (inputRef.current) inputRef.current.value = ''
  }

  const remove = (url: string) => {
    const p = photos.find((x) => x.url === url)
    if (p) URL.revokeObjectURL(p.url)
    setPhotos(photos.filter((x) => x.url !== url))
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">Add a front and a back photo of the phone. They upload to the assignment after it is created.</p>
      {localErr && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{localErr}</div>}
      <input ref={inputRef} type="file" accept={ACCEPT} capture="environment" className="hidden"
        onChange={(e) => add(photos.length ? (photos[0].type === 'FRONT' ? 'BACK' : 'FRONT') : 'FRONT', e.target.files)} />
      <div className="grid cursor-pointer gap-4 sm:grid-cols-2" onClick={() => inputRef.current?.click()}>
        {(['FRONT', 'BACK'] as const).map((t) => {
          const pick = photos.find((p) => p.type === t)
          return (
            <div key={t} className={`flex aspect-square flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border-2 border-dashed text-sm transition ${pick ? 'border-emerald-400 bg-emerald-50/40' : 'border-slate-300 text-slate-400 hover:border-slate-400'}`}>
              {pick ? (
                <img src={pick.url} alt={`${titleCase(t)} photo`} className="h-full w-full object-cover" />
              ) : (
                <><Camera className="h-8 w-8" /><span>{titleCase(t)} photo</span></>)
              }
            </div>
          )
        })}
      </div>
      {photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {photos.map((p) => (
            <div key={p.url} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs">
              <Badge>{p.type}</Badge><span className="text-slate-600">{p.file.name}</span>
              <button type="button" onClick={() => remove(p.url)} aria-label={`Remove ${p.type}`} className="text-slate-400 hover:text-red-600"><X className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function PhoneAssignPage() {
  const nav = useNavigate()
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<WizardDraft>(emptyDraft)
  const [photos, setPhotos] = useState<PhotoPick[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})

  const employees = useEmployees({ pageSize: 100 })
  const departments = useDepartments()
  const rooms = useRooms()
  const categories = useCategories()
  const chargerCats = useMemo(() => {
    const c = categories.data ?? []
    const charger = c.find((x) => !x.parentId && /charger/i.test(x.name))
    if (!charger) return { cable: [], adapter: [] }
    return {
      cable: c.filter((x) => x.parentId === charger.id && /cable/i.test(x.name)),
      adapter: c.filter((x) => x.parentId === charger.id && /adapter/i.test(x.name)),
    }
  }, [categories.data])
  const cableCat = chargerCats.cable[0]
  const adapterCat = chargerCats.adapter[0]
  const cables = useAssets({ categoryId: cableCat?.id, status: 'AVAILABLE', pageSize: 100 }, !!cableCat)
  const adapters = useAssets({ categoryId: adapterCat?.id, status: 'AVAILABLE', pageSize: 100 }, !!adapterCat)
  const accounts = useAccounts({ kind: 'BITRIX', pageSize: 100 })
  const selectedPhone = useAsset(draft.phoneAssetId || undefined)

  // SIM-card assets (single number source) + Gmail backup accounts (dropdowns).
  const simCat = categories.data?.find((c) => !c.parentId && /sim/i.test(c.name))
  const sims = useAssets({ categoryId: simCat?.id, status: 'AVAILABLE', pageSize: 100 }, !!simCat)
  const gmailBackups = useAccounts({ kind: 'GMAIL', isWhatsAppBackup: true, pageSize: 100 })
  const gmailOptions = (gmailBackups.data?.items ?? []).map((a) => ({
    value: a.email || a.identifier,
    label: a.email || a.identifier,
  }))
  const simNumber = (a: { customFields: Record<string, unknown> } | undefined): string => {
      const v = a?.customFields?.phone_number
      if (typeof v === 'string') return v
      if (typeof v === 'number') return String(v)
      return ''
    }

  const next = () => {
    const e = validateStep(stepSchemas[step], draft)
    // Call-center identities require a room (CHANGE 4).
    if (step === 0) {
      const dept = departments.data?.find((d) => d.id === draft.workIdentity.departmentTeamId)
      if (dept?.type === 'CALLCENTER' && !draft.workIdentity.roomId) {
        e['workIdentity.roomId'] = 'Select a room for call-center identity'
      }
    }
    setErrors(e)
    if (Object.keys(e).length) return
    setStep((s) => Math.min(s + 1, 6))
  }
  const back = () => setStep((s) => Math.max(s - 1, 0))

  const create = useCreatePhoneAssignment()

  const submit = async () => {
    create.mutate(buildPhonePayload(draft), {
      onSuccess: async (assignment) => {
        // Upload collected photos to the newly created assignment (contract §4.12 pattern).
        if (photos.length) {
          const front = photos.filter((p) => p.type === 'FRONT').map((p) => p.file)
          const back = photos.filter((p) => p.type === 'BACK').map((p) => p.file)
          try {
            if (front.length) {
              const f = new FormData(); f.append('type', 'FRONT'); front.forEach((x) => f.append('photos', x))
              await api.upload(`/assignments/${assignment.id}/photos`, f)
            }
            if (back.length) {
              const f = new FormData(); f.append('type', 'BACK'); back.forEach((x) => f.append('photos', x))
              await api.upload(`/assignments/${assignment.id}/photos`, f)
            }
          } catch {
            // Photos are supplementary; still navigate so the assignment isn't lost.
          }
        }
        nav(`/assignments/${assignment.id}`, { replace: true })
      },
    })
  }

  return (
    <>
      <Link to="/assets" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Assets</Link>
      <PageHeader title="Assign a phone" subtitle="7-step wizard matching the sofia handover flow" />
      <div className="grid gap-4 sm:grid-cols-0">
        {/* Step indicator */}
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
      </div>

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
            {!rooms.data?.length && departments.data?.some((d) => d.type === 'CALLCENTER') && (
              <p className="text-xs text-amber-700">No rooms loaded — call-center identities need a room to be selected above.</p>
            )}
          </div>
        )}

        {step === 1 && <PhonePicker draft={draft} setDraft={setDraft} errors={errors} />}

        {step === 2 && (
          <div className="space-y-4">
            <Field label="SIM card asset" required error={errors.sim1Number}
              hint="The SIM's number is the single source for both SIM 1 and the main WhatsApp number.">
              <Select
                value={draft.sim1AssetId}
                onChange={(e) => {
                  const id = e.target.value
                  const asset = sims.data?.items.find((s) => s.id === id)
                  const num = simNumber(asset)
                  setDraft({ ...draft, sim1AssetId: id, sim1Number: num, wa1: { ...draft.wa1, phoneNumber: num } })
                }}
              >
                <option value="">— select SIM card asset —</option>
                {sims.data?.items.map((s) => (
                  <option key={s.id} value={s.id}>{s.code} · {s.name} · {simNumber(s) || 'no number'}</option>
                ))}
              </Select>
              {draft.sim1Number && (
                <p className="mt-1 text-xs text-slate-500">SIM 1 / WhatsApp number: <span className="font-mono font-semibold text-slate-800">{draft.sim1Number}</span></p>
              )}
            </Field>
            <WaFields title="Main WhatsApp" wa={draft.wa1} onChange={(wa1) => setDraft({ ...draft, wa1 })} required backupEmailOptions={gmailOptions} />
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
              <input type="checkbox" className="accent-brand-600" checked={draft.includeSim2}
                onChange={(e) => setDraft({ ...draft, includeSim2: e.target.checked })} />
              Add a secondary SIM / WhatsApp account
            </label>
            {draft.includeSim2 && (
              <div className="space-y-4">
                <Field label="SIM card asset (secondary)"
                  hint="The SIM's number is the single source for both SIM 2 and the secondary WhatsApp number.">
                  <Select
                    value={draft.sim2AssetId}
                    onChange={(e) => {
                      const id = e.target.value
                      const asset = sims.data?.items.find((s) => s.id === id)
                      const num = simNumber(asset)
                      setDraft({ ...draft, sim2AssetId: id, sim2Number: num, wa2: { ...draft.wa2, phoneNumber: num } })
                    }}
                  >
                    <option value="">— select SIM card asset —</option>
                    {sims.data?.items.map((s) => (
                      <option key={s.id} value={s.id}>{s.code} · {s.name} · {simNumber(s) || 'no number'}</option>
                    ))}
                  </Select>
                  {draft.sim2Number && (
                    <p className="mt-1 text-xs text-slate-500">SIM 2 / WhatsApp number: <span className="font-mono font-semibold text-slate-800">{draft.sim2Number}</span></p>
                  )}
                </Field>
                <WaFields title="Secondary WhatsApp" wa={draft.wa2} onChange={(wa2) => setDraft({ ...draft, wa2 })} required={false} backupEmailOptions={gmailOptions} />
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <Field label="Bitrix account" error={errors.bitrixAccountId}>
              <Select value={draft.bitrixAccountId} onChange={(e) => setDraft({ ...draft, bitrixAccountId: e.target.value })}>
                <option value="">— none —</option>
                {accounts.data?.items.map((a) => <option key={a.id} value={a.id}>{a.identifier || a.email}</option>)}
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Charger cable" error={errors.chargerCableAssetId}>
                <Select value={draft.chargerCableAssetId} onChange={(e) => setDraft({ ...draft, chargerCableAssetId: e.target.value })}>
                  <option value="">— none —</option>
                  {cables.data?.items.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name} · {a.condition}</option>)}
                </Select>
              </Field>
              <Field label="Charger adapter" error={errors.chargerAdapterAssetId}>
                <Select value={draft.chargerAdapterAssetId} onChange={(e) => setDraft({ ...draft, chargerAdapterAssetId: e.target.value })}>
                  <option value="">— none —</option>
                  {adapters.data?.items.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name} · {a.condition}</option>)}
                </Select>
              </Field>
            </div>
            <Field label="Notes">
              <Input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Optional notes" />
            </Field>
          </div>
        )}

        {step === 5 && <PhotoStep photos={photos} setPhotos={setPhotos} />}

        {step === 6 && (
          <div className="space-y-3">
            <h2 className="text-base font-semibold text-slate-900">Review the handover</h2>
            <ReviewSnapshot
              draft={draft}
              photos={photos}
              names={{
                employee: employees.data?.items.find((e) => e.id === draft.employeeId)?.fullName,
                department: departments.data?.find((d) => d.id === draft.workIdentity.departmentTeamId)?.name,
                room: rooms.data?.find((r) => r.id === draft.workIdentity.roomId)?.code,
                phone: selectedPhone.data?.asset?.name,
                bitrix: accounts.data?.items.find((a) => a.id === draft.bitrixAccountId)?.identifier,
                cable: cables.data?.items.find((a) => a.id === draft.chargerCableAssetId)?.code,
                adapter: adapters.data?.items.find((a) => a.id === draft.chargerAdapterAssetId)?.code,
              }}
            />
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
            {step < 6 ? (
              <Button onClick={next}>Next <ChevronRight className="h-4 w-4" /></Button>
            ) : (
              <Button onClick={submit} loading={create.isPending} disabled={create.isPending}>
                {create.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Assigning…</> : <>Assign phone</>}
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

/* ------------------------------------------------------------------ */
/* Review snapshot (exact "12 GB of 15 GB" style strings)              */
/* ------------------------------------------------------------------ */

export function ReviewSnapshot({ draft, photos, names }: {
  draft: WizardDraft; photos: PhotoPick[]; names?: Record<string, string | undefined>
}) {
  const row = (label: string, value: React.ReactNode) => (
    <div className="grid grid-cols-3 gap-2 py-2 text-sm">
      <dt className="text-slate-500">{label}</dt><dd className="col-span-2 break-words text-slate-900">{value || '—'}</dd>
    </div>
  )
  const w1 = draft.wa1
  const w2 = draft.wa2
  return (
    <dl className="divide-y divide-slate-100">
      {row('Employee', names?.employee ?? draft.employeeId)}
      {row('Work identity', draft.workIdentity.name || '—')}
      {row('Department', names?.department ?? draft.workIdentity.departmentTeamId)}
      {row('Room', names?.room ?? draft.workIdentity.roomId)}
      {row('Phone', names?.phone ? `${names.phone} · ${draft.imei || 'no IMEI'}` : <span className="font-mono">{draft.phoneAssetId}</span>)}
      {row('SIM 1', draft.sim1Number)}
      {row('WhatsApp 1 (main)', `${w1.business ? 'Business' : 'Normal'} · ${w1.phoneNumber || '—'}`)}
      {row('Contact', w1.phoneNumber)}
      {row('Backup email (main)', w1.backupEmail)}
      {row('Last backup (main)', `${w1.backupDate ? fmtDate(w1.backupDate) : '—'} · ${backupSummary(w1.backupUsedGB, w1.backupTotalGB)}`)}
      {row('Chats (main)', `normal ${w1.chatNormalCount || '0'} · archived ${w1.chatArchivedCount || '0'}`)}
      {row('App variant (main)', w1.appVariant && titleCase(w1.appVariant))}
      {draft.includeSim2 && (
        <>
          {row('SIM 2', draft.sim2Number)}
          {row('WhatsApp 2', `${w2.business ? 'Business' : 'Normal'} · ${w2.phoneNumber || ''}`)}
          {row('Backup email (SIM 2)', w2.backupEmail)}
          {row('Last backup (SIM 2)', `${w2.backupDate ? fmtDate(w2.backupDate) : ''} · ${backupSummary(w2.backupUsedGB, w2.backupTotalGB, true)}`)}
          {row('Chats (SIM 2)', `normal ${w2.chatNormalCount || '0'} · archived ${w2.chatArchivedCount || '0'}`)}
          {row('App variant (SIM 2)', w2.appVariant && titleCase(w2.appVariant))}
        </>
      )}
      {row('Bitrix account', names?.bitrix ?? draft.bitrixAccountId)}
      {row('Charger cable', names?.cable ?? draft.chargerCableAssetId)}
      {row('Charger adapter', names?.adapter ?? draft.chargerAdapterAssetId)}
      {row('Notes', draft.notes)}
      {row('Photos', photos.length ? photos.map((p) => p.type).join(', ') : '—')}
    </dl>
  )
}
