import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useCategoriesWithFields, useDeleteCategory, useDeleteCategoryField, useSaveCategory, useSaveCategoryField } from '@/api/hooks'
import { ApiError } from '@/api/client'
import type { Category, CategoryField, CategoryFieldSavePayload, CategorySavePayload, FieldType } from '@/api/types'
import { useAuthStore } from '@/store/auth'
import { isAdmin as isAdminUser } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Select, Spinner, TableWrap } from '@/components/ui'

const FIELD_TYPES: FieldType[] = ['string', 'number', 'date', 'boolean', 'select', 'textarea']
const KINDS = ['physical', 'digital', 'account'] as const

const slugify = (s: string) => {
  const k = s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50)
  return /^[a-z]/.test(k) ? k : k ? `f_${k}`.slice(0, 50) : ''
}

/** Human-readable API error; 409 (in use) is spelled out. */
function errText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return `Cannot delete: ${err.message}`
    if (err.status === 403) return 'You do not have permission to do this.'
    return err.message
  }
  return (err as Error)?.message ?? 'Something went wrong.'
}

function Modal({ title, onClose, onSubmit, children, footer, error }: { title: string; onClose: () => void; onSubmit: (e: React.FormEvent) => void; children: React.ReactNode; footer: React.ReactNode; error: string | null }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-8" role="dialog" aria-modal aria-label={title}>
      <form onSubmit={onSubmit} className="card mt-4 w-full max-w-lg gap-4">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close">✕</Button>
        </div>
        <div className="grid gap-4 px-5 py-4">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
          {error && <p className="mr-auto text-xs text-red-600" role="alert">{error}</p>}
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          {footer}
        </div>
      </form>
    </div>
  )
}

function CategoryModal({ category, cats, onClose, onSaved }: { category: Category | null; cats: Category[]; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!category
  const save = useSaveCategory(category?.id)
  const [name, setName] = useState(category?.name ?? '')
  const [parentId, setParentId] = useState(category?.parentId ?? '')
  const [kind, setKind] = useState<string>(category?.kind ?? 'physical')
  const [codePrefix, setCodePrefix] = useState(category?.codePrefix ?? 'AST')
  const [isActive, setIsActive] = useState(category?.isActive ?? true)
  const [error, setError] = useState<string | null>(null)
  const hasChildren = isEdit && cats.some((c) => c.parentId === category.id)
  const parents = cats.filter((c) => !c.parentId && c.id !== category?.id)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!name.trim()) { setError('Name is required.'); return }
    if (!/^[A-Za-z]{2,5}$/.test(codePrefix.trim())) { setError('Code prefix must be 2–5 letters, e.g. PHN.'); return }
    const p: CategorySavePayload = {
      name: name.trim(), kind: kind as CategorySavePayload['kind'], codePrefix: codePrefix.trim().toUpperCase(), isActive,
      parentId: parentId || null,
    }
    try { await save.mutateAsync(p); onSaved(); onClose() } catch (err) { setError(errText(err)) }
  }

  return (
    <Modal title={isEdit ? `Edit ${category.name}` : 'New category'} onClose={onClose} onSubmit={submit} error={error}
      footer={<Button type="submit" variant="primary" loading={save.isPending}>{isEdit ? 'Save changes' : 'Create category'}</Button>}>
      <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Test" /></Field>
      <Field label="Parent category" hint={hasChildren ? 'This category has subcategories, so it cannot become a subcategory.' : 'Only one level of subcategories is supported.'}>
        <Select value={parentId} onChange={(e) => setParentId(e.target.value)} aria-label="Parent category" disabled={hasChildren}>
          <option value="">None (top level)</option>
          {parents.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Kind"><Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</Select></Field>
        <Field label="Code prefix" hint="2–5 letters"><Input value={codePrefix} onChange={(e) => setCodePrefix(e.target.value)} maxLength={5} className="font-mono uppercase" /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
        <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Active (inactive categories are hidden from the asset form)
      </label>
    </Modal>
  )
}

function FieldModal({ categoryId, field, nextOrder, onClose }: { categoryId: string; field: CategoryField | null; nextOrder: number; onClose: () => void }) {
  const isEdit = !!field
  const save = useSaveCategoryField(categoryId, field?.id)
  const [label, setLabel] = useState(field?.label ?? '')
  const [key, setKey] = useState(field?.key ?? '')
  const [keyTouched, setKeyTouched] = useState(isEdit)
  const [type, setType] = useState<FieldType>(field?.type ?? 'string')
  const [required, setRequired] = useState(field?.required ?? false)
  const [isSearchable, setIsSearchable] = useState(field?.isSearchable ?? false)
  const [isIdentifier, setIsIdentifier] = useState(field?.isIdentifier ?? false)
  const [optionsText, setOptionsText] = useState(field?.options.map((o) => o.value).join('\n') ?? '')
  const [sortOrder, setSortOrder] = useState(String(field?.sortOrder ?? nextOrder))
  const [error, setError] = useState<string | null>(null)

  const onLabel = (v: string) => { setLabel(v); if (!keyTouched) setKey(slugify(v)) }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!label.trim()) { setError('Label is required.'); return }
    if (!isEdit && !/^[a-z][a-z0-9_]{0,49}$/.test(key)) { setError('Key: lowercase letters, digits, underscore; must start with a letter.'); return }
    const order = Number(sortOrder)
    if (!Number.isInteger(order) || order < 0 || order > 10000) { setError('Sort order must be a whole number between 0 and 10000.'); return }
    const options = optionsText.split('\n').map((o) => o.trim()).filter(Boolean)
    if (type === 'select' && !options.length) { setError('Add at least one option (one per line) for a select column.'); return }
    const p: CategoryFieldSavePayload = { label: label.trim(), required, isSearchable, isIdentifier, sortOrder: order }
    if (type === 'select') p.options = options
    if (!isEdit) { p.key = key; p.type = type }
    try { await save.mutateAsync(p); onClose() } catch (err) { setError(errText(err)) }
  }

  return (
    <Modal title={isEdit ? `Edit column “${field.label}”` : 'Add custom column'} onClose={onClose} onSubmit={submit} error={error}
      footer={<Button type="submit" variant="primary" loading={save.isPending}>{isEdit ? 'Save changes' : 'Add column'}</Button>}>
      <Field label="Label" required><Input value={label} onChange={(e) => onLabel(e.target.value)} autoFocus placeholder="e.g. Warranty months" /></Field>
      <Field label="Key" required hint={isEdit ? 'The key and type cannot be changed after creation.' : 'Auto-generated from the label; editable. Lowercase letters, digits, underscore.'}>
        <Input value={key} onChange={(e) => { setKey(e.target.value); setKeyTouched(true) }} disabled={isEdit} className="font-mono text-xs" />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as FieldType)} disabled={isEdit} aria-label="Type">
            {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label="Sort order"><Input type="number" min={0} max={10000} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} /></Field>
      </div>
      {type === 'select' && (
        <Field label="Options" required hint="One option per line.">
          <textarea className="input min-h-[96px] w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={optionsText} onChange={(e) => setOptionsText(e.target.value)} aria-label="Options" />
        </Field>
      )}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium text-slate-800">
        {([['Required', required, setRequired], ['Searchable', isSearchable, setIsSearchable], ['Identifier', isIdentifier, setIsIdentifier]] as const).map(([t, v, set]) => (
          <label key={t} className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600" checked={v} onChange={(e) => set(e.target.checked)} />{t}
          </label>
        ))}
      </div>
    </Modal>
  )
}

/** Category + custom-column designer. Admin can create/edit/delete; everyone else gets a read-only view. */
export default function CategoriesSettingsPage() {
  const user = useAuthStore((s) => s.user)
  const admin = isAdminUser(user)
  const cats = useCategoriesWithFields()
  const delCat = useDeleteCategory()
  const delField = useDeleteCategoryField()
  const [sel, setSel] = useState<string>()
  const [catModal, setCatModal] = useState<{ category: Category | null } | null>(null)
  const [fieldModal, setFieldModal] = useState<{ field: CategoryField | null } | null>(null)
  const [notice, setNotice] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null)
  const active = cats.data?.find((c) => c.id === sel) ?? cats.data?.[0]

  const removeCategory = async (c: Category) => {
    setNotice(null)
    if (!window.confirm(`Delete category "${c.name}"? This cannot be undone. Categories that still have assets or subcategories cannot be deleted — deactivate them instead.`)) return
    try { await delCat.mutateAsync(c.id); setSel(undefined); setNotice({ tone: 'ok', text: `Category "${c.name}" deleted.` }) } catch (err) { setNotice({ tone: 'error', text: errText(err) }) }
  }

  const removeField = async (f: CategoryField) => {
    setNotice(null)
    if (!window.confirm(`Delete column "${f.label}"? Values already stored for it on assets will be permanently removed.`)) return
    try { await delField.mutateAsync(f.id); setNotice({ tone: 'ok', text: `Column "${f.label}" deleted.` }) } catch (err) { setNotice({ tone: 'error', text: errText(err) }) }
  }

  return (
    <>
      <PageHeader
        title="Categories"
        subtitle={admin ? 'Manage asset categories and their custom columns' : 'Asset categories and their custom columns (read-only)'}
        actions={admin ? <Button variant="primary" onClick={() => setCatModal({ category: null })}><Plus className="h-4 w-4" />New category</Button> : undefined}
      />
      {notice && <p role="alert" className={cn('mb-4 rounded-lg px-3 py-2 text-sm', notice.tone === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700')}>{notice.text}</p>}
      {cats.isLoading ? <Spinner /> : cats.isError ? <ErrorState error={cats.error} onRetry={() => cats.refetch()} /> : !cats.data?.length ? <div className="card"><EmptyState title="No categories" action={admin ? <Button variant="primary" onClick={() => setCatModal({ category: null })}>New category</Button> : undefined} /></div> : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="card p-2 lg:col-span-1">
            <ul>
              {cats.data.map((c) => (
                <li key={c.id}>
                  <button onClick={() => { setSel(c.id); setNotice(null) }} className={cn('flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm', active?.id === c.id ? 'bg-brand-50 font-medium text-brand-800' : 'text-slate-700 hover:bg-slate-50', c.parentId && 'pl-7')}>
                    {c.name}{!c.isActive && <Badge>Inactive</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="card overflow-hidden lg:col-span-2">
            {active && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">{active.name}</h2>
                  <p className="text-xs text-slate-500">{active.kind} · prefix {active.codePrefix ?? '—'}{active.parentId ? ' · subcategory' : ''}</p>
                </div>
                {admin && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setCatModal({ category: active })}><Pencil className="h-3.5 w-3.5" />Edit</Button>
                    <Button size="sm" variant="secondary" onClick={() => removeCategory(active)} loading={delCat.isPending}><Trash2 className="h-3.5 w-3.5" />Delete</Button>
                    <Button size="sm" variant="primary" onClick={() => setFieldModal({ field: null })}><Plus className="h-3.5 w-3.5" />Add column</Button>
                  </div>
                )}
              </div>
            )}
            {!active?.fields?.length ? <EmptyState title="No custom columns" hint={active ? `“${active.name}” has no custom columns defined.` : undefined} /> : (
              <TableWrap>
                <thead className="bg-slate-50"><tr><th className="th">Order</th><th className="th">Key</th><th className="th">Label</th><th className="th">Type</th><th className="th">Flags</th>{admin && <th className="th" />}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {active.fields.map((f) => (
                    <tr key={f.id}>
                      <td className="td text-xs text-slate-500">{f.sortOrder}</td>
                      <td className="td font-mono text-xs">{f.key}</td>
                      <td className="td">{f.label}</td>
                      <td className="td">{f.type}{f.type === 'select' && f.options.length ? <span className="ml-1 text-xs text-slate-400">({f.options.map((o) => o.label).join(', ')})</span> : null}</td>
                      <td className="td space-x-1">{f.required && <Badge tone="amber">required</Badge>}{f.isSearchable && <Badge tone="blue">searchable</Badge>}{f.isIdentifier && <Badge tone="violet">identifier</Badge>}</td>
                      {admin && (
                        <td className="td whitespace-nowrap text-right">
                          <Button size="sm" variant="ghost" aria-label={`Edit column ${f.label}`} onClick={() => setFieldModal({ field: f })}><Pencil className="h-3.5 w-3.5" /></Button>
                          <Button size="sm" variant="ghost" aria-label={`Delete column ${f.label}`} onClick={() => removeField(f)}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </div>
        </div>
      )}
      {admin && catModal && <CategoryModal category={catModal.category} cats={cats.data ?? []} onClose={() => setCatModal(null)} onSaved={() => setNotice(null)} />}
      {admin && fieldModal && active && (
        <FieldModal key={fieldModal.field?.id ?? 'new'} categoryId={active.id} field={fieldModal.field} nextOrder={(active.fields?.reduce((m, f) => Math.max(m, f.sortOrder), 0) ?? 0) + 10} onClose={() => setFieldModal(null)} />
      )}
    </>
  )
}
