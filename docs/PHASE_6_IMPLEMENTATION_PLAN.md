I have all the context I need. Here is the implementation-ready plan.

---

# Implementation Plan — 8 User-Requested Changes (Clinic IT-Asset App)

**Repo:** `/opt/data/handovers-sys` · **Backend:** Express+Prisma `server/` · **Frontend:** React+TS+Vite `web/`
**Contract source of truth:** `docs/API_CONTRACT.md` (re-version to track the new endpoints below).

## Verified current state (grounding)

- **CHANGE 1 (PC import):** `server/scripts/import.js` L279–291 creates PC + accessory assets with `status:'AVAILABLE'`; L314–317 calls `POST /assignments/generic` with `type:'LAPTOP'`. Root cause of the 2/47 failures: `createGenericAssignment` (assignment.service.js L413) rejects any asset whose `category.name === 'Phones'` (L423) — fine — but the **real** blocker is the **dual-active guard** `assertAssetsFree` (L426) plus the fact that the generic route's `genericType` enum (`assignments.routes.js` L19) is `['LAPTOP','PRINTER','SIM','GENERAL']` — **no `COMPUTERS`**, so the import's `type:'LAPTOP'` maps to the "Laptops" category filter, not the "Computers" category the import created. The import also never assigns the **accessories** (monitor/mouse/keyboard/headphone) — only the PC. Fix = add `COMPUTERS` (and accessory types) to the enum + import, and assign accessories as `BUNDLED` items in the same generic call.
- **CHANGE 2 (delete assets):** `DELETE /assets/:id` exists (assets.routes.js L271–296) with the3 outcomes (204 hard / 200 `{softDeleted:true,status:'DISPOSED'}` / 409 in-active-assignment). Frontend has **no** Delete button (AssetDetailPage.tsx L188 only has Edit; AssetListPage.tsx has no actions column).
- **CHANGE 3 (Computers category):** `GENERIC_ASSET_TYPES` (GenericAssignPage.tsx L14) = `['LAPTOP','PRINTER','SIM','GENERAL']`; `genericType` enum (assignments.routes.js L19) matches. Import created `Computers/Monitors/Mouse/Keyboards/Headphones` categories (import.js L187–191).
- **CHANGE 4 (employee device nav):** EmployeesPage.tsx `Devices` (L13–25) and EmployeeDetailPage.tsx `HeldDevices` (L8–20) both `<Link to={/assets/${d.id}}>`; back from asset → `/assets` (AssetDetailPage.tsx L179). No inline drawer.
- **CHANGE 5 (dropdown search):** All wizard dropdowns are plain `<Select>` (PhoneAssignPage.tsx L462–464 employees, L484–497 SIM, L544–560 bitrix/chargers; GenericAssignPage.tsx L220–223 employees; WorkIdentityFields.tsx L58–68 dept/room). No search. The asset/phone pickers already have search (PhonePicker/AssetPicker) — only the `<Select>` dropdowns need it.
- **CHANGE 6 (users CRUD):** Backend POST/PATCH `/users` + PATCH `/users/:id/password` fully implemented (users.routes.js L60/74/92). `UsersSettingsPage.tsx` is read-only (L8 comment). **No backend work needed** — pure frontend.
- **CHANGE 7 (RBAC):** `UserRole` enum = `ADMIN/MANAGER/TEAM_LEADER` (schema L58). `rbac.js` capability matrix + `roomScope()` (L43–46) scopes TEAM_LEADER to own room. `permissions.ts` mirrors roles. Need new roles + a `scope` model for "all call-center rooms read-only" vs "own room read-only".
- **CHANGE 8 (logs):** `AuditLog` model exists (schema L298–312: actorId, action, targetType, targetId, meta, ip, createdAt). `audit()` (audit.service.js) is called on all writes. **No GET endpoint exists** — needs a new route + page.

## Card split & merge order

| Card | Owner | Depends on |
|---|---|---|
| **BE-17** | backend | — (RBAC + audit-logs + users backend already done) |
| **BE-18** | backend | — (import fix + Computers category) |
| **FE-16** | frontend | BE-17 (delete assets, users CRUD, logs page) |
| **FE-17** | frontend | BE-18 (Computers category, dropdown search, employee nav) |

**Merge order:** BE-17 and BE-18 are independent (disjoint files) → merge in any order. FE-16 depends on BE-17 (RBAC roles + audit-logs endpoint); FE-17 depends on BE-18 (Computers type). FE-16 and FE-17 touch disjoint files → parallel after their backend deps land.

---

# Card BE-17 — Backend: RBAC redesign + audit-logs endpoint**Goal (CHANGE 7 + CHANGE 8 backend).** Extend the role model so: IT = full admin; call-center CEO + assistant = read-only across **all** call-center rooms; room managers = read-only within **their own** room; passwords = IT only. Add `GET /audit-logs` (paginated, filterable).

## Files to touch (all backend)
- `server/prisma/schema.prisma` — extend `UserRole` enum; add `User.scope` (room-scope discriminator).
- `server/prisma/migrations/` — new migration (enum + column).
- `server/src/middleware/rbac.js` — new capabilities + `roomScope()` rewrite.
- `server/src/middleware/auth.js` — include `scope` in the `req.user` select.
- **New** `server/src/routes/audit-logs.routes.js` — `GET /audit-logs`.
- `server/src/app.js` — mount audit-logs route.
- `server/prisma/seed.js` — seed the real people mapped to roles.
- `server/src/routes/users.routes.js` — extend `role` zod enum + `scope` field (L17, L27, L33).

## 1. Schema — Role enum + scope

```prisma
enum UserRole {
  ADMIN
  MANAGER
  TEAM_LEADER
  CALL_CENTER_MANAGER   // CEO + assistant: read-only, ALL call-center rooms
  CALL_CENTER_VIEWER    // (optional alias if you want a distinct label; see note)
}
```
Add to `User`:
```prisma
  /// Room-scope discriminator: null = unrestricted (ADMIN/MANAGER/CALL_CENTER_MANAGER),
  /// 'OWN_ROOM' = TEAM_LEADER/CALL_CENTER_VIEWER scoped to User.roomId.
  scope String?   // values: null | 'OWN_ROOM'
```
**Design decision:** keep `TEAM_LEADER` (room managers) and add **`CALL_CENTER_MANAGER`** for the CEO + assistant. Both `TEAM_LEADER` and `CALL_CENTER_MANAGER` are read-only; the difference is **scope breadth**:
- `TEAM_LEADER` → `roomScope = { roomId: user.roomId }` (own room only).
- `CALL_CENTER_MANAGER` → `roomScope = { allCallCenter: true }` (all CALLCENTER rooms).
- `ADMIN`/`MANAGER` → unrestricted (but MANAGER stays read-only, no decrypt).

`scope` column is optional; default `null`. `TEAM_LEADER` and `CALL_CENTER_MANAGER` rows set `scope='OWN_ROOM'` (TEAM_LEADER) or `scope=null` (CALL_CENTER_MANAGER — breadth comes from the role, not the column). The column exists so a future "viewer scoped to a subset of rooms" can reuse it without another enum value.

## 2. RBAC matrix (`rbac.js`)

```js
const CAPABILITIES = {
  'inventory:read':   ['ADMIN','MANAGER','TEAM_LEADER','CALL_CENTER_MANAGER'],
  'people:read':      ['ADMIN','MANAGER','TEAM_LEADER','CALL_CENTER_MANAGER'],
  'accounts:read':    ['ADMIN','MANAGER'],            // CALL_CENTER_MANAGER denied (passwords)
  'assignments:read': ['ADMIN','MANAGER','TEAM_LEADER','CALL_CENTER_MANAGER'],
  'reports:read':     ['ADMIN','MANAGER','TEAM_LEADER','CALL_CENTER_MANAGER'],
  'reports:export':   ['ADMIN','MANAGER'],
  'inventory:write': ['ADMIN'],
  'people:write': ['ADMIN'],
  'accounts:write':  ['ADMIN'],
  'accounts:decrypt':['ADMIN'],                       // IT only — unchanged
  'assignments:write':['ADMIN'],
  'users:manage':    ['ADMIN'],
  'audit:read':      ['ADMIN'],                       // NEW — logs page
};
```
**`roomScope(user)` rewrite:**
```js
function roomScope(user) {
  if (user.role === 'TEAM_LEADER') return { roomId: user.roomId ?? '00000000-0000-0000-0000-000000000000' };
  if (user.role === 'CALL_CENTER_MANAGER') return { allCallCenter: true };
  return null;
}
```
**Scope enforcement in routes** — the existing `scopeWhere`/`scoped` helpers (assets.routes.js L100–103, assignments.routes.js L33–35) only handle `{roomId}`. Extend them to handle `{allCallCenter:true}`:
- **assets.routes.js `scopeWhere`** (L100): add `if (s?.allCallCenter) return { room: { teamType: 'CALLCENTER' } }` (assets in a CALLCENTER room **or** held by an employee of a CALLCENTER room — mirror the OR pattern).
- **assignments.routes.js `scoped`** (L33): add `if (scope?.allCallCenter) return { workIdentity: { room: { teamType: 'CALLCENTER' } } }`.
- **employees.routes.js / rooms.routes.js / reports.routes.js**: apply the same `allCallCenter` branch to their existing `roomScope` filters. Reports already accept `roomId`; for CALL_CENTER_MANAGER default the report scope to all CALLCENTER rooms (or leave the picker open to CALLCENTER rooms only).
- **accounts.routes.js**: `accounts:read` excludes CALL_CENTER_MANAGER → they get 403 on `/accounts` and `/accounts/:id/decrypt` (decrypt already `accounts:decrypt` = ADMIN only). **Passwords stay IT-only.**

## 3. `GET /audit-logs` (CHANGE 8)

**New** `server/src/routes/audit-logs.routes.js`, mounted in `app.js`:
```js
api.use('/audit-logs', require('./routes/audit-logs.routes'));
```
Route: `router.use(requireCapability('audit:read'))` (ADMIN only).

**Request (query):** `page`, `pageSize`, `actorId` (uuid), `action` (string, e.g. `asset.create`), `targetType` (string), `targetId` (uuid), `from` (ISO date), `to` (ISO date), `q` (substring on `action`/`targetType`).

**Response 200 — list envelope:**
```json
{
  "data": [{
    "id": "uuid",
    "actor": { "id": "uuid", "fullName": "Nour", "username": "admin" } | null,
    "action": "asset.create",
    "targetType": "Asset",
    "targetId": "uuid",
    "meta": { "code": "COM-000001" },
    "ip": "::1",
    "createdAt": "2026-10-21T09:00:00.000Z"
  }],
  "meta": { "page": 1, "pageSize": 25, "total": 137, "totalPages": 6 }
}
```
**DB writes:** none (read-only). `where` builder: `actorId`, `action` (contains, insensitive), `targetType`, `targetId`, `createdAt` range (`gte`/`lte`), `q` → `OR:[{action},{targetType}]`. Order `createdAt desc`. Include `actor: { select: { id, fullName, username } }`.

## 4. Users route — accept new role + scope

`users.routes.js`:
- L17 `role` enum → `z.enum(['ADMIN','MANAGER','TEAM_LEADER','CALL_CENTER_MANAGER'])`.
- `createBody`/`patchBody` add `scope: z.enum(['OWN_ROOM']).nullish()`.
- L30/L81 refine: `TEAM_LEADER` requires `roomId`; `CALL_CENTER_MANAGER` requires `scope` NOT `OWN_ROOM` (i.e. `scope: null`). Keep the self-demote guard (L82).

## 5. Seed the real people (CHANGE 7 mapping)

`server/prisma/seed.js` — add users (idempotent upsert, mirror L56–70):
| username | fullName | role | roomId | scope |
|---|---|---|---|---|
| `nour.awshar` | Nour Awshar | ADMIN | null | null |
| `abdulkader` | Abdulkader | ADMIN | null | null |
| `ayman` | Ayman (IT) | ADMIN | null | null |
| `mr.mahmoud` | Mr Mahmoud (CEO) | CALL_CENTER_MANAGER | null | null |
| `mr.ayman` | Mr Ayman (assistant) | CALL_CENTER_MANAGER | null | null |
| `hazim` | Hazim | TEAM_LEADER | TR1 | OWN_ROOM |
| `fateh` | Fateh | TEAM_LEADER | TR2 | OWN_ROOM |
| `diaa` | Diaa | TEAM_LEADER | TR3 | OWN_ROOM |
| `ayman.tr4` | Ayman (TR4) | TEAM_LEADER | TR4 | OWN_ROOM |

Passwords from `SEED_*_PASSWORD` env (fallback documented in server/README). **Note:** two people named "Ayman" (IT admin + TR4 manager) — use distinct usernames (`ayman` vs `ayman.tr4`). Keep the existing `admin`/`manager`/`tl.tr1`/`tl.tr2` seed rows for back-compat (or remove `manager` if the clinic no longer wants it — flag to owner).

## Definition of done (BE-17)
- Migration applies; `UserRole` includes `CALL_CENTER_MANAGER`; `User.scope` column present.
- `CALL_CENTER_MANAGER` reads all CALLCENTER assets/employees/assignments/rooms/reports; **cannot** write (403), **cannot** see accounts (403), **cannot** decrypt (403).
- `TEAM_LEADER` reads only own room (unchanged behavior); `ADMIN` full; `MANAGER` read-only all rooms, no decrypt (unchanged).
- `GET /audit-logs` returns paginated, filterable logs (actor/action/date/q); ADMIN-only; 403 for non-ADMIN.
- Seed creates the 9 real users idempotently; `node scripts/check-db.js` passes; server boots; focused test in `server/tests/api.test.js` covers CALL_CENTER_MANAGER scope + audit-logs filter.

---

# Card BE-18 — Backend: fix PC import assignment + Computers category in generic assign

**Goal (CHANGE 1 + CHANGE 3 backend).** Make the import assign each PC **and its accessories** to the employee in the same row; add `COMPUTERS` (and accessory types) to the generic-assign type list so PCs can be assigned.

## Files to touch (all backend)
- `server/src/routes/assignments.routes.js` — extend `genericType` enum (L19).
- `server/src/services/assignment.service.js` — `createGenericAssignment` (L413) to accept accessory items.
- `server/scripts/import.js` — assign PC + accessories in one generic call.

## 1. Generic-assign type list (CHANGE 3 backend)

`assignments.routes.js` L19:
```js
const genericType = z.enum(['LAPTOP', 'PRINTER', 'SIM', 'GENERAL', 'COMPUTERS', 'MONITORS', 'MOUSE', 'KEYBOARDS', 'HEADPHONES']);
```
`createGenericAssignment` (assignment.service.js L413) already rejects only `category.name === 'Phones'` (L423) — so `COMPUTERS`/accessory types pass through unchanged. **No service change needed for the type itself.** The `AssignmentType` enum (schema L75) already has `GENERAL`; the new types map to `GENERAL` at the DB level OR we add them to the enum. **Recommendation:** keep `Assignment.type` as-is (`GENERAL`) and treat the wizard's type as a **category filter**, not a stored enum — the import already stores `type:'LAPTOP'` for PCs. Simplest: the route accepts the new strings and stores them verbatim only if we extend `AssignmentType`; otherwise map `COMPUTERS/MONITORS/MOUSE/KEYBOARDS/HEADPHONES → 'GENERAL'` in the service. **Decision:** extend `AssignmentType` enum with the 5 new values (cleaner reporting) — add a migration.

## 2. Accessory items in generic assignment

`createGenericAssignment` currently creates ONE `AssignmentItem` (L450). Extend the body to accept optional accessory asset ids:
```jsonc
// POST /assignments/generic — extended body
{
  "type": "COMPUTERS",
  "employeeId": "uuid",
  "workIdentity": { "name": "…", "departmentTeamId": "uuid", "roomId": "uuid" },
  "assetId": "uuid",                       // PRIMARY = the PC
  "accessoryAssetIds": ["uuid", "uuid"],   // NEW: monitor/mouse/keyboard/headphone
  "conditionAtHandover": "GOOD",
  "expectedReturnAt": "… | null",
  "notes": "… | null"
}
```
Service changes in `createGenericAssignment`:
- `assertAssetsFree([assetId, ...accessoryAssetIds], tx)` (L426) — guard all.
- Create items: `[{assetId, role:'PRIMARY', conditionAtHandover}, ...accessoryAssetIds.map(id => ({assetId:id, role:'BUNDLED', conditionAtHandover:'GOOD'}))]` (L450).
- Flip **all** involved assets to `ASSIGNED` + holder + room (L455 `updateMany where id in [assetId, ...accessoryAssetIds]`).
- Snapshot `items` includes all (buildSnapshot already maps `items`).

## 3. Import fix (`server/scripts/import.js`)

**Root cause recap:** the import's generic call (L315) sends `type:'LAPTOP'` but the PC is in the **Computers** category, so the wizard's category filter (GenericAssignPage L107–112) never matches — and the route enum rejected nothing (LAPTOP is valid) but the **service** never assigned accessories. The 2/47 that succeeded were likely PCs whose category happened to resolve, or rows where the phone path also ran. The fix:

- **Capture accessory asset ids** when creating them (L284–290): currently the loop discards the created id (`ar.status < 300` only). Change to collect `accessoryAssetIds.push(ar.body.data.id)`.
- **Send one generic call** (replace L314–317):
```js
const ar = await api('POST', '/assignments/generic', {
  type: 'COMPUTERS',
  employeeId: empId,
  workIdentity: wid,
  assetId: pcAssetId,
  accessoryAssetIds, // monitor/mouse/keyboard/headphone ids
  conditionAtHandover: 'GOOD',
  notes: r.note ? `Note: ${r.note}` : undefined,
});
```
- **Diagnose the 2/47:** add a `DRY_RUN`-style preflight that, for each PC row, checks `GET /assets?categoryId=Computers&status=AVAILABLE` and logs whether the PC is already `ASSIGNED` (dual-active 409) or the category/type mismatch. The fix above resolves the mismatch; if a PC is already ASSIGNED (e.g. a phone assignment grabbed it), the import should **skip** it with a clear issue line rather than fail silently.
- **Idempotency:** guard against re-running — if the PC already has an ACTIVE assignment, skip (log `already-assigned`).

## Definition of done (BE-18)
- `POST /assignments/generic` with `type:'COMPUTERS'` + `accessoryAssetIds` creates one ACTIVE assignment with PRIMARY (PC) + BUNDLED (accessories) items; all assets flip to ASSIGNED + holder + room; ASSIGNED timeline written.
- Route accepts `COMPUTERS/MONITORS/MOUSE/KEYBOARDS/HEADPHONES`; rejects `PHONE` (400); rejects any already-active asset (409).
- Re-running `node scripts/import.js` assigns every PC row (47/47) with its accessories; already-assigned PCs are skipped with a logged reason, not errored.
- `npm run lint` + `node scripts/check-db.js` pass; server boots; test in `server/tests/api.test.js` covers generic-with-accessories.

---

# Card FE-16 — Frontend: delete assets + users CRUD UI + logs page

**Goal (CHANGE 2 + CHANGE 6 + CHANGE 8 frontend).** Add Delete to the asset UI; full Users CRUD; a Logs page.

## Files to touch (all `web/`)
- `web/src/api/hooks.ts` — `useDeleteAsset`, `useSaveUser`, `useDeleteUser`, `useResetUserPassword`, `useAuditLogs`.
- `web/src/api/types.ts` — `UserSavePayload`, `AuditLogEntry`, `UserRole` type.
- `web/src/api/normalize.ts` — `normAuditLog`.
- `web/src/pages/assets/AssetDetailPage.tsx` — Delete button + outcome handling.
- `web/src/pages/assets/AssetListPage.tsx` — optional per-row Delete.
- `web/src/pages/settings/UsersSettingsPage.tsx` — full CRUD rewrite.
- **New** `web/src/pages/settings/LogsPage.tsx` — audit trail.
- `web/src/App.tsx` — `/settings/logs` route.
- `web/src/components/layout/AppLayout.tsx` — nav item.
- `web/src/lib/permissions.ts` — `settings.logs` RouteKey + new roles.

## 1. Delete assets (CHANGE 2)

**hooks.ts** — mirror `useDeleteAccount` (L191–203):
```ts
export interface DeleteAssetResult { id: string; softDeleted: boolean }
export function useDeleteAsset(id: string) {
  // DELETE /assets/:id → 204 (hard) | 200 {data:{softDeleted:true,status:'DISPOSED'}} | 409
  // onSuccess: invalidate ['assets'], ['asset', id]
}
```
**AssetDetailPage.tsx** — add a Delete button next to Edit (L188), gated by `isAdmin` (`can(user?.role,'assets.edit')`):
- Confirm dialog (`window.confirm`).
- On success: `softDeleted` → toast "Asset had history and was soft-deleted (status → Disposed)"; hard → "Asset permanently deleted"; then `nav('/assets')`.
- On 409: distinct message "Asset is part of an active assignment; return it first" (mirror `DeleteEmployeeButton` L28–49 pattern).
- **AssetListPage.tsx** — optional: add an Actions column with a Delete button (same handler), gated Admin. Recommended for parity with Employees page.

## 2. Users CRUD (CHANGE 6)

**Backend already done** (users.routes.js POST/PATCH/password). Frontend only.

**types.ts:**
```ts
export type Role = 'ADMIN' | 'MANAGER' | 'TEAM_LEADER' | 'CALL_CENTER_MANAGER'
export interface UserSavePayload {
  username: string; password?: string; fullName: string;
  role: Role; roomId?: string | null; isActive?: boolean
}
export interface AuditLogEntry {
  id: string; actor: { id: string; fullName: string; username: string } | null;
  action: string; targetType: string | null; targetId: string | null;
  meta: Record<string, unknown> | null; ip: string | null; createdAt: string
}
```
**hooks.ts:**
- `useUsers()` (already exists via `useQuery` in the page — promote to a hook).
- `useSaveUser(id?)` → POST/PATCH `/users`, invalidate `['users']`.
- `useDeleteUser(id)` → DELETE `/users/:id` (backend: add DELETE route — see note below).
- `useResetUserPassword(id)` → PATCH `/users/:id/password` `{password}`.
- `useAuditLogs(filters)` → GET `/audit-logs`.

**UsersSettingsPage.tsx** — rewrite from read-only (L8) to CRUD:
- **List** (keep L16–31) + per-row **Edit / Reset password / Delete** buttons, gated `can(role,'settings.users')` (ADMIN).
- **Create/Edit modal** (mirror `EmployeeFormModal` L52–158): fields `username`, `fullName`, `role` (Select over the 4 roles), `roomId` (Select from `useRooms`, shown/required when `role==='TEAM_LEADER'`), `isActive` (edit only), `password` (create only, min 10).
- **Reset password modal**: single password field → `useResetUserPassword`.
- **Delete**: confirm → `useDeleteUser`; surface 409 (self-demote guard) distinctly.
- **Note:** backend has **no** `DELETE /users/:id` — add it in BE-17 (or this card's backend sibling). If not added, omit Delete from the UI and flag it.

## 3. Logs page (CHANGE 8)

**New `LogsPage.tsx`** (`/settings/logs`, `RequireRole access="settings.logs"`):
- Filters: actor (Select from `useUsers`), action (free-text), date range (`from`/`to` date inputs), `q`.
- Table: `createdAt`, `actor.fullName`, `action`, `targetType`, `targetId`, `meta` (collapsible JSON), `ip`.
- Pagination (reuse `Pagination`).
- **permissions.ts:** add `'settings.logs'` RouteKey → `ADMIN`; add `CALL_CENTER_MANAGER` to `ALL`/`MGR` arrays and `ROLE_LABEL`.
- **AppLayout.tsx:** add nav item under Settings → `/settings/logs`, access `settings.logs`.

## Definition of done (FE-16)
- Delete asset works from detail (and list) with the 3 outcomes surfaced distinctly; Admin-gated; list/detail refetch after delete.
- Users page: create/edit/reset-password/delete all wired to backend; Admin-gated; 409 self-demote surfaced; build + tsc clean.
- Logs page shows paginated, filterable audit trail; Admin-only; build + tsc clean.

---

# Card FE-17 — Frontend: generic-assign Computers category + dropdown search + employee device nav fix

**Goal (CHANGE 3 + CHANGE 5 + CHANGE 4 frontend).** Add Computers (and accessory) types to the generic wizard; add search to every wizard dropdown; fix employee-device navigation.

## Files to touch (all `web/`)
- `web/src/pages/assignments/GenericAssignPage.tsx` — type list + category filter.
- `web/src/pages/phones/assign/PhoneAssignPage.tsx` — dropdown search.
- `web/src/pages/assignments/WorkIdentityFields.tsx` — dropdown search.
- `web/src/pages/EmployeesPage.tsx` — device nav fix.
- `web/src/pages/EmployeeDetailPage.tsx` — device nav fix.
- `web/src/components/ui/index.tsx` — **new** `SearchableSelect` component.
- `web/src/api/types.ts` — `GenericAssignmentPayload` + `accessoryAssetIds`.

## 1. Computers category in generic assign (CHANGE 3)

**GenericAssignPage.tsx:**
- L14 `GENERIC_ASSET_TYPES` → `['LAPTOP','PRINTER','SIM','GENERAL','COMPUTERS','MONITORS','MOUSE','KEYBOARDS','HEADPHONES']`.
- L107–112 `typeCategoryId` resolver: the regex `new RegExp(draft.type,'i')` already matches category names (`Computers` matches `COMPUTERS`, `Monitors` matches `MONITORS`, etc.) — **works as-is** once the type is in the list. Verify `Mouse`/`Keyboards`/`Headphones` match the seeded category names (`Mouse`, `Keyboards`, `Headphones` — yes).
- **types.ts** `GenericAssignmentPayload` (L325): add `accessoryAssetIds?: string[]`.
- **GenericAssignPage** step 2: after picking the PRIMARY asset, add an optional multi-select of accessory assets (from the same category filter, `status:'AVAILABLE'`) → `draft.accessoryAssetIds`. Send in `buildGenericPayload` (L70–90).

## 2. Dropdown search (CHANGE 5)

**New `SearchableSelect` in `components/ui/index.tsx`** — a combobox wrapping the existing `<Select>`:
- Props: `options: {value,label}[]`, `value`, `onChange`, `placeholder`, `label`, `error`, `hint`, `required`.
- Renders a text input that filters `options` as the user types (case-insensitive substring on `label`), then a `<Select>` (or a custom list) showing only matches. Keep the native `<Select>` for a11y/scroll; add a filter `<Input>` above it.
- Reuse across all long dropdowns.

**Apply to (replace plain `<Select>`):**
- **PhoneAssignPage.tsx:** employees (L462–464), SIM1 (L484–497), SIM2 (L517–530), Bitrix (L544–547), charger cable (L551–554), charger adapter (L556–559), backup Gmail (via `WaFields` L196–199).
- **GenericAssignPage.tsx:** employees (L220–223).
- **WorkIdentityFields.tsx:** department (L58–61), room (L65–68).
- **AssetListPage.tsx** (optional, "any other long dropdowns"): category (L73–76), holder (L85–88).

## 3. Employee device nav fix (CHANGE 4)

**Recommended: inline drawer** (matches the existing `AssignmentDrawer` pattern, FOLLOWUP_PLAN FE-2). Reuse the asset detail as an overlay instead of navigating away.

**EmployeesPage.tsx `Devices` (L13–25):** replace `<Link to={/assets/${d.id}}>` with a button that opens an inline drawer:
- Add `const [openAsset, setOpenAsset] = useState<string|null>(null)` in `EmployeesPage`.
- `Devices` renders chips as buttons → `setOpenAsset(d.id)`.
- Render `<AssetDrawer assetId={openAsset} onClose={() => setOpenAsset(null)} />` — a new lightweight overlay that fetches `useAsset(id)` and shows code/name/status/holder/notes + a "Open full page" link. (Reuse the `AssignmentDrawer` overlay styling from `web/src/pages/assets/AssignmentDrawer.tsx`.)
- Back/close returns to the employees page (no route change).

**EmployeeDetailPage.tsx `HeldDevices` (L8–20):** same treatment — inline drawer, so back stays on the employee detail.

**Alternative (if inline drawer is too much):** preserve back navigation by passing a `from` query param — `to={/assets/${d.id}?from=/employees}` and have `AssetDetailPage`'s back link (L179) honor `from`. **Recommend the drawer** (consistent with the phone-timeline drawer, no route juggling).

## Definition of done (FE-17)
- Generic wizard offers `COMPUTERS/MONITORS/MOUSE/KEYBOARDS/HEADPHONES`; picking one filters available assets to that category; accessory multi-select sends `accessoryAssetIds`; assignment succeeds end-to-end.
- Every long dropdown in both wizards + WorkIdentityFields has a type-to-filter search input; no dropdown requires scrolling the full list.
- Clicking a device from the employees page or employee detail opens it inline; closing/back returns to the same page (no `/assets` detour).
- `npm run build` + `tsc -b` clean.

---

# Future versions / notes

- **`DELETE /users/:id`** does not exist in `users.routes.js`. Add it in BE-17 (Admin, block self-delete, soft-deactivate `isActive:false` if history) or drop the Delete button from FE-16. Flag to owner.
- **`CALL_CENTER_VIEWER` vs `CALL_CENTER_MANAGER`:** the user's spec says CEO + assistant "can WATCH everything but CANNOT edit" — a single read-only role `CALL_CENTER_MANAGER` covers both. If a future need separates "CEO" from "assistant" permissions, add `CALL_CENTER_VIEWER` as a read-only alias; no schema change beyond the enum.
- **`AssignmentType` enum extension:** adding `COMPUTERS/MONITORS/MOUSE/KEYBOARDS/HEADPHONES` is a migration. If the team prefers zero-migration, map the new wizard types to `GENERAL` in the service and keep the enum unchanged — but reporting loses the type granularity. Recommend the enum extension.
- **Audit-log retention:** `AuditLog` grows unbounded. Add a retention/cleanup job (e.g. delete > 1 year) in a future version; the `createdAt` index (schema L311) supports it.
- **Password visibility:** `accounts:read` excludes `CALL_CENTER_MANAGER`; `accounts:decrypt` is ADMIN-only. Confirm the CEO/assistant should not even see the Accounts page (they get 403) — if they need to see account *identifiers* (not passwords), add a masked `accounts:read` capability for them.
- **Import idempotency:** the import is not idempotent for PCs (re-run creates duplicate assets). The BE-18 fix adds a skip-if-assigned guard; a full idempotency pass (match by serial/name) is a follow-up.
- **`scope` column vs role-derived scope:** the `User.scope` column is optional and currently redundant (breadth is role-derived). It's added for future "viewer scoped to a subset of rooms" without a new enum value. If that's never needed, drop the column and keep scope purely role-derived.

---

## Summary of work
- **What I did:** read all authoritative docs (API_CONTRACT, PHASE_5, SIM_WHATSAPP_CORRECTIONS, FOLLOWUP, FUTURE_VERSIONS, README) and inspected the live code (schema.prisma, rbac.js, auth.js, users/assets/assignments/accounts routes, assignment.service.js, audit.service.js, import.js, seed.js, app.js, and the full frontend: GenericAssignPage, PhoneAssignPage, WorkIdentityFields, AssetDetailPage, AssetListPage, EmployeesPage, EmployeeDetailPage, UsersSettingsPage, AppLayout, App.tsx, hooks/types/normalize, permissions.ts, auth.tsx, ui/index.tsx).
- **Key findings:** (1) PC import failure root cause = `genericType` enum lacks `COMPUTERS` + accessories never assigned; (2) delete-assets backend already done, only UI missing; (3) users CRUD backend already done, only UI missing; (4) RBAC needs a new role + scope model; (5) audit-logs needs a new GET endpoint + page; (6) dropdowns are all plain `<Select>` needing a searchable wrapper.
- **Deliverable:** the full Markdown plan above — 4 kanban cards (BE-17, BE-18, FE-16, FE-17) with exact files, request/response shapes, DB writes, RBAC wiring, definitions of done, parallel-merge order, and a future-notes section. **No code was modified** — this is a planning deliverable.
- **Issues surfaced for the owner:** `DELETE /users/:id` missing (add in BE-17 or drop the button); two people named "Ayman" need distinct usernames; `AssignmentType` enum extension requires a migration (or map to `GENERAL`); CEO/assistant get 403 on Accounts entirely (confirm they don't need masked identifiers); import is not idempotent for PCs.