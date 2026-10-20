# Follow-up Implementation Plan — 3 user-reported fixes

**Repo:** `/opt/data/handovers-sys` · **Stack:** React+TS+Vite `web/`, Express+Prisma `server/`
**Status:** Phase 2 done; this wave fixes 3 verified issues + preserves future-version notes.

## Cards (disjoint files, any merge order; BE-1 → FE-1, FE-2 parallel)
1. **BE-1** (backend-developer): return backend — resolve Bitrix/charger ids → human labels; both-WA chat counts in comparison; return front/back photo context (HANDOVER | RETURN); old-vs-new images in timeline snapshot.
2. **FE-1** (frontend-developer): return form — readable dropdowns for Bitrix/chargers (no raw UUID); editable chat counts for BOTH WhatsApps; photo re-upload at return; result view shows old-vs-new images.
3. **FE-2** (frontend-developer): phone timeline → inline assignment drawer (query-param on /assets/:id/timeline, preserves route + scroll); back returns to same phone timeline.

## Root causes verified in code
- **Return raw-IDs** (`server/src/services/return.service.js`): `loadAssignment` (L128-39) doesn't include Bitrix Account nor charger cable/adapter Assets; `buildOutSnapshot` (L61-76) writes raw UUIDs for kind:'id' fields (COMPARABLE_FIELDS L16-35). Frontend `ReturnPage.tsx` renders `? 'present' : '—'` (L208-10) + pre-fills free-text Input with UUID (L47-51, L266-74).
- **Both-WA chat at return**: COMPARABLE_FIELDS already has wa1+wa2 chat counts; but ReturnPage gates wa2 inputs behind `out.wa2ChatNormalCount !== null` (L240) and has no photo re-upload.
- **Timeline nav** (`web/src/pages/assets/AssetDetailPage.tsx`): TimelineItem links to `/assignments/:id` (L133) full page; back → /assets not the phone timeline.

## Key changes (summary)
- **BE-1**: add `PhotoContext` enum {HANDOVER, RETURN} + column (`prisma migrate dev`); include bitrixAccount + charger relations in loadAssignment; resolve ids → labels in buildOutSnapshot (Bitrix→email/identifier, charger→`code — name`); add `POST /assignments/:id/return/photos` (context RETURN); expose `handoverPhotos`/`returnPhotos` in return-form, result, timeline snapshot; keep wa1+wa2 chat counts compared (both required/editable).
- **FE-1**: replace 3 free-text UUID fields with `<Select>` dropdowns from `out.options`; always render wa2 chat count inputs (remove the gate); add return photo upload section (front/back, preview); result view shows handover vs return images side-by-side.
- **FE-2**: new `AssignmentDrawer.tsx` overlay driven by `?assignment=<id>` query param on the existing timeline route; TimelineItem click sets the param instead of navigating; close/back restores scroll + returns to same phone timeline.

## Definitions of done
- **BE-1**: return-form `out` returns human labels + options + handoverPhotos; comparison includes wa1 + wa2; return photos stored with context RETURN; timeline snapshot carries both image sets; migration applies; seed idempotent; server boots.
- **FE-1**: dropdowns (no raw UUID), both-WA chat editable, photo re-upload w/ preview, result shows old-vs-new images; `npm run build` + `tsc` clean; 409 handled.
- **FE-2**: assignment opens inline over /assets/:id/timeline, back/close returns to same scroll; multiple assignments openable in sequence; Return reachable from drawer; `npm run build` + `tsc` clean.

## Future-version notes (preserve)
- Reports (Phase 4): routes to ComingSoon; contract §10 (who-has-what, condition, backup-staleness, outstanding, room-composition) spec'd, no work this wave.
- Work-identity CRUD (POST/PATCH/DELETE): still deferred; wizard/drawer read-only via lookups.
- `sofia` reassignment flow (README G4): after return assets→AVAILABLE, reassign to new employee/identity with fresh REASSIGNED timeline — future module; this wave's release path is its prerequisite.
- Gaps to confirm with owner: (a) Photo `context` migration acceptable? (b) Bitrix/charger selectable-as-different at return vs only confirm/mark-missing; (c) return photos required vs optional (plan models optional); (d) inline drawer return in-place vs link-out (plan links out).
