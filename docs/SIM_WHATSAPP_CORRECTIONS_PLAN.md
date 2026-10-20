# SIM/WhatsApp & Departments Corrections Plan — 6 user-reported fixes

**Repo:** `/opt/data/handovers-sys` · **Stack:** React+TS+Vite `web/`, Express+Prisma `server/`
**Status:** This wave redoes 6 things the user flagged as wrong/overcomplicated.

## Cards (2 backend + 2 frontend; merge order BE-9 → FE-13 → FE-14)
- **BE-9** (backend): assets list includes `customFields` (fix SIM-number dots bug) + departments full CRUD.
- **FE-13** (frontend): SIM asset form hides generic fields + work-name only for call-center + remove redundant Business WhatsApp input.
- **FE-14** (frontend): SIM/WhatsApp step = SIM dropdown + variant + Gmail dropdown (puzzle assembly) + departments CRUD UI.

## The 6 fixes
1. **SIM asset form** — hide generic fields (Name/Serial/Condition/Quantity/Location/Notes) for SIM Cards; show only phone_number/carrier/plan/status. Auto-derive name from number.
2. **Work-name only for call-center** — in BOTH wizards, work-name input appears only when department === CALLCENTER; otherwise use real employee name (send workIdentity: undefined).
3. **Departments CRUD** — add POST/PATCH/DELETE /departments (Admin, people:write) + Departments management UI.
4. **Remove redundant Business WhatsApp Yes/No** — keep only App variant (Business/Normal); derive wa1Business/wa2Business from appVariant.
5. **Dots bug** — assets LIST endpoint (assets.routes.js listInclude L81-87) doesn't include customValues, so simNumber() reads undefined. Add customValues + shape into customFields in the list handler.
6. **Accounts model simplification** — Accounts page stores only Bitrix + Gmail (with passwords). WhatsApp is assembled at assignment time like a puzzle: SIM dropdown (from SIM assets) → fills number → App variant → backup Gmail dropdown (from Gmail accounts) → chat counts + backup date. Same for SIM 2 if checked. Pick a different Gmail each assignment.

## Key files
- **BE-9**: server/src/routes/assets.routes.js (add customValues to listInclude + shape customFields), server/src/routes/lookups.routes.js (remove GET /departments), NEW server/src/routes/departments.routes.js, server/src/app.js (mount).
- **FE-13**: web/src/pages/assets/AssetFormPage.tsx (isSim flag, hide General section, relax resolver), web/src/pages/assignments/WorkIdentityFields.tsx (conditional work-name), web/src/pages/phones/assign/PhoneAssignPage.tsx (remove Business WhatsApp select, derive business from variant).
- **FE-14**: web/src/pages/phones/assign/PhoneAssignPage.tsx (puzzle assembly — mostly already built, dots fix makes it work), web/src/pages/PeoplePages.tsx (DepartmentsPage), web/src/App.tsx (route), web/src/components/layout/AppLayout.tsx (nav), web/src/lib/permissions.ts (departments RouteKey), web/src/api/hooks.ts + types.ts.

## Definitions of done
- **BE-9**: GET /assets list items include customFields with phone_number (no dots, no "SIM1 number required"); departments POST/PATCH/DELETE round-trip, dup name 409, unknown parent 400, delete blocked 409 when referenced; GET /departments keeps legacy shape; server boots.
- **FE-13**: SIM form shows only Category + SIM columns; non-call-center shows no work-name in either wizard; one Business/Normal control per WhatsApp; build + tsc clean.
- **FE-14**: SIM/WhatsApp step is pure puzzle (SIM dropdown → number → variant → Gmail dropdown → chat counts + backup date; SIM 2 when checked); Admin can create/edit/delete departments; delete 409 surfaced; build + tsc clean.

## Merge order
BE-9 → FE-13 → FE-14. FE-13 and FE-14 both touch PhoneAssignPage.tsx — do them in sequence, not parallel.

## Future notes
- wa1Business/wa2Business derived from appVariant (schema unchanged).
- SIM number is the single source for sim1Number + wa1PhoneNumber.
- Backup Gmail dropdown replaces free-text email.
- Departments have no soft-delete flag — delete is block-only (409).
- Accounts page stores only Bitrix + Gmail going forward; WhatsApp defined at assignment time.
