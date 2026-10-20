# Corrections Plan — 5 user-reported fixes to the Phase 5 work

**Repo:** `/opt/data/handovers-sys` · **Stack:** React+TS+Vite `web/`, Express+Prisma `server/`
**Status:** Phases 0–5 done + pushed. This wave redoes 5 things the user flagged as wrong in the Phase 5 implementation.

## Key finding: this wave is **frontend-only**

I inspected the live backend and confirmed **every backend capability these 5 fixes need already exists**:

| Feedback | Backend already provides | Backend change needed? |
|---|---|---|
| 1. Work identity on-the-fly | `resolveWorkIdentity` (assignment.service.js L92–109) upserts the seat at assignment time; `POST /assignments/phone` + `/generic` accept `workIdentity:{name,departmentTeamId,roomId}` (assignments.routes.js L26–30, L164, L221) | **None** |
| 2. SIM/WhatsApp wizard | `POST /assignments/phone` accepts `sim1Number`/`sim1AssetId`/`wa1*`/`wa2*`/`bitrixAccountId`/chargers (assignments.routes.js L160–195); `GET /accounts?kind=&identifier=` exact-match lookup (accounts.routes.js L61, L66) | **None** |
| 3. Accounts CRUD | `POST /accounts` (L91), `PATCH /accounts/:id` (L104), `DELETE /accounts/:id` (L123) all wired, Admin-gated via `accounts:write` | **None** |
| 4. Generic assign | `POST /assignments/generic` (assignments.routes.js L229) + `createGenericAssignment` (assignment.service.js L404) | **None** |
| 5. Assets unification | `GET /assets/:id` returns `timeline` (contract §4.9); `GET /assets/:id/timeline` (contract §9.1) | **None** |

So the deliverable is **4 frontend cards + 0 backend cards**. The backend-developer has no work this wave; the frontend-developer does all of it. Cards are split by file so they can be developed in parallel and merged independently.

---

# Card FE-8 — Remove the standalone Work-identity page + nav entry (Feedback 1)

**Goal.** Work identities are NOT managed on a standalone page. They are created on-the-fly at assignment time (already implemented in BE-5 `resolveWorkIdentity`). Delete the page, its route, and its nav entry. The `GET /work-identities` endpoint and `useWorkIdentities` hook stay (harmless, still used by nothing after this — see note).

## Files to touch (all `web/`)
- `web/src/pages/PeoplePages.tsx` — **delete** the `WorkIdentitiesPage` component (L233–257).
- `web/src/App.tsx` — **delete** the `/work-identities` route (L50) and the `WorkIdentitiesPage` import (L17).
- `web/src/components/layout/AppLayout.tsx` — **delete** the `Work identities` nav item (L37) and the now-unused `IdCard` icon import (L4).
- `web/src/lib/permissions.ts` — **delete** the `workIdentities` RouteKey (L15) and its `ROUTE_ACCESS` entry (L38). (Optional but clean; nothing else references it after the above.)

## RBAC wiring
None — the page is removed entirely. No capability is touched.

## Definition of done
- No `/work-identities` route, no nav entry, no `WorkIdentitiesPage` component anywhere in `web/`.
- `npm run build` + `tsc -b` clean (no dangling imports of `WorkIdentitiesPage`, `IdCard`, or the `workIdentities` RouteKey).
- Work identities still get created on-the-fly when assigning a phone or generic asset (regression-check: assign a phone to a call-center employee with a typed identity name → seat appears in `GET /work-identities`).

## Merge note
Independent of all other cards (touches only PeoplePages.tsx/App.tsx/AppLayout.tsx/permissions.ts). Can merge any time. **Do NOT delete `useWorkIdentities` from `hooks.ts`** — it is still a valid read hook and may be reused; removing it is out of scope.

---

# Card FE-9 — SIM/WhatsApp wizard: single number from SIM-asset dropdown + asset/account dropdowns (Feedback 2)

**Goal.** The wizard must NOT ask for two separate numbers (SIM 1 number AND WhatsApp number). The real workflow: SIMs are **assets**, Gmails are **assets**, Bitrix accounts are **accounts**; the IT person looks at the phone, sees which WhatsApp it contains, and enters that number **once**. Rework the phone wizard's SIM/WhatsApp steps so every value is picked from existing assets/accounts via dropdowns, and the combination is made in the assignment.

## Files to touch (all `web/`)
- `web/src/pages/phones/assign/PhoneAssignPage.tsx` — rework step 2 (SIM1+WhatsApp main) and step 3 (SIM2+WhatsApp secondary).
- `web/src/pages/phones/assign/SimNumberAutoFill.tsx` — **delete** (superseded; its single-number auto-fetch is replaced by the SIM-asset dropdown + Gmail dropdown below). Remove its import from PhoneAssignPage (L12).
- `web/src/api/hooks.ts` — add `useAccounts` filter support for `subcategory` (to fetch Gmail backup assets) if not already present; add a `useAssets` call for SIM-card assets (already supported via `categoryId`). No new endpoint.
- `web/src/api/types.ts` — no change (payload shape already matches §7.6).

## New step-2/3 field layout (per WhatsApp)
For the **main WhatsApp** (step 2):
1. **SIM card asset** — `<Select>` from `useAssets({ categoryId: <SIM Cards category>, status:'AVAILABLE', pageSize:100 })`. The SIM asset's number is the single source. On selection, set `draft.sim1Number` AND `draft.wa1.phoneNumber` to the SIM asset's number (one number, two fields — the payload already sends both `sim1Number` and `wa1PhoneNumber`; they must be equal). Show the SIM asset's number as a read-only caption under the dropdown.
2. **App type** — `<Select>` Business | Normal → `wa1.appVariant` (already exists in `WaFields`).
3. **Backup Gmail** — `<Select>` from `useAccounts({ kind:'GMAIL', isWhatsAppBackup:true, pageSize:100 })` → `wa1.backupEmail` (pick the account's `email`/`identifier`). This replaces the free-text backup-email input.
4. **Chat counts** — normal + archived (already in `WaFields`).
5. **Backup date** — (already in `WaFields`).

For the **secondary WhatsApp** (step 3): same fields, but the whole block is shown **only when** the `includeSim2` checkbox/toggle "has second WhatsApp" is checked (already the pattern at PhoneAssignPage L487–511). When unchecked, `sim2*`/`wa2*` are sent as `null` (already handled in `buildPhonePayload` L156–166).

**Bitrix account + chargers** (step 4): already dropdowns from `useAccounts({kind:'BITRIX'})` and charger-cable/adapter assets (L377, L516–535). Keep as-is — they already "choose from dropdowns if the employee takes them."

## What to remove
- The free-text "WhatsApp phone number" input in `WaFields` (PhoneAssignPage L199–203) — the number now comes from the SIM-asset dropdown. Keep `hidePhoneNumber` prop or drop it.
- The free-text "Backup email" input (L204–206) — replaced by the Gmail dropdown.
- `SimNumberAutoFill.tsx` entirely.

## Payload / request shape (unchanged — §7.6)
`buildPhonePayload` (L129–172) already sends `sim1Number`, `sim1AssetId`, `wa1PhoneNumber`, `wa1BackupEmail`, `wa1AppVariant`, chat counts, backup date, `bitrixAccountId`, chargers. **No payload change** — only the UI that fills the draft changes. Ensure `sim1Number === wa1.phoneNumber` and `sim1AssetId` is set from the chosen SIM asset.

## DB writes
None directly from this card (the assignment create/activate transaction in `createPhoneAssignment` writes the `PhoneAssignmentDetail` + `AssignmentItem` rows for SIM1/SIM2/chargers and binds accounts — already implemented).

## RBAC wiring
None — the wizard is already Admin-gated via `assets.new` (App.tsx L39).

## Definition of done
- Step 2 has exactly **one** number source: the SIM-card-asset dropdown; selecting it fills both `sim1Number` and `wa1.phoneNumber` with the same value.
- Backup Gmail is a dropdown of Gmail backup accounts (no free-text email).
- Step 3 (secondary WhatsApp) renders only when "has second WhatsApp" is checked; otherwise `sim2*`/`wa2*` are null.
- Bitrix + chargers remain dropdowns.
- `SimNumberAutoFill.tsx` deleted; no dangling imports.
- `npm run build` + `tsc -b` clean; assigning a phone end-to-end persists the single number to both `sim1Number` and `wa1PhoneNumber`.

## Merge note
Depends on nothing else. Touches PhoneAssignPage.tsx + SimNumberAutoFill.tsx + hooks.ts. Can merge independently.

---

# Card FE-10 — Accounts page: full CRUD UI (Feedback 3)

**Goal.** The Accounts page is read-only (no add/edit/delete buttons) even though the backend has `POST/PATCH/DELETE /accounts`. The user cannot add an account, so when assigning they can't pick numbers because "it doesn't exist in the account." Add full CRUD UI, Admin-gated, wired to the existing endpoints.

## Files to touch (all `web/`)
- `web/src/pages/AccountsPage.tsx` — add **New account** button + create/edit modal + per-row **Edit / Delete** actions.
- `web/src/api/hooks.ts` — add `useSaveAccount(id?)` (POST/PATCH) and `useDeleteAccount(id)` (DELETE), mirroring the existing `useSaveEmployee`/`useDeleteEmployee` patterns (L208–247). Invalidate `['accounts']` on success.
- `web/src/api/types.ts` — add `AccountSavePayload` (`kind`, `subcategory?`, `identifier`, `email?`, `password?`, `isWhatsAppBackup?`, `isActive?`, `assetId?`, `notes?`). `password` is required on create for GMAIL/WHATSAPP/BITRIX (server enforces, contract §6.2), optional on edit (send to rotate).

## Endpoint / request-response shapes (already live — no backend change)
- `POST /accounts` (accounts.routes.js L91) — body `{ kind, subcategory?, identifier, email?, password, isWhatsAppBackup?, isActive?, assetId?, notes? }` → 201 `{data: account}`. `password` required for GMAIL/WHATSAPP/BITRIX.
- `PATCH /accounts/:id` (L104) — partial; send `password` to rotate → 200 `{data: account}`.
- `DELETE /accounts/:id` (L123) — 204 hard-delete, or 200 `{data:{softDeleted:true}}` when history exists (deactivates), or **409** when `currentAssignmentId` is set (in use by an active assignment).

## UI changes
- **New account** button in the `PageHeader` actions, shown only when `isAdmin(user)` (already computed at L49).
- **Create/Edit modal** (mirror `RoomFormModal` in PeoplePages.tsx L80–127): fields `kind` (Select GMAIL/WHATSAPP/BITRIX/OTHER), `subcategory` (Input, e.g. "GMail-for-WhatsApp-Backup"), `identifier` (Input — the number/email), `email` (Input), `password` (Input, required on create, placeholder "leave blank to keep" on edit), `isWhatsAppBackup` (checkbox), `isActive` (checkbox, edit only), `notes` (textarea). On save → `useSaveAccount` → invalidate `['accounts']`.
- **Edit** button per row (Admin only) → opens modal pre-filled.
- **Delete** button per row (Admin only) → confirm dialog → `useDeleteAccount`; surface the three outcomes distinctly: 204 (deleted), `softDeleted:true` (deactivated — history kept), 409 (in use by an active assignment — show the message).

## RBAC wiring
- Route already Admin-only (`accounts` → ADMIN, App.tsx L46 + permissions.ts L35).
- Buttons gated by `isAdmin(user)` (L49 already computes it). Backend enforces `accounts:write` (Admin) on all three write endpoints — client gating is UX only.

## Definition of done
- Admin can create, edit, and delete an account from the Accounts page; list refetches after each mutation.
- Create requires `password` for GMAIL/WHATSAPP/BITRIX (server 400 surfaced); edit can rotate password or leave it.
- Delete handles 204 / soft-delete / 409 distinctly.
- Non-Admin sees the read-only list (no buttons).
- `npm run build` + `tsc -b` clean.

## Merge note
Independent (AccountsPage.tsx + hooks.ts + types.ts). Can merge any time. **Prerequisite for the wizard's Gmail/SIM dropdowns to be useful** — merge before or with FE-9 so the dropdowns have data to pick from.

---

# Card FE-11 — Generic assign: fix the asset-type filter (Feedback 4b)

**Goal.** The asset-type filter is broken: selecting LAPTOP/PRINTER/SIM/GENERAL does NOT filter the available-asset list — the user can pick "Printer" and then select a laptop. When a type is chosen, filter the list to that type's category.

## Files to touch (all `web/`)
- `web/src/pages/assignments/GenericAssignPage.tsx` — fix `AssetPicker` (L89–139).

## Root cause (verified)
`AssetPicker` fetches **all** non-phone assets (`useAssets({ status:'AVAILABLE', pageSize:100 })` at L103) and only filters out the Phones category (L104). It ignores `draft.type` entirely, so the type buttons (L212–221) are cosmetic.

## Fix
In `AssetPicker`, resolve the category for the chosen `draft.type` and pass it to `useAssets`:
- Build a type→category map from `useCategories()`: find the root category whose name matches the type (LAPTOP→"Laptops", PRINTER→"Printers", SIM→"SIM Cards", GENERAL→everything non-phone). Reuse the existing name-matching pattern already used for Phones (L94–99) and chargers (PhoneAssignPage L364–372).
- When `draft.type` is set and maps to a category, call `useAssets({ categoryId: <that category id>, status:'AVAILABLE', pageSize:100 }, enabled)` so the server filters server-side.
- For `GENERAL`, keep the current behavior (all non-phone assets).
- If `draft.type` is empty, show an empty state prompting the user to pick a type first (or keep the full list — but the type buttons are step-2, so the type is always chosen before the picker is meaningful).

## Request shape
No backend change. `useAssets` already accepts `categoryId` (hooks.ts L53–72) and the server filters by it (contract §4.8).

## Definition of done
- Selecting LAPTOP shows only Laptops-category assets; PRINTER only Printers; SIM only SIM Cards; GENERAL all non-phone.
- The user can no longer select a laptop after choosing "Printer".
- `npm run build` + `tsc -b` clean.

## Merge note
Independent (GenericAssignPage.tsx only). Can merge any time.

---

# Card FE-12 — Assets page: add View button + remove the Phones page (Feedback 5)

**Goal.** The Assets page must have the same per-row **View** button + timeline tracking as the Phones page. And the separate Phones page is duplicated (filtering Assets to Phones shows the same thing) — remove it. The Assets page becomes the single place to track every asset's timeline.

## Files to touch (all `web/`)
- `web/src/pages/assets/AssetListPage.tsx` — add a **View** button per row (opens `/assets/:id`, which already shows the timeline via `AssetDetailPage`).
- `web/src/pages/phones/PhonesPage.tsx` — **delete** the file.
- `web/src/App.tsx` — **delete** the `/phones` route (L38) and the `PhonesPage` import (L7). Keep `/phones/assign` (L39) — the phone-assignment wizard still needs its route.
- `web/src/components/layout/AppLayout.tsx` — **delete** the `Phones` nav item (L24) and the now-unused `Smartphone` icon import (L4).
- `web/src/lib/permissions.ts` — **delete** the `phones` RouteKey (L10) and its `ROUTE_ACCESS` entry (L33). (Optional but clean.)

## UI changes
- In `AssetListPage`, add a `View` column with a `<Link to={`/assets/${a.id}`}><Button size="sm" variant="secondary">View</Button></Link>` per row — exactly the pattern in PhonesPage L113. The asset detail page (`AssetDetailPage`) already renders the timeline, so "View" gives timeline tracking for every asset type.
- The `phonesOnly` prop on `AssetListPage` (L17) becomes dead — remove it and the `effectiveCategory` phone-only branch (L43–44, L58, L77) since the Phones page is gone. (Keep the generic category filter.)

## RBAC wiring
None — `/assets` is open to all roles (permissions.ts L29). Removing the `phones` RouteKey only affects the deleted nav/route.

## Definition of done
- Every row in the Assets page has a View button that opens the asset detail with its timeline.
- No `/phones` route, no `PhonesPage.tsx`, no `Phones` nav entry.
- `/phones/assign` still works (phone wizard reachable from the Assignments page "Assign phone" button, PeoplePages.tsx L24).
- `npm run build` + `tsc -b` clean (no dangling imports of `PhonesPage`, `Smartphone`, or the `phones` RouteKey).

## Merge note
Independent (AssetListPage.tsx + PhonesPage.tsx + App.tsx + AppLayout.tsx + permissions.ts). Can merge any time. **Do NOT remove `/phones/assign`** — only the `/phones` list route.

---

# Suggested merge & test order

All 5 cards are frontend-only and touch disjoint files, so they can be developed in parallel. Suggested merge order:

1. **FE-8** (remove work-identity page) — trivial, merge first.
2. **FE-10** (Accounts CRUD) — merge before FE-9 so the Gmail/SIM dropdowns have data.
3. **FE-9** (SIM/WhatsApp wizard) — depends on FE-10 for dropdown data.
4. **FE-11** (generic type filter) — independent.
5. **FE-12** (Assets View + remove Phones) — independent.

**End-to-end smoke after all merges:**
- Assign a phone: pick employee → call-center dept shows room + work-identity name → pick SIM asset (fills the single number) → pick app type → pick backup Gmail → chat counts + backup date → (optional) second WhatsApp → Bitrix + chargers → photos → review → submit. Verify `sim1Number === wa1PhoneNumber` in the assignment detail.
- Assign a laptop/printer/SIM/general: type filter shows only that category's assets.
- Accounts: create a Gmail backup account, then pick it in the wizard; edit it; delete it (incl. the 409-in-use case).
- Assets: every row has a View button; `/phones` 404s; `/phones/assign` still works.
- No `/work-identities` route or nav entry.

---

# Future versions / notes (append to `docs/FUTURE_VERSIONS.md`)

- **`GET /work-identities` + `useWorkIdentities` are now unused by the UI** after FE-8. The endpoint stays (harmless, still the read source for reports/room-composition). If a management page is ever wanted, that's a separate future card (contract §5.10–5.11) — but the user explicitly does NOT want one now.
- **SIM number as the single source:** the wizard now derives both `sim1Number` and `wa1PhoneNumber` from the chosen SIM-card asset. The `PhoneAssignmentDetail` still stores both columns (schema/contract unchanged); they are kept equal by the UI. If the clinic later wants the WhatsApp number to differ from the SIM number, that's a schema/contract follow-up.
- **Backup Gmail dropdown** replaces free-text email. `Account` stores `email`/`identifier`; the wizard picks the account and stores its email on `wa1BackupEmail`. Backup date/GB/chat counts still live on `PhoneAssignmentDetail` and remain manual (unchanged limitation, already documented in FUTURE_VERSIONS §3).
- **Phones page removed** — the Assets page (filtered to the Phones category) is now the single inventory view. `/phones/assign` remains the phone-assignment entry point.
- **No backend work this wave** — all 5 corrections are UI-level. The backend already implements work-identity upsert, account CRUD, generic assignment, and account-by-identifier lookup. If a future wave re-introduces a Phones page or work-identity management, the backend endpoints are already there.

---

## Summary of work
- **What I did:** read all authoritative docs (API_CONTRACT, PHASE_5_IMPLEMENTATION_PLAN, FOLLOWUP_PLAN, FUTURE_VERSIONS, README) and inspected the live code (AccountsPage, PhoneAssignPage, GenericAssignPage, WorkIdentityFields, SimNumberAutoFill, AssetListPage, PhonesPage, PeoplePages, App, AppLayout, hooks, types, normalize, permissions, accounts.routes, assignment.service, assignments.routes, lookups.routes, app.js, rbac).
- **Key finding:** all 5 corrections are **frontend-only**. The backend already implements work-identity on-the-fly upsert, account CRUD, generic assignment, and account-by-identifier lookup. No backend card is needed.
- **Deliverable:** this plan — 5 frontend kanban cards (FE-8…FE-12) with exact files, request/response shapes, DB writes, RBAC wiring, definitions of done, and a parallel merge order. Written to `docs/CORRECTIONS_PLAN.md`.
- **Files created:** `docs/CORRECTIONS_PLAN.md`. No code modified.
- **Issues surfaced:** (a) the SIM-asset dropdown in the current wizard is empty (no options populated) — FE-9 must populate it from the SIM Cards category; (b) the generic-assign type filter is cosmetic (ignores `draft.type`) — FE-11 fixes it; (c) `useWorkIdentities`/`GET /work-identities` become unused after FE-8 but should be kept; (d) `/phones/assign` must survive the Phones-page removal.
