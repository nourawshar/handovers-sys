# IT Asset Management & Device Handover System — System Design Document

**Version:** 1.0
**Status:** Reviewed / Implementation-ready
**Author:** System Architect (on behalf of Nour, IT Administrator)
**Audience:** Engineering, IT department, clinic group stakeholders

---

## 1. Executive Summary

This document specifies a full-stack web application to bring complete visibility and control to the IT department of a Turkish clinic group. The system has three core jobs, in priority order:

1. **Inventory** — a single database of every IT asset (sims, phones, laptops, chargers, accounts, printers, networking gear and more), labelled, quantified, and tracked by condition.
2. **Assignment & handover** — assign assets (primarily call-center phones) to named employees, recording every bundled component (SIM cards, WhatsApp accounts + backup emails, Bitrix CRM accounts, chargers, photos, chat counts, backup sizes).
3. **Timeline & audit** — a full, searchable history per item and per assignment, including a return/handback flow that compares device state when handed out versus handed back.

The system is built with **React (frontend) + Node.js/Express (backend) + PostgreSQL + Prisma ORM**, with JWT authentication and local-disk image storage (self-managed). It models assets generically so new categories and custom columns can be added with zero schema changes, then captures phone-specific richness through a dedicated phone-detail model.

The deliverable is a phased roadmap that lands a working MVP for **call-center phone assignment** (the highest-value workflow) within roughly 6–8 weeks, then expands to full inventory, other assignment types, and reporting.

---

## 2. Goals & Non-Goals

### 2.1 Goals (in scope)

- **G1 — Full inventory:** Register all assets/categories, quantities, condition, labels (asset codes), and photos.
- **G2 — Phone assignment (`sofia`-style):** Assign a physical phone to a real employee with complete detail: IMEI, both SIMs, both WhatsApp accounts (business/normal), backup mail + backup condition + chat counts for each, app version, Bitrix account, front/back photos, charger cable and adapter.
- **G3 — Return / handback:** Compare out-state vs return-state and record differences (chat counts, condition, SIMs, accounts, photos).
- **G4 — Reassignment:** After return, a device can be assigned to another employee (new work identity) with a fresh timeline entry.
- **G5 — Item-level timelines:** Every asset has its own chronological, searchable history.
- **G6 — Roles & permissions:** Admin / Manager / Team Leader with distinct capabilities (see §9).
- **G7 — Reporting:** Who-has-what, device condition, outstanding assignments, backup staleness, room/team composition.
- **G8 — Extensibility:** Generic asset model that supports the full category list out of the box.

### 2.2 Non-goals (explicitly out of scope for MVP, listed for clarity)

- **NG1 — Helpdesk / ticketing.** This system records IT assets, not support tickets. No SLA, escalation, or ticket queue.
- **NG2 — Procurement / purchase orders / finance integration.** We track laptops, PCs and parts *after* they are received. No PO creation, vendor management, or cost tracking.
- **NG3 — Telephony integration.** We do not dial, route, or manage calls against the SIMs. SIMs are tracked as assets only.
- **NG4 — Active Directory / SSO.** Authentication is local to this app (JWT). No LDAP/Entra ID sync in MVP.
- **NG5 — Auto WhatsApp/Google backup.** We record backup *state* (date, size); we do not trigger or restore backups.
- **NG6 — Mobile client.** Web-only in MVP.
- **NG7 — Multi-clinic/multi-entity isolation beyond teams/rooms.** The clinic group is modelled within one instance; cross-branch isolation can be added later.

---

## 3. Functional Requirements

### 3.1 Module A — Inventory & Assets

| ID | Requirement |
|----|-------------|
| A-1 | Admin can create, edit, deactivate, and delete asset categories. |
| A-2 | Each category can define its own **custom columns** (e.g., Phone → IMEI, color, serial, storage; Laptop → CPU, RAM, disk; Printer → model, pages delivered). |
| A-3 | Each asset has a unique **asset code / label** (auto-generated, e.g., `PHN-000123`) and/or IMEI search. |
| A-4 | Asset attributes include **condition** (New, Good, Fair, Poor, Damaged, Disposed), quantity (for consumables/bulk items), and one or more **photos**. |
| A-5 | Assets belong to a category; assignments link to a category's **compatible columns** only. |
| A-6 | Search and filter across all assets by code, IMEI, name, category, condition, location/room, and current holder. |
| A-7 | **Accounts** are a first-class category (Gmail, WhatsApp, Bitrix) with subcategory `GMail-for-WhatsApp-Backup`. Account records store credentials (email + password) and which device/assignment uses them. |

### 3.2 Module B — Phone Assignment (highest priority)

The call-center phone assignment form is the core workflow. When assigning a phone to a real employee it must capture:

- **Employee:** real full name (select from Employees).
- **Work identity:** dropdown of work identities on the department/room (e.g., `sofia`, `ceo2`, room seats). Work identity is a label assigned to a phone; it can change between assignments.
- **Phone:** by IMEI or asset code (dropdown/search).
- **SIM card 1 (main):** the main phone number.
  - **Main WhatsApp account:** which WhatsApp account (business/normal) is active for the main number.
  - **Main WhatsApp backup email** *(for backup)*, e.g., `class3447@gmail.com`.
  - **Main backup condition:** date + storage used (e.g., "last backup 17/5/2026, 12 GB of 15 GB").
  - **Main chat counts:** two inputs — normal messages and archived messages.
  - **App version:** the application used for the main number (business or normal).
- **SIM card 2:** secondary number (optional).
  - Secondary WhatsApp account, backup email, backup condition, chat counts (same sub-fields as main).
- **Photos:** front and back of the phone (upload).
- **Charger cable:** dropdown selecting from charger-cable assets (with condition).
- **Charger adapter:** dropdown selecting from adapter assets.
- **Bitrix account** used in the phone (from Accounts table — email + password, stored centrally).

**Concrete validated example** (mirrors the required model):

> Work identity `sofia` holds a **Samsung Galaxy A12**. SIM 1 (main) = `905369700889`. WhatsApp main = **business**. Backup mail = `class3447@gmail.com`. Last backup `17/5/2026`, **12 GB of 15 GB**. Chat counts (normal + archived) recorded. Secondary WhatsApp fields recorded likewise. Charger cable and adapter selected from inventory with conditions. Bitrix account attached. Front + back photos uploaded.

### 3.3 Module C — Return / Handback

- A **Return form** is initiated against an open (active) assignment.
- The form pre-fills the **out-state** (snapshot taken at assignment) and asks for the **return-state** for every comparable field: chat counts (normal/archived) for each WhatsApp, backup date/size, phone condition, SIMs present, Bitrix account, charger cable & adapter present, photos.
- The system performs a **side-by-side comparison** and flags every difference (e.g., `Chat count normal: 4,500 → 5,120`, `Backup size: 12 GB → 8 GB`).
- Any **missing/changed SIM, account, or charger** is flagged as a discrepancy that must be acknowledged.
- On completion the assignment moves to **Returned** and the items are released back to Available.

### 3.4 Module D — Timelines & History

- Every **assignment** produces one timeline entry per item it includes, storing all detail.
- Every **asset** has a scrollable, searchable timeline of every assignment/return/update it participated in.
- Every **employee** has a history of all devices they held.
- Timeline entries are immutable after creation (append-only) and carry actor + timestamp.

### 3.5 Module E — Roles & Permissions

- **Admin:** full CRUD on everything, category/column design, user/role management, all rules.
- **Manager:** read-only visibility across all rooms and teams; can view but not edit; can export reports.
- **Team Leader:** read-only within their own room (e.g., TR1 staff and their assignments); no cross-room access; no edit.
- (See §9 matrix.)

### 3.6 Module F — Reporting

- **Who-has-what:** current holder + device for any scope (team, room, category).
- **Condition report:** asset condition distribution per category.
- **Backup staleness:** phones whose last WhatsApp backup date is beyond a configurable threshold (**assumption:** warn if > 7 days).
- **Outstanding assignments:** open assignments older than N days (returns due — clinic policy is 1 month).
- **Room/team composition:** employees and work identities per room.
- **Excel/CSV export** of any report (Manager + Admin).

### 3.7 Module G — Other Assignment Types

Beyond phones, provide well-designed assignment forms for **laptops, printers, SIMs, and general equipment**, reusing the same lifecycle (Assign → Track → Return). Fields derive from each category's compatible columns (e.g., Laptop → model, serial, condition; SIM → number, carrier, status). All create timeline entries identically to phones.

---

## 4. Non-Functional Requirements

### 4.1 Security

- **Authentication:** JWT (access token, short-lived ~15 min) + refresh token (rotating, ~7 days) stored in HttpOnly cookies. Argon2/bcrypt password hashing.
- **Authorization:** role-based checks enforced **server-side on every endpoint** (never client-side only).
- **Transport:** all traffic over HTTPS/TLS.
- **Credentials in Accounts table:** stored encrypted-at-rest (AES-256-GCM) with a server-side key; only Admin can decrypt on explicit view.
- **Input validation:** server-side validation (Zod schemas) for all payloads; prepared statements via Prisma.
- **Rate limiting,** request logging, and security headers (CSP, HSTS, X-Frame-Options).
- **File uploads:** only images (jpeg/png/webp), size-limited, malware-scanning optional, stored outside the web root.

### 4.2 Performance

- Target p95 API latency < 300 ms for reads and < 400 ms for writes on-line.
- Database indexes on all foreign keys, asset code, IMEI, and timeline query columns.
- Pagination on all list endpoints; lazy-loaded photos.
- Real-time feel achieved via optimistic UI + SWR/React Query caching; no heavy push infra needed at this scale.

### 4.3 Reliability & Backup

- PostgreSQL with **WAL archiving + nightly full backup + hourly incremental**; RPO ≤ 1 hour, RTO ≤ 4 hours (**assumption**).
- Backup of the image store (local disk) to off-site storage nightly.
- Config via environment variables; 12-factor app; Docker Compose for deployment.
- Application-level error logging (structured) with centralised log collection.

### 4.4 Usability

- Turkish + English UI labels at minimum (**assumption:** primary UI Turkish; admin/technical strings bilingual).
- Mobile responsive — field work happens in clinics.
- Keyboard-friendly, fast search-first UX for selecting phones/employees/accounts.

---

## 5. Data Model / Database Schema

**Database:** PostgreSQL 15+. **ORM:** Prisma. The generic asset core uses **table-per-type inheritance**: every asset lives in `Asset` (common fields + category FK), and category-specific detail lives in typed child tables (notably `PhoneDetail`). Dynamic category text columns (custom fields) live in an **EAV-style** `AssetCustomFieldValue` table keyed off `AssetCategoryField` definitions. This combination gives a strong relational core *and* per-category flexibility without a schema migration per new column.

### 5.1 Entity list

#### Core assets & inventory

**`AssetCategory`**
- `id` UUID PK, `name` (e.g., "Phones", "Laptops", "SIM Cards", "Accounts"), `parentId` FK self (for subcategories: Accounts → GMail-for-WhatsApp-Backup), `kind` enum (`physical` | `digital` | `account`), `isActive`, `createdAt`.

**`AssetCategoryField`** — custom-column definition per category.
- `id`, `categoryId` FK, `key` (e.g., `imei`), `label` (e.g., "IMEI"), `type` enum (`string`,`number`,`date`,`boolean`,`select`,`textarea`), `options` JSON (for select), `required`, `isSearchable`, `isIdentifier`, `sortOrder`.

**`Asset`**
- `id`, `code` unique (e.g., `PHN-000123`), `categoryId` FK, `name`, `serialNumber` (nullable), `qty` int (default 1; >1 for consumables), `condition` enum (`NEW`|`GOOD`|`FAIR`|`POOR`|`DAMAGED`|`DISPOSED`), `status` enum (`AVAILABLE`|`ASSIGNED`|`RETURNED`|`DISPOSED`|`IN_REPAIR`), `location/roomId` FK nullable, `currentHolderEmployeeId` FK nullable (denormalised for queries), `notes`, `createdAt`, `updatedAt`.

**`AssetCustomFieldValue`** — EAV storage for category-specific fields.
- `id`, `assetId` FK, `fieldId` FK → `AssetCategoryField`, `value` JSON/text.
- `UNIQUE(assetId, fieldId)`.

**`PhoneDetail`** — structured, queryable phone specifics (avoids EAV for the most-searched fields). FK to `Asset`.
- `assetId` unique, `imei` unique, `color`, `storage` (e.g., "128 GB"), `model`, `operatingSystem`/`appBinary` (business vs normal), nullable make/carrier, plus referencing fields (many relations, below).

**`Photo`**
- `id`, `assetId` FK nullable, `assignmentId` FK nullable, `type` enum (`FRONT`|`BACK`|`CONDITION`|`GENERAL`), `fileName`, `path`, `mimeType`, `sizeBytes`, `uploadedById`, `createdAt`.

#### People, departments, rooms

**`User`** (system account)
- `id`, `username` unique, `passwordHash`, `fullName`, `role` enum (`ADMIN`|`MANAGER`|`TEAM_LEADER`), `roomId` FK nullable (for team leaders), `isActive`, `lastLoginAt`.

**`Employee`** (real person, assigned devices)
- `id`, `fullName`, `departmentTeamId` FK, `roomId` FK nullable, `phoneContact` nullable, `internalEmail` nullable, `status` enum (`ACTIVE`|`LEFT`|`ON_LEAVE`), `notes`, `createdAt`.
- `UNIQUE(fullName, departmentTeamId)` (**assumption** to avoid duplicates).

**`DepartmentTeam`**
- `id`, `name`, `type` enum (`HOSPITAL`|`CALLCENTER`), parent/order.
- HOSPITAL subcategories (seeded): Odeme, Muhasebe, Banko, Dr, Asst, Satin alma, HR (IK), Guvenlik, Turcuman, Idare isler, CEI.

**`Room`**
- `id`, `code` (TR1, TR2, TR3, TR4), `teamType` = CALLCENTER, `managerEmployeeId` FK nullable.
- Seeded from the 4 call-center rooms.

**`WorkIdentity`** — the seat/label attached to a phone during an assignment.
- `id`, `name` (e.g., `sofia`, `ceo2`, `coordinator`, `data_entry`), `roomId` FK nullable, `departmentTeamId` FK nullable, `isActive`, `notes`.
- Not tied to one Employee — it can be reassigned to a different employee later.

#### Assignment, handover, timeline

**`Assignment`** (header — the handover record)
- `id`, `assignmentCode` unique, `type` enum (`PHONE`|`LAPTOP`|`PRINTER`|`SIM`|`GENERAL`), `employeeId` FK, `workIdentityId` FK nullable, `assetId` FK (primary asset), `status` enum (`DRAFT`|`ACTIVE`|`RETURNED`|`CLOSED`), `assignedAt`, `expectedReturnAt` (e.g., assigned + 1 month), `returnedAt`, `notes`, `createdById`.

**`AssignmentItem`** (items bundled into the assignment — each is a real asset)
- `id`, `assignmentId` FK, `assetId` FK, `role` enum (`PRIMARY`|`SIM1`|`SIM2`|`CHARGER_CABLE`|`CHARGER_ADAPTER`|`BUNDLED`), `conditionAtHandover` enum, `returnCondition` enum nullable.
- `UNIQUE(assetId)` — an asset cannot be actively handed to two assignments.

**`AssignmentTimelineEntry`** (item-level event log — the core audit record)
- `id`, `assignmentId` FK, `assetId` FK, `employeeId` FK, `workIdentityId` FK nullable, `eventType` enum (`ASSIGNED`|`RETURNED`|`REASSIGNED`|`UPDATED`|`DISCREPANCY`|`NOTE`), `snapshot` JSON (full detail captured at event time — makes history immutable and reconstructable), `createdById`, `createdAt`.
- Indexed on `assetId` and `assignmentId` for fast per-item history.

#### Phone-specific assignment detail

**`PhoneAssignmentDetail`** (1:1 with Assignment, only when `type = PHONE`)
- `id`, `assignmentId` unique FK.
- SIM & main WhatsApp (SIM 1):
  - `sim1Number` (main phone number), `sim1AssetId` FK nullable.
  - `wa1Business` bool (is main WhatsApp "business"), `wa1PhoneNumber`, `wa1BackupEmail`, `wa1BackupDate`, `wa1BackupUsedGB` numeric, `wa1BackupTotalGB` numeric, `wa1ChatNormalCount` int, `wa1ChatArchivedCount` int, `wa1AppVariant` enum (`BUSINESS`|`NORMAL`).
- Secondary (SIM 2 & WhatsApp 2): `sim2Number`, `sim2AssetId`, `wa2Business`, `wa2PhoneNumber`, `wa2BackupEmail`, `wa2BackupDate`, `wa2BackupUsedGB`, `wa2BackupTotalGB`, `wa2ChatNormalCount`, `wa2ChatArchivedCount`, `wa2AppVariant`.
- Bitrix & charger: `bitrixAccountId` FK → Account, `chargerCableAssetId` FK, `chargerAdapterAssetId` FK.
- `notes`. Photo references live on the `Photo` table via `assignmentId + type`.

#### Accounts (credentials)

**`Account`** (digital asset category "Accounts")
- `id`, `assetId` FK nullable, `kind` enum (`GMAIL`|`WHATSAPP`|`BITRIX`|`OTHER`), `subcategory` nullable (e.g., "GMail for WhatsApp backup"), `identifier` (e.g., gmail address or WhatsApp number), `email` nullable, `passwordEnc` encrypted, `isWhatsAppBackup` bool, `isActive`, `currentAssignmentId` FK nullable, `notes`.

#### Return records (comparison)

**`ReturnRecord`**
- `id`, `assignmentId` FK, `returnedAt`, `returnedById`.
- `returnCondition` enum, `returnNotes`.
- Child rows store the comparison: 

**`ReturnComparisonField`**
- `id`, `returnRecordId` FK, `fieldKey` (e.g., `wa1ChatNormalCount`), `label`, `valueAtHandover` JSON, `valueAtReturn` JSON, `isDiscrepancy` bool, `severity` enum (`INFO`|`WARNING`|`CRITICAL`).

#### Related: roles handled via `User.role` enum + `Room` scope (see §9).

### 5.2 Key relationships (summary)

```
User (role, roomId)
 └── accesses assignment/asset data scoped by role

AssetCategory ─< AssetCategoryField
AssetCategory ─< Asset ─< AssetCustomFieldValue
                 ├──< PhoneDetail (1:1)
                 ├──< Photo
                 └──< AssignmentItem ─< Assignment >── AssignmentTimelineEntry
                                       ├──< PhoneAssignmentDetail (1:1, phones)
                                       ├──< ReturnRecord ─< ReturnComparisonField
                                       ├── Employee
                                       ├── WorkIdentity
                                       └── Account (bitrix FK)

Employee ─ Room ─ WorkIdentity ─ Assignment
DepartmentTeam ─< Employee
```

**Integrity rules:**
- An `Asset.status` reflects its most recent `AssignmentItem`; system prevents dual-active assignment of the same asset/SIM/account.
- Timeline entries are append-only; historical `snapshot` JSON preserves full detail even if the live record changes.
- Deleting an employee/asset is soft/disabled if history references it — history must never break.

---

## 6. API Design (REST)

All endpoints are under `/api/v1`, JSON bodies, Bearer JWT. Auth endpoints excluded from auth.

### 6.1 Auth & users

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/auth/login` | Authenticate, set tokens |
| POST | `/auth/refresh` | Rotate refresh token |
| POST | `/auth/logout` | Invalidate session |
| GET | `/auth/me` | Current user + role/scope |
| GET | `/users` | List users (Admin) |
| POST | `/users` | Create user (Admin) |
| PATCH | `/users/:id` | Update user/role/room (Admin) |
| PATCH | `/users/:id/password` | Reset password (Admin) |

### 6.2 Categories & inventory

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/asset-categories` | List categories (incl. subcategories) |
| POST | `/asset-categories` | Create category (Admin) |
| PATCH | `/asset-categories/:id` | Update category (Admin) |
| DELETE | `/asset-categories/:id` | Deactivate/delete (Admin; blocked if in use) |
| GET | `/asset-categories/:id/fields` | List custom column definitions |
| POST | `/asset-categories/:id/fields` | Add custom column (Admin) |
| DELETE | `/asset-categories/fields/:fieldId` | Remove custom column (Admin) |
| GET | `/assets` | List/search/filter assets |
| GET | `/assets/:id` | Asset detail incl. custom fields, photos, timeline |
| POST | `/assets` | Create asset (Admin) |
| PATCH | `/assets/:id` | Update asset (Admin) |
| POST | `/assets/:id/photos` | Upload asset photo(s) (Admin) |

### 6.3 Employees, departments, rooms, work identities

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/employees` | List employees (scoped) |
| POST | `/employees` | Create employee (Admin) |
| PATCH | `/employees/:id` | Update employee (Admin) |
| GET | `/employees/:id` | Employee + device history |
| GET | `/departments` | List department teams/subcategories |
| CRUD | `/departments` | Manage teams (Admin) |
| GET | `/rooms` | List rooms |
| PATCH | `/rooms/:id` | Set room manager (Admin) |
| GET | `/work-identities` | List work identities (scoped) |
| POST | `/work-identities` | Create work identity (Admin) |
| PATCH | `/work-identities/:id` | Update work identity (Admin) |

### 6.4 Accounts

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/accounts` | List accounts (searchable; Admin for credentials) |
| POST | `/accounts` | Create account (Admin) |
| PATCH | `/accounts/:id` | Update account (Admin) |
| GET | `/accounts/:id/decrypt` | View decrypted password (Admin only, audited) |
| POST | `/accounts/:id/photos` | Upload account proof docs (Admin) |

### 6.5 Assignments (generic + phone)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/assignments` | List/filter assignments |
| GET | `/assignments/:id` | Assignment detail with all items + phone detail |
| POST | `/assignments` | Create draft assignment (Admin) |
| POST | `/assignments/:id/activate` | Finalize/hand over — writes timeline+snapshot, marks assets ASSIGNED (Admin) |
| PATCH | `/assignments/:id` | Edit open assignment (Admin) |
| POST | `/assignments/phone` | Submit full phone assignment (all §3.2 fields) |
| GET | `/assignments/draft/:id` | Resume unfinished assignment |

### 6.6 Return / handback

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/assignments/:id/return-form` | Pre-filled out-state snapshot for return |
| POST | `/assignments/:id/return` | Submit return-state; server compares, writes ReturnRecord + discrepancies + timeline (Admin) |

### 6.7 Timelines

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/assets/:id/timeline` | Item-level timeline (paginated) |
| GET | `/assignments/:id/timeline` | Assignment timeline |
| GET | `/employees/:id/timeline` | Employee device history |

### 6.8 Reports

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/reports/who-has-what` | Current holder + device, scoped |
| GET | `/reports/condition` | Asset condition distribution |
| GET | `/reports/backup-staleness` | Phones overdue for WhatsApp backup |
| GET | `/reports/outstanding-assignments` | Open assignments past expected return |
| GET | `/reports/room-composition` | Room/team employee + seat overview |
| GET | `/reports/:id/export` | CSV/Excel export (Manager/Admin) |

Referential note: every read endpoint applies the role scope of §9 (Team Leader restricted to own room; Manager read-only).

---

## 7. Frontend Structure (React)

**Stack:** React + TypeScript, Vite, React Router, TanStack Query (server state), Zustand (UI state), Tailwind + component library (e.g., shadcn/ui), React Hook Form + Zod.

### Routes / screens

| Route | Screen | Access |
|-------|--------|--------|
| `/login` | Login | all |
| `/dashboard` | Overview dashboard (counts, quick actions) | all |
| `/assets` | Asset list + search/filter | all |
| `/assets/new` | Create asset (category-driven dynamic form) | Admin |
| `/assets/:id` | Asset detail + photos + timeline | all |
| `/assets/:id/timeline` | Full timeline | all |
| `/phones` | Phone-specific list (IMEI-sortable) | all |
| `/phones/assign` | **Phone assignment form** (the core form) | Admin |
| `/assignments` | Assignment list/filter | all |
| `/assignments/:id` | Assignment detail + items + timeline | all |
| `/assignments/:id/return` | Return/handback comparison form | Admin |
| `/laptops`, `/printers`, `/sims`, `/equipment` | Per-category inventory | all |
| `/assignments/:type/new` | Generic assignment (laptop/printer/sim/etc.) | Admin |
| `/accounts` | Account list (credentials masked) | Admin |
| `/accounts/:id` | Account detail + decrypt action | Admin |
| `/employees` | Employee directory + their devices | all |
| `/rooms` | Rooms + managers + seats/composition | Manager/Admin |
| `/work-identities` | Work identity management | Manager/Admin |
| `/reports` | Report selection + views | Manager/Admin |
| `/settings/categories` | Category + custom-column designer | Admin |
| `/settings/users` | User/role management | Admin |

### UI notes
- The phone assignment form is a **wizard** (Steps: Employee & identity → Phone & SIMs → Main WhatsApp → Secondary WhatsApp → Bitrix & chargers → Photos → Review/snapshot) to keep the large capture manageable.
- The return screen renders a **two-column comparison** (Handover | Return) highlighting discrepancies with color severity.
- Asset forms render **dynamically** from `AssetCategoryField` definitions — adding a new column to a category instantly changes the create/edit form with no deploy.

---

## 8. Assignment Lifecycle State Machine

```
              (create)                                 (return, compare ok)
  ┌──────►  DRAFT  ──activate──►  ACTIVE  ────────────────────────────────►  RETURNED
  │          │                        │                                        │
  │          │                        │  expectedReturnAt t+1mo                  │ reassign to new
  │          │                        └── alert if overdue                       │ employee (new identity)
  │          │                        └── (manual) return-with-discrepancies      ▼
  └───── (edit)                                  └──► RETURNED(WITH_DISCREPANCIES)  REASSIGNED (new ACTIVE)
```

**Transitions & rules:**
1. `DRAFT` → `ACTIVE`: only Admin; requires all required fields; on activation the system writes the **handover snapshot** timeline entry and flips every involved asset to `ASSIGNED`.
2. `ACTIVE` → `RETURNED`: only via a Return; server compares out/return states; discrepancies recorded but do not block return (they are flagged).
3. `RETURNED` → assigned assets flip to `AVAILABLE`; SIMs/accounts released (still linked historically).
4. `REASSIGNED`: a new `ASSIGNMENT`/`ACTIVE` entry for the same asset to a new employee (possibly a changed work identity name); the old record stays `RETURNED`. Assets are never double-active — enforced by `UNIQUE(assetId)` on active `AssignmentItem`.
5. Any `UPDATED` / `NOTE` to an active assignment also appends a timeline entry.

---

## 9. Role-Based Access Control Matrix

| Capability | Admin | Manager | Team Leader |
|-------------|:-----:|:-------:|:-----------:|
| View all assets / all rooms | ✅ | ✅ | 🔒 own room only |
| Create/edit/delete assets & categories | ✅ | ❌ | ❌ |
| Design custom columns | ✅ | ❌ | ❌ |
| Create/activate/return/update assignments | ✅ | ❌ | ❌ |
| Manage employees, departments, rooms, work identities | ✅ | ❌ | ❌ |
| Manage accounts (incl. decrypting credentials) | ✅ | ❌ | ❌ |
| Manage users & roles | ✅ | ❌ | ❌ |
| View reports | ✅ | ✅ | 🔒 own room scope |
| Export reports (CSV/Excel) | ✅ | ✅ | ❌ |
| View credentials (password field) | ✅ decrypted | masked | ❌ |

Enforcement: middleware decodes JWT → nested route guards check `role` + `roomScope`. Team Leader queries are automatically filtered by `roomId` server-side.

---

## 10. Timeline / Audit Approach

- **Append-only** `AssignmentTimelineEntry` table is the single source of audit truth. Entries are never edited or deleted.
- Each entry stores a full **`snapshot` JSON** of the relevant state (assignment detail, phone WhatsApp fields, SIMs, accounts, charger conditions, condition) at the time of the event, plus `createdById` and timestamp. This makes history reconstructable even if live rows change.
- **Immutable-history guarantee:** re-pointing or clearing a live record never re-writes past snapshots.
- **Searchability:** timeline is indexed by `assetId`, `assignmentId`, `employeeId`, and `createdAt`; planned full-text/binary search over serial, IMEI, codes so a future query like "show me every time this IMEI appeared" returns instantly.
- **Audit of privileged actions:** decrypting an account password and any role/permission change also appends to a separate `AuditLog` (not shown but present) recording actor, action, target, and timestamp.
- **UI:** every item detail page shows a "History/Timeline" tab rendering these entries chronologically.

---

## 11. MVP Build Plan / Phased Roadmap

**Assumptions:** solo + small junior team; each phase ends with something usable in the clinic.

### Phase 0 — Foundations (Weeks 1–2)
- Repo scaffold (monorepo: `server/`, `web/`), Docker Compose (Postgres + app), Prisma schema, JWT auth, RBAC middleware, error/validation framework.
- **Exit:** login works; seeded roles.

### Phase 1 — Inventory core (Weeks 2–4)
- Categories + custom-column designer; Asset CRUD with dynamic forms; photo upload to local disk; asset search/filter; Accounts model + encrypted credentials.
- **Exit:** Admin can register every device/sim/account with category-specific fields.

### Phase 2 — Phone assignment MVP (Weeks 4–6) ⭐ core
- Employees, departments, rooms, work identities; full phone assignment wizard capturing all §3.2 fields (`sofia` example end-to-end); activation → asset flips ASSIGNED; handover snapshot + item timelines; search by IMEI/code.
- **Exit:** a call-center phone is fully assignable and returns a complete searchable record.

### Phase 3 — Return & lifecycle (Weeks 6–8)
- Return form with out/return comparison and discrepancy flags; state machine transitions; reassignment flow; overdue alerts.
- **Exit:** 1-month return → compare → reassign cycle works fully.

### Phase 4 — Team Leader scoping + reports (Weeks 8–10)
- Room-scoped Team Leader access; reports module + CSV export; dashboard.
- **Exit:** roles enforced end-to-end; Manager can export who-has-what.

### Phase 5 — Generalize (Weeks 10–12)
- Generic assignment forms for laptops, printers, SIMs, equipment; bulk import (CSV of assets); hardening (rate limits, backup jobs, logging); seed real inventory from the clinic.

### Post-MVP (later)
- Multi-clinic isolation, AD/SSO, S3/Cloudinary image hosting, scheduled backup reminders, mobile app, integration with Google/Bitrix APIs.

---

## 12. Open Questions & Assumptions

### Assumptions (flagged for confirmation)

| # | Assumption | Status |
|---|-----------|--------|
| A1 | **Backup staleness threshold** = warn if WhatsApp last backup > 7 days | adjust per operations |
| A2 | **Backup RPO ≤ 1 h / RTO ≤ 4 h**; nightly full + hourly incremental | confirm budget |
| A3 | **Primary UI language Turkish** with bilingual labels; English acceptable for technical/admin strings | confirm |
| A4 | **Employee dedup key** `fullName + departmentTeam` | confirm (could add gov-id/email) |
| A5 | **Expected return = 1 month** for phones (per clinic policy) | confirm, may differ per category |
| A6 | **Image storage = local disk** on server (S3/Cloudinary deferred to post-MVP) | confirm capacity/HA |
| A7 | **Phones currently unassigned / freelancers** are modelled as `WorkIdentity` without an `Employee` until a real person holds it | confirm |
| A8 | **A phone may be bound to a fixed `WorkIdentity`** across reassignments (identity stays, employee changes) | confirm workflow preference |
| A9 | SIMs are individual tracked assets (not a pool) so return comparison can verify them | confirm |

### Open questions for the product owner

1. Should a phone be **pinned to one `WorkIdentity`/room** permanently, or movable between rooms/identities freely?
2. For **accounts**, is one Gmail allowed to back up multiple WhatsApp numbers, and should the system enforce uniqueness?
3. Are there **scanners/barcode readers** in the clinic to automate asset lookup (label printing + QR) — or pure manual entry?
4. Who triggers a **return** — the leaving employee, the room manager, or Admin only?
5. Should **discrepancies at return** block reassignment, or merely be logged?
6. WhatsApp/chat count capture — should each reassignment **carry forward the previous snapshot** to compare growth, or always start fresh?
7. Confirm the exact **category list + per-category custom columns** (the design supports adding them later without code).
8. Do you want **history on Accounts too** (which employees used which WhatsApp/Bitrix account), beyond what assignment snapshots already imply?

---

*End of document. This specification is self-contained and implementation-ready; Phases 0–3 can begin immediately against PostgreSQL + Prisma with the schema in §5.*