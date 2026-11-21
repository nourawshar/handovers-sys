# Phase 8 — owner requests after testing Phase 7 (2026-11-21)

Repo `/opt/data/handovers-sys` (server/ Express+Prisma, web/ React+TS+Vite). Dev API `:4000`, web `:5173` are running on `handovers_dev`;
do NOT restart them. For your own backend tests use a clean DB: `create database <yours>`, `DATABASE_URL=... npx prisma migrate deploy && npm run seed`,
`DATABASE_URL=... LOGIN_RATE_LIMIT=1000 PORT=<yours> node src/server.js`, tests with `BASE_URL=http://localhost:<yours>`. Never commit; the coach commits.
Login for manual checks: `admin / Admin#12345`. Re-read every file before editing (other cards edit nearby files). `web/src/api/types.ts`, `hooks.ts`, `normalize.ts` are shared: ADD only, never reformat.

## R1. Remove the useless "GMail-for-WhatsApp-Backup" category from the asset form
Cause: `server/prisma/seed.js` L130-131 seeds an `Accounts` (kind account) category + `GMail-for-WhatsApp-Backup`. The Accounts page uses its own `Account` table, so these categories are noise in the asset form.
Fix: seed stops creating them; the asset **create/edit form** lists only `kind=physical` categories (an existing asset that already sits in an account category still edits fine); asset list filter keeps all categories. Owner can delete the leftover category on his DB from the Categories page.

## R2. Accessories on every assignment (PC, laptop, printer, ...)
Cause: `GenericAssignPage.tsx` `AccessoryPicker` only offers root categories whose name matches `/monitor|mouse|keyboard|headphone/`; those categories exist only after the Excel import, so a fresh install shows nothing.
Fix: accessory picker = "Add accessories": pick ANY physical category (combobox, excluding Phones, SIM Cards and the category of the main asset) and tick available assets (status AVAILABLE, not held); selected accessories show as removable chips with their code, name and a condition select (default = the asset's current condition). Sends `accessoryAssetIds` + `accessoryConditions`. Seed adds the root categories `Computers`(COM), `Monitors`(MON), `Mouse`(MOU), `Keyboards`(KEY), `Headphones`(HDP) (physical) so a fresh DB works. Phone wizard keeps chargers; no change there.

## R3. Richer handover form (receipt) and assignment detail
The printed receipt (`AssignmentReceiptPage.tsx`) and the detail page show, for the main asset AND every item/accessory:
code, name, category, serial number, quantity if >1, condition at handover, asset notes, assignment notes, room (asset room / employee room), employee's department, work identity, and the category's custom columns with their labels (processor, RAM, GPU, ...; skip empty ones). Phones additionally: IMEI, make, model, colour, storage (existing phone detail). Layout: one block per item, A4 print friendly, Turkish/English labels like the current ones. Employee block shows department and room.

### API (Backend produces, Frontend consumes) — `GET /assignments/:id`
- `employee`: `{ id, fullName, department: {id,name}|null, room: {id,code}|null }`
- `items[]` (existing fields kept: id, role, isActive, conditionAtHandover, returnCondition) and `items[].asset`:
  `{ id, code, name, serialNumber, qty, notes, category:{id,name}, room:{id,code}|null, phone:{imei,make,model,color,storage}|null, customFields:[{key,label,type,value}] , photos:[...] }`
  (`customFields` = only non-empty values, label from the category field definition, boolean as true/false, sorted by field sortOrder; `photos` = the asset's own gallery photos only, i.e. `assignmentId IS NULL`.)
- `photos[]` = ONLY this assignment's photos: `{ id, type, context:'HANDOVER'|'RETURN', assetId:string|null, url, createdAt }`. `assetId` says which item the photo shows (null = whole assignment).
- `notes` (assignment notes) already exists.

## R4. Condition at handover: hybrid logic + write-back (BUG)
Bug (verified): `assignment.service.js` stores the delivery condition only on `AssignmentItem.conditionAtHandover`; `asset.condition` is never updated at delivery (return already writes back). Phone path even ignores the user's choice (`PRIMARY` uses `phoneAsset.condition`), and SIM/charger/accessory items default to `'GOOD'`.
Decision (owner asked for a hybrid): the handover condition is **prefilled from the asset's current condition** and shown with a hint "Last recorded: Fair — from return A-000012 on 12 Nov 2026" (or "from the asset record" / "set at delivery A-0000xx"), and the user can change it in a dropdown. When the user picks a different value, **the asset's own condition is updated** and an asset timeline entry is written.
Backend rules (phone AND generic paths, for the primary asset and every item: SIM1/SIM2/charger cable/adapter/accessories):
1. effective handover condition = submitted value, else the asset's CURRENT condition (never hard-coded GOOD).
2. Stored on `AssignmentItem.conditionAtHandover`.
3. If it differs from `asset.condition`: update `asset.condition` in the same transaction and write an `UPDATED` timeline entry on the asset `{ field:'condition', from, to, assignmentCode, reason:'handover' }`.
4. Phone body gets optional `phoneCondition` (primary phone); existing optional `condition` stays for SIM/charger items; accessories use `accessoryConditions`.
5. `GET /assets/:id` returns `lastConditionCheck: { condition, at, source:'created'|'delivery'|'return'|'manual', assignmentCode:string|null }` derived from the newest asset timeline entry with `snapshot.field==='condition'` (reason delivery/return), else the newest UPDATED-by-edit, else asset createdAt.
Frontend: generic wizard Details step and phone wizard Phone step: "Condition at handover" select prefilled from the chosen asset, hint line from `lastConditionCheck`, never starts empty; accessories likewise. Return form already compares against the stored handover condition.

## R5. Photos: per delivery, grouped on the asset page
Problems: the receipt prints the assignment's FRONT/BACK of every context (return photos too) plus each item asset's whole photo history; the asset detail page shows only the asset's own uploads and none of the delivery/return photos, and has no assignment context.
Rules:
- Receipt/handover form: ONLY photos of THIS assignment with `context=HANDOVER` (grouped under the item they belong to via `assetId`, else under "Whole handover"). No asset gallery photos, no return photos.
- Asset detail page: the asset's own gallery (photos with `assignmentId` null) stays under "Asset photos" (these are the inventory photos, uploadable as now). Below it a **"Photo history"** timeline, newest first, one block per assignment the asset took part in: assignment code (link/drawer), employee, assigned date -> returned date, with two rows "At handover" and "At return" showing that assignment's photos for this asset (photos with `assetId` = this asset, plus the assignment's whole-handover photos when this asset is the PRIMARY item). Empty blocks are hidden.
- Backend: `POST /assignments/:id/photos` accepts optional multipart fields `assetId` (must be an item of the assignment, else 400) and `context` (`HANDOVER` default | `RETURN`); the Photo row stores both. Return photos route stays; set `assetId` of the primary asset when known.
- `GET /assets/:id` → `photos` = gallery only (`assignmentId` null) and new `photoHistory: [{ assignmentId, assignmentCode, status, employeeName, assignedAt, returnedAt, role, handover:[{id,type,url,createdAt}], return:[...] }]`.
- Wizards (phone + generic): when uploading front/back/condition photos after create, send `assetId` of the main asset (phone/primary). Generic wizard may tag a photo to an accessory (optional).

## Cards
| Card | Owner | Files (exclusive) |
|---|---|---|
| BE-1 | backend | `server/src/services/assignment.service.js`, `server/src/routes/assignments.routes.js` (+ new `server/tests/phase8.assign.test.js`) — R3 API, R4 rules 1-4, R5 upload fields |
| BE-2 | backend | `server/src/routes/assets.routes.js`, `server/prisma/seed.js` (+ new `server/tests/phase8.assets.test.js`) — R1 seed, R2 seed categories, R4 `lastConditionCheck`, R5 asset `photos`/`photoHistory`. Does NOT edit assignment files. |
| FE-1 | frontend | `web/src/pages/assignments/GenericAssignPage.tsx`, `web/src/pages/phones/assign/PhoneAssignPage.tsx` — R2, R4 UI, R5 photo tagging |
| FE-2 | frontend | `web/src/pages/assignments/AssignmentReceiptPage.tsx`, `web/src/pages/assignments/AssignmentDetailPage.tsx`, `web/src/pages/assets/AssignmentDrawer.tsx` — R3, R5 receipt rule |
| FE-3 | frontend | `web/src/pages/assets/AssetDetailPage.tsx`, `web/src/pages/assets/AssetFormPage.tsx`, `web/src/pages/assets/AssetDrawer.tsx` — R1 form, R5 photo history |
FE cards start after the backend card(s) they depend on. Definition of done for every card: build/tests green, and a verified end-to-end proof described in your summary (curl output for backend, what you checked in the running app for frontend).
