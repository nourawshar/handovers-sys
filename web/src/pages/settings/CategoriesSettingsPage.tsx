import { useState } from 'react'
import { useCategoriesWithFields } from '@/api/hooks'
import { Badge, EmptyState, ErrorState, PageHeader, Spinner, TableWrap } from '@/components/ui'
import { cn } from '@/lib/utils'

/** Read-only category + custom-column viewer. The Admin designer (create/edit/delete) is a follow-up. */
export default function CategoriesSettingsPage() {
  const cats = useCategoriesWithFields()
  const [sel, setSel] = useState<string>()
  const active = cats.data?.find((c) => c.id === sel) ?? cats.data?.[0]

  return (
    <>
      <PageHeader title="Categories" subtitle="Asset categories and their custom columns (read-only view; designer coming next)" />
      {cats.isLoading ? <Spinner /> : cats.isError ? <ErrorState error={cats.error} onRetry={() => cats.refetch()} /> : !cats.data?.length ? <div className="card"><EmptyState title="No categories" /></div> : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="card p-2 lg:col-span-1">
            <ul>
              {cats.data.map((c) => (
                <li key={c.id}>
                  <button onClick={() => setSel(c.id)} className={cn('flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm', active?.id === c.id ? 'bg-brand-50 font-medium text-brand-800' : 'text-slate-700 hover:bg-slate-50', c.parentId && 'pl-7')}>
                    {c.name}{!c.isActive && <Badge>Inactive</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="card overflow-hidden lg:col-span-2">
            {!active?.fields?.length ? <EmptyState title="No custom columns" hint={active ? `“${active.name}” has no custom columns defined.` : undefined} /> : (
              <TableWrap>
                <thead className="bg-slate-50"><tr><th className="th">Key</th><th className="th">Label</th><th className="th">Type</th><th className="th">Flags</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {active.fields.map((f) => (
                    <tr key={f.id}>
                      <td className="td font-mono text-xs">{f.key}</td>
                      <td className="td">{f.label}</td>
                      <td className="td">{f.type}{f.type === 'select' && f.options.length ? <span className="ml-1 text-xs text-slate-400">({f.options.map((o) => o.label).join(', ')})</span> : null}</td>
                      <td className="td space-x-1">{f.required && <Badge tone="amber">required</Badge>}{f.isSearchable && <Badge tone="blue">searchable</Badge>}{f.isIdentifier && <Badge tone="violet">identifier</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </div>
        </div>
      )}
    </>
  )
}
