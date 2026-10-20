# Phase 4 Implementation Plan — Reports Module (who-has-what, condition, backup-staleness, outstanding, room-composition + export)

**Repo:** `/opt/data/handovers-sys` · **Stack:** React+TS+Vite `web/`, Express+Prisma `server/`
**Status of the codebase today (verified):** Phases 0–2 + the follow-up wave (commit `4656b78`) are DONE and pushed. The reports module is the last roadmap item in README §3.6 / §6.8 / §11 Phase 4. `web/src/App.tsx` L46 still routes `/reports` to `<ComingSoon phase="Phase 4">`. RBAC capabilities `reports:read` and `reports:export` **already exist** in `server/src/middleware/rbac.js` (L16–17) — no RBAC change is needed server-side. The frontend `reports` route key already exists in `web/src/lib/permissions.ts` (L16, L38) but is gated to `MGR` (Admin+Manager) only.

**Authoritative contract:** `docs/API_CONTRACT.md` §10 (report endpoints + export) and §11 (role scope). This file wins over any code divergence. The plan names endpoints verbatim from it.

---

## 0. Global decisions & assumptions (read first)

| # | Decision / assumption | Owner | Notes |
|---|------------------------|-------|-------|
| R1 | **Reports are read-only.** No new write endpoints. All five reports + export are GETs. | contract §10 | |
| R2 | **Report rows are returned as a bare `{ "data": [...] }` array** — no `meta` envelope, but the endpoints still accept `page`/`pageSize` (contract §10 preamble). The frontend normaliser must handle a bare array (the existing `normList` already does). | contract §10 | |
| R3 | **Team Leader room scoping crosses reports.** A TEAM_LEADER may view reports but only for their own `roomId` (README §9, contract §11). This is enforced **server-side** on every report endpoint via the existing `roomScope(req.user)` helper. The frontend hides the room/team/category scope pickers for TEAM_LEADER and disables the export button (server also returns `403 FORBIDDEN` on export for TEAM_LEADER). | contract §11 | |
| R4 | **Backup-staleness threshold** = `BACKUP_STALENESS_DAYS` env (default **7**), overridable per-request via `?days=`. "Stale" = `daysSinceBackup > threshold` (strictly greater, per README "warn if > 7 days"). | README §3.6 / A1 | |
| R5 | **Outstanding-assignments threshold** = clinic policy **1 month** (README §3.6, A5). The report lists open assignments past `expectedReturnAt`; `?days=` filters to only those overdue by ≥ N days. | README §3.6 / A5 | |
| R6 | **Staleness field** = `PhoneAssignmentDetail.wa1BackupDate` (the WhatsApp-1 backup date). This is the only structured backup-date field on the phone assignment detail. **Gap:** there is **no** `isWhatsAppBackup` flag on `PhoneAssignmentDetail` — the flag lives on `Account.isWhatsAppBackup` (schema L516). The backup-staleness report therefore keys off **active phone assignments that have a `wa1BackupDate`** (i.e. phones with a recorded WhatsApp-1 backup), not off the Account flag. See §Gaps. | schema | |
| R7 | **Export format** = CSV or XLSX, selected by `Accept` header (`text/csv` or `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`). Default CSV. Implemented with a small dependency-free CSV writer (no new deps) and an optional XLSX writer (recommend `exceljs` or `xlsx` — see BE-4). | contract §10.6 | |
| R8 | **Export reuses the same query filters** as the corresponding report endpoint, so the exported rows match the on-screen table exactly. | contract §10.6 | |
| R9 | **No schema migration required.** All report data lives in existing models (`Asset`, `PhoneDetail`, `Assignment`, `AssignmentItem`, `PhoneAssignmentDetail`, `Employee`, `WorkIdentity`, `Room`, `DepartmentTeam`). | schema | |
| R10 | **Frontend route access:** README §7 lists `/reports` as Manager/Admin, but README §9 + contract §11 say Team Leaders can view reports within their room scope. The existing `permissions.ts` comment (L24–25) already flags this mismatch and chose §7 (MGR). **This plan resolves it in favour of §9/§11** (Team Leader can view, own-room only, no export) — the server already allows it via `reports:read` including TEAM_LEADER. The frontend `reports` route key must be widened to `ALL` and the page must room-scope its pickers. | README §7 vs §9 | |

---

## 1. Kanban summary (dependency DAG)

```
BE-4 reports endpoints + export  ──►  FE-4 reports page + export UI   (needs BE-4 alive)
```

**Parallelism:** BE-4 and FE-4 touch **disjoint files** (explicit in each card). The only coupling is the shared report-row DTO shapes (contract §10.1–10.5) — verify against the contract, not against each other. FE-4 can start as soon as BE-4 is spec'd (the contract is the interface) and can render against mocked row shapes.

**Merge order:** `BE-4` first (it defines the row shapes + export), then `FE-4`. Card SCOPE is document-only and can land any time.

---

# BACKEND

## BE-4 — Reports endpoints + export (backend-developer)

**Goal:** Five read-only report endpoints + a CSV/XLSX export endpoint, all room-scoped for Team Leaders, matching contract §10 shapes exactly.

**Files (all new):**
- `server/src/services/report.service.js` — the five report queries + the shared row-shaping + the export serializer (CSV/XLSX).
- `server/src/routes/reports.routes.js` — the six GET handlers (five reports + export).

**Mount** in `server/src/app.js` (one line): `api.use('/reports', require('./routes/reports.routes'));` — add after the `assignments` mounts (L46–47). This is the only touch to an existing file.

**RBAC:** `read = requireCapability('reports:read')` (ADMIN/MANAGER/TEAM_LEADER) on all five report endpoints; `exportCap = requireCapability('reports:export')` (ADMIN/MANAGER) on the export endpoint. Both capabilities already exist in `rbac.js` — **no RBAC file change needed.**

**Room scoping helper** (shared, in `report.service.js`): reuse `roomScope(req.user)` from `../middleware/rbac`. For a TEAM_LEADER, every query is filtered to `roomId = scope.roomId`. The scoping key differs per report:
- who-has-what / room-composition: filter by the **room** of the employee/work-identity/asset.
- condition: filter by `Asset.roomId` (or the asset's current holder's room).
- backup-staleness / outstanding-assignments: filter by the **assignment's** room (`workIdentity.roomId ?? employee.roomId`).

### Endpoints (contract §10)

**GET `/reports/who-has-what`** — current holder + device for a scope. Query: `scope` (`room`|`team`|`category`), `roomId?`, `departmentTeamId?`, `categoryId?`, `page?`, `pageSize?`.
- **Logic:** query `Assignment` where `status: 'ACTIVE'` (current holdings), include `employee`, `workIdentity`, `asset` (+ `asset.category`). Apply the scope filter:
  - `room` → `workIdentity.roomId = roomId` (or `employee.roomId`).
  - `team` → `employee.departmentTeamId = departmentTeamId`.
  - `category` → `asset.categoryId = categoryId` (or `asset.category.parentId = categoryId` to include subcategories).
  - TEAM_LEADER → force `workIdentity.roomId = scope.roomId` regardless of the requested scope (fail closed).
- **Row (contract §10.1):**
```json
{ "employeeFullName": "Ayşe Yılmaz", "workIdentityName": "sofia", "roomCode": "TR1",
  "assetCode": "PHN-000123", "assetName": "Samsung Galaxy A12", "categoryName": "Phones",
  "assignmentCode": "A-000042", "assignedAt": "...", "expectedReturnAt": "..." }
```

**GET `/reports/condition`** — asset condition distribution per category. Query: `categoryId?`, `status?`, `page?`, `pageSize?`.
- **Logic:** `prisma.asset.groupBy({ by: ['categoryId', 'condition'], _count: { _all: true }, where })`; join category names. Optional `status` filter (default: all non-DISPOSED). TEAM_LEADER → `where.roomId = scope.roomId`.
- **Row (contract §10.2):** `{ "categoryName": "Phones", "condition": "GOOD", "count": 42 }`.

**GET `/reports/backup-staleness`** — phones whose last WhatsApp backup is stale. Query: `days?` (override threshold), `page?`, `pageSize?`.
- **Logic:** `Assignment` where `status: 'ACTIVE'`, `type: 'PHONE'`, `phoneDetail.wa1BackupDate != null`, include `phoneDetail`, `asset`, `employee`, `workIdentity`. Compute `daysSinceBackup = floor((now - wa1BackupDate) / 86400000)`. Keep rows where `daysSinceBackup > threshold` (threshold = `days ?? BACKUP_STALENESS_DAYS ?? 7`). TEAM_LEADER → filter by assignment room.
- **Row (contract §10.3):**
```json
{ "assetCode": "PHN-000123", "assetName": "Samsung Galaxy A12", "wa1PhoneNumber": "905369700889",
  "wa1BackupDate": "2026-05-17", "wa1BackupUsedGB": 12, "daysSinceBackup": 155,
  "employeeFullName": "Ayşe Yılmaz", "workIdentityName": "sofia" }
```

**GET `/reports/outstanding-assignments`** — open assignments past expected return. Query: `days?` (only flag overdue by ≥ N days), `page?`, `pageSize?`.
- **Logic:** `Assignment` where `status: 'ACTIVE'`, `expectedReturnAt != null`, `expectedReturnAt < now`, include `employee`, `asset`. Compute `daysOverdue = floor((now - expectedReturnAt) / 86400000)`. Optional `days` filter → keep only `daysOverdue >= days`. TEAM_LEADER → filter by assignment room.
- **Row (contract §10.4):**
```json
{ "assignmentCode": "A-000042", "type": "PHONE", "status": "ACTIVE",
  "employeeFullName": "Ayşe Yılmaz", "assetCode": "PHN-000123",
  "assignedAt": "...", "expectedReturnAt": "...", "daysOverdue": 12 }
```

**GET `/reports/room-composition`** — employees + work identities per room. Query: `roomId?`, `page?`, `pageSize?`.
- **Logic:** for each room (or the single `roomId`), list its `employees` and `workIdentities`, plus the room's `managerEmployee`. For each work identity, aggregate the asset codes of its **active** assignments (`assignedAssetCodes`). TEAM_LEADER → force `roomId = scope.roomId`.
- **Row (contract §10.5):**
```json
{ "roomCode": "TR1", "managerFullName": "Ayşe Yılmaz", "employeeFullName": "Ayşe Yılmaz",
  "workIdentityName": "sofia", "assignedAssetCodes": ["PHN-000123"] }
```
  (One row per employee and one row per work identity; `assignedAssetCodes` is populated on the work-identity rows.)

**GET `/reports/:id/export`** — CSV/XLSX export of any report. `id` = report slug (`who-has-what` | `condition` | `backup-staleness` | `outstanding-assignments` | `room-composition`). Pass the same query filters as the report. **Response 200:** file download, not JSON.
- **RBAC:** `reports:export` (ADMIN/MANAGER). TEAM_LEADER → `403 FORBIDDEN` (contract §10.6).
- **Format selection:** `Accept: text/csv` → CSV; `Accept: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` → XLSX; default CSV.
- **Implementation:** reuse the same query builder as the report endpoint (factor the row-building into `report.service.js` so export and view share one code path). Serialize:
  - **CSV:** a small dependency-free writer (RFC 4180: quote fields containing `,` `"` `\n`; escape `"` as `""`; CRLF line endings; UTF-8 BOM so Excel opens Turkish characters correctly). Set `Content-Type: text/csv; charset=utf-8` and `Content-Disposition: attachment; filename="<slug>-<date>.csv"`.
  - **XLSX:** recommend `exceljs` (a single new dev dependency) — write one worksheet per report with the same column headers. Set the XLSX content-type + `Content-Disposition`.
- **Column headers** = the row keys, humanised (e.g. `employeeFullName` → `Employee`, `daysSinceBackup` → `Days since backup`). Keep a per-report column map in `report.service.js`.

**Definition of done**
- [ ] All five report endpoints return `{ "data": [...] }` with rows matching contract §10.1–10.5 shapes (field names verbatim).
- [ ] TEAM_LEADER GET on any report is room-scoped (only their `roomId`); a TEAM_LEADER requesting another room's scope returns only their own room's rows (fail closed).
- [ ] `GET /reports/:id/export` returns CSV by default and XLSX when the `Accept` header requests it; TEAM_LEADER gets `403 FORBIDDEN`.
- [ ] `?days=` overrides the backup-staleness and outstanding thresholds; default `BACKUP_STALENESS_DAYS` = 7.
- [ ] `npm run seed` still passes; no schema change; server boots with the new mount.
- [ ] `npm run build` (server) passes.

---

# FRONTEND

## FE-4 — Reports page + export UI (frontend-developer)

**Goal:** Replace the `ComingSoon` at `/reports` with a report picker + per-report table + export button, room-scoped for Team Leaders. *Needs BE-4 alive.*

**Files:**
- `web/src/pages/reports/ReportsPage.tsx` (new) — the report picker + table shell.
- `web/src/pages/reports/reportColumns.ts` (new) — per-report column definitions (key, header, renderer) shared by the table and the export.
- `web/src/api/types.ts` — add `ReportRow`-family types + `ReportSlug` union.
- `web/src/api/normalize.ts` — add `normReportRows` (handles the bare `{data:[...]}` array) + per-report row normalisers.
- `web/src/api/hooks.ts` — add `useReport(slug, filters)` and `useExportReport(slug, filters)` (the latter triggers a browser download).
- `web/src/App.tsx` — point `/reports` to `<ReportsPage />` (was `<ComingSoon phase="Phase 4">`), keep under `RequireRole access="reports"`.
- `web/src/lib/permissions.ts` — widen the `reports` route key from `MGR` to `ALL` (Team Leader can view, own-room only; see R10). **No change to the server RBAC.**

**Page structure:**
1. **Report picker** — a segmented control / select of the five reports: Who-has-what, Condition, Backup staleness, Outstanding assignments, Room composition.
2. **Scope filters** (per report, hidden for TEAM_LEADER):
   - who-has-what: scope (`room`|`team`|`category`) + the matching picker (rooms / departments / categories).
   - condition: category + status.
   - backup-staleness: `days` override (number input, default blank = server default 7).
   - outstanding: `days` override.
   - room-composition: room picker.
   - TEAM_LEADER: render the pickers disabled/absent and rely on the server's room scope (R3).
3. **Table** — reuse the existing table primitives (`TableWrap`, `EmptyState`, `ErrorState`, `Spinner`, `Pagination` from `@/components/ui`). Columns come from `reportColumns.ts`. For room-composition, render `assignedAssetCodes` as a comma-joined list.
4. **Export button** — visible for ADMIN/MANAGER only (hide for TEAM_LEADER; server also 403s). On click, call `useExportReport` with the current filters and the chosen format (CSV default; a small format toggle CSV/XLSX). The hook fetches the file as a blob and triggers a download via a temporary `<a download>`.

**Hooks:**
- `useReport(slug, filters)` → `useQuery` keyed `['report', slug, filters]`, `queryFn` = `normList(await api.get('/reports/'+slug, filters), rowMapper)`. `normList` already tolerates a bare `{data:[...]}` array (normalize.ts L23–34).
- `useExportReport(slug, filters, format)` → a function that `fetch`s `/reports/${slug}/export` with `Accept: text/csv` (or the XLSX type), reads the blob, and downloads it. Use `api.get` won't work for blobs — call `fetch` directly (or add a small `api.download` helper in `client.ts`).

**RBAC wiring:** route stays under `RequireRole access="reports"`. With `reports` widened to `ALL`, TEAM_LEADER reaches the page; the page reads the current user's role from the auth store and (a) hides scope pickers + export for TEAM_LEADER, (b) shows a "Your room only" notice. ADMIN/MANAGER see full pickers + export.

**Definition of done**
- [ ] `/reports` renders a report picker; each of the five reports shows its table with the contract §10 columns populated.
- [ ] Scope filters work for ADMIN/MANAGER; TEAM_LEADER sees only their own room's data (server-enforced) with pickers hidden.
- [ ] Export button (ADMIN/MANAGER) downloads a CSV (and XLSX when selected) whose rows match the on-screen table; TEAM_LEADER has no export button.
- [ ] Empty states, error states, and pagination all work; `npm run build` (web) passes; `tsc` clean.

---

# SCOPE — Notes for work-identity CRUD + sofia reassignment (document-only, no code)

**Goal:** Record the deferred scope so the reports module and future waves are unambiguous. **No code in this card.**

## Work-identity CRUD (POST/PATCH/DELETE `/work-identities`)
- **Status:** still deferred per `docs/FOLLOWUP_PLAN.md` ("Work-identity CRUD (POST/PATCH/DELETE): still deferred; wizard/drawer read-only via lookups") and `docs/IMPLEMENTATION_PLAN.md` Card 4.
- **What the reports module needs:** read access only — `GET /work-identities` already exists via `server/src/routes/lookups.routes.js` L57–69 and is used by the reports' who-has-what / room-composition queries. **No work-identity write endpoint is required for Phase 4.**
- **When it becomes needed:** when seats are created ad-hoc at assignment time (Phase 2.5 gap, `PHASE_2_IMPLEMENTATION_PLAN.md` §3.6) or when the `/work-identities` management page needs create/edit/delete. That card would add `server/src/routes/work-identities.routes.js` (POST/PATCH/DELETE) + capability `people:write` (already exists, Admin-only) + a write UI on `WorkIdentitiesPage`.

## `sofia` multi-assignment reassignment flow (README G4)
- **Status:** a future module, not in this plan. README §8 state machine: `RETURNED` → `REASSIGNED` (new ACTIVE) for the same asset to a new employee/identity.
- **What the release path enables:** the Phase-2/3 return flow (`server/src/services/return.service.js` `applyReturn`) already flips involved assets to `AVAILABLE` and clears `currentHolderEmployeeId`/`roomId` (L266). This is the **prerequisite** for reassignment — a returned asset is immediately assignable again via the existing `POST /assignments/phone` wizard (which re-flips it to `ASSIGNED` and writes a fresh `ASSIGNED` timeline entry).
- **What a future reassignment card would add:** a dedicated "Reassign" action that creates a new ACTIVE assignment for the same asset to a new employee/work identity, writes a `REASSIGNED` timeline entry (the `TimelineEventType.REASSIGNED` enum value already exists, schema L102), and keeps the old record `RETURNED`. No schema change needed.
- **Reports impact:** who-has-what and room-composition already reflect the *current* ACTIVE assignment, so reassignment needs no report change — the reports read live ACTIVE state.

## Gaps / data-model notes surfaced while designing reports
1. **No `isWhatsAppBackup` on `PhoneAssignmentDetail`.** The flag lives on `Account.isWhatsAppBackup` (schema L516). The backup-staleness report keys off **active phone assignments with a non-null `wa1BackupDate`** (R6). If the clinic wants staleness to also cover WhatsApp-2 or to require the Account flag, that is a follow-up decision — the current plan uses `wa1BackupDate` as the single staleness field (matches contract §10.3 which only exposes `wa1BackupDate`).
2. **`wa1BackupDate` is the right staleness field** — it is the only structured backup-date on the phone assignment detail and is what contract §10.3 exposes. `wa2BackupDate` exists but is not in the contract row; leave it out of the MVP report (note for a future "both-WA staleness" enhancement).
3. **Room scoping crosses reports inconsistently by nature.** who-has-what / room-composition scope by the room of the employee/work-identity/asset; condition scopes by `Asset.roomId`; backup-staleness / outstanding scope by the assignment's room (`workIdentity.roomId ?? employee.roomId`). The shared `roomScope` helper must be applied per-report with the correct key (BE-4). A TEAM_LEADER's `User.roomId` is the single source of their scope.
4. **`Asset.roomId` vs assignment room can diverge.** An asset's `roomId` is set at activation from the work identity's room (assignment.service.js L200, L332) and cleared on return (return.service.js L266). For condition-report scoping, prefer `Asset.roomId`; for who-has-what, prefer the assignment's room. Documented so the two reports don't disagree.
5. **Export needs a blob-capable client path.** The existing `api.get` parses JSON; the export endpoint returns a file. FE-4 adds a small `api.download` helper (or direct `fetch`) in `client.ts` — the only client-layer addition.

---

## Suggested merge order
1. **BE-4** (backend) — defines the row shapes + export; everything else depends on it.
2. **FE-4** (frontend) — can start against the contract shapes as soon as BE-4 is spec'd; merge after BE-4 is alive.
3. **SCOPE** — document-only; land any time (record the decisions in the README/plan).

BE-4 and FE-4 touch disjoint files (`server/src/services/report.service.js`, `server/src/routes/reports.routes.js`, `server/src/app.js` vs `web/src/pages/reports/*`, `web/src/api/*`, `web/src/App.tsx`, `web/src/lib/permissions.ts`), so they can be developed in parallel without conflicts. The only shared surface is the contract §10 row shapes — verify against the contract, not against each other.

*End of plan. Cards are implementation-ready; anything named with a contract reference (§) is authoritative from `docs/API_CONTRACT.md`.*
