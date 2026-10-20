# Printable Handover Receipt (Teslim Belgesi) — Implementation Plan

**Repo:** `/opt/data/handovers-sys` · **Stack:** React+TS+Vite `web/`, Express+Prisma `server/`

## Design decision
Client-side printable HTML receipt page at `/assignments/:id/receipt`, mounted OUTSIDE AppLayout (no nav/sidebar in DOM), using `window.print()` + `@media print` A4 CSS. Native "Save as PDF" covers the download — zero new dependencies, no backend endpoint needed (GET /assignments/:id already returns everything).

## Cards
- **BE-16** (backend, optional but recommended): extend `detailInclude` in assignments.routes.js (L48-56) to hydrate `bitrixAccount`/`chargerCableAsset`/`chargerAdapterAsset` relations (mirror return.service.js L178-184) so the receipt prints human labels, not raw UUIDs. Additive, no schema change.
- **FE-15** (frontend): new AssignmentReceiptPage.tsx (A4 layout: header, employee name+work identity, asset code/name/IMEI/storage/condition, SIMs, both WhatsApps with backup Gmail + backup condition "12 GB of 15 GB" + chat counts, Bitrix, chargers, front/back photos, signature lines) + Print receipt button on AssignmentDetailPage header + route outside AppLayout + @media print CSS (@page A4, hide toolbar, color-adjust exact, break-inside avoid, photos 60mm). Extend PhoneAssignmentDetail type + normalize.

## Merge order
BE-16 → FE-15. FE-15 works against existing detail endpoint; BE-16 only upgrades labels.

## Future notes
- Server-side PDF (pdfkit/puppeteer) not needed for MVP — browser Save-as-PDF covers it. Revisit if server-generated/emailed/bulk PDF needed.
- Return receipt variant from GET /assignments/:id/return-form — natural follow-up.
- Bilingual labels (Turkish-primary: Teslim Belgesi, Teslim eden/alan).
- Photo print weight: cap to front/back, max mm width.
- Printing is read-only; no timeline entry. Optional "receipt printed" audit NOTE — future card.
