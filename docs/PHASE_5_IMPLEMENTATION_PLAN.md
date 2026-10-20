I have read all authoritative docs and inspected the live code (schema, assignment service/routes, lookups routes, phone wizard, App.tsx, hooks/types/normalize, permissions, RBAC, app.js mounting, users CRUD pattern, accounts route). Here is the implementation-ready plan.

---

# Phase 5 Implementation Plan — Generic assignment + full People CRUD + work-identity & SIM/WhatsApp rework

**Repo:** `/opt/data/handovers-sys` · **Backend:** Express+Prisma `server/` · **Frontend:** React+TS+Vite `web/`.
Contract source of truth: `docs/API_CONTRACT.md` (assumes it gets re-versioned to track the new endpoints below).

## Cards & recommended split

To keep backend and frontend merges independent, split the umbrella cards by file:

- **BE-5** — Backend: work-identity upsert + generic assignment + account-by-number lookup *(assignments.routes.js, assignment.service.js, accounts.routes.js, app.js)*
- **BE-6** — Backend: Employees full CRUD *(new employees.routes.js, lookups.routes.js, app.js)*
- **BE-7** — Backend: Rooms full CRUD *(new rooms.routes.js, lookups.routes.js, app.js)*
- **FE-5** — Frontend: generic assignment wizard + manual work-identity input + SIM/WhatsApp single-number auto-fetch *(PhoneAssignPage.tsx, new GenericAssignPage.tsx, App.tsx, hooks/types/normalize)*
- **FE-6** — Frontend: Employees CRUD UI *(EmployeesPage.tsx rewrite, hooks/types)*
- **FE-7** — Frontend: Rooms CRUD UI *(RoomsPage.tsx rewrite, hooks/types)*

**Merge order (parallel where noted):** BE-5, BE-6, BE-7 can be implemented in any order & merged independently (distinct files; BE-6 and BE-7 also touch lookups.routes.js/app.js — do those two in one commit to avoid overlapping the shared edits). FE-7/FE-6 depend on BE-6/BE-7; FE-5 depends on BE-5. All three FE cards are independent files once the contract is fixed, so they can be developed in parallel against the agreed shapes below.

---

# BE-5 — Generic assignment + work-identity upsert + account-by-number lookup

**Goal.** (CHANGE 1) Let any asset type (LAPTOP/PRINTER/SIM/GENERAL) be assigned in a one-call flow; (CHANGE 4) create/upsert the WorkIdentity on-the-fly from a manual name + department + optional room instead of picking from a fixed list; (CHANGE 5) look up a WhatsApp Account by phone number.

## Files to touch (all backend)
- `server/src/services/assignment.service.js` — add `resolveWorkIdentity`; wire into `createPhoneAssignment`; add `createGenericAssignment`.
- `server/src/routes/assignments.routes.js` — extend `phoneBody`; add `POST /assignments/generic`.
- `server/src/routes/accounts.routes.js` — add `identifier` exact-match to `GET /accounts` query.
- `server/src/app.js` — no change for BE-5 (no new mount).

## 1. Work-identity upsert (`resolveWorkIdentity`)
Add a service method (used inside the assignment transaction) that returns `{ id }`:

```js
async function resolveWorkIdentity({ name, departmentTeamId, roomId }, tx = prisma) {
  const n = String(name ?? '').trim();
  if (!n) throw badRequest('workIdentity.name is required');
  if (roomId) {
    // Call-center identity: unique index @unique([name, roomId]) matches exactly.
    return tx.workIdentity.upsert({
      where: { name_roomId: { name: n, roomId } },
      update: { departmentTeamId: departmentTeamId ?? null, isActive: true },
      create: { name: n, departmentTeamId: departmentTeamId ?? null, roomId, isActive: true },
    });
  }
  // Non-call-center: roomId is null. Postgres treats NULL as distinct in the unique index,
  // so query by name + departmentTeamId explicitly (never `upsert` on a null compound key).
  const existing = await tx.workIdentity.findFirst({ where: { name: n, departmentTeamId: departmentTeamId ?? null } });
  if (existing) return tx.workIdentity.update({ where: { id: existing.id }, data: { isActive: true, roomId: null } });
  return tx.workIdentity.create({ data: { name: n, departmentTeamId: departmentTeamId ?? null, roomId: null, isActive: true } });
}
```

**Callers:** in `createPhoneAssignment` and the new `createGenericAssignment` replace `workIdentityId: workIdentityId ?? null` with:
`const wid = opts.workIdentityId ?? (opts.workIdentity && (await resolveWorkIdentity(opts.workIdentity, tx)).id);` — `workIdentityId` takes precedence when both are sent (keeps existing drawer/draft callers working). Assign `wid` on the Assignment row and use it for the asset `roomId` flip and the timeline `workIdentityId`.

## 2. `POST /assignments/generic` (create + activate atomically)
Place the route immediately after the existing `POST /phone` block (assignments.routes.js L189–204) and **before** `POST /:id/activate`, mirroring `/phone`. Zod body (mirror `createBody`/`phoneBody` style):

```jsonc
{
  "type": "LAPTOP" | "PRINTER" | "SIM" | "GENERAL",   // required; reject PHONE here (400)
  "employeeId": "uuid",
  "workIdentityId": "uuid | null",                    // optional, legacy
  "workIdentity": { "name": "string", "departmentTeamId": "uuid|null", "roomId": "uuid|null" }, // optional
  "assetId": "uuid",                                  // PRIMARY item
  "conditionAtHandover": "NEW|GOOD|FAIR|POOR|DAMAGED|DISPOSED",  // required (was hardcoded 'GOOD')
  "expectedReturnAt": "YYYY-MM-DD | null",
  "notes": "string | null"
}
```
- `.strict()`; validate `type !== 'PHONE'` (else 400). Reuse `assignmentType` minus PHONE or a separate enum.
- **Service `createGenericAssignment(body, userId, tx)`:**
  - Resolve work identity (see §1).
  - `assertAssetsFree([assetId], tx)` (dual-active guard, assignment.service.js L35) + check the asset is not the Phones category (400 if it is — phones must go through `/phone`).
  - `nextAssignmentCode`, create Assignment `{type, employeeId, workIdentityId: wid, assetId, status:'ACTIVE', assignedAt: now, expectedReturnAt, notes, createdById}`.
  - Create ONE `AssignmentItem` `{role:'PRIMARY', conditionAtHandover: body.conditionAtHandover, isActive:true}`.
  - Flip asset to `ASSIGNED`, set `currentHolderEmployeeId`, set `roomId` from wid (pattern in L326–334).
  - Write `ASSIGNED` timeline snapshot (reuse `buildSnapshot`, WIP `phoneDetail:null`).
- **Response 201** `data`: full assignment via the existing `detailInclude` (assignments.routes.js L41) → `normAssignmentDetail` renders it unchanged.
- **Route handler** mirrors `/phone` (L189–204): `write` guard, `validate`, existence checks on employee/workIdentity/asset, `audit('assignment.create', ...)`.

## 3. `POST /assignments/phone` — accept work-identity-on-the-fly
Extend `phoneBody` (L153–187) with `workIdentity: z.object({ name: z.string().trim().min(1).max(100), departmentTeamId: z.uuid().nullish(), roomId: z.uuid().nullish() }).nullish()`. Keep `workIdentityId` for back-compat. In `createPhoneAssignment` replace the direct `workIdentityId` usage with the resolver from §1. **No other phone-body change.** CHANGES 4's phone-step is mostly a FE change; backend just needs the upsert path.

## 4. `GET /accounts?identifier=…` — lookup WhatsApp account by number (CHANGE 5 backend)
In `accounts.routes.js` extend the list query (L61) with `identifier: z.string().trim().min(1).max(200).optional()` and the `where` builder (L64–70) with `...(f.identifier && { identifier: f.identifier })`. Exact match on `identifier` (covers `@@unique([kind, identifier])`). The FE will call `GET /accounts?kind=WHATSAPP&identifier=<number>`. Existing `publicSelect.shape` (L24–30) already returns `email`, `isWhatsAppBackup`, `isActive`, `notes` — enough to auto-fill the wizard with **no normalize change** (`normAccount` L152–165 already maps them).

**DB writes:** none new in schema. All work-identity/assignment writes go through Prisma; no migration required.

## Definition of done (BE-5)
- `POST /assignments/generic` creates an ACTIVE LAPTOP/PRINTER/SIM/GENERAL assignment in one call (asserted: employee asset flips to ASSIGNED, roomId set from wid, ASSIGNED timeline written, expectedReturnAt honored).
- Generic route rejects PHONE (400), rejects `assetId` already in an active assignment (409).
- `POST /assignments/phone` with a `workIdentity:{name,departmentTeamId,roomId}` upserts the seat (call-center via `name_roomId`, others via `name+departmentTeamId`) and links it; call-center upsert is idempotent; null-room path never violates the unique index.
- `GET /accounts?kind=WHATSAPP&identifier=9053…` returns the matching account (or empty list) with `email`/`isWhatsAppBackup` present; unknown number → empty list, not 404.
- `npm run lint` + `node scripts/check-db.js` pass; server boots; a focused test in `server/tests/api.test.js` covers generic create + WIP upsert idempotency.

---

# BE-6 — Employees full CRUD

**Goal (CHANGE 2).** Replace the read-only `GET /employees` lookup with full CRUD under capability `people:write` (Admin). Contract §5.1–5.4.

## Files
- **New** `server/src/routes/employees.routes.js` (mirror `users.routes.js` structure: L13 router.use, L60 POST, L74 PATCH).
- `server/src/routes/lookups.routes.js` — **remove** the `GET /employees` handler (L41–55) so no duplicate route; keep `GET /departments` + `GET /work-identities`.
- `server/src/app.js` — add `api.use('/employees', require('./routes/employees.routes'));` **before** the `api.use('/', require('./routes/lookups.routes'))` line (L50).
- `web/...` files for the UI live in FE-6 (below), not here.

## Endpoints (all Admin writes via `requireCapability('people:write')`)
- **`GET /employees`** — keep the exact current shape/list envelope (lookups L41–55) the FE depends on, including `roomScope` scoping for TEAM_LEADER/L1 and `departmentTeam`+`room` includes. Capability `people:read`.
- **`GET /employees/:id`** — `data`: employee plus `history` (array of `{assignmentId, assignmentCode, assetCode, assetName, workIdentityName, status, assignedAt, returnedAt}`), derived from `employee.assignments` include (contract §5.4).
- **`POST /employees`** (201) — body `{ fullName, departmentTeamId, roomId?, phoneContact?, internalEmail?, notes? }`; `status` defaults ACTIVE. Validate `departmentTeamId` exists (400); catch Prisma `P2002` on `@@unique([fullName, departmentTeamId])` → 409.
- **`PATCH /employees/:id`** (200) — partial subset of the above **plus `status`** (`ACTIVE|LEFT|ON_LEAVE`). Mirror users PATCH validation style.
- **`DELETE /employees/:id`** (204 | 200 soft) — mirror account-delete pattern (accounts.routes.js L122–140):
  - 409 CONFLICT if the employee is `managerEmployee` of any Room, **or** holds active assets (`currentAssets.length`), **or** has an `ACTIVE` assignment.
  - Else if any assignment/timeline history exists → soft-delete via `status:'LEFT'`, return `200 {data:{id,softDeleted:true}}`.
  - Else hard delete → `204`.
  - Audit each write (`employee.create|update|delete|deactivate`).

**RBAC wiring:** `people:write` already exists in `rbac.js` (L20, Admin-only). `GET /employees/:id` reads use `people:read`.

## Definition of done (BE-6)
- POST/PATCH/DELETE/GET:id all wired; duplicate `fullName+departmentTeamId` → 409; unknown `departmentTeamId` → 400; delete blocked (409) when employee is a room manager or holds active assets, soft → LEFT when history exists, hard delete otherwise.
- run its own app/test assertions: lifecycle create→patch→delete round-trip; DB state verified via `node scripts/check-db.js`.
- GET /employees list still returns the legacy shape so FE-6's fetch keeps working unchanged.

---

# BE-7 — Rooms full CRUD

**Goal (CHANGE 3).** Replace read-only `GET /rooms` with full CRUD incl. manager assignment under `people:write`. Contract §5.7–5.8.

## Files
- **New** `server/src/routes/rooms.routes.js` (mirror users/accounts route structure).
- `server/src/routes/lookups.routes.js` — **remove** `GET /rooms` handler (L18–30); keep `/departments`, `/work-identities`.
- `server/src/app.js` — add `api.use('/rooms', require('./routes/rooms.routes'));` before the lookups mount (L50).

## Endpoints
- **`GET /rooms`** — preserve current response (bare `{ data: [...] }`, `includes: managerEmployee{id,fullName}`, `_count{employees,workIdentities}`) so `useRooms` (hooks L175–181) keeps working. `people:read`, with `roomScope` for TEAM_LEADER (lookups L22–24).
- **`GET /rooms/:id`** — same item shape + `_count`.
- **`POST /rooms`** (201) — `{ code, teamType?: CALLCENTER|HOSPITAL, managerEmployeeId?: uuid|null }`; `code` unique → 409 (catch P2002); `managerEmployeeId` must exist → 400. `teamType` defaults `CALLCENTER`.
- **`PATCH /rooms/:id`** (200) — partial `code`, `teamType`, `managerEmployeeId`(nullable → "set manager"/clear). Revalidate uniqueness + manager existence.
- **`DELETE /rooms/:id`** (204 | 409) — **409 CONFLICT** if referenced by any `Employee`, `WorkIdentity`, `User`, or `Asset` (matches the categories "blocked if referenced" rule, contract §4.4). No soft-delete flag exists on Room, so a referenced room cannot be deleted — block only. Audit each write.

**RBAC:** `people:write` for writes; `rooms:read`-equivalent is `people:read` for reads.

## Definition of done (BE-7)
- Full create→read→set-manager→delete round-trip; code uniqueness 409; delete blocked (409) when employees/work-identities/users/assets reference the room; unknown manager → 400.
- DB round-trip verified via check-db; test in api.test.js.
- GET /rooms still returns the legacy shape for FE-7.

---

# FE-5 — Generic assignment wizard + manual work identity + SIM/WhatsApp auto-fetch

**Goal (CHANGES 1, 4, 5 frontend).** A generic assign flow for any non-phone asset; the wizard's identity step becomes manual name + department + conditional room; SIM/WhatsApp takes ONE number that auto-fetches Account data.

## Files (all `web/`)
- **New** `web/src/pages/assignments/GenericAssignPage.tsx` — non-phone flow.
- `web/src/pages/phones/assign/PhoneAssignPage.tsx` — Change 4 (identity step) + Change 5 (single-number step).
- `web/src/App.tsx` — route for `/assignments/new`.
- `web/src/pages/PeoplePages.tsx` — add "Assign asset" CTA on `AssignmentsPage` + the type chooser entry (or route to chooser).
- `web/src/api/hooks.ts`, `web/src/api/types.ts`, `web/src/api/normalize.ts` — new payloads/hooks; extend account/employee/room hooks.

## Types & hooks (shared FE layer)
- `types.ts`: add `WorkIdentityInput = { name:string; departmentTeamId?: string|null; roomId?: string|null }`; add `GenericAssignmentPayload { type; employeeId; workIdentityId?; workIdentity?: WorkIdentityInput; assetId; conditionAtHandover; expectedReturnAt?; notes? }`; add `workIdentity?: WorkIdentityInput` to `PhoneAssignmentPayload` (optional, alongside `workIdentityId`); add `EmployeeHistoryEntry`, `Room` already present.
- `hooks.ts`:
  - `useCreateGenericAssignment()` → `POST /assignments/generic`, invalidation `['assignments']` (mirror `useCreatePhoneAssignment` L242–251).
  - `useAccounts` filters — add `identifier?: string` and pass through (L153–160).
  - `useEmployee(id)`, `useSaveEmployee(id?)`, `useDeleteEmployee(id)`; `useRoom(id)`, `useSaveRoom(id?)`, `useDeleteRoom(id)`.
  - Keep `useEmployees`/`useRooms` unchanged (they hit the rehomed BE-6/BE-7 list endpoints).
- `normalize.ts`: `normAccount` already returns `email`/`isWhatsAppBackup` (L152–165) — no change needed for auto-fill. Add `normEmployeeHistory` if detail is fetched raw.

## Change 4 — work-identity step (both wizards) — PhoneAssignPage.tsx L423–426 → replace
Replace the work-identity `<Select>` (L423–426) with:
1. **Manual name input** (`Input`, `draft.workIdentity.name`).
2. **Department picker** — `useDepartments()` (already imported in the wizard's tree); values `{id, name, type}`.
3. **Conditional room `<Select>`** — shown only when `selectedDept.type === 'CALLCENTER'`; options from `useRooms()` filtered to `teamType==='CALLCENTER'` (TR1–TR4). Non-call-center → no room field.
- Remove `useWorkIdentities` list dependency for the wizard (keep import if other pages still use it). The step's Zod schema now validates `name` (min 1) and, when CALLCENTER, a non-empty `roomId`.
- `buildPhonePayload` (L120–156): set `workIdentityId: undefined`, add `workIdentity: {name, departmentTeamId, roomId}`.

## Change 1 — generic wizard: **New `GenericAssignPage.tsx`** (`/assignments/new`)
Self-contained wizard reusing existing components (`Field/Input/Select/PageHeader/EmptyState/ErrorState`, `useAssets`, `useEmployees`, `useDepartments`, `useRooms`). Steps:
1. **Employee + work identity** — same manual identity step as Change 4 (name/dept/room).
2. **Asset** — a purpose-specific type selector (LAPTOP/PRINTER/SIM/GENERAL) then `useAssets({ status:'AVAILABLE', categoryId:// chosen non-phone category, pageSize:100 })` picker (generalize `PhonePicker` L224–272: drop IMEI/phone-only columns). Reject Phones category (hidden/filtered out).
3. **Details** — `conditionAtHandover` (Select over `CONDITIONS`), `expectedReturnAt` (date), `notes`. **No SIM/WhatsApp/Bitrix/charger/photos** — those remain phone-only.
4. **Review** — summary; submit → `useCreateGenericAssignment` → navigate `/assignments/${id}`.
Contains no phone-specific files → parallel-safe with FE-6/FE-7.

**Routing/CTA:** `App.tsx` add `<Route path="/assignments/new" element={<RequireRole access="assets.new"><GenericAssignPage/></RequireRole>} />`. `PeoplePages.tsx` `AssignmentsPage` header action (L20–23): add a second button "Assign other asset" → `/assignments/new`; keep "Assign phone" → `/phones/assign`. Optionally gate by `can(role,'assets.new')`.

## Change 5 — SIM/WhatsApp single-number auto-fetch — PhoneAssignPage.tsx step 2/3
Rework step 2 (L434–448): **ONE number input** drives `sim1Number` AND `wa1.phoneNumber` (value of both = the same input). On `onBlur` (or debounced change when the number ≥ ~9 digits):
- Call new `useAccounts({ kind:'WHATSAPP', identifier: number, pageSize:1 }, enabled=!!number)`.
- On match: `set` `wa1.backupEmail = account.email`, and set the number into `sim1Number` + `wa1.phoneNumber`; mark "auto-filled from Account `identifier`".
- On no match: keep fields editable & blank, show a hint "No WhatsApp Account with this number — enter backup details manually" (fields remain editable; never block submission).
- Keep the **rest** of `WaFields` (backup date / used / total GB / chat counts / app variant — L169–211) editable-after-autofill: `Account` does **not** store these (they live on `PhoneAssignmentDetail`), so only `backupEmail` (+ a read-only `isWhatsAppBackup` indicator) auto-fills. This is a deliberate limitation — document it in FUTURE_VERSIONS.
- `buildPhonePayload`: `sim1Number = wa1.phoneNumber` (single source), send `wa1BackupEmail` from the auto-filled/overridden value. Also wire the SIM2 step (L450–471) the same way when `includeSim2`.

## Definition of done (FE-5)
- `/assignments/new` assigns LAPTOP/PRINTER/SIM/GENERAL assets end-to-end; phone-specific fields never appear for non-phone types; result navigates to the ACTIVE assignment detail.
- Work-identity step is name + department + conditional Call-Center room; non-call-center has no room field; CALLCENTER requires a room.
- SIM/WhatsApp step has a single number input; typing an existing WhatsApp Account number auto-fills `wa1BackupEmail` (+ marks the source); unknown numbers leave fields editable with a hint.
- `npm run build` + `tsc -b` clean; 409/validation errors surfaced (existing patterns).

---

# FE-6 — Employees CRUD UI (CHANGE 2)

**Files:** `web/src/pages/EmployeesPage.tsx` (rewrite to add CRUD), `web/src/api/hooks.ts` (+`useSaveEmployee/useDeleteEmployee/useEmployee`), `web/src/api/types.ts` (+`EmployeeHistoryEntry`), `web/src/App.tsx` (employee detail route).

- **List** (existing `EmployeesPage` L24–89): keep search/filter/devices, add per-row **Edit / Delete** buttons gated by `can(role,'employees')`-style Admin check (reuse `useAuthStore` + `isAdmin`/`can` from `permissions.ts`).
- **Create/Edit form**: modal or inline panel using `useSaveEmployee(id?)`; fields `fullName`, `departmentTeamId` (from `useDepartments`), `roomId` (from `useRooms`, filtered), `phoneContact`, `internalEmail`, `notes`, `status` (edit only). On save invalidate `['employees']`.
- **View**: new `/employees/:id` route → detail page showing employee + `history` (from `useEmployee(id)`), reusing device chips pattern.
- **Delete**: confirm dialog → `useDeleteEmployee`; handle 409 (blocked) and soft-delete result distinctly.

## DoD (FE-6)
- Create/edit/delete/view all wired to BE-6; Admin-only gating; list refetches after mutations; `npm run build` + `tsc` clean.

---

# FE-7 — Rooms CRUD UI (CHANGE 3)

**Files:** `web/src/pages/PeoplePages.tsx` (`RoomsPage`, currently read-only grid L63–81) → rewrite to a CRUD page; `web/src/api/hooks.ts` (+useSaveRoom/useDeleteRoom/useRoom), `web/src/App.tsx` (room detail route if chosen).

- **List**: keep the card grid; add **New room / Edit / Set manager / Delete** actions, gated Admin (`people:write` ⇔ front-end gate via `can(role,'rooms')` — note `ROUTE_ACCESS.rooms` is currently `MGR`; **keep reads MGR but gate writes to ADMIN** via `can(role,'assets.new')` or an `isAdmin` check; make this explicit in the DoD).
- **Create/Edit form**: `code`, `teamType` (CALLCENTER/HOSPITAL), manager picker (`useEmployees({pageSize:100})` → fullName). On save invalidate `['rooms']`.
- **Set manager**: quick inline manager `<Select>` on each card → `PATCH managerEmployeeId`.
- **Delete**: confirm → `useDeleteRoom`; surface 409 (still referenced) clearly.

## DoD (FE-7)
- New/edit/delete/set-manager wired to BE-7; writes Admin-only; 409 on delete handled; `npm run build` + `tsc` clean.

---

## Suggested merge & test order
1. Merge BE-5, BE-6, BE-7 (any order; do the BE-6+BE-7 lookups.routes.js/app.js edits in one commit).
2. `server`: `prisma` nothing to migrate; run tests + `check-db.js`. 
3. Merge FE-7 and FE-6 (depend on BE-6/BE-7), then FE-5 (depends on BE-5). All three FE cards build cleanly in parallel.
4. End-to-end smoke: create a non-phone asset → assign via `/assignments/new` with a typed work identity; assign a phone with an auto-fetched WhatsApp Account; add/edit/delete an employee and a room (incl. blocked delete).

## Future versions / notes (append to `docs/FUTURE_VERSIONS.md`)
- **Standalone WorkIdentity CRUD** (POST/PATCH/DELETE `/work-identities`): still deferred — seats are now created on-the-fly by the assignment upsert, which covers the stated need. Revisit if a management page is wanted (contract §5.10–5.11).
- **WhatsApp Account auto-fill scope:** `Account` stores only `email`(backup) + `isWhatsAppBackup` + `notes`. Backup date, GB, and chat counts live on `PhoneAssignmentDetail` and must remain manual in the wizard. If the clinic wants these on the Account, that's a schema/seed follow-up.
- **`@@unique([name, roomId])` NULL caveat:** non-call-center identities (room NULL) can't use Prisma `upsert` on the compound key — the plan handles it via explicit `findFirst`; keep this if the unique index or a department uniqueness rule later changes.
- **Department CRUD** (contract §5.6 POST/PATCH/DELETE) is still read-only (`GET /departments` in lookups.routes.js L32–39) — unchanged by this wave; the wizard's department list is consumed read-only.
- **Generic-assignment return:** `POST /assignments/:id/return` (returns.routes.js) is type-agnostic; it compares only the phoneDetail fields, so returning a laptop/print shows the standard asset-condition comparison with no phone rows — acceptable, but flag to owner if per-category return fields are wanted.

---

## Summary of work
- **What I did:** read all authoritative contracts/plans (API_CONTRACT, IMPLEMENTATION_PLAN, PHASE_2/4, FOLLOWUP, FUTURE_VERSIONS, README) and inspected the live code (schema.prisma, assignment service/routes, lookups.routes.js, PhoneAssignPage.tsx, PeoplePages.tsx, EmployeesPage.tsx, App.tsx, AppLayout.tsx, hooks/types/normalize, permissions.ts, rbac.js, accounts.routes.js, users.routes.js, assets service).
- **Key grounding:** verified current read-only `/rooms` and `/employees` (lookups L18–30 / L41–55), the hardcoded phone wizard + fixed identity dropdown (PhoneAssignPage L423–426) and double SIM/WhatsApp entry (L437–438, L446), the reusable `Assignment`/`AssignmentItem`/`Timeline` model already carrying `LAPTOP/PRINTER/SIM/GENERAL` types, `people:write` capability already Admin-only, and the DRAFT→ACTIVATE + `/phone` create-and-activate service patterns to reuse.
- **Deliverable:** the full Markdown plan above — 6 kanban cards (BE-5/6/7, FE-5/6/7) with exact files, request/response shapes, DB writes, RBAC wiring, definitions of done, parallel-merge order, and a future-notes section. No code was modified; this is a planning deliverable.
- **Issues surfaced for the owner:** `@@unique([name, roomId])` null-unique caveat for non-call-center identities; WhatsApp Account lacks backup date/GB/chat data so auto-fill is limited to backup email; rooms have no soft-delete flag (block-only delete); returning non-phone assets shows no phone-specific comparison fields.