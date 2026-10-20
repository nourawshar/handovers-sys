import { useEffect } from 'react'
import { useAccounts } from '@/api/hooks'
import { useDebounce } from '@/lib/useDebounce'
import { Field, Input } from '@/components/ui'

/**
 * CHANGE 5 — ONE number input that drives BOTH the SIM number and the WhatsApp phone number.
 *
 * When the (debounced) number is ≥ 9 digits it looks up the matching WHATSAPP Account by `identifier`
 * (BE-5 `GET /accounts?kind=WHATSAPP&identifier=…`). On a match it auto-fills the WhatsApp backup email
 * via `onBackupEmail` and marks the source; unknown numbers keep fields editable and show a hint.
 */
export function SimNumberAutoFill({ label, value, onChange, error, required, onBackupEmail, className }: {
  label: string
  value: string
  onChange: (v: string) => void
  /** Called with the matched Account email so the caller can auto-fill the WhatsApp backup email. */
  onBackupEmail: (email: string) => void
  error?: string
  required?: boolean
  className?: string
}) {
  const dq = useDebounce(value, 450)
  const digits = dq.replace(/\D/g, '')
  const lookupEnabled = !!dq && digits.length >= 9
  const lookup = useAccounts(
    { kind: 'WHATSAPP', identifier: dq || undefined, pageSize: 1 },
    lookupEnabled,
  )
  const matched = lookup.data?.items?.[0]

  useEffect(() => {
    // Auto-fill the backup email only when a new Account match resolves for the current number.
    if (matched?.email && value === (dq || value)) onBackupEmail(matched.email)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matched?.id, dq])

  const unknown = lookupEnabled && lookup.isSuccess && !matched && (lookup.isFetching === false)

  return (
    <Field label={label} required={required} error={error}>
      <Input
        inputMode="tel"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))}
        placeholder="905369700889"
        className={className}
        aria-label={label}
        invalid={!!error}
      />
      {matched && (
        <p className="mt-1 text-xs text-emerald-700">
          Auto-filled from Account {matched.identifier}
          {matched.email ? ` (${matched.email})` : ''}
        </p>
      )}
      {unknown && (
        <p className="mt-1 text-xs text-slate-500">
          No WhatsApp Account with this number — enter backup details manually.
        </p>
      )}
    </Field>
  )
}