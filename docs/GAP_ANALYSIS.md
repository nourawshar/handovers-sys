# Spec-vs-Code Gap Analysis (Phase 7, 2026-11-21)

Sources: README v1.0 (§3, §5, §6, §7, §9), docs/PHASE_7_KNOWN_ISSUES.md, docs/FUTURE_VERSIONS.md vs. `server/src` and `web/src`.
Method: every route in `server/src/routes/*.js` was cross-checked against `web/src/api/hooks.ts` and every hook against its page usage.
Status: DONE / PARTIAL / MISSING. Open items already in PHASE_7_KNOWN_ISSUES.md are referenced as KI-n, not re-described.

## 1. Requirements -> status -> evidence

| Req | Status | Evidence / gap |
|---|---|---|
| A-1 category CRUD | PARTIAL | BE done: `categories.routes.js:75,91,112`. FE read-only: `CategoriesSettingsPage.tsx`; no save/delete hooks in `hooks.ts` (KI-2). |
| A-2 custom columns | PARTIAL | BE done: `categories.routes.js:146,162,176`. FE has only `useCategoryFields` (read, `hooks.ts:41`); no designer UI (KI-2). |
| A-3 auto asset code + IMEI search | DONE | `assets.routes.js:24,70,147`. |
| A-4 condition / photos | PARTIAL | Condition + photos done (`assets.routes.js:18`, `AssetDetailPage.tsx:29`). Quantity MISSING: no `quantity` field in `schema.prisma` or asset forms. Photo delete: BE `photos.routes.js:36` exists, no FE caller. |
| A-5 compatible columns only | PARTIAL | Fields are per category (`AssetFormPage` via `useCategoryFields`). The assignment-side "compatible columns" check was not found in `GenericAssignPage`. |
| A-6 search / filter | PARTIAL | q, imei, condition, holderId done (`assets.routes.js:69-76`, `AssetListPage.tsx:65`). Room filter exists in BE (`:137`); check the FE room filter. |
| A-7 accounts first-class | DONE | `accounts.routes.js` (encrypt + audit `:98,118`), `AccountsPage.tsx`, decrypt `hooks.ts:188`. `/accounts/:id` detail page not built (list-only). |
| B (phone assignment, all fields) | PARTIAL | `PhoneAssignPage.tsx` + `POST /assignments/phone` (`assignment.service.js`). SIM/WhatsApp wrongly required (KI-3). Draft/resume (§6.5) MISSING. |
| B photos front/back | DONE | `PhoneAssignPage.tsx:426-430` (raw `api.upload`, hook `useUploadAssignmentPhotos` is unused). |
| C return form + comparison | PARTIAL | `returns.routes.js:42,92`, `ReturnPage.tsx:119,144`. Gaps: KI-5 (condition not written back), return is not a separate viewable record, pre-fill of charger/Bitrix dropdowns suspect (KI "Earlier requests"). Discrepancy acknowledgement: no ack field found. |
| C release to Available | PARTIAL | `return.service.js:268-278`: missing items stay ASSIGNED (by design), condition not applied (KI-5). |
| D assignment timeline | DONE | `returns.routes.js:149`, `AssignmentDetailPage.tsx`. |
| D asset timeline | DONE | `assets.routes.js` + `hooks.ts:167`, `AssetDetailPage.tsx`. |
| D employee history | PARTIAL | Delivered inside `GET /employees/:id` (`EmployeeDetailPage.tsx:64`). Dedicated `/employees/:id/timeline` (§6.7) MISSING (acceptable, see P3). |
| D append-only timeline | DONE | No update/delete route for timeline entries. |
| E Admin / Manager / TL roles | DONE | `middleware/rbac.js:12-27`, `roomScope`; `permissions.ts`. CALL_CENTER_MANAGER role added beyond spec. |
| E-credential masking | DONE | `accounts.routes.js:14,32`. |
| F who-has-what | DONE | `reports.routes.js:52`, `ReportsPage.tsx`. |
| F condition | DONE | `reports.routes.js:63`. |
| F backup staleness | DONE | `report.service.js:11,173` (7-day default). |
| F outstanding assignments | DONE | `reports.routes.js:85`. |
| F room composition | DONE | `reports.routes.js:96`. |
| F export CSV/Excel | DONE | `reports.routes.js:107-131` (exceljs), `hooks.ts:618`. |
| G laptops/printers/SIM/equipment | PARTIAL | One generic form `GenericAssignPage.tsx` -> `POST /assignments/generic`. No photo capture (KI-4). No per-category inventory pages (`/laptops` etc.). |
| §7 `/phones` list | MISSING | No route in `App.tsx`; phones are only reachable through `/assets`. |
| §7 `/rooms` management | PARTIAL | `RoomsPage` CRUD works. `GET /rooms/:id` has no caller (`useRoom` unused). |
| §7 `/work-identities` page | MISSING | No page, no write BE (deferred, FUTURE_VERSIONS §1). `useWorkIdentities` is unused (wizard sends inline `workIdentity`). |
| §7 `/accounts/:id` | MISSING | Detail + decrypt are inline in `AccountsPage`. |
| §6.5 `PATCH /assignments/:id` | MISSING | No BE route; no FE. |
| §6.5 `GET /assignments/draft/:id` | MISSING | BE and FE. The wizard keeps its state client-side only. |
| §6.5 `POST /assignments/:id/activate` | PARTIAL | BE `assignments.routes.js:323`; FE never calls it (wizard creates and activates in one call). |
| §6.4 `POST /accounts/:id/photos` | PARTIAL | BE `accounts.routes.js:163`; no FE. |
| §6.4 account/asset DELETE | DONE | Beyond spec; used by FE. |
| §4.1 security, audit | DONE | `audit.service.js`, `LogsPage.tsx`. |

## 2. Unwired backend endpoints (no web caller)

- `POST|PATCH|DELETE /asset-categories[/:id]` and `POST|PATCH|DELETE /asset-categories/fields/:fieldId` (`categories.routes.js:75-176`) -> categories page is read-only.
- `POST /asset-categories/:id/fields` (`:146`) -> same.
- `GET /rooms/:id` (`rooms.routes.js:73`) -> `useRoom` hook exists, no page uses it.
- `POST /assignments/:id/activate` (`assignments.routes.js:323`) -> never called.
- `POST /accounts/:id/photos` (`accounts.routes.js:163`).
- `DELETE /photos/:id` (`photos.routes.js:36`) -> no delete-photo control anywhere.
- `GET /work-identities` (`lookups.routes.js:19`) -> `useWorkIdentities` defined but unused.
- Hook unused by any page: `useUploadAssignmentPhotos` (`hooks.ts:473`); `PhoneAssignPage` bypasses it, and `GenericAssignPage` never uploads.

Reverse check (FE calls with no BE route): none found. All paths in `hooks.ts` resolve to a mounted route. `useDeleteUser` deliberately uses `PATCH /users/:id {isActive:false}` because no `DELETE /users/:id` exists (`hooks.ts:550`).

## 3. Prioritised backlog

P1 (blocks daily use, or an owner request)
1. Category + custom-column designer UI (FE; hooks + `CategoriesSettingsPage.tsx`). BE ready. KI-2.
2. Make SIM / WhatsApp optional in the phone wizard (FE `PhoneAssignPage.tsx`). KI-3.
3. Return must write `asset.condition` (+ UPDATED timeline entry, status rule) (BE `return.service.js`), and show it on the result screen (FE `ReturnPage.tsx`). KI-5.
4. Separate return record view, with the asset timeline linking to both delivery and return (BE `returns.routes.js` + FE `AssignmentDetailPage.tsx`). Also verify the return form pre-fill of charger/Bitrix options (FE `ReturnPage.tsx` `idFieldOptions`).
5. Single combobox replacing the `SearchableSelect` input+select (FE `components/ui/index.tsx`). KI-1.

P2 (spec gap, workaround exists)
6. Generic assign: photo capture, and receipt prints assignment + item asset photos (FE `GenericAssignPage.tsx`, `AssignmentReceiptPage.tsx`; BE include asset photos in the detail response, `assignments.routes.js`). KI-4.
7. Assignments list: drop Due column, add Asset/model column (FE `PeoplePages.tsx`; BE add the asset name/model to the list select).
8. Asset photo delete control (FE `AssetDetailPage.tsx`, wire `DELETE /photos/:id`).
9. Asset `quantity` for consumables (BE `schema.prisma` + `assets.routes.js` migration; FE `assetSchema.ts`, `AssetFormPage.tsx`).
10. Work-identity CRUD + `/work-identities` page (BE new `work-identities.routes.js`; FE new page). Deferred in FUTURE_VERSIONS §1; promote it.
11. Per-category inventory entry points (`/phones`, `/laptops`, `/printers`, `/sims`) as category-preset links to the asset list (FE `App.tsx`, `AppLayout.tsx`, `AssetListPage.tsx`).
12. Return discrepancy acknowledgement (§3.3 "must be acknowledged") (BE `return.service.js` ack flag; FE `ReturnPage.tsx`).

P3 (nice to have / spec drift)
13. `/accounts/:id` detail page and account proof-photo upload (FE `AccountsPage.tsx`; BE ready).
14. `/employees/:id/timeline` endpoint (BE) - history already embedded in `GET /employees/:id`; amend README/contract instead if kept.
15. Draft assignment save/resume and `PATCH /assignments/:id` (BE new; FE wizard). Decide whether to drop from the spec or build.
16. Sofia reassignment flow (`REASSIGNED` timeline event, FUTURE_VERSIONS §2) (BE `assignment.service.js`; FE action on the detail page).
17. Use `GET /rooms/:id` for a room detail page (composition and seats) (FE `PeoplePages.tsx`).
18. Update README §3/§6/§7/§9 to match the shipped scope: CALL_CENTER_MANAGER role, generic `/assignments/generic`, `/departments`, `/settings/logs`, `/audit-logs`, no `/phones`.

## 4. Suggested card split (P1 + P2, disjoint files)

| Card | Items | Owns (files) | Side |
|---|---|---|---|
| C1 Categories designer | 1 | `web/src/pages/settings/CategoriesSettingsPage.tsx`, add category hooks at the end of `web/src/api/hooks.ts` | FE |
| C2 Combobox | 5 | `web/src/components/ui/index.tsx` (+ the native `<Select>` swaps in `AssetListPage.tsx`, `PeoplePages.tsx`, `EmployeesPage.tsx`, `AccountsPage.tsx` only after C1/C3 land) | FE |
| C3 Phone wizard optional SIM/WA | 2 | `web/src/pages/phones/assign/PhoneAssignPage.tsx` | FE |
| C4 Return BE | 3 (BE), 12 (BE), 4 (BE) | `server/src/services/return.service.js`, `server/src/routes/returns.routes.js`, `server/prisma/schema.prisma` (ack flag only), return tests | BE |
| C5 Return FE | 3 (FE), 4 (FE), 12 (FE) | `web/src/pages/assignments/ReturnPage.tsx`, `web/src/pages/assignments/AssignmentDetailPage.tsx`. Depends on C4. | FE |
| C6 Generic assign + receipt photos | 6 | `web/src/pages/assignments/GenericAssignPage.tsx`, `web/src/pages/assignments/AssignmentReceiptPage.tsx`, `server/src/routes/assignments.routes.js` (photo include in the detail `include`) | FE+BE |
| C7 Assignments list | 7 | `web/src/pages/PeoplePages.tsx` (`AssignmentsPage` only) + the list select in `server/src/routes/assignments.routes.js`. Overlaps C6 on `assignments.routes.js`: run after C6. | FE+BE |
| C8 Asset photo delete + quantity | 8, 9 | `web/src/pages/assets/AssetDetailPage.tsx`, `AssetFormPage.tsx`, `assetSchema.ts`, `server/src/routes/assets.routes.js`, `server/prisma/schema.prisma` (quantity). Overlaps C4 on `schema.prisma`: serialise migrations. | FE+BE |
| C9 Work identities | 10 | new `server/src/routes/work-identities.routes.js`, mount line in `server/src/app.js`, new `web/src/pages/WorkIdentitiesPage.tsx` | FE+BE |
| C10 Category entry points | 11 | `web/src/App.tsx`, `web/src/components/layout/AppLayout.tsx`, `web/src/pages/assets/AssetListPage.tsx`. Conflicts with C2 on `AssetListPage.tsx`: run after C2. | FE |

Hotspots: `web/src/api/hooks.ts` (C1, C9 append only), `server/prisma/schema.prisma` (C4, C8), `server/src/routes/assignments.routes.js` (C6, C7), `AssetListPage.tsx` (C2, C10). Sequence those pairs; the rest can run in parallel.

Unverified: whether `AssetListPage.tsx` exposes a room filter, whether `GenericAssignPage.tsx` enforces category-compatible fields (A-5), and whether the return flow stores any discrepancy acknowledgement. Check these before starting P1 item 4 and P2 items 11-12.
