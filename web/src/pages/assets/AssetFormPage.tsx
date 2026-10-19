import { useEffect, useMemo, useRef } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Controller, useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ArrowLeft } from 'lucide-react'
import { useAsset, useCategories, useCategoryFields, useRooms, useSaveAsset } from '@/api/hooks'
import { CONDITIONS, type CategoryField } from '@/api/types'
import { titleCase } from '@/lib/utils'
import { Button, ErrorState, Field, Input, PageHeader, Select, Spinner, Textarea } from '@/components/ui'
import { baseAssetSchema, buildCustomSchema, customToForm, customToPayload, IMEI_RE, isPhoneCategory } from './assetSchema'

type FormValues = z.infer<typeof baseAssetSchema> & { custom: Record<string, unknown> }

const EMPTY_PHONE = { imei: '', make: '', model: '', color: '', storage: '' }
const EMPTY: FormValues = {
  name: '', categoryId: '', serialNumber: '', qty: '1', condition: 'GOOD', roomId: '', notes: '', phone: EMPTY_PHONE, custom: {},
}

/** One input per category-defined custom column, chosen by field `type`. */
function DynamicField({ f, control, error }: {
  f: CategoryField
  control: ReturnType<typeof useForm<FormValues>>['control']
  error?: string
}) {
  const name = `custom.${f.key}` as const
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => {
        const value = field.value as string | boolean | undefined
        if (f.type === 'boolean') {
          return (
            <label className="flex items-center gap-2 pt-6 text-sm text-slate-700">
              <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600" checked={!!value} onChange={(e) => field.onChange(e.target.checked)} />
              {f.label}
            </label>
          )
        }
        return (
          <Field label={f.label} required={f.required} error={error}>
            {f.type === 'select' ? (
              <Select invalid={!!error} value={String(value ?? '')} onChange={field.onChange} onBlur={field.onBlur}>
                <option value="">Select…</option>
                {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            ) : f.type === 'textarea' ? (
              <Textarea invalid={!!error} value={String(value ?? '')} onChange={field.onChange} onBlur={field.onBlur} />
            ) : (
              <Input
                invalid={!!error}
                type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                step={f.type === 'number' ? 'any' : undefined}
                value={String(value ?? '')}
                onChange={field.onChange}
                onBlur={field.onBlur}
              />
            )}
          </Field>
        )
      }}
    />
  )
}

export default function AssetFormPage() {
  const { id } = useParams()
  const editing = !!id
  const nav = useNavigate()
  const existing = useAsset(id)
  const categories = useCategories()
  const rooms = useRooms()
  const save = useSaveAsset(id)

  // Fields / phone-ness are read through refs so the resolver always validates against the current category.
  const fieldsRef = useRef<CategoryField[]>([])
  const phoneRef = useRef(false)
  const resolver: Resolver<FormValues> = (values, ctx, opts) => {
    let schema = baseAssetSchema.extend({ custom: buildCustomSchema(fieldsRef.current) })
    if (phoneRef.current) {
      schema = schema.extend({
        phone: baseAssetSchema.shape.phone.extend({
          imei: z.string().trim().regex(IMEI_RE, 'IMEI must be 14–17 digits'),
        }),
      })
    } else {
      // Non-phone categories keep a manually required Name; phones auto-derive it from Make+Model.
      schema = schema.extend({
        name: z.string().trim().min(1, 'Name is required').max(200),
      })
    }
    return zodResolver(schema)(values, ctx, opts) as ReturnType<Resolver<FormValues>>
  }

  const form = useForm<FormValues>({ resolver, defaultValues: EMPTY })
  const { register, handleSubmit, watch, control, reset, setValue, formState: { errors, isSubmitting } } = form

  const categoryId = watch('categoryId')
  const fieldsQ = useCategoryFields(categoryId || undefined)
  const fields = useMemo(() => fieldsQ.data ?? [], [fieldsQ.data])
  fieldsRef.current = fields
  const selectedCat = categories.data?.find((c) => c.id === categoryId)
  const isPhone = isPhoneCategory(selectedCat, categories.data?.find((c) => c.id === selectedCat?.parentId))
  phoneRef.current = isPhone

  // Populate when editing (after both asset + its field definitions are known).
  const loadedFor = useRef<string | null>(null)
  useEffect(() => {
    const a = existing.data?.asset
    if (!editing || !a || !fieldsQ.data || fieldsQ.isFetching || a.categoryId !== categoryId) return
    if (loadedFor.current === a.id + a.updatedAt) return
    loadedFor.current = a.id + a.updatedAt
    reset({
      name: a.name, categoryId: a.categoryId, serialNumber: a.serialNumber ?? '',
      phone: {
        imei: a.phone?.imei ?? '', make: a.phone?.make ?? '', model: a.phone?.model ?? '',
        color: a.phone?.color ?? '', storage: a.phone?.storage ?? '',
      },
      qty: String(a.qty), condition: a.condition, roomId: a.roomId ?? '', notes: a.notes ?? '',
      custom: customToForm(fieldsQ.data, a.customFields),
    })
  }, [editing, existing.data, fieldsQ.data, fieldsQ.isFetching, categoryId, reset])

  // When editing, seed the category first so its fields load.
  useEffect(() => {
    const a = existing.data?.asset
    if (editing && a && !categoryId) setValue('categoryId', a.categoryId)
  }, [editing, existing.data, categoryId, setValue])

  // New asset: when the category changes, reset the custom values to blank defaults for its fields.
  useEffect(() => {
    if (editing || !fieldsQ.data) return
    setValue('custom', customToForm(fieldsQ.data), { shouldDirty: false })
  }, [editing, fieldsQ.data, setValue])

  const onSubmit = handleSubmit(async (v) => {
    const blank = (s: string) => s.trim() || null
    const phone = isPhone
      ? {
          imei: v.phone.imei.trim(),
          make: blank(v.phone.make), model: blank(v.phone.model), color: blank(v.phone.color), storage: blank(v.phone.storage),
        }
      : undefined
    // Phones auto-derive their Name from Make + Model (fall back to 'Phone' when both are blank,
    // so the server's min(1) is always satisfied). Non-phones keep the manual required Name.
    const name = isPhone
      ? [v.phone.make?.trim(), v.phone.model?.trim()].filter(Boolean).join(' ') || 'Phone'
      : v.name.trim()
    const a = await save.mutateAsync({
      name,
      // The server allows re-categorising via PATCH, but this UI locks the category once created.
      ...(editing ? {} : { categoryId: v.categoryId }),
      serialNumber: v.serialNumber?.trim() || null,
      qty: Number(v.qty),
      condition: v.condition,
      roomId: v.roomId || null,
      notes: v.notes?.trim() || null,
      customFields: customToPayload(fields, v.custom),
      ...(phone && { phone }),
    })
    nav(`/assets/${a.id || id}`)
  })
  if (editing && existing.isLoading) return <Spinner />
  if (editing && existing.isError) return <ErrorState error={existing.error} onRetry={() => existing.refetch()} />

  const customErrors = (errors.custom ?? {}) as Record<string, { message?: string }>

  return (
    <>
      <Link to={editing ? `/assets/${id}` : '/assets'} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> Back
      </Link>
      <PageHeader title={editing ? 'Edit asset' : 'New asset'} subtitle={editing ? existing.data?.asset.code : 'The form adapts to the selected category’s custom columns'} />

      <form onSubmit={onSubmit} noValidate className="space-y-6">
        {save.isError && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{(save.error as Error).message}</div>}

        <section className="card p-5">
          <h2 className="mb-4 text-sm font-semibold text-slate-900">General</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category" required error={errors.categoryId?.message}>
              <Select invalid={!!errors.categoryId} disabled={editing} {...register('categoryId')}>
                <option value="">Select category…</option>
                {categories.data?.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.parentId ? '— ' : ''}{c.name}</option>)}
              </Select>
            </Field>
            {isPhone ? (
              <p className="text-sm text-slate-500">Name is auto-generated from Make + Model.</p>
            ) : (
              <Field label="Name" required error={errors.name?.message}>
                <Input invalid={!!errors.name} placeholder="e.g. Samsung Galaxy A12" {...register('name')} />
              </Field>
            )}
            <Field label="Serial number" error={errors.serialNumber?.message}>
              <Input {...register('serialNumber')} />
            </Field>
            <Field label="Condition" required error={errors.condition?.message}>
              <Select {...register('condition')}>
                {CONDITIONS.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
              </Select>
            </Field>
            <Field label="Quantity" required hint="Use more than 1 for bulk consumables" error={errors.qty?.message}>
              <Input type="number" min={0} invalid={!!errors.qty} {...register('qty')} />
            </Field>
            <Field label="Location / room">
              <Select {...register('roomId')}>
                <option value="">— None —</option>
                {rooms.data?.map((r) => <option key={r.id} value={r.id}>{r.code}</option>)}
              </Select>
            </Field>
            <Field label="Notes" className="sm:col-span-2" error={errors.notes?.message}>
              <Textarea {...register('notes')} />
            </Field>
          </div>
        </section>

        {isPhone && (
          <section className="card p-5">
            <h2 className="mb-1 text-sm font-semibold text-slate-900">Phone details</h2>
            <p className="mb-4 text-xs text-slate-500">Stored in the structured phone record (searchable by IMEI).</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="IMEI" required hint="14–17 digits" error={errors.phone?.imei?.message}>
                <Input inputMode="numeric" maxLength={17} invalid={!!errors.phone?.imei} {...register('phone.imei')} />
              </Field>
              <Field label="Make"><Input placeholder="Samsung" {...register('phone.make')} /></Field>
              <Field label="Model"><Input placeholder="Galaxy A12" {...register('phone.model')} /></Field>
              <Field label="Color"><Input {...register('phone.color')} /></Field>
              <Field label="Storage"><Input placeholder="64 GB" {...register('phone.storage')} /></Field>
            </div>
          </section>
        )}

        {categoryId && (
          <section className="card p-5">
            <h2 className="mb-1 text-sm font-semibold text-slate-900">Category details</h2>
            <p className="mb-4 text-xs text-slate-500">Custom columns defined for this category.</p>
            {fieldsQ.isLoading ? <Spinner label="Loading fields…" /> : fieldsQ.isError ? <ErrorState error={fieldsQ.error} onRetry={() => fieldsQ.refetch()} /> : fields.length === 0 ? (
              <p className="text-sm text-slate-500">This category has no custom columns.</p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {fields.map((f) => (
                  <div key={f.id} className={f.type === 'textarea' ? 'sm:col-span-2' : undefined}>
                    <DynamicField f={f} control={control} error={customErrors[f.key]?.message} />
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <div className="flex justify-end gap-2">
          <Link to={editing ? `/assets/${id}` : '/assets'}><Button type="button" variant="secondary">Cancel</Button></Link>
          <Button type="submit" loading={isSubmitting || save.isPending}>{editing ? 'Save changes' : 'Create asset'}</Button>
        </div>
      </form>
    </>
  )
}
