import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Printer } from 'lucide-react'
import { useReturnRecord } from '@/api/hooks'
import { ErrorState, Spinner } from '@/components/ui'
import { fmtDate, titleCase } from '@/lib/utils'
import type { Photo, ReturnRecord } from '@/api/types'
import { conditionChange } from './ReturnRecordPage'

// Screen-only toolbar; hidden by the print CSS below.
function Toolbar({ assignmentId }: { assignmentId: string }) {
  return (
    <div className="receipt-toolbar mx-auto mb-6 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm print:hidden">
      <Link to={`/assignments/${assignmentId}/return-record`} className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" /> Back to return record
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

const photoLabel = (t: string) => (t === 'FRONT' ? 'Ön / Front' : t === 'BACK' ? 'Arka / Back' : t === 'CONDITION' ? 'Durum / Condition' : titleCase(t))
const cond = (c?: string | null) => (c ? titleCase(c) : '—')
const fmtVal = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'Evet / Yes' : 'Hayır / No') : String(v))
const roleLabel = (r: string) => (r === 'PRIMARY' ? 'Ana cihaz / Main device' : r === 'BUNDLED' ? 'Aksesuar / Accessory' : titleCase(r))

function PhotoStrip({ photos, alt }: { photos: Photo[]; alt: string }) {
  return (
    <div className="receipt-photos">
      {photos.map((p) => (
        <div key={p.id} className="receipt-photo">
          <img src={p.url} alt={`${alt} ${p.type} photo`} />
          <span>{photoLabel(p.type)}</span>
        </div>
      ))}
    </div>
  )
}

function ReceiptBody({ r }: { r: ReturnRecord }) {
  // ONLY this return's RETURN photos (the record's `photos.return`), grouped per item. Never handover photos.
  const ret = r.photos.return
  const itemIds = new Set(r.items.map((i) => i.assetId))
  const whole = ret.filter((p) => !p.assetId || !itemIds.has(p.assetId))
  const discrepancies = r.comparison.filter((c) => c.isDiscrepancy)
  const owed = r.unreturned.filter((u) => u.status === 'OPEN')
  const settled = r.unreturned.filter((u) => u.status === 'RESOLVED')

  return (
    <div className="receipt-sheet">
      <header className="receipt-header">
        <div className="receipt-clinic">İADE BELGESİ / RETURN RECEIPT</div>
        <h1 className="receipt-title">Device Return</h1>
        <dl className="receipt-meta">
          <div><dt>Belge / Code</dt><dd className="font-mono">{r.assignmentCode}</dd></div>
          <div><dt>İade tarihi / Returned</dt><dd>{fmtDate(r.returnedAt, true)}</dd></div>
          <div><dt>Teslim alan / Received by</dt><dd>{r.returnedBy?.fullName ?? '—'}</dd></div>
        </dl>
      </header>

      <section className="receipt-section">
        <h2>İade Eden / Returned By</h2>
        <dl className="receipt-grid">
          <DetailRow label="Personel / Employee" value={r.employee?.fullName} />
          <DetailRow label="Departman / Department" value={r.employee?.department?.name} />
          <DetailRow label="Oda / Room" value={r.employee?.room?.code} />
          <DetailRow label="Görev / Work identity" value={r.workIdentity?.name} />
          {r.returnCondition && <DetailRow label="Genel durum / Overall condition" value={cond(r.returnCondition)} />}
        </dl>
      </section>

      <section className="receipt-section">
        <h2>Eşyalar / Items</h2>
        <table className="receipt-table">
          <thead>
            <tr><th>Kod / Code</th><th>Ad / Name</th><th>Teslimde / At handover</th><th>İadede / At return</th></tr>
          </thead>
          <tbody>
            {r.items.map((i) => {
              const ch = conditionChange(i.conditionAtHandover, i.returnCondition)
              return (
                <tr key={i.assetId}>
                  <td className="font-mono">{i.code}</td>
                  <td>{i.name}<div className="receipt-sub">{roleLabel(i.role)}{i.serialNumber ? ` · ${i.serialNumber}` : ''}</div></td>
                  <td>{cond(i.conditionAtHandover)}</td>
                  <td>
                    {i.returned
                      ? <>→ {cond(i.returnCondition)}{ch === 'worse' ? ' (kötü / worse)' : ch === 'better' ? ' (iyi / better)' : ''}</>
                      : <strong>İade edilmedi / Not returned</strong>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      {discrepancies.length > 0 && (
        <section className="receipt-section">
          <h2>Farklılıklar / Discrepancies</h2>
          <table className="receipt-table">
            <thead><tr><th>Alan / Field</th><th>Teslimde / At handover</th><th>İadede / At return</th></tr></thead>
            <tbody>
              {discrepancies.map((c) => (
                <tr key={c.fieldKey}><td>{c.label}</td><td>{fmtVal(c.valueAtHandover)}</td><td>{fmtVal(c.valueAtReturn)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {owed.length > 0 && (
        <section className="receipt-section receipt-owed">
          <h2>İade Edilmeyenler (borç) / Not Returned (owed)</h2>
          <ul>
            {owed.map((u) => (
              <li key={u.assetId ?? u.accountId ?? u.code}><span className="font-mono">{u.code}</span> · {u.name} <span className="receipt-sub">{roleLabel(u.role)}</span></li>
            ))}
          </ul>
        </section>
      )}

      {settled.length > 0 && (
        <section className="receipt-section">
          <h2>Sonradan Çözülenler / Settled Later</h2>
          <ul>
            {settled.map((u) => (
              <li key={u.assetId ?? u.accountId ?? u.code}>
                <span className="font-mono">{u.code}</span> · {u.name} — {u.resolution?.kind === 'LOST' ? 'Kayıp / Lost' : 'Geç iade / Returned late'}
                {u.resolution?.at ? ` (${fmtDate(u.resolution.at)})` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      {r.returnNotes && (
        <section className="receipt-section">
          <h2>İade Notları / Return Notes</h2>
          <p className="receipt-notes">{r.returnNotes}</p>
        </section>
      )}

      {r.items.map((i) => {
        const ph = ret.filter((p) => p.assetId === i.assetId)
        return ph.length === 0 ? null : (
          <section key={i.assetId} className="receipt-section receipt-photos-section">
            <h2>İade fotoğrafları / Return photos · <span className="font-mono">{i.code}</span> · {i.name}</h2>
            <PhotoStrip photos={ph} alt={i.code} />
          </section>
        )
      })}
      {whole.length > 0 && (
        <section className="receipt-section receipt-photos-section">
          <h2>Tüm iade / Whole return</h2>
          <PhotoStrip photos={whole} alt="Whole return" />
        </section>
      )}

      <section className="receipt-signatures">
        <div>
          <div className="receipt-sign-line" />
          <div className="receipt-sign-label">Teslim Alan / Received by IT</div>
          <div className="receipt-sign-note">Ad Soyad / Name · Tarih / Date</div>
        </div>
        <div>
          <div className="receipt-sign-line" />
          <div className="receipt-sign-label">Teslim Eden / Returned by employee</div>
          <div className="receipt-sign-note">Ad Soyad / Name · Tarih / Date</div>
        </div>
      </section>
    </div>
  )
}

export default function ReturnReceiptPage() {
  const { id } = useParams()
  const { data, isLoading, isError, error, refetch } = useReturnRecord(id)

  if (isLoading) return <div className="grid place-items-center pt-24"><Spinner /></div>
  if (isError || !data) return <div className="mx-auto max-w-3xl pt-12"><ErrorState error={error} onRetry={() => refetch()} /></div>

  return (
    <div className="receipt-root min-h-screen bg-slate-100 px-4 py-8 print:m-0 print:bg-white print:p-0">
      <Toolbar assignmentId={data.assignmentId} />
      <ReceiptBody r={data} />

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

        .receipt-table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .receipt-table th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; border-bottom: 1px solid #94a3b8; padding: 4px 6px; }
        .receipt-table td { padding: 5px 6px; border-bottom: 1px solid #e2e8f0; vertical-align: top; overflow-wrap: anywhere; }
        .receipt-table tr { break-inside: avoid; }
        .receipt-sub { font-size: 10px; color: #64748b; }
        .receipt-owed { border: 1.5px solid #0f172a; padding: 8px 10px; }
        .receipt-owed ul, .receipt-section ul { margin: 0; padding-left: 18px; font-size: 13px; }
        .receipt-owed li { font-weight: 600; }

        .receipt-photos { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        .receipt-photo { break-inside: avoid; text-align: center; }
        .receipt-photo img { width: 100%; max-width: 120px; border: 1px solid #cbd5e1; border-radius: 3px; }
        .receipt-photo span { display: block; margin-top: 3px; font-size: 11px; color: #475569; }
        .receipt-notes { font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }

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
          .receipt-photo img { width: 52mm; }
          .receipt-section.receipt-photos-section { break-inside: auto; }
          .receipt-row, .receipt-photo, .receipt-section { break-inside: avoid; }
        }
      `}</style>
    </div>
  )
}
