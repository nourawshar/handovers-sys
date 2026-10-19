import { useEffect, useState } from 'react'
import { Eye, EyeOff, Search, ShieldAlert } from 'lucide-react'
import { decryptAccount, useAccounts } from '@/api/hooks'
import type { Account } from '@/api/types'
import { useAuthStore } from '@/store/auth'
import { isAdmin } from '@/lib/permissions'
import { useDebounce } from '@/lib/useDebounce'
import { Badge, Button, EmptyState, ErrorState, Input, PageHeader, Pagination, Select, Spinner, StatusBadge, TableWrap } from '@/components/ui'

const REVEAL_MS = 30_000

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

export default function AccountsPage() {
  const user = useAuthStore((s) => s.user)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('')
  const [page, setPage] = useState(1)
  const dq = useDebounce(q)
  useEffect(() => setPage(1), [dq, kind])
  const list = useAccounts({ q: dq || undefined, kind: kind || undefined, page, pageSize: 25 })
  const admin = isAdmin(user)

  return (
    <>
      <PageHeader title="Accounts" subtitle="Gmail, WhatsApp and Bitrix accounts. Credentials are encrypted at rest and masked here." />
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>Revealing a password is an audited, Admin-only action. Revealed values auto-hide after {REVEAL_MS / 1000} seconds.</span>
      </div>
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
        {list.isLoading ? <Spinner /> : list.isError ? <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div> : !list.data?.items.length ? <EmptyState title="No accounts found" /> : (
          <>
            <TableWrap>
              <thead className="bg-slate-50"><tr>
                <th className="th">Kind</th><th className="th">Identifier</th><th className="th">Email</th><th className="th">Password</th><th className="th">Backup</th><th className="th">Status</th>
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
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onChange={setPage} />
          </>
        )}
      </div>
    </>
  )
}
