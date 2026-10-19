# Seed Data — IT Asset Management & Device Handover System

**Version:** 1.0
**Source of truth:** `README.md` §5 (data model) + §12 assumptions. This file defines the **realistic dev-database seed** so both developers populate `server/` and `web/` against identical data. Field names match `docs/API_CONTRACT.md` exactly.

The seed is a Prisma script executed via `npm run seed` (see `docs/SETUP.md`). It must be **idempotent** (safe to re-run).

---

## 1. Departments (`DepartmentTeam`)

`type` = `HOSPITAL` | `CALLCENTER`.

| id | name | type |
|----|------|------|
| `dep-odeme` | Odeme | HOSPITAL |
| `dep-muhasebe` | Muhasebe | HOSPITAL |
| `dep-banko` | Banko | HOSPITAL |
| `dep-dr` | Dr | HOSPITAL |
| `dep-asst` | Asst | HOSPITAL |
| `dep-satin-alma` | Satin alma | HOSPITAL |
| `dep-hr` | HR (IK) | HOSPITAL |
| `dep-guvenlik` | Guvenlik | HOSPITAL |
| `dep-turcuman` | Turcuman | HOSPITAL |
| `dep-idare` | Idare isler | HOSPITAL |
| `dep-cei` | CEI | HOSPITAL |
| `dep-ceo2` | Ceo2 | CALLCENTER |
| `dep-coordinator` | Coordinator | CALLCENTER |
| `dep-dataentry` | Data entry | CALLCENTER |
| `dep-media` | Media dept | CALLCENTER |

> **Naming note:** the call-center seats (Ceo2, Coordinator, Data entry, Media) are seeded both as `DepartmentTeam` rows (above) **and** as `WorkIdentity` rows (below). The rooms TR1–TR4 define the physical call-center seats; work identities name the seat held on a phone.

---

## 2. Rooms (`Room`)

`teamType` = `CALLCENTER` for all. `managerEmployeeId` set after employees exist (see §5). Manager links below reference seeded employee ids from §5 (use `UPDATE` in the seed, or set at creation with a nullable-first then update).

| id | code | teamType | managerEmployeeId |
|----|------|----------|-------------------|
| `room-tr1` | TR1 | CALLCENTER | `emp-ayse` |
| `room-tr2` | TR2 | CALLCENTER | `emp-mehmet` |
| `room-tr3` | TR3 | CALLCENTER | `emp-fatma` |
| `room-tr4` | TR4 | CALLCENTER | `emp-fatma` |

---

## 3. Work Identities (`WorkIdentity`)

The seat/label attached to a phone (not tied to one employee — reassignable, per §12 A7/A8).

| id | name | roomId | departmentTeamId | isActive | notes |
|----|------|--------|------------------|:--------:|-------|
| `wi-sofia` | sofia | `room-tr1` | `dep-dataentry` | true | Main call-center seat; **the §3.2 example** |
| `wi-ceo2` | ceo2 | `room-tr1` | `dep-ceo2` | true | |
| `wi-coordinator` | coordinator | `room-tr2` | `dep-coordinator` | true | |
| `wi-data-entry-3` | data_entry | `room-tr3` | `dep-dataentry` | true | |
| `wi-media` | media | `room-tr4` | `dep-media` | true | |
| `wi-unassigned-tr2` | seat_02 | `room-tr2` | null | true | Freelancer/unassigned seat (no Employee until filled, per A7) |

---

## 4. Users / System Roles (`User`) — seed logins for dev

Passwords below are **dev-only** (`bcrypt`/`argon2` hashed at seed time; plaintext only shown here for dev convenience — never hard-code in prod).

| id | username | fullName | role | roomId |
|----|----------|----------|------|--------|
| `usr-admin` | admin | Nour (IT) | ADMIN | null |
| `usr-manager` | manager | IT Manager | MANAGER | null |
| `usr-tl1` | tl.tr1 | TR1 Team Leader | TEAM_LEADER | `room-tr1` |
| `usr-tl2` | tl.tr2 | TR2 Team Leader | TEAM_LEADER | `room-tr2` |

Dev passwords: `admin` / `manager` / `tl1` / `tl2` (all `DevPass123!` optional — simplest: use `password`).

---

## 5. Employees (`Employee`) — 3 sample

`UNIQUE(fullName, departmentTeamId)` per §5 A4.

| id | fullName | departmentTeamId | roomId | phoneContact | internalEmail | status |
|----|----------|------------------|--------|--------------|---------------|--------|
| `emp-ayse` | Ayşe Yılmaz | `dep-dataentry` | `room-tr1` | +90 530 000 00 00 | ayse@clinic.local | ACTIVE |
| `emp-mehmet` | Mehmet Demir | `dep-coordinator` | `room-tr2` | +90 531 000 00 00 | mehmet@clinic.local | ACTIVE |
| `emp-fatma` | Fatma Kaya | `dep-media` | `room-tr4` | +90 532 000 00 00 | fatma@clinic.local | ACTIVE |

---

## 6. Asset Categories & Custom Columns

### 6.1 Categories (`AssetCategory`)

| id | name | parentId | kind |
|----|------|----------|------|
| `cat-phones` | Phones | null | physical |
| `cat-sims` | SIM Cards | null | physical |
| `cat-chargers` | Chargers | null | physical |
| `cat-accounts` | Accounts | null | account |
| `cat-accounts-gmail-backup` | GMail-for-WhatsApp-Backup | `cat-accounts` | account |
| `cat-laptops` | Laptops | null | physical |
| `cat-printers` | Printers | null | physical |
| `cat-equipment` | Equipment | null | physical |

### 6.2 Custom columns (`AssetCategoryField`) for Phones

Used by the dynamic asset form; `key`s must match `customFields` payload keys in the API.

| id | categoryId | key | label | type | options | required | isSearchable | isIdentifier |
|----|-----------|-----|-------|------|---------|:--------:|:------------:|:------------:|
| `fld-imei` | `cat-phones` | imei | IMEI | string | – | true | true | true |
| `fld-color` | `cat-phones` | color | Color | string | – | false | false | false |
| `fld-storage` | `cat-phones` | storage | Storage | select | ["64 GB","128 GB","256 GB"] | false | false | false |
| `fld-model` | `cat-phones` | model | Model | string | – | false | true | false |
| `fld-serial` | `cat-phones` | serialNumber | Serial No. | string | – | false | true | false |

(Note: `PhoneDetail` table ALSO stores `imei`, `color`, `storage`, `model` as structured columns per §5. Both exist by design — `PhoneDetail` is the queryable store; the custom columns give the dynamic-form path. Seed both consistently.)

### 6.3 Chargers (`cat-chargers`) custom columns

| key | label | type |
|-----|-------|------|
| type | Type (Cable/Adapter) | select ["CABLE","ADAPTER"] |
| lengthM | Length (m) | number |

---

## 7. Assets (`Asset`) + `PhoneDetail`

### 7.1 Phones

| id | code | name | categoryId | condition | status | qty |
|----|------|------|-----------|-----------|--------|:---:|
| `ast-phone-a12` | PHN-000001 | Samsung Galaxy A12 | `cat-phones` | GOOD | ASSIGNED | 1 |
| `ast-phone-a12-2` | PHN-000002 | Samsung Galaxy A12 | `cat-phones` | GOOD | AVAILABLE | 1 |
| `ast-phone-a12-3` | PHN-000003 | Samsung Galaxy A12 | `cat-phones` | FAIR | AVAILABLE | 1 |

`PhoneDetail` for `ast-phone-a12` (the §3.2 device):

| assetId | imei | color | storage | model | appBinary |
|---------|------|-------|---------|-------|-----------|
| `ast-phone-a12` | 352957084322001 | Black | 64 GB | SM-A125F | business |

Additional registered phones (seed a couple more for the phones list):
- `ast-phone-a12-2` → imei `352957084322002`, Black, 64 GB, SM-A125F, appBinary `normal`, AVAILABLE
- `ast-phone-a12-3` → imei `352957084322003`, Blue, 128 GB, SM-A125F, appBinary `business`, FAIR, AVAILABLE

### 7.2 SIM cards (`cat-sims`)

SIMs are individual tracked assets (per §12 A9) so the return comparison can verify them.

| id | code | name | categoryId | condition | status | customFields |
|----|------|------|-----------|-----------|--------|--------------|
| `ast-sim1-main` | SIM-000001 | SIM 905369700889 | `cat-sims` | GOOD | ASSIGNED | number: "905369700889", carrier: "Turkcell" |
| `ast-sim2-sec` | SIM-000002 | SIM 905369700999 | `cat-sims` | GOOD | AVAILABLE | number: "905369700999", carrier: "Turkcell" |

> This matches **§3.2 example: SIM 1 (main) = `905369700889`.**
> The SIM custom column `number` is filtered for search, so `GET /assets?q=905369700889` finds the SIM.

### 7.3 Charger cable & adapter (`cat-chargers`)

| id | code | name | categoryId | condition | status | customFields |
|----|------|------|-----------|-----------|--------|--------------|
| `ast-cable-1` | CHG-000001 | USB-C cable 1m | `cat-chargers` | GOOD | AVAILABLE | type: "CABLE", lengthM: 1 |
| `ast-adapter-1` | CHG-000101 | Micro-USB adapter 15W | `cat-chargers` | GOOD | AVAILABLE | type: "ADAPTER" |

---

## 8. Accounts (`Account`) — sample of §3.7 / A-7

| id | assetId | kind | subcategory | identifier | email | isWhatsAppBackup | isActive | currentAssignmentId |
|----|---------|------|-------------|------------|-------|:----------------:|:--------:|---------------------|
| `acc-bitrix-main` | null | BITRIX | null | bitrix@clinic.local | bitrix@clinic.local | false | true | null |
| `acc-gmail-wa1` | null | GMAIL | GMail-for-WhatsApp-Backup | class3447@gmail.com | class3447@gmail.com | true | true | null |
| `acc-gmail-wa2` | null | GMAIL | GMail-for-WhatsApp-Backup | class3455@gmail.com | class3455@gmail.com | true | true | null |

> **§3.2 example:** Main WhatsApp backup email = `class3447@gmail.com` → seed as `acc-gmail-wa1`.
> `passwordEnc`: AES-256-GCM ciphertext written by the seed using the server key from `ENCRYPTION_KEY`; only `GET /accounts/:id/decrypt` (Admin) returns it.

---

## 9. The canonical seed assignment — "sofia holds the Samsung A12" (Phase 2 acceptance)

This is the end-to-end record both devs MUST be able to reproduce from seed, mirroring §3.2:

**Assignment** (`Assignment`, type PHONE, status ACTIVE)
- `assignmentCode`: `A-000001`
- `employeeId`: `emp-ayse`, `workIdentityId`: `wi-sofia`
- `assetId` (PRIMARY): `ast-phone-a12`
- `assignedAt`: 2026-10-10, `expectedReturnAt`: 2026-11-10 (≈ +1 month, §12 A5)
- `createdById`: `usr-admin`

**AssignmentItems:**
| assetId | role | conditionAtHandover |
|---------|------|---------------------|
| `ast-phone-a12` | PRIMARY | GOOD |
| `ast-sim1-main` | SIM1 | GOOD |
| `ast-cable-1` | CHARGER_CABLE | GOOD |
| `ast-adapter-1` | CHARGER_ADAPTER | GOOD |

**PhoneAssignmentDetail** (SIM 1 / main WhatsApp — the §3.2 example):
```
sim1Number:            "905369700889"
sim1AssetId:           ast-sim1-main
wa1Business:           true
wa1PhoneNumber:        "905369700889"
wa1BackupEmail:        "class3447@gmail.com"      // acc-gmail-wa1
wa1BackupDate:         2026-05-17                 // "last backup 17/5/2026"
wa1BackupUsedGB:       12.0                       // "12 GB of 15 GB"
wa1BackupTotalGB:      15.0
wa1ChatNormalCount:    4500
wa1ChatArchivedCount:  210
wa1AppVariant:         "BUSINESS"
sim2Number:            null
wa2*:                  all null                  // secondary optional, empty in this seed
bitrixAccountId:       acc-bitrix-main
chargerCableAssetId:   ast-cable-1
chargerAdapterAssetId: ast-adapter-1
notes:                 null
```

**Photos:** attach two `Photo` rows to the assignment (`type` FRONT & BACK), e.g. `/uploads/seeds/a12-front.jpg`, `/uploads/seeds/a12-back.jpg` (seed may reference placeholder files under `server/uploads/seeds/`).

**Timeline entry** (`AssignmentTimelineEntry`, `eventType: ASSIGNED`, `createdById: usr-admin`, `createdAt: 2026-10-10`): `snapshot` = the full `PhoneAssignmentDetail` + item conditions JSON above.

Asset statuses after seed: `ast-phone-a12` = `ASSIGNED`, `ast-sim1-main` = `ASSIGNED`, `ast-cable-1`/`ast-adapter-1` = `ASSIGNED` (all part of the ACTIVE assignment); all other assets = their listed status.

---

## 10. Consistency checklist (verify after seeding)

- ✅ 15 `DepartmentTeam` rows (11 HOSPITAL, 4 CALLCENTER) — matches task list verbatim.
- ✅ 4 `Room` rows TR1–TR4.
- ✅ `sofia` work identity exists and is linked to `emp-ayse` via the seed assignment.
- ✅ Samsung Galaxy A12 device/IMEI/SIM exists and `GET /assignments/:id` returns `wa1ChatNormalCount` etc. matching §3.2.
- ✅ `class3447@gmail.com` GMAIL backup account + a BITRIX account exist.
- ✅ 3 `Employee` rows seeded with real names.
- ✅ Re-running `npm run seed` produces identical state (no duplicate $2A IDs).
