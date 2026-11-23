import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Eye, EyeOff, Pencil, Plus, Search, ShieldAlert, Trash2, X } from 'lucide-react'
import { decryptAccount, useAccounts, useDeleteAccount, useSaveAccount } from '@/api/hooks'
import type { Account, AccountSavePayload } from '@/api/types'
import { ApiError } from '@/api/client'
import { useAuthStore } from '@/store/auth'
import { isAdmin } from '@/lib/permissions'
import { useDebounce } from '@/lib/useDebounce'
import { SortTh, sortParams, useSort } from '@/components/SortHeader'
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, Select, Spinner, StatusBadge, TableWrap, Textarea } from '@/components/ui'

const REVEAL_MS = 30_000

/** Kinds a user may create. WHATSAPP accounts are created automatically from the SIM number. */
const ACCOUNT_KINDS = ['GMAIL', 'BITRIX', 'OTHER'] as const
type AccountKind = (typeof ACCOUNT_KINDS)[number] | 'WHATSAPP'

const KIND_LABELS: Record<string, string> = { GMAIL: 'Email / Gmail', BITRIX: 'Bitrix', OTHER: 'Other', WHATSAPP: 'WhatsApp (auto)' }
const kindLabel = (k: string) => KIND_LABELS[k] ?? k
const WA_AUTO_HINT = 'Created automatically from the SIM number — nothing to enter'

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
function AccountFormModal({ account, onClose, onCreated }: { account: Account | null; onClose: () => void; onCreated?: () => void }) {
  const isEdit = !!account
  const save = useSaveAccount(account?.id)
  const [kind, setKind] = useState<AccountKind>((account?.kind as AccountKind) ?? 'GMAIL')
  const [subcategory, setSubcategory] = useState(account?.subcategory ?? '')
  const [identifier, setIdentifier] = useState(account?.identifier ?? '')
  const [email, setEmail] = useState(account?.email ?? '')
  const [password, setPassword] = useState('')
  const [isActive, setIsActive] = useState(account?.isActive ?? true)
  const [notes, setNotes] = useState(account?.notes ?? '')
  const [err, setErr] = useState<string | null>(null)

  const isWhatsApp = kind === 'WHATSAPP' // only reachable when editing an old auto-created account
  const passwordRequired = !isEdit && PASSWORD_REQUIRED_KINDS.has(kind)

  const submit = () => {
    setErr(null)
    const payload: AccountSavePayload = {
      kind, // an existing WHATSAPP account keeps its kind
      subcategory: subcategory.trim() || null,
      identifier: identifier.trim(),
      email: email.trim() || null,
      notes: notes.trim() || null,
      ...(password ? { password } : {}),
      ...(isEdit ? { isActive } : {}),
    }
    save.mutate(payload, {
      onError: (e) => setErr((e as Error).message),
      onSuccess: () => { if (!isEdit) onCreated?.(); onClose() },
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
              <Select value={kind} onChange={(e) => setKind(e.target.value as AccountKind)} aria-label="Kind" disabled={isWhatsApp}>
                {isWhatsApp && <option value="WHATSAPP">{kindLabel('WHATSAPP')}</option>}
                {ACCOUNT_KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
              </Select>
            </Field>
            <Field label="Subcategory">
              <Input value={subcategory} onChange={(e) => setSubcategory(e.target.value)} placeholder="Optional" />
            </Field>
          </div>
          {isWhatsApp && <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">{WA_AUTO_HINT}</p>}
          <Field label="Identifier" required hint={isWhatsApp ? 'The SIM number.' : 'The email or name that identifies this account.'}>
            <Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder={isWhatsApp ? '+90 5xx xxx xx xx' : 'e.g. frontdesk@clinic.com'} autoFocus />
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
  const [active, setActive] = useState('')
  const [sp, setSp] = useSearchParams()
  const page = Math.max(1, Number(sp.get('page')) || 1)
  const setPage = (p: number) => setSp((prev) => { const n = new URLSearchParams(prev); if (p > 1) n.set('page', String(p)); else n.delete('page'); return n }, { replace: true })
  const { sort, order, toggle } = useSort('createdAt', 'desc')
  const dq = useDebounce(q)
  const firstRun = useRef(true)
  useEffect(() => { if (firstRun.current) { firstRun.current = false; return } setPage(1) }, [dq]) // eslint-disable-line react-hooks/exhaustive-deps
  const list = useAccounts({ q: dq || undefined, kind: kind || undefined, isActive: active === '' ? undefined : active === 'yes', ...sortParams(sort, order), page, pageSize: 25 })
  /** After creating, show the new row: newest first, page 1. */
  const showNewest = () => setSp((prev) => { const n = new URLSearchParams(prev); n.delete('sort'); n.delete('order'); n.delete('page'); return n }, { replace: true })
  const admin = isAdmin(user)
  const [form, setForm] = useState<Account | 'new' | null>(null)
  const th = { sort, order, onSort: toggle }

  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle="Email, Bitrix and other accounts (WhatsApp accounts are created automatically from SIM numbers). Credentials are encrypted at rest and masked here."
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
      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative lg:col-span-2">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search identifier or email…" className="pl-9" aria-label="Search accounts" />
        </div>
        <Select value={kind} onChange={(e) => { setKind(e.target.value); setPage(1) }} aria-label="Kind filter">
          <option value="">All kinds</option>
          {(['GMAIL', 'BITRIX', 'OTHER', 'WHATSAPP'] as const).map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
        </Select>
        <Select value={active} onChange={(e) => { setActive(e.target.value); setPage(1) }} aria-label="Active filter">
          <option value="">Active: any</option><option value="yes">Active: yes</option><option value="no">Active: no</option>
        </Select>
      </div>
      <div className="card overflow-hidden">
        {list.isLoading ? <Spinner /> : list.isError ? <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div> : !list.data?.items.length ? <EmptyState title="No accounts found" hint={admin ? 'Admins can create an account with the New account button.' : undefined} /> : (
          <>
            <TableWrap>
              <thead className="bg-slate-50"><tr>
                <SortTh label="Kind" sortKey="kind" {...th} />
                <SortTh label="Identifier" sortKey="identifier" {...th} />
                <SortTh label="Email" sortKey="email" {...th} />
                <th className="th">Password</th>
                <SortTh label="Active" sortKey="isActive" {...th} />
                <SortTh label="Created" sortKey="createdAt" {...th} />
                {admin && <th className="th">Actions</th>}
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.items.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="td">
                      <Badge tone={a.kind === 'WHATSAPP' ? 'green' : 'blue'}>{kindLabel(a.kind)}</Badge>
                      {a.kind === 'WHATSAPP' && <div className="mt-0.5 text-xs text-slate-400">{WA_AUTO_HINT}</div>}
                      {a.subcategory && <div className="mt-0.5 text-xs text-slate-400">{a.subcategory}</div>}
                    </td>
                    <td className="td font-medium">{a.identifier}</td>
                    <td className="td">{a.email ?? '—'}</td>
                    <td className="td"><PasswordCell account={a} canDecrypt={admin} /></td>
                    <td className="td"><StatusBadge value={a.isActive ? 'ACTIVE' : 'LEFT'} /></td>
                    <td className="td whitespace-nowrap text-xs text-slate-600">{a.createdAt ? new Date(a.createdAt).toLocaleString() : '—'}</td>
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
      {form && <AccountFormModal account={form === 'new' ? null : form} onClose={() => setForm(null)} onCreated={showNewest} />}
    </>
  )
}
