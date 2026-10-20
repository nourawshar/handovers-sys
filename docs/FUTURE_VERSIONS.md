# Deferred Scope / Future Versions

**Repo:** `/opt/data/handovers-sys` · **Stack:** React+TS+Vite `web/`, Express+Prisma `server/`

This is the single consolidated reference for work that is deliberately **out of scope** for the current wave (Phase 4 reports) but is expected to land in a future version. It records the decisions so future waves are unambiguous. It consolidates the SCOPE section of `docs/PHASE_4_IMPLEMENTATION_PLAN.md` and the future-version notes of `docs/FOLLOWUP_PLAN.md`; keep those in sync with this file.

---

## 1. Work-identity CRUD (POST/PATCH/DELETE `/work-identities`) — deferred

- **Status:** deferred. The wizard/drawer and reports read work identities via the existing `GET /work-identities` lookup (`server/src/routes/lookups.routes.js` L57–69). No write endpoint is required for the current wave.
- **When it becomes needed:** when seats are created ad-hoc at assignment time (Phase 2.5 gap, `PHASE_2_IMPLEMENTATION_PLAN.md` §3.6) or when the `/work-identities` management page needs create/edit/delete.
- **What that card adds:** `server/src/routes/work-identities.routes.js` (POST/PATCH/DELETE) + capability `people:write` (already exists, Admin-only) + a write UI on `WorkIdentitiesPage`.

## 2. `sofia` multi-assignment reassignment flow (README G4) — future module

- **Status:** future module, not in the current plan. README §8 state machine: `RETURNED` → `REASSIGNED` (new ACTIVE) for the same asset to a new employee/identity.
- **Prerequisite (already in place):** the Phase-2/3 return flow (`server/src/services/return.service.js` `applyReturn`) flips involved assets to `AVAILABLE` and clears `currentHolderEmployeeId`/`roomId` (L266). A returned asset is immediately assignable again via the existing `POST /assignments/phone` wizard (re-flips to `ASSIGNED`, writes a fresh `ASSIGNED` timeline entry).
- **What a future reassignment card adds:** a dedicated "Reassign" action that creates a new ACTIVE assignment for the same asset to a new employee/work identity, writes a `REASSIGNED` timeline entry (the `TimelineEventType.REASSIGNED` enum value already exists, schema L102), and keeps the old record `RETURNED`. **No schema change needed.**
- **Reports impact:** none — who-has-what and room-composition read live ACTIVE state, so reassignment needs no report change.

## 3. Data-model gaps surfaced by reports

1. **No `isWhatsAppBackup` on `PhoneAssignmentDetail`.** The flag lives on `Account.isWhatsAppBackup` (schema L516). The backup-staleness report keys off **active phone assignments with a non-null `wa1BackupDate`** (R6 in the Phase 4 plan). If the clinic wants staleness to also cover WhatsApp-2 or to require the Account flag, that is a follow-up decision.
2. **`wa1BackupDate` is the single staleness field.** It is the only structured backup-date on the phone assignment detail and is what contract §10.3 exposes. `wa2BackupDate` exists but is not in the contract row — leave it out of the MVP report; a future "both-WA staleness" enhancement would add it.
3. **`Asset.roomId` vs assignment room can diverge.** An asset's `roomId` is set at activation from the work identity's room (assignment.service.js L200, L332) and cleared on return (return.service.js L266). For condition-report scoping prefer `Asset.roomId`; for who-has-what prefer the assignment's room. Documented per-report so the two reports don't disagree.
4. **Export needs a blob-capable client path.** The existing `api.get` parses JSON; the export endpoint returns a file. FE-4 adds a small `api.download` helper (or direct `fetch`) in `client.ts` — the only client-layer addition.

---

*Consolidated from `docs/PHASE_4_IMPLEMENTATION_PLAN.md` (SCOPE section) and `docs/FOLLOWUP_PLAN.md` (future-version notes).*
