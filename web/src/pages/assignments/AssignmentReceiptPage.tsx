import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Printer } from 'lucide-react'
import { useAssignmentDetail } from '@/api/hooks'
import { ErrorState, Spinner } from '@/components/ui'
import { fmtDate, titleCase } from '@/lib/utils'
import type { AssignmentDetail, PhoneAssignmentDetail } from '@/api/types'

// Screen-only toolbar; hidden by the print CSS below.
function Toolbar({ assignmentId }: { assignmentId: string }) {
  return (
    <div className="receipt-toolbar mx-auto mb-6 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm print:hidden">
      <Link
        to={`/assignments/${assignmentId}`}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" /> Back to assignment
      </Link>
      <button
        type="button"
        onClick={() => window.print()}
        className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
      >
        <Printer className="h-4 w-4" /> Print / Save as PDF
      </button>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="receipt-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function humanLabel(v?: { id: string; code?: string; name?: string } | null, rawId?: string | null, fallback?: string): string | null {
  if (v) return v.code && v.name ? `${v.code} · ${v.name}` : (v.name || v.code || v.id)
  if (rawId) return fallback ? `${fallback} (${rawId.slice(0, 8)})` : rawId
  return null
}

function backupCondition(pd: PhoneAssignmentDetail, which: 1 | 2): string {
  const used = which === 1 ? pd.wa1BackupUsedGB : pd.wa2BackupUsedGB
  const total = which === 1 ? pd.wa1BackupTotalGB : pd.wa2BackupTotalGB
  if (used === null && total === null) return 'backup not recorded'
  return `${used ?? '—'} GB of ${total ?? '—'} GB`
}

function WhatsAppBlock({ pd, which }: { pd: PhoneAssignmentDetail; which: 1 | 2 }) {
  const appVariant = which === 1 ? pd.wa1AppVariant : pd.wa2AppVariant
  const phone = which === 1 ? pd.wa1PhoneNumber : pd.wa2PhoneNumber
  const backupEmail = which === 1 ? pd.wa1BackupEmail : pd.wa2BackupEmail
  const normal = which === 1 ? pd.wa1ChatNormalCount : pd.wa2ChatNormalCount
  const archived = which === 1 ? pd.wa1ChatArchivedCount : pd.wa2ChatArchivedCount

  return (
    <section className="receipt-section">
      <h2>WhatsApp {which}</h2>
      <dl className="receipt-grid">
        <DetailRow label="App variant" value={appVariant ? titleCase(appVariant) : null} />
        <DetailRow label="Phone number" value={phone ? <span className="font-mono">{phone}</span> : null} />
        <DetailRow label="Backup Gmail" value={backupEmail ? <span className="font-mono">{backupEmail}</span> : null} />
        <DetailRow label="Backup condition" value={backupCondition(pd, which)} />
        <DetailRow
          label="Chats"
          value={`normal ${normal ?? 0} · archived ${archived ?? 0}`}
        />
      </dl>
    </section>
  )
}

function ReceiptBody({ a }: { a: AssignmentDetail }) {
  const pd = a.phoneDetail
  const sim2 = pd?.sim2Number
  const primary = a.items.find((i) => i.role === 'PRIMARY') ?? a.items[0]
  const photos = a.photos.filter((p) => p.type === 'FRONT' || p.type === 'BACK')

  const bitrixLabel = pd
    ? pd.bitrixAccount
      ? (pd.bitrixAccount.email || pd.bitrixAccount.identifier || pd.bitrixAccountId)
      : humanLabel(undefined, pd.bitrixAccountId, 'Bitrix')
    : null
  const cableLabel = pd ? humanLabel(pd.chargerCableAsset, pd.chargerCableAssetId, 'Charger cable') : null
  const adapterLabel = pd ? humanLabel(pd.chargerAdapterAsset, pd.chargerAdapterAssetId, 'Charger adapter') : null

  return (
    <div className="receipt-sheet">
      <header className="receipt-header">
        <div className="receipt-clinic">TESLİM BELGESİ / HANDOVER RECEIPT</div>
        <h1 className="receipt-title">Device Handover</h1>
        <dl className="receipt-meta">
          <div><dt>Belge / Code</dt><dd className="font-mono">{a.assignmentCode}</dd></div>
          <div><dt>Veriliş / Assigned</dt><dd>{fmtDate(a.assignedAt, true)}</dd></div>
          <div><dt>Durum / Status</dt><dd>{titleCase(a.status)}</dd></div>
        </dl>
      </header>

      <section className="receipt-section">
        <h2>Teslim Edilen / Issued To</h2>
        <dl className="receipt-grid">
          <DetailRow label="Personel / Employee" value={a.employee?.fullName} />
          <DetailRow label="Görev / Work identity" value={a.workIdentity?.name} />
        </dl>
      </section>

      <section className="receipt-section">
        <h2>Cihaz / Device</h2>
        <dl className="receipt-grid">
          <DetailRow label="Kod / Code" value={a.asset?.code ? <span className="font-mono">{a.asset.code}</span> : null} />
          <DetailRow label="Ad / Name" value={a.asset?.name} />
          <DetailRow label="Durum / Condition" value={primary?.conditionAtHandover ? titleCase(primary.conditionAtHandover) : null} />
        </dl>
      </section>

      {pd && (
        <>
          <section className="receipt-section">
            <h2>SIM Kartları / SIM Cards</h2>
            <dl className="receipt-grid">
              <DetailRow label="SIM 1" value={pd.sim1Number ? <span className="font-mono">{pd.sim1Number}</span> : null} />
              {sim2 && <DetailRow label="SIM 2" value={<span className="font-mono">{sim2}</span>} />}
            </dl>
          </section>

          <WhatsAppBlock pd={pd} which={1} />
          {sim2 && <WhatsAppBlock pd={pd} which={2} />}

          <section className="receipt-section">
            <h2>Bağlantılar / Accounts & Accessories</h2>
            <dl className="receipt-grid">
              <DetailRow label="Bitrix hesap / Bitrix" value={bitrixLabel} />
              <DetailRow label="Şarj kablosu / Charger cable" value={cableLabel} />
              <DetailRow label="Adaptör / Adapter" value={adapterLabel} />
            </dl>
          </section>
        </>
      )}

      <section className="receipt-section">
        <h2>Fotoğraflar / Photos</h2>
        {photos.length === 0 ? (
          <p className="receipt-empty">Fotoğraf yok / No photos recorded.</p>
        ) : (
          <div className="receipt-photos">
            {photos.map((p) => (
              <div key={p.id} className="receipt-photo">
                <img src={p.url} alt={`${p.type} photo`} />
                <span>{p.type === 'FRONT' ? 'Ön / Front' : 'Arka / Back'}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="receipt-signatures">
        <div>
          <div className="receipt-sign-line" />
          <div className="receipt-sign-label">Teslim Eden / Issued by</div>
          <div className="receipt-sign-note">Ad Soyad / Name · Tarih / Date</div>
        </div>
        <div>
          <div className="receipt-sign-line" />
          <div className="receipt-sign-label">Teslim Alan / Received by</div>
          <div className="receipt-sign-note">Ad Soyad / Name · Tarih / Date</div>
        </div>
      </section>
    </div>
  )
}

export default function AssignmentReceiptPage() {
  const { id } = useParams()
  const { data, isLoading, isError, error, refetch } = useAssignmentDetail(id)

  if (isLoading) return <div className="grid place-items-center pt-24"><Spinner /></div>
  if (isError || !data) return <div className="mx-auto max-w-3xl pt-12"><ErrorState error={error} onRetry={() => refetch()} /></div>

  return (
    <div className="receipt-root min-h-screen bg-slate-100 px-4 py-8 print:m-0 print:bg-white print:p-0">
      <Toolbar assignmentId={data.id} />
      <ReceiptBody a={data} />

      <style>{`
        .receipt-root, .receipt-sheet, .receipt-row dd, .receipt-photo span, .receipt-sign-label, .receipt-sign-note, .receipt-clinic, .receipt-title { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }

        .receipt-sheet {
          margin: 0 auto;
          max-width: 720px;
          background: #fff;
          color: #000;
          padding: 28px 32px;
          border-radius: 8px;
          box-shadow: 0 1px 3px rgb(0 0 0 / 0.12);
        }

        .receipt-header { border-bottom: 3px double #1e293b; padding-bottom: 14px; margin-bottom: 18px; }
        .receipt-clinic { font-size: 13px; letter-spacing: 0.08em; color: #334155; font-weight: 600; text-align: center; }
        .receipt-title { font-size: 22px; margin: 4px 0 12px; text-align: center; letter-spacing: 0.02em; }
        .receipt-meta { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 8px; }
        .receipt-meta > div { display: flex; flex-direction: column; }
        .receipt-meta dt { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; }
        .receipt-meta dd { font-size: 13px; font-weight: 600; color: #0f172a; }

        .receipt-section { break-inside: avoid; margin-bottom: 16px; }
        .receipt-section h2 {
          font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #0f172a;
          border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; margin-bottom: 8px;
        }
        .receipt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; }
        .receipt-row { display: flex; align-items: baseline; gap: 8px; }
        .receipt-row dt { width: 46%; flex: none; font-size: 12px; color: #475569; }
        .receipt-row dd { flex: 1; font-size: 13px; font-weight: 500; color: #0f172a; overflow-wrap: anywhere; }

        .receipt-photos { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .receipt-photo { break-inside: avoid; text-align: center; }
        .receipt-photo img { width: 100%; max-width: 120px; border: 1px solid #cbd5e1; border-radius: 3px; }
        .receipt-photo span { display: block; margin-top: 3px; font-size: 11px; color: #475569; }
        .receipt-empty { font-size: 12px; color: #64748b; }

        .receipt-signatures { break-inside: avoid; display: grid; grid-template-columns: 1fr 1fr; gap: 48px; margin-top: 40px; }
        .receipt-sign-line { border-bottom: 1px solid #0f172a; height: 42px; }
        .receipt-sign-label { font-size: 12px; font-weight: 600; color: #0f172a; margin-top: 6px; }
        .receipt-sign-note { font-size: 10px; color: #64748b; }

        @media print {
          @page { size: A4; margin: 12mm; }
          html, body { background: #fff !important; }
          body * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .receipt-toolbar { display: none !important; }
          .receipt-root { padding: 0 !important; margin: 0 !important; background: #fff !important; }
          .receipt-sheet { box-shadow: none; max-width: none; padding: 0; border-radius: 0; }
          .receipt-photo img { width: 60mm; }
          .receipt-row, .receipt-photo, .receipt-section { break-inside: avoid; }
        }
      `}</style>
    </div>
  )
}