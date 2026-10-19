import { z, type ZodTypeAny } from 'zod'
import type { CategoryField } from '@/api/types'
import { CONDITIONS } from '@/api/types'

/** Builds the per-category Zod schema for the custom-column values from the field definitions. */
export function buildCustomSchema(fields: CategoryField[]) {
  const shape: Record<string, ZodTypeAny> = {}
  for (const f of fields) {
    const req = `${f.label} is required`
    switch (f.type) {
      case 'number': {
        const base = z.string().refine((v) => v === '' || !Number.isNaN(Number(v)), `${f.label} must be a number`)
        shape[f.key] = f.required ? base.refine((v) => v !== '', req) : base
        break
      }
      case 'boolean':
        shape[f.key] = z.boolean().optional()
        break
      case 'select': {
        const allowed = f.options.map((o) => o.value)
        const base = z.string().refine((v) => v === '' || allowed.length === 0 || allowed.includes(v), `Invalid ${f.label}`)
        shape[f.key] = f.required ? base.refine((v) => v !== '', req) : base
        break
      }
      default: {
        const base = z.string()
        shape[f.key] = f.required ? base.trim().min(1, req) : base
      }
    }
  }
  return z.object(shape)
}

export const baseAssetSchema = z.object({
  // `name` is required for non-phone categories only (enforced in the asset form's resolver,
  // mirroring how `imei` is conditionally required). Phones auto-derive their name from Make+Model.
  name: z.string().trim().max(200),
  categoryId: z.string().min(1, 'Select a category'),
  serialNumber: z.string().optional(),
  qty: z.string().refine((v) => /^\d+$/.test(v) && Number(v) <= 100000, 'Quantity must be a whole number (0–100000)'),
  condition: z.enum(CONDITIONS),
  roomId: z.string().optional(),
  notes: z.string().optional(),
  phone: z.object({
    imei: z.string(),
    make: z.string(),
    model: z.string(),
    color: z.string(),
    storage: z.string(),
  }),
})
export type BaseAssetValues = z.infer<typeof baseAssetSchema>

/** A category is phone-like when it is (or sits under) a category whose name contains "phone". */
export const isPhoneCategory = (cat?: { name: string } | null, parent?: { name: string } | null) =>
  !!cat && (/phone/i.test(cat.name) || !!(parent && /phone/i.test(parent.name))) && !/charger/i.test(cat.name)

/** Server rule: IMEI = 14–17 digits. Only enforced when the category is phone-like. */
export const IMEI_RE = /^\d{14,17}$/

/** Form (string-based) → API (typed) custom field values. */
export function customToPayload(fields: CategoryField[], values: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const v = values[f.key]
    if (f.type === 'boolean') out[f.key] = !!v
    else if (v === '' || v === undefined || v === null) out[f.key] = null
    else if (f.type === 'number') out[f.key] = Number(v)
    else out[f.key] = v
  }
  return out
}

/** API → form values. */
export function customToForm(fields: CategoryField[], stored: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const v = stored[f.key]
    if (f.type === 'boolean') out[f.key] = v === true || v === 'true'
    else if (f.type === 'date' && typeof v === 'string') out[f.key] = v.slice(0, 10)
    else out[f.key] = v === undefined || v === null ? '' : String(v)
  }
  return out
}
