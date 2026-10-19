# Implementation Plan — Next Version Wave (Inventory polish)

**Repo:** `/opt/data/handovers-sys` · **Stack:** React+TS+Vite `web/`, Express+Prisma `server/`
**Status:** Phases 0–1 (inventory, auth, RBAC, categories/custom-columns, asset CRUD, accounts) are DONE and pushed.
**This wave:** 4 user-feedback items → 3 code cards + 1 scope decision. All cards are independent and can be merged in any order.

---

## Scope summary

| # | Card | Owner | Effort |
|---|------|-------|--------|
| 1 | Fix the asset form (remove App binary, de-dupe Name vs Make/Model, auto-name phones) | frontend-developer | M |
| 2 | Dedicated Phones page (full columns + View button) | frontend-developer | M |
| 3 | Useful per-category seed custom-columns | backend-developer | S |
| 4 | **Decision:** defer work-identity CRUD + assignment/timeline backend to Phase 2 | — (no code) | — |

Cards 1–3 are independent. Card 4 is a documented recommendation, not work.

---

## Card 1 — Fix the asset form (frontend-developer)

**Goal:** Adding a phone as an asset is clean and non-redundant. The generic `Name` no longer duplicates `Make`/`Model` for phones, and `App binary` is gone from the asset form (it belongs to the assignment stage).

### Current behaviour (verified)
- `web/src/pages/assets/AssetFormPage.tsx`:
  - L15 `EMPTY_PHONE` includes `appBinary: ''`; L17 `EMPTY` includes `name: ''`.
  - L179–181 renders a **required** `Name` field in the General section.
  - L205–224 renders the "Phone details" section when `isPhone`; L213–217 renders the **App binary** select (BUSINESS/NORMAL).
  - L111–114 `reset()` seeds `appBinary`; L134–139 `onSubmit` sends `appBinary` in the phone payload.
- `web/src/pages/assets/assetSchema.ts`:
  - L35 `name: z.string().trim().min(1, 'Name is required')` — required.
  - L42–49 `phone` schema includes `appBinary: z.string()`.
- `server/src/routes/assets.routes.js`:
  - L23–32 `phoneBody` accepts `appBinary` (L31); L39 `createBody.name` is required `min(1)`.
  - `listInclude` (L81–87) selects `phoneDetail` `{ imei, model, make, color, storage }` — **no appBinary in list**, so removing it from the form has no list impact.

### Changes

**`web/src/pages/assets/assetSchema.ts`**
1. Remove `appBinary` from the `phone` object schema (L42–49).
2. Make `name` conditional: keep it required for non-phone categories, but for phone categories allow it to be auto-derived. Concretely, change `baseAssetSchema` so `name` is `z.string().trim().max(200)` (not `.min(1)`), and enforce "name required" only when the category is **not** phone-like (in the resolver, L79–89, mirroring how `imei` is conditionally required). Keep the server's `min(1)` rule satisfied by always sending a derived name (below).

**`web/src/pages/assets/AssetFormPage.tsx`**
3. Remove the **App binary** field (L213–217) and drop `appBinary` from `EMPTY_PHONE` (L15), the `reset()` payload (L111–114), and the `onSubmit` phone object (L134–139).
4. De-duplicate Name vs Make/Model for phones:
   - When `isPhone`, hide the generic `Name` field (L179–181) and show a hint instead, e.g. *"Name is auto-generated from Make + Model."*
   - In `onSubmit`, when `isPhone`, derive `name = [make, model].filter(Boolean).join(' ')`; if both are blank, fall back to `'Phone'` (or the IMEI) so the server's `min(1)` is always satisfied. Non-phone categories keep the manual `Name` field and its required validation.
5. Keep the phone section's IMEI (required), Make, Model, Color, Storage fields (L210–221) unchanged — these are the structured, searchable phone fields.

**`server/src/routes/assets.routes.js`** (optional, low-risk)
6. Leave `phoneBody.appBinary` (L31) in place — the DB column stays and the assignment stage (Phase 2) will own it. **No server change required for this card.** (If you want to harden the contract, you may remove `appBinary` from `phoneBody` and from `seed.js` phone rows, but that is not required and would orphan existing seed data — recommend leaving it.)

### Definition of done
- [ ] Adding a phone shows **no** App binary field and **no** redundant Name field; the phone section is IMEI / Make / Model / Color / Storage.
- [ ] Creating a phone with Make=`Samsung`, Model=`Galaxy A12` produces an asset named `Samsung Galaxy A12` (auto-derived).
- [ ] Editing an existing phone loads and saves correctly (name preserved, appBinary untouched).
- [ ] Non-phone categories (e.g. Laptops) still show the required `Name` field and validate it.
- [ ] `npm run build` (web) passes; `tsc` clean.

---

## Card 2 — Dedicated Phones page (frontend-developer)

**Goal:** The `/phones` page shows phone-specific columns (Model, Storage, Color, Status, Holder) **and** an explicit per-row **View** button that opens the full record.

### Recommendation: dedicated page, not a flag on AssetListPage
The generic `AssetListPage` is already parameterised by `phonesOnly` and its column set is fixed (Code, Name, Category, IMEI/Serial, Condition, Status, Holder — `web/src/pages/assets/AssetListPage.tsx` L105–106, L110–119). Overloading it further with phone columns + a View button would entangle two concerns. A small dedicated `PhonesPage` is cleaner and matches the user's ask ("Add a dedicated PhonesPage … OR enhance the list … Recommend the cleaner approach" → dedicated page).

**No backend change needed:** the list endpoint already returns `phoneDetail` with `model/make/color/storage` (`assets.routes.js` L83), and `web/src/api/normalize.ts` L110/L120 maps it to `a.phone.{model,storage,color}`. The existing IMEI search (`AssetListPage` L46–59) already works via the `imei` query param.

### Changes
1. **New file `web/src/pages/phones/PhonesPage.tsx`** — copy the structure of `AssetListPage.tsx` but:
   - Hard-code the Phones category filter (resolve by name, as `AssetListPage` L43–44 does) — no category dropdown.
   - Columns: **Code** (link), **Name**, **Model**, **Storage**, **Color**, **IMEI**, **Condition**, **Status**, **Holder**, **View**.
   - Add a **View** button in the last column per row: `<Link to={`/assets/${a.id}`}><Button size="sm" variant="secondary">View</Button></Link>` (or a "Details" link styled as a button). This is the explicit "view the whole record" affordance the user asked for.
   - Keep the search box (code/IMEI/name/serial), Condition, Status, and Holder filters, and pagination (reuse `Pagination`, `TableWrap`, `ConditionBadge`, `StatusBadge`, `EmptyState`, `ErrorState`, `Spinner` from `@/components/ui`).
   - Keep the "New asset" action (permission `assets.new`) linking to `/assets/new`.
2. **`web/src/App.tsx`** — change L31 from `<Route path="/phones" element={<AssetListPage phonesOnly />} />` to `<Route path="/phones" element={<PhonesPage />} />`; add the import.
3. **`web/src/pages/assets/AssetListPage.tsx`** — leave the `phonesOnly` prop in place (still used by nothing after this, but harmless); optionally note it is now unused. Do **not** delete it in this card to avoid churn.

### Definition of done
- [ ] `/phones` renders a dedicated page with Model, Storage, Color columns populated from `a.phone.*`.
- [ ] Every row has a **View** button that navigates to `/assets/:id` (the full record with details, photos, timeline).
- [ ] IMEI search, Condition/Status/Holder filters, and pagination all work on the new page.
- [ ] `npm run build` (web) passes; `tsc` clean.

---

## Card 3 — Useful per-category seed custom-columns (backend-developer)

**Goal:** Each category's custom columns are genuinely useful and non-duplicative. Phones keep their structured fields (IMEI, make, model, color, storage) on `PhoneDetail` — **do not** re-add them as custom columns. Add the missing useful columns the user named.

### Current seed columns (`server/prisma/seed.js`)
- **Phones** (L118–122): `purchase_date` (date), `warranty` (select), `screen_protector` (boolean). Make/model/color/storage already live on `PhoneDetail` (structured, searchable) — correct, keep.
- **SIM Cards** (L123–127): `phone_number` (string, searchable, identifier, required), `carrier` (select), `plan` (string). Missing: **status**.
- **Laptops** (L128–130): `cpu`, `ram_gb` (number), `disk`. Missing: **model**.
- **Printers** (L131–133): `model` (searchable), `pages_delivered` (number). Good.
- Chargers / Cables / Adapters / Networking / Accounts: no columns (fine for now).

### Changes (`server/prisma/seed.js`)
1. **SIM Cards** — add a `status` select column: `{ key: 'status', label: 'Status', type: 'select', options: ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] }` (matches the user's "number/carrier/status"). Seed the existing 4 SIM rows (L150–154) with `status: 'ACTIVE'`.
2. **Laptops** — add `{ key: 'model', label: 'Model', isSearchable: true }` (user: "laptops get model/CPU/RAM/disk"). Seed the existing laptop (L155) with `model: 'ThinkPad E14'`.
3. **Phones** — optionally add `{ key: 'operating_system', label: 'Operating system' }` and/or `{ key: 'battery_health', label: 'Battery health', type: 'select', options: ['Good', 'Fair', 'Poor'] }` as genuinely useful additions. **Do not** add make/model/color/storage as custom columns — they are already structured on `PhoneDetail` and searchable via IMEI/model.
4. Re-run `npm run seed` (idempotent — `upsertFields` at L21–27 upserts by `categoryId_key`, so new columns are added and existing rows updated without duplication).

### Definition of done
- [ ] `server/prisma/seed.js` re-runs idempotently; SIMs now have a `status` column, Laptops a `model` column.
- [ ] Phones do **not** gain duplicate make/model/color/storage custom columns.
- [ ] `npm run seed` completes with no errors; the new columns appear in the asset form's "Category details" block and on the asset detail page.

---

## Card 4 — Decision: defer work-identity CRUD + assignment/timeline backend

**Recommendation: DEFER to Phase 2. Do not build now.**

### Rationale
- The 4 user-feedback items are all **inventory/asset-form polish** (Cards 1–3) and ship independently with no dependency on assignment logic. They are fully testable today.
- Assignment is a distinct Phase 2 feature with its own wizard (`/phones/assign`), return flow (`/assignments/:id/return`), and timeline semantics. A "minimal" version now would be throwaway code: it needs new route files (`work-identities.routes.js`, `assignments.routes.js`), new RBAC capabilities, transaction logic, and timeline writes — a full card on its own.
- The frontend already degrades gracefully: `useAssignments` (`web/src/api/hooks.ts` L195–201) calls `/assignments` which 404s, and `AssignmentsPage` (`web/src/pages/PeoplePages.tsx` L21–23) renders a "coming in Phase 2" empty state. `WorkIdentitiesPage` (L72–95) is already **read-only functional** via the `GET /work-identities` lookup (`server/src/routes/lookups.routes.js` L57–69). Nothing is broken.
- **App binary note:** removing it from the asset form (Card 1) means it is only settable at the assignment stage. The DB column (`PhoneDetail.appBinary`, `schema.prisma` L221) stays; the Phase 2 assignment card will own it. Seed data already carries it, so no data is lost.

### What Phase 2 should contain (for the future plan, not this wave)
- `server/src/routes/work-identities.routes.js`: POST/PATCH/DELETE + capability `workIdentities:write` (currently read-only via lookups).
- `server/src/routes/assignments.routes.js`: GET list, GET :id, POST create (with `AssignmentItem` + `PhoneAssignmentDetail` + `AssignmentTimelineEntry` writes), and the return endpoint.
- Wire `/phones/assign` and `/assignments/:id/return` to real pages (currently `ComingSoon`, `App.tsx` L32/L36).

### Definition of done (for the decision)
- [ ] No new backend route files are added in this wave.
- [ ] The plan documents that work-identity CRUD + assignment/timeline backend are Phase 2, with the app-binary ownership handoff noted.

---

## Suggested merge order
1. **Card 3** (backend seed) — smallest, unblocks nothing but is safe to land first.
2. **Card 1** (asset form) — independent.
3. **Card 2** (Phones page) — independent.
4. **Card 4** — no code; record the decision in the README/plan.

All three code cards touch disjoint files (`assetSchema.ts`/`AssetFormPage.tsx` vs `PhonesPage.tsx`/`App.tsx` vs `seed.js`), so they can be developed in parallel without conflicts.
