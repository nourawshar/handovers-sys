# API Contract — IT Asset Management & Device Handover System

**Version:** 1.0
**Source of truth:** `README.md` §5 (data model) + §6 (API design). This document is the single binding contract for **backend** (`server/`) and **frontend** (`web/`). If anything here disagrees with code, this file wins until it is re-versioned.

---

## 1. Global Conventions

### 1.1 Base URL & transport
- All endpoints live under **`/api/v1`**. Example table path `GET /auth/login` means `GET /api/v1/auth/login`.
- Request/response bodies are **JSON** (`Content-Type: application/json`), UTF-8.
- Auth uses **`Authorization: Bearer <accessToken>`** for every endpoint except `POST /auth/login`, `POST /auth/refresh`, and `POST /auth/logout`.
- All dates are **ISO 8601 UTC** strings (`2026-10-19T10:30:00.000Z`) unless stated otherwise.
- All money-free numerics (`wa1ChatNormalCount`, `qty`, etc.) are JSON **integers**. Backup sizes are JSON **numbers** (GB, decimal allowed).

### 1.2 Success envelope
```json
{
  "data": { }                     // single object, or array for list endpoints
}
```

### 1.3 List / pagination envelope
Every list endpoint returns `meta`:
```json
{
  "data":   [ { } ],
  "meta":   {
    "page": 1,
    "pageSize": 25,
    "total": 137,
    "totalPages": 6
  }
}
```
Query params accepted on **every** list endpoint: `page` (1-based, default 1), `pageSize` (default 25, max 100).

### 1.4 Error envelope
Every error returns the matching HTTP status plus:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human readable message",
    "details": { "fieldName": "reason" }    // optional; present for validation errors
  }
}
```
Standard `code` values:

| code | HTTP | Meaning |
|------|:----:|---------|
| `UNAUTHORIZED` | 401 | Missing/expired token |
| `FORBIDDEN` | 403 | Authenticated but role/scope denies |
| `NOT_FOUND` | 404 | Resource (or parent) does not exist |
| `VALIDATION_ERROR` | 400 | Zod schema failed; `details` = per-field errors (field name → message) |
| `CONFLICT` | 409 | Unique / dual-active / in-use violation (e.g. asset not available for handover, duplicate IMEI, duplicate category name/prefix, phone number in use). `error.details` MAY carry machine-readable context (see the endpoint) |
| `DECRYPT_NOT_ALLOWED` | 403 | Non-Admin tried to decrypt an account |
| `INTERNAL` | 500 | Unhandled server error (no internals leaked) |

Validation messages SHOULD be Turkish with English fallback; the frontend renders `details` keys locally if present, otherwise `message`.

### 1.5 Field naming rule (CRITICAL)
JSON field names are **exactly** the camelCase column names from §5. Examples devs MUST reuse verbatim:
`wa1ChatNormalCount`, `wa1ChatArchivedCount`, `wa1BackupUsedGB`, `wa1AppVariant`, `sim1Number`, `expectedReturnAt`, `currentHolderEmployeeId`, `passwordHash` (never sent — server-only). When a DB column is snake_case (e.g. `assignment_code`), the JSON key is camelCase (`assignmentCode`).

### 1.6 Auth tokens
- `POST /auth/login` and `POST /auth/refresh` set two **HttpOnly cookies**: `access_token` (JWT, ~15 min) and `refresh_token` (rotating, ~7 days).
- On refresh the server issues a **new** access token and **rotates** the refresh token (old one invalidated).
- `GET /auth/me` is the only definition of the current session/scope the frontend should trust.

---

## 2. Enums (single source, must match Prisma enums)

| Enum | Values |
|------|--------|
| `AssetCategory.kind` | `physical`, `digital`, `account` |
| `AssetCategoryField.type` | `string`, `number`, `date`, `boolean`, `select`, `textarea` |
| `Asset.condition` | `NEW`, `GOOD`, `FAIR`, `POOR`, `DAMAGED`, `DISPOSED` |
| `Asset.status` | `AVAILABLE`, `ASSIGNED`, `RETURNED`, `DISPOSED`, `IN_REPAIR` |
| `User.role` | `ADMIN`, `MANAGER`, `TEAM_LEADER`, `CALL_CENTER_MANAGER` |
| `Employee.status` | `ACTIVE`, `LEFT`, `ON_LEAVE` |
| `DepartmentTeam.type` | `HOSPITAL`, `CALLCENTER` |
| `Assignment.type` | `PHONE`, `LAPTOP`, `PRINTER`, `SIM`, `GENERAL` |
| `Assignment.status` | `DRAFT`, `ACTIVE`, `RETURNED`, `CLOSED` |
| `AssignmentItem.role` | `PRIMARY`, `SIM1`, `SIM2`, `CHARGER_CABLE`, `CHARGER_ADAPTER`, `BUNDLED` |
| `AssignmentTimelineEntry.eventType` | `ASSIGNED`, `RETURNED`, `REASSIGNED`, `UPDATED`, `DISCREPANCY`, `NOTE` |
| `Photo.type` | `FRONT`, `BACK`, `CONDITION`, `GENERAL` |
| `Account.kind` | `GMAIL`, `WHATSAPP`, `BITRIX`, `OTHER` |
| `PhoneAssignmentDetail.wa1AppVariant` / `wa2AppVariant` | `BUSINESS`, `NORMAL` |
| `ReturnComparisonField.severity` | `INFO`, `WARNING`, `CRITICAL` |

---

## 3. Auth & Users

### 3.1 POST `/auth/login`
Authenticate and set tokens. *No auth required.*

**Request:**
```json
{
  "username": "admin",
  "password": "secret"
}
```
**Response 200 / `data`:**
```json
{
  "user": {
    "id": "uuid",
    "username": "admin",
    "fullName": "Nour",
    "role": "ADMIN",
    "roomId": null
  }
}
```
*Access/refresh tokens returned via HttpOnly cookies, not in body.*

**Errors:** `400 VALIDATION_ERROR`, `401 UNAUTHORIZED` (bad credentials).

### 3.2 POST `/auth/refresh`
Rotate tokens using the HttpOnly refresh cookie. *No auth required.* No body.

**Response 200:** same `user` shape as login. **Errors:** `401 UNAUTHORIZED` (refresh cookie missing/revoked).

### 3.3 POST `/auth/logout`
Invalidate the session (clear cookies). *No auth required.* No body. **Response 204** (no body).

### 3.4 GET `/auth/me`
Current user + role/scope. **Response 200 / `data`:**
```json
{
  "user": {
    "id": "uuid",
    "username": "admin",
    "fullName": "Nour",
    "role": "ADMIN",
    "roomId": null
  },
  "scope": { "rooms": ["TR1","TR2","TR3","TR4"] }   // TEAM_LEADER => their own room only
}
```

### 3.5 GET `/users` (Admin)
List users (paginated). **Response:** list envelope with `data` = array of user objects (same shape as above, `passwordHash` omitted).

### 3.6 POST `/users` (Admin)
**Request:**
```json
{
  "username": "tl.tr1",
  "password": "temp-password",
  "fullName": "Team Lead TR1",
  "role": "TEAM_LEADER",
  "roomId": "uuid"
}
```
**Response 201 / `data`: user object. Errors:** `400 VALIDATION_ERROR`, `409 CONFLICT` (username taken).

### 3.7 PATCH `/users/:id` (Admin)
Update `fullName`, `role`, `roomId`, `isActive`. Partial body allowed. **Response 200 / `data`: user object.**

### 3.8 PATCH `/users/:id/password` (Admin)
**Request:**
```json
{ "password": "new-password" }
```
**Response 204.** No other field accepted.

---

## 4. Categories & Inventory

### 4.1 GET `/asset-categories`
List categories, each with its nested `children` (subcategories) and `fields`.
**Response 200 — `data` array:**
```json
[
  {
    "id": "uuid",
    "name": "Accounts",
    "parentId": null,
    "kind": "account",
    "isActive": true,
    "createdAt": "...",
    "children": [
      {
        "id": "uuid",
        "name": "GMail-for-WhatsApp-Backup",
        "parentId": "uuid-accounts",
        "kind": "account",
        "isActive": true,
        "createdAt": "...",
        "children": [],
        "fields": []
      }
    ],
    "fields": []
  }
]
```

### 4.2 POST `/asset-categories` (Admin)
**Request:**
```json
{
  "name": "Phones",
  "parentId": null,
  "kind": "physical"
}
```
**Response 201 / `data`:** category object (as in 4.1). `codePrefix` (2-5 letters, upper-cased, default `AST`) is also accepted.
**Errors:** `400 VALIDATION_ERROR`; `409 CONFLICT` when the `name` already exists at the same level (same `parentId`, case-insensitive: "Laptops" == "LAPTOPS") or the `codePrefix` is already used by any category (any level). `error.details = { "field": "name" | "codePrefix", "categoryId": "<id of the existing category>" }`.

### 4.3 PATCH `/asset-categories/:id` (Admin)
Partial: `isActive`, `name`, `kind`, `parentId`, `codePrefix` allowed. **Response 200 / `data`:** category object.
**Errors:** same `409 CONFLICT` + `details { field, categoryId }` as 4.2. Uniqueness is re-checked only for values that actually change (a rename, a move to another level, a new `codePrefix`), so unrelated edits of a legacy duplicate keep working.

### 4.4 DELETE `/asset-categories/:id` (Admin)
Soft-deactivate. **Blocked (`409 CONFLICT`) if any asset or child category references it.** **Response 204.** (Blocked = returns 409, does NOT hard-delete.)

### 4.5 GET `/asset-categories/:id/fields`
**Response 200 / `data`:** array of field definitions:
```json
[
  {
    "id": "uuid",
    "categoryId": "uuid",
    "key": "imei",
    "label": "IMEI",
    "type": "string",
    "options": null,
    "required": true,
    "isSearchable": true,
    "isIdentifier": true,
    "sortOrder": 1
  }
]
```

### 4.6 POST `/asset-categories/:id/fields` (Admin)
**Request:**
```json
{
  "key": "storage",
  "label": "Storage",
  "type": "select",
  "options": ["64 GB","128 GB","256 GB"],
  "required": false,
  "isSearchable": true,
  "isIdentifier": false,
  "sortOrder": 3
}
```
**Response 201 / `data`:** field definition. Errors: `400 VALIDATION_ERROR`, `409 CONFLICT` (duplicate `key` within category).

### 4.7 DELETE `/asset-categories/fields/:fieldId` (Admin)
Remove a custom column definition. **Response 204.** (Existing `AssetCustomFieldValue` rows for it are deleted too.)

### 4.8 GET `/assets`
Search/filter assets (paginated). Query params: `q` (code/name/IMEI/serial substring), `categoryId`, `condition`, `status`, `roomId`, `currentHolderEmployeeId`, `page`, `pageSize`.
**Response 200 — list envelope; `data` item:**
```json
{
  "id": "uuid",
  "code": "PHN-000123",
  "name": "Samsung Galaxy A12",
  "serialNumber": null,
  "qty": 1,
  "condition": "GOOD",
  "status": "AVAILABLE",
  "roomId": null,
  "currentHolderEmployeeId": null,
  "notes": null,
  "createdAt": "...",
  "updatedAt": "...",
  "category": { "id": "uuid", "name": "Phones", "kind": "physical" },
  "phoneDetail": null,
  "customFields": {}            // { fieldKey: value, ... } flattened
}
```
Filtering on `q` MUST match `code`, `name`, `serialNumber`, and IMEI (via `PhoneDetail.imei`).

### 4.9 GET `/assets/:id`
Detail incl. custom fields, photos, and timeline. **Response 200 / `data`:**
```json
{
  "id": "uuid",
  "code": "PHN-000123",
  "name": "Samsung Galaxy A12",
  "serialNumber": null,
  "qty": 1,
  "condition": "GOOD",
  "status": "ASSIGNED",
  "roomId": null,
  "currentHolderEmployeeId": "uuid",
  "notes": null,
  "createdAt": "...",
  "updatedAt": "...",
  "category": { "id": "uuid", "name": "Phones" },
  "phoneDetail": {
    "assetId": "uuid",
    "imei": "352957084322001",
    "color": "Black",
    "storage": "64 GB",
    "model": "SM-A125F",
    "appBinary": "business"
  } | null,
  "customFields": {},
  "photos": [ { "id": "uuid", "type": "FRONT", "url": "/uploads/phn-000123-front.jpg", "mimeType": "image/jpeg" } ],
  "timeline": [ /* AssignmentTimelineEntry objects, see §9 */ ]
}
```
**Errors:** `404 NOT_FOUND`.

### 4.10 POST `/assets` (Admin)
**Request:**
```json
{
  "categoryId": "uuid",
  "name": "Samsung Galaxy A12",
  "serialNumber": null,
  "qty": 1,
  "condition": "NEW",
  "roomId": null,
  "notes": null,
  "phoneDetail": { "imei": "352957084322001", "color": "Black", "storage": "64 GB", "model": "SM-A125F", "appBinary": "business" },
  "customFields": { "someKey": "value" }
}
```
`phoneDetail` is required iff `category.kind` is the Phones category (or a category flagged phone-like); `customFields` keys must match the category's declared `AssetCategoryField.key`s (unknown keys → `400 VALIDATION_ERROR`).
**Response 201 / `data`:** full asset object (as 4.9). Errors: `409 CONFLICT` (duplicate IMEI).

### 4.11 PATCH `/assets/:id` (Admin)
Partial: `name`, `serialNumber`, `qty`, `condition`, `roomId`, `status`, `notes`, `phoneDetail`, `customFields` (merged per-field). **Response 200 / `data`:** full asset.

### 4.12 POST `/assets/:id/photos` (Admin)
`multipart/form-data`, field `files` (repeatable). Allowed mime: `image/jpeg`, `image/png`, `image/webp`. Max file size enforced by config (`MAX_UPLOAD_MB`, default 10). Each part may carry a form field `type` (`FRONT`|`BACK`|`CONDITION`|`GENERAL`).
**Response 201 / `data`:** `{ "photos": [ { "id":"uuid","type":"FRONT","url":"/uploads/...","mimeType":"image/jpeg","sizeBytes":12345 } ] }`.
**Errors:** `400 VALIDATION_ERROR` (bad mime/oversize).

### 4.13 GET `/photos/:id/file`
Streams a stored image (auth required, capability `inventory:read`). **Response 200:** the image bytes with the stored `Content-Type`, `Content-Disposition: inline`, `Cache-Control: private, max-age=3600`. This is the target of every photo `url` (`/api/v1/photos/:id/file`).
**Visibility:** a photo is exactly as visible as its parent. An asset photo follows the asset detail rule (asset room, else the holder's room); an assignment photo follows the assignment rule of 7.1 (seat room, else employee room). `ADMIN`/`MANAGER` = everything; `TEAM_LEADER` = own room; `CALL_CENTER_MANAGER` = every `CALLCENTER` room. An asset with no room and no holder is visible to `ADMIN`/`MANAGER` only. Account photos are never shown to scoped users.
**Errors:** `401 UNAUTHORIZED`; `404 NOT_FOUND` for a photo outside the caller's scope (never 403, existence is not leaked), for an unknown id, or when the file is missing on disk.

---

## 5. Employees, Departments, Rooms, Work Identities

### 5.1 GET `/employees`
List (scoped; paginated). Query: `q`, `departmentTeamId`, `roomId`, `status`, `page`, `pageSize`.
Scope: `TEAM_LEADER` = employees of their own room; `CALL_CENTER_MANAGER` = employees of every `CALLCENTER` room; `ADMIN`/`MANAGER` = all. `?roomId=` narrows **inside** the caller's scope and never widens it (a scoped user asking for another room gets an empty list).
**Response 200 — `data` item:**
```json
{
  "id": "uuid",
  "fullName": "Ayşe Yılmaz",
  "departmentTeamId": "uuid",
  "roomId": "uuid",
  "phoneContact": "+90 530 000 00 00",
  "internalEmail": null,
  "status": "ACTIVE",
  "notes": null,
  "createdAt": "...",
  "department": { "id": "uuid", "name": "Data entry", "type": "CALLCENTER" },
  "room": { "id": "uuid", "code": "TR1" }
}
```

### 5.2 POST `/employees` (Admin)
**Request:**
```json
{
  "fullName": "Ayşe Yılmaz",
  "departmentTeamId": "uuid",
  "roomId": "uuid",
  "phoneContact": "+90 530 000 00 00",
  "internalEmail": null,
  "notes": null
}
```
`status` defaults to `ACTIVE`. **Response 201 / `data`:** employee. Errors: `409 CONFLICT` (`fullName`+`departmentTeamId` duplicate, per §5 A4).

### 5.3 PATCH `/employees/:id` (Admin)
Partial, fields as above incl. `status`. **Response 200 / `data`:** employee.

### 5.4 GET `/employees/:id`
Detail + device history. Uses the **same scope as the list (5.1)**: an employee outside the caller's scope answers `404 NOT_FOUND` (existence is not leaked) — a Team Leader of another room, and a Team Leader / Call-centre manager asking for an employee with no (call-centre) room. **Response 200 / `data`:** employee object plus:
```json
{
  "...employee fields...",
  "history": [
    {
      "assignmentId": "uuid",
      "assignmentCode": "A-000042",
      "assetCode": "PHN-000123",
      "assetName": "Samsung Galaxy A12",
      "workIdentityName": "sofia",
      "status": "ACTIVE",
      "assignedAt": "...",
      "returnedAt": null
    }
  ]
}
```

### 5.5 GET `/departments`
List department teams/subcategories (tree by `type`). **Response 200 / `data`:**
```json
{
  "HOSPITAL":   [ { "id":"uuid","name":"Odeme","type":"HOSPITAL" }, { "id":"uuid","name":"Muhasebe","type":"HOSPITAL" } ],
  "CALLCENTER": [ { "id":"uuid","name":"Coordinator","type":"CALLCENTER" } ]
}
```

### 5.6 POST / PATCH / DELETE `/departments` (Admin)
- `POST /departments`: `{ "name", "type", "parentId"? }` → 201.
- `PATCH /departments/:id`: `{ "name"? }` → 200.
- `DELETE /departments/:id`: soft; `409 CONFLICT` if employees reference it → 204.

### 5.7 GET `/rooms`
List rooms. **Response 200 / `data`:**
```json
[
  { "id": "uuid", "code": "TR1", "teamType": "CALLCENTER", "managerEmployeeId": "uuid" | null }
]
```

### 5.8 PATCH `/rooms/:id` (Admin)
**Request:** `{ "managerEmployeeId": "uuid" | null }`. **Response 200 / `data`:** room.

### 5.9 GET `/work-identities`
List (scoped; paginated). Query: `roomId`, `departmentTeamId`, `isActive`, `q`, `page`, `pageSize`.
**Response 200 — `data` item:**
```json
{
  "id": "uuid",
  "name": "sofia",
  "roomId": "uuid",
  "departmentTeamId": null,
  "isActive": true,
  "notes": "Call-center seat"
}
```

### 5.10 POST `/work-identities` (Admin)
**Request:**
```json
{
  "name": "sofia",
  "roomId": "uuid",
  "departmentTeamId": null,
  "isActive": true,
  "notes": null
}
```
**Response 201 / `data`:** work identity. Errors: `400 VALIDATION_ERROR`, `409 CONFLICT` (duplicate `name` in same room).

### 5.11 PATCH `/work-identities/:id` (Admin)
Partial: `name`, `roomId`, `departmentTeamId`, `isActive`, `notes`. **Response 200 / `data`:** work identity.

---

## 6. Accounts

### 6.1 GET `/accounts`
List (searchable; paginated; credentials masked for non-Admin). Query: `q`, `kind`, `subcategory`, `isActive`, `isWhatsAppBackup`, `page`, `pageSize`.
**Response 200 — `data` item:**
```json
{
  "id": "uuid",
  "assetId": null,
  "kind": "GMAIL",
  "subcategory": "GMail-for-WhatsApp-Backup",
  "identifier": "class3447@gmail.com",
  "email": "class3447@gmail.com",
  "passwordEnc": null,          // ALWAYS null in lists even for Admin
  "isWhatsAppBackup": true,
  "isActive": true,
  "currentAssignmentId": null,
  "notes": null
}
```

### 6.2 POST `/accounts` (Admin)
**Request:**
```json
{
  "assetId": null,
  "kind": "GMAIL",
  "subcategory": "GMail-for-WhatsApp-Backup",
  "identifier": "class3447@gmail.com",
  "email": "class3447@gmail.com",
  "password": "plaintext-password",   // server encrypts with AES-256-GCM
  "isWhatsAppBackup": true,
  "notes": null
}
```
**Response 201 / `data`:** account object (`passwordEnc` omitted). **Errors:** `400 VALIDATION_ERROR` (password required for GMAIL/WHATSAPP/BITRIX).

### 6.3 PATCH `/accounts/:id` (Admin)
Partial (same fields; send `password` to rotate). **Response 200 / `data`:** account.

### 6.4 GET `/accounts/:id/decrypt` (Admin)
Decrypt and audit. **Response 200 / `data`:**
```json
{
  "id": "uuid",
  "kind": "GMAIL",
  "identifier": "class3447@gmail.com",
  "password": "decrypted-plaintext"
}
```
**Errors:** `403 DECRYPT_NOT_ALLOWED` (non-Admin), `404 NOT_FOUND`. Decryption is written to `AuditLog`.

### 6.5 POST `/accounts/:id/photos` (Admin)
Multipart proof docs; same rules as asset photos (§4.12). **Response 201 / `data`: `{ "photos": [...] }`.**

---

## 7. Assignments (generic + phone)

### 7.1 GET `/assignments`
List/filter (paginated). Query: `type`, `status`, `employeeId`, `workIdentityId`, `roomId`, `q` (assignmentCode/assetCode/IMEI/employee name), `page`, `pageSize`.
**Room rule (one rule for list, detail and photos):** an assignment's room is its work identity's (seat) room, else the employee's room. `TEAM_LEADER` = assignments in their own room; `CALL_CENTER_MANAGER` = assignments in any `CALLCENTER` room; `ADMIN`/`MANAGER` = all. `?roomId=` narrows inside the caller's scope (same seat-else-employee rule) and never widens it.
**Response 200 — `data` item (summary, no nested detail):**
```json
{
  "id": "uuid",
  "assignmentCode": "A-000042",
  "type": "PHONE",
  "employeeId": "uuid",
  "employeeName": "Ayşe Yılmaz",
  "workIdentityId": "uuid",
  "workIdentityName": "sofia",
  "assetId": "uuid",
  "assetCode": "PHN-000123",
  "assetName": "Samsung Galaxy A12",
  "status": "ACTIVE",
  "assignedAt": "...",
  "expectedReturnAt": "...",
  "returnedAt": null,
  "createdById": "uuid"
}
```

### 7.2 GET `/assignments/:id`
Detail with items + phone detail. Same room rule and scope as 7.1: an assignment outside the caller's scope answers `404 NOT_FOUND`, so a row returned by the list can always be opened. `items[]` expose `id`, `assetId`, `role`, `isActive`, `conditionAtHandover`, `returnCondition` and `asset`. **Response 200 / `data`:**
```json
{
  "id": "uuid",
  "assignmentCode": "A-000042",
  "type": "PHONE",
  "employee": { "id":"uuid","fullName":"Ayşe Yılmaz" },
  "workIdentity": { "id":"uuid","name":"sofia" },
  "status": "ACTIVE",
  "assignedAt": "...",
  "expectedReturnAt": "...",
  "returnedAt": null,
  "notes": null,
  "createdById": "uuid",
  "items": [
    { "id":"uuid", "assetId":"uuid", "role":"PRIMARY", "isActive": true, "conditionAtHandover":"GOOD", "returnCondition": null,
      "asset": { "id":"uuid", "code":"PHN-000123", "name":"Samsung Galaxy A12" } }
  ],
  "phoneDetail": {
    "sim1Number": "905369700889",
    "sim1AssetId": "uuid",
    "wa1Business": true,
    "wa1PhoneNumber": "905369700889",
    "wa1BackupEmail": "class3447@gmail.com",
    "wa1BackupDate": "2026-05-17T00:00:00.000Z",
    "wa1BackupUsedGB": 12.0,
    "wa1BackupTotalGB": 15.0,
    "wa1ChatNormalCount": 4500,
    "wa1ChatArchivedCount": 210,
    "wa1AppVariant": "BUSINESS",

    "sim2Number": null,
    "sim2AssetId": null,
    "wa2Business": false,
    "wa2PhoneNumber": null,
    "wa2BackupEmail": null,
    "wa2BackupDate": null,
    "wa2BackupUsedGB": null,
    "wa2BackupTotalGB": null,
    "wa2ChatNormalCount": null,
    "wa2ChatArchivedCount": null,
    "wa2AppVariant": null,

    "bitrixAccountId": "uuid",
    "chargerCableAssetId": "uuid",
    "chargerAdapterAssetId": "uuid",
    "notes": null
  } | null,
  "photos": [ { "id":"uuid","type":"FRONT","url":"/uploads/...","mimeType":"image/jpeg" } ]
}
```
`phoneDetail` is `null` unless `type === "PHONE"` (or the phone draft). `photos` filtered by `assignmentId`.

### 7.3 POST `/assignments` (Admin)
Create a **draft** (generic or pre-scoped). **Request:**
```json
{
  "type": "PHONE",
  "employeeId": "uuid",
  "workIdentityId": "uuid",
  "assetId": "uuid",            // PRIMARY asset
  "notes": null
}
```
**Response 201 / `data`:** assignment with `status: "DRAFT"`. Errors: `409 CONFLICT` if `assetId` is already part of an ACTIVE assignment; `400 VALIDATION_ERROR`.

### 7.4 POST `/assignments/:id/activate` (Admin)
Finalize a DRAFT → ACTIVE. Writes handover snapshot timeline entries and flips all involved assets to `ASSIGNED`. No body. Required: assignment has a PRIMARY item (and phoneDetail complete for PHONE type).
**Response 200 / `data`:**
```json
{ "id": "uuid", "status": "ACTIVE", "assignedAt": "...", "expectedReturnAt": "..." }
```
**Errors:** `400 VALIDATION_ERROR` (incomplete), `409 CONFLICT` (asset already ASSIGNED).

### 7.5 PATCH `/assignments/:id` (Admin)
Edit an open (DRAFT or ACTIVE) assignment. Partial. Any change appends an `UPDATED` timeline entry with a snapshot.
**Request (partial):** any of `notes`, `employeeId`, `workIdentityId`, `expectedReturnAt`, plus nested `phoneDetail` (whole object replaces), plus `items` (array of `{ assetId, role }` to add as items).
**Response 200 / `data`:** full assignment (as 7.2).

### 7.6 POST `/assignments/phone` (Admin)
Submit a **complete** phone assignment in one call (creates DRAFT then activates, or just creates ACTIVE — see note). This is the **core wizard submit** for §3.2.
**Request:**
```json
{
  "employeeId": "uuid",
  "workIdentityId": "uuid",
  "phoneAssetId": "uuid",                      // => PRIMARY item
  "imei": "352957084322001",
  "sim1Number": "905369700889",
  "sim1AssetId": "uuid",
  "wa1Business": true,
  "wa1PhoneNumber": "905369700889",
  "wa1BackupEmail": "class3447@gmail.com",
  "wa1BackupDate": "2026-05-17",
  "wa1BackupUsedGB": 12,
  "wa1BackupTotalGB": 15,
  "wa1ChatNormalCount": 4500,
  "wa1ChatArchivedCount": 210,
  "wa1AppVariant": "BUSINESS",

  "sim2Number": null,
  "sim2AssetId": null,
  "wa2Business": null,
  "wa2PhoneNumber": null,
  "wa2BackupEmail": null,
  "wa2BackupDate": null,
  "wa2BackupUsedGB": null,
  "wa2BackupTotalGB": null,
  "wa2ChatNormalCount": null,
  "wa2ChatArchivedCount": null,
  "wa2AppVariant": null,

  "bitrixAccountId": "uuid",
  "chargerCableAssetId": "uuid",
  "chargerAdapterAssetId": "uuid",
  "notes": null
}
```
**Response 201 / `data`:** activated assignment (as 7.2, `status: "ACTIVE"`). Note: the README names this `POST /assignments/phone` — implement it as creating + activating atomically; intermediate DRAFT is internal.
Optional extra body fields: `workIdentity` (`{name, departmentTeamId?, roomId?}`, find-or-create instead of `workIdentityId`), `expectedReturnAt`, `condition` (condition of the phone at handover). The body is strict (unknown keys → 400).

**Errors:** `400 VALIDATION_ERROR` (all required §3.2 fields), `409 CONFLICT` (see 7.6.1).

#### 7.6.1 Validation and availability rules (apply to `/assignments/phone` and `/assignments/generic`)
Order: body schema → ids → business rules → availability (inside the transaction).

1. **Ids are validated first (400).** An unknown id answers `400 "<field> does not exist"`; an id of the wrong category answers `400 "<field> must be an asset of the \"<category>\" category (...)"`. This replaces the former FK-violation 409. Fields and required categories: `sim1AssetId`, `sim2AssetId` = "SIM Cards"; `chargerCableAssetId` = "Charger Cables"; `chargerAdapterAssetId` = "Charger Adapters"; `phoneAssetId` = "Phones". Unknown `employeeId`, `workIdentityId`, `bitrixAccountId` also answer 400.
2. **Every involved asset must be handover-ready (409).** The phone, SIM 1/2, charger cable/adapter (generic: the primary and every accessory) must each have `status = AVAILABLE`, no current holder, and be in no active assignment. Otherwise `409 CONFLICT`:
   `Asset "<code>" (<name>) is not available for handover: status <S>[, held by <employee>][, in active assignment <A-code>]`
   `error.details = { assetId, assetCode, status, heldBy, assignmentCode }`.
3. **Concurrency.** Concurrent requests for the same asset or phone number: exactly one succeeds (201), the rest get `409`, never `5xx`.
4. **Phone numbers (one namespace).** Numbers are compared digits-only (`+90 536 970 08 89` == `905369700889`) in a single namespace shared by SIM and WhatsApp numbers. A number already used by another **ACTIVE** assignment answers `409 CONFLICT`:
   `Phone number "<n>" is already in use (SIM 1 | SIM 2 | WhatsApp 1 | WhatsApp 2) by active assignment A-000012`, or
   `WhatsApp account "<n>" is already in use by active assignment A-000012`.
   `error.details = { number, slot?, assignmentCode }`. The number is free again once that assignment is `RETURNED`.
5. **Other 400s:** `sim1Number` ≠ `wa1PhoneNumber`, or `sim2Number` ≠ `wa2PhoneNumber` ("the SIM number is the single source"); slot-1 number equals slot-2 number; the same asset in two slots; body `imei` differing from the IMEI recorded on the phone asset (or supplied for a phone that has none).

### 7.6a POST `/assignments/generic` (Admin)
Create **and activate** a non-phone assignment atomically (types `LAPTOP`, `PRINTER`, `SIM`, `GENERAL`, `COMPUTERS`, `MONITORS`, `MOUSE`, `KEYBOARDS`, `HEADPHONES`; a Phones-category asset must go through 7.6). The body is strict.
**Request:**
```json
{
  "type": "LAPTOP",
  "employeeId": "uuid",
  "workIdentityId": null,
  "workIdentity": null,
  "assetId": "uuid",
  "accessoryAssetIds": ["uuid", "uuid"],
  "accessoryConditions": [ { "assetId": "uuid", "condition": "FAIR" } ],
  "conditionAtHandover": "GOOD",
  "expectedReturnAt": null,
  "notes": null
}
```
- `assetId` = PRIMARY item and keeps the top-level `conditionAtHandover` (required; `NEW|GOOD|FAIR|POOR|DAMAGED|DISPOSED`). Each accessory becomes a bundled item.
- `accessoryAssetIds` (max 20) and `accessoryConditions` (max 20, strict `{assetId, condition}` objects) may each be omitted or `null`.
- Each `accessoryConditions[].assetId` must be listed in `accessoryAssetIds` and appear once; its `condition` becomes that accessory's `conditionAtHandover`. Accessories without an entry default to `GOOD`.
- **Response 201 / `data`:** activated assignment (as 7.2, `status: "ACTIVE"`).
- **Errors:** the availability rule (409) and id rules (400) of 7.6.1 apply. Additional `400`: duplicate ids in `accessoryAssetIds`; `assetId` also listed as an accessory; unknown accessory ids (message lists them); a Phones-category asset; an `accessoryConditions` entry that is not in `accessoryAssetIds` or is duplicated.

### 7.7 GET `/assignments/draft/:id`
Resume an unfinished DRAFT assignment. **Response 200 / `data`:** assignment with `status: "DRAFT"` (as 7.2). **Errors:** `404 NOT_FOUND`, `409 CONFLICT` if not DRAFT.

---

## 8. Return / Handback

### 8.1 GET `/assignments/:id/return-form`
Pre-filled **out-state** snapshot for the return UI (two-column comparison: Handover | Return).
**Response 200 / `data`:**
```json
{
  "assignmentId": "uuid",
  "assignmentCode": "A-000042",
  "out": {
    "employeeFullName": "Ayşe Yılmaz",
    "workIdentityName": "sofia",
    "assetCode": "PHN-000123",
    "assetName": "Samsung Galaxy A12",
    "condition": "GOOD",
    "wa1ChatNormalCount": 4500,
    "wa1ChatArchivedCount": 210,
    "wa1BackupDate": "2026-05-17",
    "wa1BackupUsedGB": 12,
    "wa1BackupTotalGB": 15,
    "wa2ChatNormalCount": null,
    "wa2ChatArchivedCount": null,
    "sim1Number": "905369700889",
    "sim2Number": null,
    "bitrixAccountId": "uuid",
    "chargerCableAssetId": "uuid",
    "chargerAdapterAssetId": "uuid"
  }
}
```
`out` contains every comparable field as of handover. **Errors:** `404 NOT_FOUND` (or 409 if not ACTIVE).

### 8.2 POST `/assignments/:id/return` (Admin)
Submit the **return-state**; server compares, writes `ReturnRecord` + `ReturnComparisonField` rows + `RETURNED` timeline entry, flips assets to `AVAILABLE` (discrepancies flagged, do not block).
**Request:**
```json
{
  "returnCondition": "FAIR",
  "returnNotes": "Charger cable missing",
  "return": {
    "wa1ChatNormalCount": 5120,
    "wa1ChatArchivedCount": 240,
    "wa1BackupDate": "2026-10-01",
    "wa1BackupUsedGB": 8,
    "wa1BackupTotalGB": 15,
    "wa2ChatNormalCount": null,
    "wa2ChatArchivedCount": null,
    "sim1Number": "905369700889",
    "sim2Number": null,
    "bitrixAccountId": null,
    "chargerCableAssetId": null,
    "chargerAdapterAssetId": "uuid",
    "newPhotos": [ "BASE64_OR_UPLOADED_REF" ]
  }
}
```
The `return` object mirrors the `out` object from 8.1; omitted keys are treated as **unchanged** (copied from out). Missing SIM/account/charger → `isDiscrepancy: true`.
**Response 200 / `data`:**
```json
{
  "assignmentId": "uuid",
  "assignmentCode": "A-000042",
  "status": "RETURNED",
  "returnedAt": "...",
  "hasDiscrepancies": true,
  "discrepancies": [
    {
      "fieldKey": "wa1ChatNormalCount",
      "label": "Chat count (normal)",
      "valueAtHandover": 4500,
      "valueAtReturn": 5120,
      "isDiscrepancy": false,
      "severity": "INFO"
    },
    {
      "fieldKey": "chargerCableAssetId",
      "label": "Charger cable",
      "valueAtHandover": "uuid-cable",
      "valueAtReturn": null,
      "isDiscrepancy": true,
      "severity": "CRITICAL"
    }
  ]
}
```
Discrepancy severity heuristic (server): value changed but non-missing → `INFO`/`WARNING`; a required item (SIM/account/charger) missing → `CRITICAL`.
**Errors:** `400 VALIDATION_ERROR`, `409 CONFLICT` (not ACTIVE).

---

## 9. Timelines

`AssignmentTimelineEntry` object shape (used everywhere):
```json
{
  "id": "uuid",
  "assignmentId": "uuid",
  "assetId": "uuid",
  "employeeId": "uuid",
  "workIdentityId": "uuid | null",
  "eventType": "ASSIGNED",
  "snapshot": { } ,          // opaque JSON captured at event time
  "createdById": "uuid",
  "createdAt": "..."
}
```
Entries are **append-only** — no update/delete endpoints exist.

### 9.1 GET `/assets/:id/timeline`
Item-level timeline (paginated). Query: `eventType`, `page`, `pageSize`.
**Response:** list envelope of `AssignmentTimelineEntry` (ordered `createdAt` desc).

### 9.2 GET `/assignments/:id/timeline`
Assignment timeline (paginated). **Response:** list envelope of entries.

### 9.3 GET `/employees/:id/timeline`
Employee device history (paginated). **Response:** list envelope of entries.

---

## 10. Reports (Manager/Admin; Team Leader own-room scope)

All report endpoints return `data` as an **array of row objects** in the `{ "data": [...] }` envelope (no `meta`, but accept `page`/`pageSize`).

### 10.1 GET `/reports/who-has-what`
Query: `scope` (`room`|`team`|`category`), `roomId?`, `departmentTeamId?`, `categoryId?`.
**Row:**
```json
{
  "employeeFullName": "Ayşe Yılmaz",
  "workIdentityName": "sofia",
  "roomCode": "TR1",
  "assetCode": "PHN-000123",
  "assetName": "Samsung Galaxy A12",
  "categoryName": "Phones",
  "assignmentCode": "A-000042",
  "assignedAt": "...",
  "expectedReturnAt": "..."
}
```

### 10.2 GET `/reports/condition`
Query: `categoryId?`, `status?`.
**Row:**
```json
{ "categoryName": "Phones", "condition": "GOOD", "count": 42 }
```

### 10.3 GET `/reports/backup-staleness`
Uses configured threshold (default **> 7 days**). Query: `days?` (override threshold).
**Row:**
```json
{
  "assetCode": "PHN-000123",
  "assetName": "Samsung Galaxy A12",
  "wa1PhoneNumber": "905369700889",
  "wa1BackupDate": "2026-05-17",
  "wa1BackupUsedGB": 12,
  "daysSinceBackup": 155,
  "employeeFullName": "Ayşe Yılmaz",
  "workIdentityName": "sofia"
}
```

### 10.4 GET `/reports/outstanding-assignments`
Open assignments past `expectedReturnAt`. Query: `days?` (only flag assignments overdue by ≥ N days).
**Row:**
```json
{
  "assignmentCode": "A-000042",
  "type": "PHONE",
  "status": "ACTIVE",
  "employeeFullName": "Ayşe Yılmaz",
  "assetCode": "PHN-000123",
  "assignedAt": "...",
  "expectedReturnAt": "...",
  "daysOverdue": 12
}
```

### 10.5 GET `/reports/room-composition`
Query: `roomId?`.
**Row:**
```json
{
  "roomCode": "TR1",
  "managerFullName": "Ayşe Yılmaz",
  "employeeFullName": "Ayşe Yılmaz",
  "workIdentityName": "sofia",
  "assignedAssetCodes": ["PHN-000123"]
}
```

### 10.6 GET `/reports/:id/export`
`id` = id of a report definition (`who-has-what`, `condition`, `backup-staleness`, `outstanding-assignments`, `room-composition`) or its slug. Pass the same query filters. **Response 200:** file download (CSV or XLSX; `Accept: text/csv` or `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`). Not JSON.
**Errors:** `403 FORBIDDEN` (Team Leader / Call-centre manager cannot export); `404 NOT_FOUND` (unknown report).

**CSV format** (UTF-8 with BOM, CRLF line endings, header row = the humanised column names of the JSON table):
- **Dates** are ISO-8601 UTC without milliseconds: `YYYY-MM-DDTHH:MM:SSZ` (e.g. `2026-11-21T07:51:30Z`). Never a JS `Date.toString()` form such as `... GMT+0000 (Coordinated Universal Time)`.
- **Formula-injection guard:** a text cell whose first character is `=`, `+`, `-`, `@`, TAB or CR is prefixed with a single quote (`'=SUM(A1)`), so spreadsheets keep it inert. Real numbers (e.g. a negative count) and booleans are untouched.
- Cells containing `,`, `"` or line breaks are RFC-4180 quoted.

**Pagination applies to exports (known behaviour).** The export honours `page` / `pageSize` exactly like the JSON report: without them a CSV/XLSX holds at most the first **25 rows** (`pageSize` max 100). Example: 30 active assignments → 25 CSV rows, 30 with `pageSize=100`. **Open question:** a silently truncated export may not be intended; product/backend must decide whether `/reports/:id/export` should ignore pagination. Until decided, clients that need a full export must pass `pageSize=100` and page through.

---

### 10.7 GET `/audit-logs` (Admin only)
Paginated, newest first (`createdAt desc`). Capability `audit:read` = `ADMIN` only (others `403`). Query: `page`, `pageSize`, `actorId` (uuid), `action` (substring, case-insensitive), `targetType` (substring, case-insensitive), `targetId` (uuid), `q` (substring of action or targetType), `from`, `to`.
- `from`: inclusive lower bound on `createdAt`. A date-only value (`YYYY-MM-DD`) means 00:00:00 UTC of that day.
- `to`: a **date-only** value (`YYYY-MM-DD`) means *through the end of that day (UTC)* (`createdAt < next day 00:00 UTC`); a full timestamp stays an exact **inclusive** bound.
- An unparseable `from`/`to` → `400 VALIDATION_ERROR`.
**Response 200:** `{ "data": [ { "id", "action", "targetType", "targetId", "createdAt", "...", "actor": { "id", "fullName", "username" } } ], "meta": { page envelope as 1.3 } }` (log row columns are returned as stored; `actor` is the acting user).

---

## 11. Role scope enforcement (applies to every read)

| Capability | Admin | Manager | Team Leader |
|---|---|---|---|
| All rooms/assets | ✅ | ✅ | 🔒 own `roomId` only |
| Reports | ✅ | ✅ | own room only | 
| Export | ✅ | ✅ | ❌ |
| Credentials (decrypt) | ✅ | masked | ‑ |

Team Leader queries are filtered server-side by `roomId` (the value from their User/scope). `CALL_CENTER_MANAGER` is scoped to every `CALLCENTER` room (employees, assets, assignments, photos, reports) and is read-only, like Manager, but cannot export. Out-of-scope single entities answer `404 NOT_FOUND`, not 403. Manager is read-only (writes → `403 FORBIDDEN`). Middleware decodes JWT → sets `req.user { id, role, roomScope }` → route guards enforce.

---

## 12. Status codes summary

| Status | Used for |
|--------|----------|
| 200 | Successful GET / PATCH / POST(activate, return) |
| 201 | Successful creation (`POST /...` returning a new object) |
| 204 | No-body success (`DELETE`, `logout`, password/patch plain) |
| 400 | Validation / malformed |
| 401 | Unauthenticated / expired token |
| 403 | Forbidden (role, scope, decrypt) |
| 404 | Missing resource |
| 409 | Conflict (duplicate, dual-active, in-use) |
| 500 | Internal |
