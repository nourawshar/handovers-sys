# Phase 2 Implementation Plan — Phone Assignment Wizard + Return/Handback + Assignment/Timeline Backend

**Repo:** `/opt/data/handovers-sys` · **Scope:** Phases 2 & 3 in the README roadmap (`README.md` §3.2, §3.3, §3.4, §6.5–6.8, §8, §9) — **NOT** the Phase 4 reports-work (that is deferred per consensus below).
**Status of the codebase today (verified):**
- Prisma models `Assignment`, `AssignmentItem`, `PhoneAssignmentDetail`, `AssignmentTimelineEntry`, `ReturnRecord`, `ReturnComparisonField`, `Photo(assignmentId)`, `Account` (encrypted credentials) all **already exist** in `server/prisma/schema.prisma` — no schema migration is required for this phase.
- Web has a `useAssignments` hook (`web/src/api/hooks.ts`) already targeting `GET /assignments` (returns 404 today), an `AssignmentDetails`-style types block, an `AssignmentsPage` stub, and `ComingSoon` placeholders at `/phones/assign`, `/assignments/:id/return`.
- **No** server route file exists for assignments, work-identities writing, or returns → these are the backend build.
- RBAC middleware `server/src/middleware/rbac.js` + `server/src/middleware/rbac.js` (capability/`can`) exists with roles ADMIN/MANAGER/TEAM_LEADER and room scoping; `assignments` route access keys already exist on the web side (`web/src/lib/permissions.ts`).

**Authoritative contract:** `docs/API_CONTRACT.md` §7–§9 (this file wins over any code divergence). The plan names endpoints verbatim from it.

---

## 0. Global decisions & assumptions (read first)

| # | Decision / assumption | Owner | Notes |
|---|------------------------|-------|-------|
| A1 | **Phone assignment = a 7-step wizard** collected in one shot and submitted to `POST /assignments/phone`, which server-side creates a `DRAFT` assignment, a `PhoneAssignmentDetail`, all `AssignmentItem`s, a handover snapshot timeline entry, then flips to `ACTIVE` atomically (§7.6 note: this endpoint activates in one call; no client-side multi-ticket workflow). | plan | Wizard steps enumerated in FE-1. |
| A2 | **Expected return = assignedAt + 1 month** by default (assumption A5 in SEED doc), user-overridable in the wizard (`expectedReturnAt`). | plan | |
| A3 | **Return discrepancies do NOT block the return** — flagged with severity, return completes, assets flip to `AVAILABLE` (§8.2 "discrepancies flagged, do not block"). | contract | |
| A4 | **Same SIM can be its own asset** — SIMs are tracked assets; the wizard links `sim1AssetId`/`sim2AssetId` to Asset rows (SEED doc §7.2, A9). The user's "SIM card 1 (main number)" = `sim1Number` string + optional `sim1AssetId`. | plan | |
| A5 | **Charger cable / adapter** = dropdowns over charger-category assets (`chargerCableAssetId`, `chargerAdapterAssetId`), not free text. | user | shared with Bitrix: `bitrixAccountId` from Accounts. |
| A6 | **Photos (front/back)** upload as multipart to the assignment (`POST /assignments/:id/photos`) reusing the existing `persistImages`/`sniffImage` upload service (§4.12 pattern in `lookups.routes.js` comments). **Gap:** model the two phone photos as `Photo` rows with `assignmentId` + `type` (`FRONT`/`BACK`) — the existing `Photo` model supports this. | plan | |
| A7 | **Chat counts** are **manual numeric inputs** (normal + archived) per WhatsApp account — no live WhatsApp API in MVP (README Non-goal NG5). | contract §3.2 | |
| A8 | `war1Backup*` totals are the only structured where user said "12 GB of 15 GB": capture `wa1BackupUsedGB` + `wa1BackupTotalGB` separately in the backup-condition field group. | user | |
| A9 | Work identities are **already seeded & read-through** (GET `/work-identities`), but **no write CRUD exists** — the wizard only needs reads, so work-identity CRUD (`POST/PATCH`) is **deferred** (noted in §9 gap list). | plan | |
| A10 | **Assigned-by** = current user (`createdById`), captured on the timeline snapshot and assignment. | contract §7 | |
| A11 | Item-level condition at handover is captured on each `AssignmentItem.conditionAtHandover` (enum `AssetCondition`). | schema | |

---

## 1. Kanban summary (dependency DAG)

```
BE-1 assignments core      ──►  FE-1 phone assignment wizard     (needs BE-1 alive + A-1 codes)
   │                                 │
BE-2 returns (BE-1 dep)   ──►  FE-3 return comparison page        (needs BE-2 alive)
   │
BE-3 timelines/audit      ──►  FE-2 assignments list + detail     (needs BE-1 + BE-3 alive)
```

**Parallelism:** BE-1, BE-2, BE-3, FE-1, FE-2, FE-3 all touch **disjoint files** (explicit in each card). The only soft coupling is the shared `PhoneAssignmentDetail` DTO shape (verify against the contract, not against each other). Merge order suggestion: `BE-1 → BE-2 → FE-1`, `BE-3 → FE-2`, `FE-3` last (it depends on both BE-2 DTO and FE-1's field normalization).

---

# BACKEND

## BE-1 — Assignment creation + listing + detail (backend-developer)

**Goal:** The phone-assignment wizard's persistence layer and the assignments read surface.

**Files (all new):**
- `server/src/services/assignment.service.js` — code generator, create-and-activate transaction, snapshot builder.
- `server/src/routes/assignments.routes.js` — GET list, GET detail, POST create, POST `/phone` (core wizard), POST `/:id/activate`.

**Prisma usage** (`prisma.assignment`, `prisma.assignmentItem`, `prisma.phoneAssignmentDetail`, `prisma.asset`, `prisma.account`): no migration needed — models exist.

### Endpoints (from contract §7 + §6.5)

**GET `/assignments`** — list/filter (paginated). Query: `type`, `status`, `employeeId`, `workIdentityId`, `roomId`, `q` (assignmentCode / assetCode / IMEI / employee name), `page`, `pageSize`.
Response `data` item (summary — no nested detail):
```json
{ "id":"uuid", "assignmentCode":"A-000042", "type":"PHONE", "status":"ACTIVE",
  "employee":{ "id":"uuid","fullName":"Ayşe Yılmaz" }, "workIdentity":{ "id":"uuid","name":"sofia" },
  "asset":{ "id":"uuid","code":"PHN-000123","name":"Samsung Galaxy A12" },
  "assignedAt":"...", "expectedReturnAt":"...", "returnedAt":null }
```
Meta envelope: paginated per §1.3. Scoping: `read` capability; TEAM_LEADER scope filters to own room via `roomScope`.

**GET `/assignments/:id`** — full detail incl. `phoneDetail` (`PhoneAssignmentDetail` shape), `items` (primary + SIMs + chargers with role + conditionAtHandover), `photos`, `timelineEntries` (latest 20). Errors: `404 NOT_FOUND`.

**POST `/assignments`** (Admin) — create a **DRAFT** generic or pre-scoped assignment. Body: `{ type, employeeId, workIdentityId?, assetId (PRIMARY), expectedReturnAt?, notes? }`. Response 201 `data` with `status:"DRAFT"` and generated `assignmentCode` (`A-000042` style via the per-prefix sequence pattern in `asset.service.js`). Errors: `409 CONFLICT` if the asset already belongs to an ACTIVE assignment (dual-active guard), `400 VALIDATION_ERROR`.

**POST `/assignments/phone`** (Admin) — the **core wizard submit** (contract §7.6). Creates + activates in one atomic transaction. Request body (all fields from §3.2):
```json
{
  "employeeId":"uuid", "workIdentityId":"uuid",
  "phoneAssetId":"uuid",                 // PRIMARY asset; must be category Phones
  "imei":"352957084322001",
  "sim1Number":"905369700889", "sim1AssetId":"uuid",
  "wa1Business": true, "wa1PhoneNumber":"905369700889",
  "wa1BackupEmail":"class3447@gmail.com",
  "wa1BackupDate":"2026-05-17", "wa1BackupUsedGB":12, "wa1BackupTotalGB":15,
  "wa1ChatNormalCount":4500, "wa1ChatArchivedCount":210, "wa1AppVariant":"BUSINESS",
  "sim2Number":null, "sim2AssetId":null,
  "wa2Business": false, "wa2PhoneNumber":null, "wa2BackupEmail":null, "wa2BackupDate":null,
  "wa2BackupUsedGB":null, "wa2BackupTotalGB":null, "wa2ChatNormalCount":null, "wa2ChatArchivedCount":null, "wa2AppVariant":null,
  "bitrixAccountId":"uuid", "chargerCableAssetId":"uuid", "chargerAdapterAssetId":"uuid",
  "expectedReturnAt":"2026-06-10", "notes": null
}
```
Response 201 `data`: full assignment with `status:"ACTIVE"`, `assignedAt`, `expectedReturnAt`. Errors: `400 VALIDATION_ERROR` (missing required §3.2 fields), `409 CONFLICT` (asset / IMEI / SIM asset / account already in an ACTIVE assignment — dual-active guard).

**DB writes** (single `prisma.$transaction`):
1. `assignmentCode` via `nextCode('A', tx)` (reuse `asset.service.js` sequence idiom).
2. `assignment.create` with `status:'ACTIVE'`, `assignedAt: now()`, `expectedReturnAt` (default `assignedAt + 1 month`), `createdById: req.user.id`.
3. `assignmentItem.createMany`: PRIMARY (phoneAsset, role `PRIMARY`, conditionAtHandover), SIM1 (`sim1AssetId`, role `SIM1`), SIM2 (if present), CHARGER_CABLE, CHARGER_ADAPTER (if provided). **Do not insert CHAR items for null assets — conditionally push.**
4. `phoneAssignmentDetail.create` with the full §3.2 field set.
5. Flip asset statuses: phone asset → `ASSIGNED`; SIM/charger assets → `ASSIGNED`; set `asset.currentHolderEmployeeId = employeeId`, `asset.roomId = workIdentity.roomId`.
6. Flip each linked `Account.currentAssignmentId` (Bitrix + any WA backup accounts) → this assignment id.
7. `assignmentTimelineEntry.create` with `eventType:'ASSIGNED'`, `snapshot` = full JSON of the assignment + phoneDetail + items condition (`snapshot` builder in `assignment.service.js`), `createdById: req.user.id`, `assetId: phoneAsset.id`, `employeeId`, `workIdentityId`.
8. Audit log `assignment.create` (reuse `audit` service).

**POST `/assignments/:id/activate`** (Admin) — generic DRAFT→ACTIVE (contract §7.4) for non-phone categories; shared transaction logic factored into `assignment.service.activate(tx, assignmentId)`. Returns 200 `data` with status ACTIVE. This endpoint is the generalized half of the same code path the phone wizard uses — implement it so Phase-3/4 "other types" reuse it.

**Definition of done**
- [ ] `GET /assignments`, `GET /assignments/:id`, `POST /assignments`, `POST /assignments/phone`, `POST /assignments/:id/activate` all respond per contract shapes with correct status codes.
- [ ] Activating an ASSIGNED asset returns `409 CONFLICT`; same for a SIM/account already used in an ACTIVE assignment.
- [ ] Phone submit produces one ACTIVE assignment + one `ASSIGNED` timeline snapshot + flipped asset statuses + `A-0000xx` code.
- [ ] TEAM_LEADER GET `/assignments` is room-scoped; Manager read-only.
- [ ] `npm run seed` still passes; no schema change.

---

## BE-2 — Return / handback comparison (backend-developer)

**Goal:** Two-column (Handover vs Return) comparison with discrepancy severity, closeout, and asset release. *Depends on BE-1 DTO shapes (`PhoneAssignmentDetail`).*

**Files (all new):**
- `server/src/services/return.service.js` — comparison engine (out vs return state), severity classifier.
- `server/src/routes/returns.routes.js` — `GET /assignments/:id/return-form`, `POST /assignments/:id/return`, `GET /assignments/:id/timeline` (owned here since it is assignment-scoped; the asset/employee timeline variants live in BE-3).

### Endpoints (contract §8 + §9.2)

**GET `/assignments/:id/return-form`** — pre-filled **out-state** snapshot for the two-column comparison UI. Response 200 `data`:
```json
{
  "assignmentId":"uuid", "assignmentCode":"A-000042",
  "out":{
    "employeeFullName":"Ayşe Yılmaz", "workIdentityName":"sofia",
    "assetCode":"PHN-000123", "assetName":"Samsung Galaxy A12", "condition":"GOOD",
    "wa1ChatNormalCount":4500, "wa1ChatArchivedCount":210,
    "wa1BackupDate":"2026-05-17", "wa1BackupUsedGB":12.0, "wa1BackupTotalGB":15.0,
    "wa2ChatNormalCount":null, "wa2ChatArchivedCount":null,
    "sim1Number":"905369700889", "sim2Number":null,
    "bitrixAccountId":"uuid", "chargerCableAssetId":"uuid", "chargerAdapterAssetId":"uuid"
  }
}
```
Errors: `404 NOT_FOUND`, `409 CONFLICT` (assignment not ACTIVE).

**POST `/assignments/:id/return`** (Admin) — the return submit (contract §8.2). Request body mirrors `out` with `return*` values + discrepancies:
```json
{
  "returnCondition":"FAIR", "returnNotes":"Charger cable missing",
  "return": {
    "wa1ChatNormalCount":5120, "wa1ChatArchivedCount":240,
    "wa1BackupDate":"2026-10-01", "wa1BackupUsedGB":8.0, "wa1BackupTotalGB":15.0,
    "wa1BackupEmail":"class3447@gmail.com",
    "wa2ChatNormalCount":null, "wa2ChatArchivedCount":null,
    "sim1Number":"905369700889", "sim2Number":null,
    "bitrixAccountId":null, "chargerCableAssetId":null, "chargerAdapterAssetId":"uuid"
  }
}
```
Omitted `return` keys are treated as **unchanged** (copied from out; key-by-key merge server-side). Missing/removed SIM / account / charger → `isDiscrepancy: true`, severity `CRITICAL`.

**Response 200 `data`:**
```json
{
  "assignmentId":"uuid", "assignmentCode":"A-000042", "status":"RETURNED", "returnedAt":"...",
  "hasDiscrepancies": true,
  "comparison": [
    {"fieldKey":"wa1ChatNormalCount","label":"Chat count (normal)","valueAtHandover":4500,"valueAtReturn":5120,
     "isDiscrepancy":false,"severity":"INFO"},
    {"fieldKey":"chargerCableAssetId","label":"Charger cable","valueAtHandover":"uuid-cable","valueAtReturn":null,
     "isDiscrepancy":true,"severity":"CRITICAL"},
    {"fieldKey":"sim2Number","label":"SIM 2 number","valueAtHandover":null,"valueAtReturn":null,
     "isDiscrepancy":false,"severity":"INFO"}
  ]
}
```
**DB writes** (single `$transaction`):
1. `returnRecord.create` with `returnedAt: now()`, `returnedById: req.user.id`, `returnCondition`, `returnNotes`.
2. `returnComparisonField.createMany` — one row per comparable field from the field-key list below, with `valueAtHandover` / `valueAtReturn` JSON, `isDiscrepancy`, and `severity`. **Comparable field-key set (single source, reused by the wizard DTO):** `wa1ChatNormalCount`, `wa1ChatArchivedCount`, `wa1BackupDate`, `wa1BackupUsedGB`, `wa1BackupTotalGB`, `wa1BackupEmail`, `wa2*` equivalents, `sim1Number`, `sim2Number`, `bitrixAccountId`, `chargerCableAssetId`, `chargerAdapterAssetId`, `condition`.
3. `assignmentItem.updateMany` — set `returnCondition` on each item and `isActive:false`; `assignment.update` → `status:'RETURNED'`, `returnedAt`.
4. Release assets: every involved asset → `AVAILABLE`; clear `currentHolderEmployeeId`/`roomId`; `phoneAsset` → `AVAILABLE`. Accounts: release `currentAssignmentId`.
5. Timeline snapshot entry `eventType:'RETURNED'` (+ a `DISCREPANCY` entry when `hasDiscrepancies`), immutably capturing the full return snapshot.
6. Audit `assignment.return`.

**Severity classifier** (in `return.service.js`): value changed but present → `INFO`/`WARNING` (chat/backup deltas); a required item missing at return (SIM present at out but absent, charger cable absent, Bitrix account missing) → `CRITICAL`; no change → `INFO`, `isDiscrepancy:false`.

**Definition of done**
- [ ] Return-form returns the exact out-state snapshot for an ACTIVE assignment (`409` otherwise).
- [ ] Return submit persists ReturnRecord + comparison fields, releases all assets, appends `RETURNED`/`DISCREPANCY` timeline, returns the comparison payload above.
- [ ] Re-returning an already-RETURNED assignment → `409 CONFLICT`.
- [ ] Assets are `AVAILABLE` after return and can be reassigned (`A4` release path).

---

## BE-3 — Timelines per item / employee (backend-developer)

**Goal:** Searchable, paginated, append-only history for assets, employees, and assignments (contract §3.4, §9.1–9.3).

**Files (all new):** `server/src/services/timeline.service.js` (query + snapshot helpers) + the three GET handlers (can live in `server/src/routes/timeline.routes.js`, mounted separately to keep file sets disjoint from BE-1/BE-2).

### Endpoints
- **GET `/assets/:id/timeline`** — paginated, filter `eventType`, `q`. `data` item = `AssignmentTimelineEntry` (id, assignmentId, assetId, employeeId, workIdentityId, eventType, snapshot, createdById, createdAt) ordered `createdAt desc`.
- **GET `/employees/:id/timeline`** — employee device history (all entries where `employeeId = :id`), paginated.
- **GET `/assignments/:id/timeline`** — assignment-scoped history (this also lives on the assignment detail page).

**Writes:** none directly — timeline entries are written by BE-1 (ASSIGNED) and BE-2 (RETURNED/DISCREPANCY). BE-3 only reads; **append-only invariant: no update/delete endpoints.**

**Definition of done**
- [ ] All three endpoints paginate, filter by event type, and return normalized timeline entries from the existing `AssignmentTimelineEntry` model.
- [ ] TEAM_LEADER asset/employee timeline is room-scoped (shared `roomScope`).
- [ ] `snapshot` JSON round-trips through the API shape `timeline.snapshot`.

---

# FRONTEND

## FE-1 — Phone assignment wizard (frontend-developer)

**Goal:** Replace the `ComingSoon` at `/phones/assign` with the 7-step wizard capturing every §3.2 field, ending in one `POST /assignments/phone`.

**Files:**
- `web/src/pages/phones/assign/` (new): `PhoneAssignPage.tsx` (routing shell + step state), `steps/` with one component per step:
  - `Step1Employee.tsx` (employee select → work identity/`sofia` dropdown; reuses `useEmployees`/`useWorkIdentities`).
  - `Step2Phone.tsx` (phone by IMEI/asset code via `useAssets`; shows `PhoneInfo`).
  - `Step3Sim1WhatsApp.tsx` (SIM1 number + asset, WhatsApp business bool, phone number, backup email, **backup condition group** = backup date + `wa1BackupUsedGB`/`wa1BackupTotalGB`, chat normal + archived counts, `wa1AppVariant` select BUSINESS/NORMAL).
  - `Step4Sim2WhatsApp.tsx` (same field set for SIM2, optional).
  - `Step5BitrixChargers.tsx` (Bitrix account dropdown from `useAccounts` kind BITRIX; charger cable dropdown + charger adapter dropdown from charger-assets).
  - `Step6Photos.tsx` (front/back uploads via `FormData` → `POST /assignments/:id/photos`; preview + remove; client-side file-type/limit validation mirroring server `sniffImage`).
  - `Step7Review.tsx` (read-only summary verifying the `sofia` example shape: shows every captured field incl. "12 GB of 15 GB", chat counts, IMEI, SIMs, Bitrix, charger, photos; **Submit** button → POST).
- `web/src/api/types.ts` — extend with `PhoneAssignmentPayload`, `Assignment`, `PhoneAssignmentDetail`, `ReturnComparisonField`.
- `web/src/api/normalize.ts` — `normAssignment`, `normPhoneAssignmentDetail` (match the contract shapes).
- `web/src/api/hooks.ts` — `useCreatePhoneAssignment` (mutation → `POST /assignments/phone`), `useUploadAssignmentPhotos`, and wire `useAssignments` (already exists, add page/pageSize). Sibling `web/src/api/hooks.ts` `useEmployees`/`useWorkIdentities` already exposed.
- `web/src/App.tsx` — point `/phones/assign` to `<PhoneAssignPage />` (was `<ComingSoon phase="Phase 2">`); keep under `RequireRole access="assets.new"`.

**Wizard state:** local `useState` per step + a single draft object passed down; per-step Zod validation before advancing; back/next navigation; dirty-step guard. Chat-count inputs are plain numeric fields (A7).

**RBAC:** page guarded by `assets.new` capability (Admin). Work-identity dropdown is read-only lookup.

**Definition of done**
- [ ] All 7 steps render, validate, and collect their fields; review step shows the exact §3.2 example values (IMEI, "12 GB of 15 GB", chat counts, SIM1/SIM2, Bitrix, charger, photos).
- [ ] Submit issues `POST /assignments/phone` with the full payload and navigates to `/assignments/:id` on 201; server errors (409 dual-active, 400 validation) surface inline.
- [ ] Photo upload hits `POST /assignments/:id/photos` and previews before submit; removes work client-side.
- [ ] `npm run build` (web) passes, `tsc` clean.

---

## FE-2 — Assignments list + detail + timeline (frontend-developer)

**Goal:** The `/assignments` list + `/assignments/:id` detail with items, phone detail, timeline tab. *Needs BE-1 + BE-3 alive.*

**Files:**
- `web/src/pages/assignments/AssignmentsPage.tsx` (replaces the stub in `PeoplePages.tsx`): filters (status, type, q), pagination (reuse `Pagination`), rows → detail links.
- `web/src/pages/assignments/AssignmentDetailPage.tsx`: header with `assignmentCode`, employee + work identity, asset; **phone detail panel** rendering `PhoneAssignmentDetail` (SIM1/SIM2, WA chat counts, backup condition incl. "12GB of 15GB", Bitrix, charger); **photos** grid; **timeline tab** (from `GET /assignments/:id/timeline`) with `eventType` badges and snapshot expand.
- `web/src/App.tsx` — route `/assignments/:id` off `ComingSoon`.
- `web/src/api/hooks.ts` — `useAssignment(id)`, `useAssignmentTimeline(id, page)` (reuse `useAssetTimeline` pattern).

**Definition of done**
- [ ] List paginates/filters and links to detail.
- [ ] Detail shows all phone assignment fields, photos, and a scrollable timeline; empty states handled.
- [ ] Route reuses existing `assets`-style table primitives; `tsc` clean.

---

## FE-3 — Return comparison page (frontend-developer)

**Goal:** `/assignments/:id/return` — two-column **Handover | Return** comparison form that pre-fills the out-state and asks for the return state. *Needs BE-2 alive.*

**Files:**
- `web/src/pages/assignments/ReturnPage.tsx`: on mount `GET /assignments/:id/return-form`; render two-column grid where each comparable field row shows `out` value (read-only, left) and a `return` input (right) so the user compares chat counts, backup date/size, SIMs, charger, Bitrix, photos.
- `web/src/api/hooks.ts` — `useReturnForm(id)`, `useSubmitReturn(id)`.
- Submission → `POST /assignments/:id/return`. On success render the returned `comparison` array: red = `CRITICAL`/`WARNING`, amber = `INFO`, with discrepancy count banner.
- `web/src/App.tsx` — route `/assignments/:id/return` off `ComingSoon` (under `assets.new`).

**Definition of done**
- [ ] Form pre-fills from `out`; each field editable to the return state; photos re-uploaded here (front/back again).
- [ ] Submit posts return payload and displays the comparison table with severity colors.
- [ ] `tsc` clean; empty/`409` (non-ACTIVE) states handled.

---

## 2. Card order & theoretical schedule

| Order | Card | Why |
|-------|------|-----|
| 1 | **BE-1** | Everything depends on the assignment DTO + transaction. |
| 2 | **BE-3** (parallel) | Disjoint files; read-only. |
| 3 | **BE-2** | Needs BE-1 DTO. |
| 4 | **FE-1** | Blocks on BE-1's live endpoints (contract already defines shapes, can start against mocked parses). |
| 5 | **FE-2** | Blocks on BE-1 + BE-3. |
| 6 | **FE-3** | Blocks on BE-2 + FE-1's normalization. |

FE-1 can start as soon as BE-1 is spec'd (the contract is the interface). BE-3 is sprint-parallel to BE-1. Total estimated effort ~2–3 dev-weeks across one backend + one frontend dev.

---

## 3. Gaps & open points to confirm with the product owner

1. **SIM as number vs asset:** the wizard captures `sim1Number` (string) with an optional linked `sim1AssetId`. Confirm whether SIM/assets rows must be **mandatory** at assignment (README A9 says individual tracked SIM assets → suggest requiring the assetId, with the number derivable). Plan assumes optional on first pass.
2. **Chat counts entry** = manual integer inputs (A7). Confirm the "archived chat" second input is just a second integer (it is per §3.2) — no split by folder.
3. **Backup condition** = single group of `date + used/total GB`; confirm there is no need for per-chat-type granularity (README shows one backup per WA account).
4. **Charger components:** one cable + one adapter assumed; confirm whether the clinic also tracks "charger cable with adapter" as a single assignment item (then `chargerCableAssetId` alone suffices). Plan separates them per the schema.
5. **Photo count / required-ness:** front/back required at handover? Plan marks them required in step 6 but allows disabling; confirm.
6. **Work-identity CRUD** (POST/PATCH/DELETE) is **deferred**; the wizard only reads seeded identities. If seats are created ad-hoc at assignment time, this becomes Phase 2.5.
7. **Reports (who-has-what / returns / outstanding)** are **Phase 4** per roadmap — not in this plan. Flag if the clinic wants them earlier.

---

*End of plan. Cards are implementation-ready; anything named with a contract reference (§) is authoritative from `docs/API_CONTRACT.md`.*
