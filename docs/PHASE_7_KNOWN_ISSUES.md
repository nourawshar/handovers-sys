# Phase 7 — Known issues & gaps (grounded in code, 2026-11-21)

Repo: `/opt/data/handovers-sys` (server/ = Express+Prisma, web/ = React+TS+Vite). Servers for testing: API `:4000`, web `:5173`
(already running, DB `handovers_dev`, seeded). Logins: `admin / Admin#12345` (ADMIN), `manager / Manager#12345`, `tl.tr1 / Leader#12345`.
Do NOT commit `server/.env`. Do NOT stop/restart the shared servers; for a backend change use a separate `PORT=3001` instance.

## Owner-reported problems (verified in code)

| # | Problem | Evidence | Fix |
|---|---|---|---|
| 1 | **Filter input + separate dropdown** (two stacked controls: a text box that filters and a native `<select>` that shows the result). Bad UX. | `SearchableSelect` in `web/src/components/ui/index.tsx` L77+ renders `<Input>` above `<Select>`. Used in 12 places: AssetListPage(2), GenericAssignPage(1), WorkIdentityFields(2), PhoneAssignPage(7). | Replace with ONE combobox: a single input showing the selected label; click/focus opens a list below; typing filters that list; keyboard up/down/enter/escape; click-outside closes; clear (x) button. Same props so all call sites keep working. Also audit every other plain `<Select>` with >15 options (employees, rooms, departments, accounts) and use the combobox. |
| 2 | **Categories page cannot add custom columns.** Page is read-only (49 lines). | `web/src/pages/settings/CategoriesSettingsPage.tsx`. Backend already has `POST/PATCH/DELETE /categories` and `POST/PATCH/DELETE` for category fields (`server/src/routes/categories.routes.js` L75-176). | Full CRUD UI: create/rename/delete category; per field: add/edit/delete custom column (label, key, type, required, options for select). ADMIN-only writes. |
| 3 | **Phone cannot be assigned without SIM/WhatsApp.** | `PhoneAssignPage.tsx` L93 `sim1Number ... min(1,'SIM 1 number is required')`; `waSchema(required)` makes WhatsApp 1 fields required. Server already accepts null (`sim1Number ?? null`). | SIM 1, WhatsApp 1 and all backup/chat fields become OPTIONAL. Add an explicit checkbox "This phone has a SIM / WhatsApp" (off => nothing required, nulls submitted). If a SIM is chosen, WhatsApp stays optional. Keep server rule "sim number == wa number when both given". |
| 4 | **Asset images missing for non-phone assignments / PDF receipt has no pictures.** | `GenericAssignPage.tsx` has no photo capture. `AssignmentReceiptPage.tsx` L80 prints only assignment photos of type FRONT/BACK. | Generic assign: add front/back/condition photo capture (reuse the phone wizard's photo picker, upload via existing `POST /assignments/:id/photos` after create). Receipt: print the assignment's photos AND each item asset's own photos (asset photos exist from "image upload on new asset"); label them per item (code + name). Backend: include item asset photos in the assignment detail response. |
| 5 | **Return does not change the asset's condition.** Employee returns a broken asset; comparison shows good->broken but the asset stays "Good". | `server/src/services/return.service.js` `applyReturn` sets item `returnCondition` + status AVAILABLE but never writes `asset.condition` (L274 only updates status/holder/room). | In the same transaction set `asset.condition = returnCondition` for the primary asset; for accessory items use each item's own returned condition when submitted (else keep). Write an UPDATED timeline entry on the asset (old->new condition). If returned condition is DAMAGED/POOR/DISPOSED, keep status AVAILABLE only for GOOD/NEW/FAIR; use a clear rule and document it (suggest: DAMAGED/DISPOSED -> status `IN_REPAIR` or `DISPOSED` if those exist in the enum, otherwise leave AVAILABLE and flag in UI). Add a unit/API test. Frontend: show the asset's new condition on the result screen. |

## Earlier requests still open (from the previous message, not yet delivered)

- Assignments list: remove the **Due** column; add an **Asset / model** column (asset name + code, and for phones the model).
- Return creates a **separate return record/row**: delivery record keeps its handover data; the return is a second record (with the updated chat counts/condition); asset timeline links to both (delivery + return) and each opens its own view.
- Return form **pre-fills from the delivery** (chargers, SIM, Bitrix, counts, backup data) — user only edits what changed. (Check first: `ReturnPage.tsx` `fromOut` already pre-fills; verify it really works for every field, incl. charger/Bitrix dropdowns whose option values are labels — likely broken, see `idFieldOptions`.)

## Process rules

- Each card works only on the files it names; commit nothing (the coach verifies, then commits).
- Run `npm run build` in `web/` and `node --check` / a live request for server changes before reporting done.
- Report exact files changed and the verification output.
