# Phase 9 — owner requests (2026-11-21, after Phase 8 testing)

Repo `/opt/data/handovers-sys` (server/ Express+Prisma, web/ React+TS+Vite). Dev API `:4000` + web `:5173` run on `handovers_dev` — do NOT restart them.
Backend tests: own clean DB (`create database <yours>`; `DATABASE_URL=... npx prisma migrate deploy && npm run seed`), own server `DATABASE_URL=... LOGIN_RATE_LIMIT=1000 PORT=<yours> node src/server.js`,
`BASE_URL=http://localhost:<yours> node --test tests/<files>`; existing suite must stay green: `tests/api.test.js tests/return.fixes.test.js tests/assign.fixes.test.js tests/phase8.assets.test.js tests/phase8.assign.test.js`. Never commit (the coach commits). Re-read files before editing.
`web/src/api/types.ts`, `hooks.ts`, `normalize.ts` are shared: ADD only. Logins: `admin / Admin#12345`.

## P1. BUG: "Add photos" in the New asset wizard submits the form
Cause: `Button` (web/src/components/ui/index.tsx) renders `<button {...rest}>` with no default `type`, so inside a `<form>` it is a submit button. Fix: default `type="button"`; every real submit button must pass `type="submit"` explicitly (audit all `<form>` pages: LoginPage, EmployeesPage, UsersSettingsPage, CategoriesSettingsPage, AssetFormPage and any modal forms) so nothing else breaks (Enter-to-submit on login must still work).

## P2. Sorting and filters everywhere
Convention (backend): list endpoints accept `sort=<key>&order=asc|desc`, whitelist per endpoint, unknown key => 400 VALIDATION_ERROR, default stays "newest first" where it makes sense.
| Endpoint | sort keys | default |
|---|---|---|
| GET /accounts | createdAt, identifier, email, kind, isActive | createdAt desc |
| GET /assets | createdAt, code, name, condition, status, category | createdAt desc |
| GET /assignments | assignedAt, assignmentCode, status, type, employee | assignedAt desc |
| GET /employees | fullName, createdAt, department, room | fullName asc (keep) |
| GET /users | createdAt, username, fullName, role | createdAt desc |
| GET /audit-logs | createdAt, action, actor | createdAt desc |
Frontend: a reusable `SortHeader` (new file `web/src/components/SortHeader.tsx`: clickable `<th>` with ▲▼ indicator, `useSort(defaultKey, defaultOrder)` hook returning `{sort, order, toggle}`; keep state in the URL query like AssetListPage does so back/forward keep it). Apply to every table. Add sensible missing filters: Accounts (kind, active, backup in use), Assets (already), Employees (department, room), Assignments (employee/q, type, status, date range assigned from/to), Users (role, active), Logs (action, actor, date range). Mobile: filters wrap.

## P3. Assignment wizard step 1 field order
Both wizards (phone + generic): Employee (real name) -> Department -> then, only when the department is Call Center: Work identity name -> Room. Today the work identity name sits ABOVE Department. Fix `WorkIdentityFields.tsx` order and the Employee field placement in `PhoneAssignPage.tsx` / `GenericAssignPage.tsx`; validation messages must still point to the right field.

## P4. Accounts: one concept, no duplicates
Facts: WhatsApp accounts are created automatically by the assignment (kind WHATSAPP, identifier = SIM number) to stop the same number being used twice (assignment.service.js) — the user never types them. The phone wizard's "Backup Gmail" dropdown today lists only `kind=GMAIL AND isWhatsAppBackup=true`, so a normal mail account never appears.
Decision: **an email account is just an email account.** Any ACTIVE `GMAIL` account (Accounts page) is selectable as WhatsApp backup in the wizard; the "WhatsApp backup" checkbox and the WHATSAPP kind disappear from the Accounts create/edit form (the API still accepts them for the import and old data; `isWhatsAppBackup` column stays, just unused by the UI; WHATSAPP accounts stay listed read-only under a "WhatsApp (auto)" filter). Rename the kind label GMAIL -> "Email / Gmail". Wizard dropdown: searchable, shows the email, hint "Not in the list? Add the email on the Accounts page first". The seed's old category `GMail-for-WhatsApp-Backup` has nothing to do with accounts (already hidden from the asset form).
Nothing that relies on this may break: the dual-use check for WhatsApp numbers, the return form's backup email comparison, the Excel import, the receipt.

## P5. Return record = a second record, unreturned items, condition history, return PDF
### P5a. Return record (backend, new endpoints in returns.routes.js / return.service.js)
- `GET /assignments/:id/return-record` (404 if the assignment was never returned; same room scope as detail). Payload:
```
{ id, assignmentId, assignmentCode, returnedAt, returnedBy:{id,fullName}, returnCondition, returnNotes,
  employee:{id,fullName,department:{id,name}|null,room:{id,code}|null}, workIdentity:{id,name}|null,
  items:[{ assetId, code, name, role, serialNumber, conditionAtHandover, returnCondition, returned:boolean }],
  comparison:[{fieldKey,label,valueAtHandover,valueAtReturn,isDiscrepancy,severity}], hasDiscrepancies,
  unreturned:[{ kind:'ASSET'|'ACCOUNT', assetId|null, accountId|null, code, name, role, status:'OPEN'|'RESOLVED', resolution:null|{kind:'RETURNED'|'LOST', at, by:{id,fullName}, notes, condition} }],
  photos:{ handover:[{id,type,assetId,url}], return:[{id,type,assetId,url}] } }
```
- Unreturned derivation (single rule, exported helper `getUnreturned(assignmentIds)` from return.service.js, reused by the assignments list): for an assignment with status RETURNED: every involved ASSET whose status is still ASSIGNED and `currentHolderEmployeeId` = the assignment's employee and that has no active AssignmentItem elsewhere => OPEN; every ACCOUNT (Bitrix) with `currentAssignmentId` = the assignment => OPEN. A resolution is recorded as an assignment timeline entry `eventType NOTE` with `snapshot {kind:'UNRETURNED_RESOLVED', assetId|accountId, resolution, condition, notes}`; an item with such an entry is RESOLVED (so history stays visible).
- `GET /assignments/:id/unreturned` -> `{ data:[...same shape as above...] }`.
- `POST /assignments/:id/unreturned/resolve` (ADMIN) body `{ assetId?:uuid, accountId?:uuid, resolution:'RETURNED'|'LOST', condition?:AssetCondition, notes?:string }` (exactly one of assetId/accountId; must currently be OPEN else 409). RETURNED: asset -> status AVAILABLE, holder null, condition set if given (+ UPDATED asset timeline entry from/to, reason 'return-resolved'); account -> currentAssignmentId null. LOST: asset -> status LOST if the AssetStatus enum has it, otherwise DISPOSED with a note; account -> isActive false and unbound. Always: NOTE timeline entry on the assignment (snapshot above), audit row.
- Return list summary (done in BE-A2, using the helper): `GET /assignments` rows get `returnRecord: { returnedAt, hasDiscrepancies, unreturnedOpen:number } | null`.
### P5b. Asset "Condition over handovers" (backend `GET /assets/:id/handover-history`, owned by BE-A2)
```
{ asset:{id,code,name,condition}, current:{condition,at,source,assignmentCode}|null,
  rows:[{ assignmentId, assignmentCode, status, role, employee:{id,fullName}, assignedAt, returnedAt|null,
          conditionAtHandover, returnCondition|null, change:'same'|'worse'|'better'|'unknown', returnNotes|null,
          discrepancyCount:number, unreturnedOpen:boolean, photoCount:number }] }   // newest first, same room scope as photoHistory
```
`change` ranks NEW > GOOD > FAIR > POOR > DAMAGED > DISPOSED comparing conditionAtHandover vs returnCondition (unknown when not returned).
### P5c. Frontend
- Assignments list shows TWO rows for a returned assignment: the delivery row (as today) and, directly under it, a "Return" row (indent/arrow, type badge `Return`, returned date, discrepancy badge, open-unreturned badge) linking to `/assignments/:id/return-record`. Active assignments keep one row. Applies the sorting from P2 (the return row follows its delivery row).
- New page `/assignments/:id/return-record` (read-only): header (code, employee, dept, room, returnedBy, date), items table (handover vs return condition, returned yes/no), comparison table with severity, notes, photos at return vs handover, Unreturned items panel with a **Mark as returned** / **Mark as lost** action per OPEN item (condition select + notes modal) and RESOLVED history, button **Print return receipt**, link back to the delivery assignment.
- New printable `/assignments/:id/return-receipt` ("İade Belgesi / Return Receipt"), same A4 style and bilingual labels as the handover receipt: employee/department/room, item list with condition at handover -> at return, discrepancies, unreturned items (listed as owed), return notes, only this return's RETURN photos, signature boxes (Teslim Alan / Received by IT, Teslim Eden / Returned by employee). Print buttons on the return-record page, the Return complete screen and the assignment detail.
- AssignmentDetailPage: link "View return record" when returned + unreturned warning badge.
- Asset detail: a third tab **Condition over handovers** (query `?tab=conditions`, no new route) showing `current` summary line then a table (one row per assignment: code, employee, assigned->returned dates, condition at handover, condition at return with coloured arrow worse=red/better=green, notes, discrepancies, unreturned badge, photos count); clicking a row opens `/assignments/:id`; rows where `change==='worse'` are highlighted; empty state when never assigned.

## P6. Dashboard (design only now)
Owner is "thinking" about a nicer dashboard: cards, filtering assets by employee, global search. NOT part of these cards; coach proposes a design after Phase 9 ships.

## Cards
| Card | Owner | Files (exclusive) | Depends on |
|---|---|---|---|
| BE-R | backend | `server/src/routes/returns.routes.js`, `server/src/services/return.service.js`, new `server/tests/phase9.return.test.js` | — |
| BE-A1 | backend | `server/src/routes/accounts.routes.js`, `employees.routes.js`, `users.routes.js`, `audit-logs.routes.js`, new `server/tests/phase9.sort.test.js` | — |
| BE-A2 | backend | `server/src/routes/assets.routes.js`, `server/src/routes/assignments.routes.js`, new `server/tests/phase9.assets.test.js` | BE-R |
| FE-1 | frontend | `web/src/components/ui/index.tsx` (Button only), `web/src/pages/assignments/WorkIdentityFields.tsx`, `web/src/pages/phones/assign/PhoneAssignPage.tsx`, `web/src/pages/assignments/GenericAssignPage.tsx`, any other page ONLY to add `type="submit"` where the audit needs it | — |
| FE-2 | frontend | new `web/src/components/SortHeader.tsx`, `web/src/pages/AccountsPage.tsx` | BE-A1, FE-1 |
| FE-3 | frontend | `web/src/pages/assets/AssetListPage.tsx`, `web/src/pages/EmployeesPage.tsx`, `web/src/pages/settings/UsersSettingsPage.tsx`, `web/src/pages/settings/LogsPage.tsx` | BE-A1, BE-A2, FE-2 |
| FE-4 | frontend | `web/src/pages/assignments/ReturnPage.tsx`, `AssignmentDetailPage.tsx`, new `ReturnRecordPage.tsx`, new `ReturnReceiptPage.tsx`, `web/src/App.tsx`, `web/src/pages/PeoplePages.tsx` (AssignmentsPage only) | BE-R, BE-A2, FE-2 |
| FE-5 | frontend | `web/src/pages/assets/AssetDetailPage.tsx` | BE-A2 |
Definition of done: build/tests green + an end-to-end proof in the summary (curl output for backend; what was checked in the running app for frontend).
