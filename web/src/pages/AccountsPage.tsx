import { useEffect, useState } from 'react'
import { Eye, EyeOff, Pencil, Plus, Search, ShieldAlert, Trash2, X } from 'lucide-react'
import { decryptAccount, useAccounts, useDeleteAccount, useSaveAccount } from '@/api/hooks'
import type { Account, AccountSavePayload } from '@/api/types'
import { ApiError } from '@/api/client'
import { useAuthStore } from '@/store/auth'
import { isAdmin } from '@/lib/permissions'
import { useDebounce } from '@/lib/useDebounce'
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, Select, Spinner, StatusBadge, TableWrap, Textarea } from '@/components/ui'

const REVEAL_MS = 30_000

const ACCOUNT_KINDS = ['GMAIL', 'WHATSAPP', 'BITRIX', 'OTHER'] as const
type AccountKind = (typeof ACCOUNT_KINDS)[number]

/** Kinds that require a password on create (server enforces, contract §6.2). */
const PASSWORD_REQUIRED_KINDS: ReadonlySet<string> = new Set(['GMAIL', 'WHATSAPP', 'BITRIX'])

/** Masked by default; Admin can reveal. Plaintext lives only in component state and auto-hides. */
function PasswordCell({ account, canDecrypt }: { account: Account; canDecrypt: boolean }) {
  const [plain, setPlain] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (plain === null) return
    const t = setTimeout(() => setPlain(null), REVEAL_MS)
    return () => clearTimeout(t)
  }, [plain])

  const reveal = async () => {
    if (!window.confirm(`Reveal the password for ${account.identifier}? This action is audited.`)) return
    setBusy(true); setErr(null)
    try { setPlain(await decryptAccount(account.id)) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs">{plain ?? '••••••••••'}</span>
      {canDecrypt && (plain === null
        ? <Button size="sm" variant="ghost" loading={busy} onClick={reveal} aria-label="Reveal password"><Eye className="h-4 w-4" /></Button>
        : <Button size="sm" variant="ghost" onClick={() => setPlain(null)} aria-label="Hide password"><EyeOff className="h-4 w-4" /></Button>)}
      {err && <span className="text-xs text-red-600">{err}</span>}
    </div>
  )
}

/** Create/edit modal (New account / Edit). Writes Admin-only in the caller. */
function AccountFormModal({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const isEdit = !!account
  const save = useSaveAccount(account?.id)
  const [kind, setKind] = useState<AccountKind>((account?.kind as AccountKind) ?? 'GMAIL')
  const [subcategory, setSubcategory] = useState(account?.subcategory ?? '')
  const [identifier, setIdentifier] = useState(account?.identifier ?? '')
  const [email, setEmail] = useState(account?.email ?? '')
  const [password, setPassword] = useState('')
  const [isWhatsAppBackup, setIsWhatsAppBackup] = useState(account?.isWhatsAppBackup ?? false)
  const [isActive, setIsActive] = useState(account?.isActive ?? true)
  const [notes, setNotes] = useState(account?.notes ?? '')
  const [err, setErr] = useState<string | null>(null)

  const passwordRequired = !isEdit && PASSWORD_REQUIRED_KINDS.has(kind)

  const submit = () => {
    setErr(null)
    const payload: AccountSavePayload = {
      kind,
      subcategory: subcategory.trim() || null,
      identifier: identifier.trim(),
      email: email.trim() || null,
      isWhatsAppBackup,
      notes: notes.trim() || null,
      ...(password ? { password } : {}),
      ...(isEdit ? { isActive } : {}),
    }
    save.mutate(payload, {
      onError: (e) => setErr((e as Error).message),
      onSuccess: onClose,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={isEdit ? `Edit account ${account?.identifier}` : 'New account'}>
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">{isEdit ? 'Edit account' : 'New account'}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"><X className="h-5 w-5" /></button>
        </div>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Kind" required>
              <Select value={kind} onChange={(e) => setKind(e.target.value as AccountKind)} aria-label="Kind">
                {ACCOUNT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </Select>
            </Field>
            <Field label="Subcategory">
              <Input value={subcategory} onChange={(e) => setSubcategory(e.target.value)} placeholder="e.g. GMail-for-WhatsApp-Backup" />
            </Field>
          </div>
          <Field label="Identifier" required hint="The number or email that identifies this account.">
            <Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="e.g. +90 5xx xxx xx xx" autoFocus />
          </Field>
          <Field label="Email">
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="account@example.com" />
          </Field>
          <Field
            label="Password"
            required={passwordRequired}
            hint={isEdit ? 'Leave blank to keep the current password.' : undefined}
          >
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isEdit ? 'Leave blank to keep' : '••••••••'} />
          </Field>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
            <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600" checked={isWhatsAppBackup} onChange={(e) => setIsWhatsAppBackup(e.target.checked)} />
            WhatsApp backup account
          </label>
          {isEdit && (
            <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
              <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Active
            </label>
          )}
          <Field label="Notes">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes…" />
          </Field>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={save.isPending} disabled={!identifier.trim() || (passwordRequired && !password)}>
            {isEdit ? 'Save changes' : 'Create account'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Delete with confirmation; surfaces 204 / soft-delete / 409 distinctly. Admin-only caller. */
function DeleteAccountButton({ account }: { account: Account }) {
  const del = useDeleteAccount(account.id)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null)

  const confirm = () => {
    if (!window.confirm(`Delete account "${account.identifier}"?\n\nThis cannot be undone.`)) return
    setMsg(null)
    del.mutate(undefined, {
      onSuccess: (r) => {
        setMsg(r.softDeleted
          ? { tone: 'warn', text: `"${account.identifier}" was deactivated (it has assignment history that must be kept).` }
          : { tone: 'ok', text: `"${account.identifier}" was deleted.` })
      },
      onError: (e) => {
        const status = (e as ApiError).status
        setMsg(status === 409
          ? { tone: 'err', text: `Cannot delete "${account.identifier}" — it is in use by an active assignment.` }
          : { tone: 'err', text: (e as Error).message })
      },
    })
  }

  return (
    <div>
      <Button size="sm" variant="danger" onClick={confirm} loading={del.isPending}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
      {msg && (
        <p className={`mt-1 text-xs ${msg.tone === 'ok' ? 'text-emerald-600' : msg.tone === 'warn' ? 'text-amber-600' : 'text-red-600'}`}>{msg.text}</p>
      )}
    </div>
  )
}

export default function AccountsPage() {
  const user = useAuthStore((s) => s.user)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('')
  const [page, setPage] = useState(1)
  const dq = useDebounce(q)
  useEffect(() => setPage(1), [dq, kind])
  const list = useAccounts({ q: dq || undefined, kind: kind || undefined, page, pageSize: 25 })
  const admin = isAdmin(user)
  const [form, setForm] = useState<Account | 'new' | null>(null)

  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle="Gmail, WhatsApp and Bitrix accounts. Credentials are encrypted at rest and masked here."
        actions={admin && <Button onClick={() => setForm('new')}><Plus className="h-4 w-4" /> New account</Button>}
      />
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>Revealing a password is an audited, Admin-only action. Revealed values auto-hide after {REVEAL_MS / 1000} seconds.</span>
      </div>
      {admin && (
        <p className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
          Creating, editing and deleting accounts are Admin-only actions. Managers can view accounts read-only.
        </p>
      )}
      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-3">
        <div className="relative sm:col-span-2">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search identifier or email…" className="pl-9" aria-label="Search accounts" />
        </div>
        <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          <option value="">All kinds</option>
          <option value="GMAIL">Gmail</option><option value="WHATSAPP">WhatsApp</option><option value="BITRIX">Bitrix</option><option value="OTHER">Other</option>
        </Select>
      </div>
      <div className="card overflow-hidden">
        {list.isLoading ? <Spinner /> : list.isError ? <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div> : !list.data?.items.length ? <EmptyState title="No accounts found" hint={admin ? 'Admins can create an account with the New account button.' : undefined} /> : (
          <>
            <TableWrap>
              <thead className="bg-slate-50"><tr>
                <th className="th">Kind</th><th className="th">Identifier</th><th className="th">Email</th><th className="th">Password</th><th className="th">Backup</th><th className="th">Status</th>{admin && <th className="th">Actions</th>}
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.items.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="td"><Badge tone="blue">{a.kind}</Badge>{a.subcategory && <div className="mt-0.5 text-xs text-slate-400">{a.subcategory}</div>}</td>
                    <td className="td font-medium">{a.identifier}</td>
                    <td className="td">{a.email ?? '—'}</td>
                    <td className="td"><PasswordCell account={a} canDecrypt={admin} /></td>
                    <td className="td">{a.isWhatsAppBackup ? <Badge tone="green">WhatsApp backup</Badge> : '—'}</td>
                    <td className="td"><StatusBadge value={a.isActive ? 'ACTIVE' : 'LEFT'} /></td>
                    {admin && (
                      <td className="td">
                        <div className="flex items-start gap-2">
                          <Button size="sm" variant="secondary" onClick={() => setForm(a)}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
                          <DeleteAccountButton account={a} />
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onChange={setPage} />
          </>
        )}
      </div>
      {form && <AccountFormModal account={form === 'new' ? null : form} onClose={() => setForm(null)} />}
    </>
  )
}
