import { forwardRef, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { AlertCircle, ChevronDown, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react'
import { cn, titleCase } from '@/lib/utils'

/* ---------- Button ---------- */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm',
  secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 shadow-sm',
  ghost: 'text-slate-600 hover:bg-slate-100',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
}
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md'
  loading?: boolean
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, className, children, disabled, ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-60',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-4 py-2 text-sm',
        variants[variant], className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  )
})

/* ---------- Form controls ---------- */
export function Field({ label, error, hint, required, children, className }: {
  label: string; error?: string; hint?: string; required?: boolean; children: ReactNode; className?: string
}) {
  return (
    <div className={className}>
      <label className="label">
        {label}{required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...p }, ref) {
    return <input ref={ref} className={cn('input', invalid && 'input-error', className)} {...p} />
  })
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function Select({ className, invalid, children, ...p }, ref) {
    return <select ref={ref} className={cn('input pr-8', invalid && 'input-error', className)} {...p}>{children}</select>
  })

/* ---------- SearchableSelect: single-control combobox ---------- */
export interface SearchableOption {
  value: string
  label: string
}

/** Lower-case in both the Turkish and the default locale so i/İ/ı/I all match each other. */
const TR_PLAIN: Record<string, string> = { ş: 's', ç: 'c', ğ: 'g', ö: 'o', ü: 'u', ı: 'i', â: 'a', î: 'i', û: 'u' }
function foldTr(s: string): string[] {
  // Also strip Turkish diacritics so typing "sahin" finds "Şahin" and "cagri" finds "Çağrı".
  const plain = (x: string) => x.replace(/[şçğöüıâîû]/g, (c) => TR_PLAIN[c]).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return [plain(s.toLocaleLowerCase('tr')), plain(s.toLowerCase())]
}

/**
 * ONE control: a text input that shows the selected label when closed. Focus/click opens a listbox
 * right under it; typing filters (substring, case- and Turkish-insensitive); ArrowUp/Down moves,
 * Enter picks, Escape/Tab/outside-click close. A small (x) clears the value when one is set.
 */
export function SearchableSelect({ options, value, onChange, placeholder = 'Type to filter…', selectPlaceholder = '— select —', notFound = 'No matching options', disabled, className, ariaLabel }: {
  options: SearchableOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  selectPlaceholder?: string
  notFound?: string
  disabled?: boolean
  className?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const uid = useId()
  const listId = `${uid}-list`

  const selected = options.find((o) => o.value === value)
  const needles = useMemo(() => foldTr(query.trim()), [query])
  const filtered = useMemo(() => {
    if (!query.trim()) return options
    return options.filter((o) => {
      const hay = foldTr(o.label)
      return needles.some((n, i) => hay[i].includes(n))
    })
  }, [options, query, needles])

  const close = () => { setOpen(false); setQuery('') }
  const openList = () => {
    if (disabled || open) return
    const idx = filtered.findIndex((o) => o.value === value)
    setActive(idx >= 0 ? idx : 0)
    setOpen(true)
  }
  const pick = (v: string) => { onChange(v); close() }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, open, filtered])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) return openList()
      setActive((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return openList()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      if (open) {
        e.preventDefault()
        if (filtered[active]) pick(filtered[active].value)
      }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); e.stopPropagation(); close() }
    } else if (e.key === 'Tab') {
      if (open) close()
    }
  }

  const showClear = !!value && !disabled
  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-activedescendant={open && filtered[active] ? `${uid}-opt-${active}` : undefined}
        aria-label={ariaLabel ?? placeholder}
        autoComplete="off"
        disabled={disabled}
        className={cn('input', showClear ? 'pr-16' : 'pr-9', !open && !selected && 'text-slate-500')}
        value={open ? query : (selected?.label ?? selectPlaceholder)}
        placeholder={open ? placeholder : undefined}
        onFocus={openList}
        onClick={openList}
        onChange={(e) => { setQuery(e.target.value); setActive(0); if (!open) setOpen(true) }}
        onKeyDown={onKeyDown}
      />
      {showClear && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Clear selection"
          className="absolute right-8 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onChange(''); close() }}
        >
          <X className="h-4 w-4" />
        </button>
      )}
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 z-30 mt-1 max-h-60 overflow-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-slate-500">{notFound}</li>
          ) : filtered.map((o, i) => (
            <li
              key={o.value}
              id={`${uid}-opt-${i}`}
              role="option"
              aria-selected={o.value === value}
              data-active={i === active}
              className={cn(
                'cursor-pointer px-3 py-1.5',
                i === active && 'bg-slate-100',
                o.value === value ? 'font-medium text-brand-700 bg-brand-50' : 'text-slate-800',
                o.value === value && i === active && 'bg-brand-100',
              )}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o.value)}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...p }, ref) {
    return <textarea ref={ref} rows={3} className={cn('input', invalid && 'input-error', className)} {...p} />
  })

/* ---------- Badges ---------- */
const tones: Record<string, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  red: 'bg-red-50 text-red-700 ring-red-600/20',
  slate: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/20',
}
export function Badge({ tone = 'slate', children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', tones[tone])}>{children}</span>
}

const conditionTone: Record<string, string> = { NEW: 'green', GOOD: 'green', FAIR: 'amber', POOR: 'amber', DAMAGED: 'red', DISPOSED: 'slate' }
const statusTone: Record<string, string> = { AVAILABLE: 'green', ASSIGNED: 'blue', RETURNED: 'violet', DISPOSED: 'slate', IN_REPAIR: 'amber', ACTIVE: 'green', LEFT: 'slate', ON_LEAVE: 'amber', DRAFT: 'slate', CLOSED: 'slate' }
export const ConditionBadge = ({ value }: { value?: string }) => value ? <Badge tone={conditionTone[value] ?? 'slate'}>{titleCase(value)}</Badge> : null
export const StatusBadge = ({ value }: { value?: string }) => value ? <Badge tone={statusTone[value] ?? 'slate'}>{titleCase(value)}</Badge> : null

/* ---------- Page chrome ---------- */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong.'
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-10 text-center">
      <AlertCircle className="h-8 w-8 text-red-500" />
      <p className="text-sm text-slate-700">{msg}</p>
      {onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  )
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
      {action}
    </div>
  )
}

export function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
  if (total <= pageSize) return <div className="px-4 py-2 text-xs text-slate-500">{total} result{total === 1 ? '' : 's'}</div>
  return (
    <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2.5">
      <span className="text-xs text-slate-500">{total} results · page {page} of {pages}</span>
      <div className="flex gap-1">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
        <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
      </div>
    </div>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="mb-4 flex gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn('-mb-px border-b-2 px-4 py-2 text-sm font-medium transition',
            value === t.id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800')}
        >{t.label}</button>
      ))}
    </div>
  )
}

/** Responsive table wrapper: horizontal scroll on small screens. */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto"><table className="min-w-full divide-y divide-slate-200">{children}</table></div>
}
