'use strict';
const prisma = require('../db');
const { badRequest, conflict, notFound } = require('../utils/errors');

/** AssetCondition values (mirrors the Prisma enum), ordered best → worst: NEW > GOOD > FAIR > POOR > DAMAGED > DISPOSED.
 *  classifyCondition() relies on that order to tell a worsening from an improvement. */
const CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'DISPOSED'];
/** A valid AssetCondition or null — keeps loosely-typed return-form values away from Prisma enums. */
const asCondition = (v) => (typeof v === 'string' && CONDITIONS.includes(v) ? v : null);

/**
 * Status an asset takes when it comes back, decided by the condition it comes back in (Phase 7 #5):
 *   NEW / GOOD / FAIR → AVAILABLE  (reusable)
 *   POOR / DAMAGED    → AVAILABLE  (still assignable — the asset's condition carries the problem;
 *                                   IN_REPAIR exists in AssetStatus but stays a manual decision)
 *   DISPOSED          → DISPOSED   (written off)
 */
const statusForReturnedCondition = (condition) => (condition === 'DISPOSED' ? 'DISPOSED' : 'AVAILABLE');

/**
 * BE-2 / BE-3 — Return / handback comparison engine.
 *
 * Owns the single source of truth for the *comparable field set*: the exact set of
 * fields that the wizard DTO and the return form both use, their human labels, their
 * JSON storage kind, and whether a missing value at return-time is a required-item
 * (SIM / account / charger) that must be flagged CRITICAL.
 *
 * All values passed in/out are JSON-safe scalars (number | string | null),
 * never Prisma Decimal/Date instances.
 */
const COMPARABLE_FIELDS = [
  { key: 'condition', label: 'Phone condition', kind: 'enum', requiredItem: false },
  { key: 'sim1Number', label: 'SIM 1 number', kind: 'string', requiredItem: true },
  { key: 'sim2Number', label: 'SIM 2 number', kind: 'string', requiredItem: false },
  { key: 'bitrixAccountId', label: 'Bitrix account', kind: 'id', requiredItem: true },
  { key: 'chargerCableAssetId', label: 'Charger cable', kind: 'id', requiredItem: true },
  { key: 'chargerAdapterAssetId', label: 'Charger adapter', kind: 'id', requiredItem: true },
  { key: 'wa1ChatNormalCount', label: 'Chat count (normal) · WhatsApp 1', kind: 'number' },
  { key: 'wa1ChatArchivedCount', label: 'Chat count (archived) · WhatsApp 1', kind: 'number' },
  { key: 'wa1BackupDate', label: 'Backup date · WhatsApp 1', kind: 'date' },
  { key: 'wa1BackupUsedGB', label: 'Backup used (GB) · WhatsApp 1', kind: 'number' },
  { key: 'wa1BackupTotalGB', label: 'Backup total (GB) · WhatsApp 1', kind: 'number' },
  { key: 'wa1BackupEmail', label: 'Backup email · WhatsApp 1', kind: 'string' },
  { key: 'wa2ChatNormalCount', label: 'Chat count (normal) · WhatsApp 2', kind: 'number' },
  { key: 'wa2ChatArchivedCount', label: 'Chat count (archived) · WhatsApp 2', kind: 'number' },
  { key: 'wa2BackupDate', label: 'Backup date · WhatsApp 2', kind: 'date' },
  { key: 'wa2BackupUsedGB', label: 'Backup used (GB) · WhatsApp 2', kind: 'number' },
  { key: 'wa2BackupTotalGB', label: 'Backup total (GB) · WhatsApp 2', kind: 'number' },
  { key: 'wa2BackupEmail', label: 'Backup email · WhatsApp 2', kind: 'string' },
];

const comparableKeys = () => COMPARABLE_FIELDS.map((f) => f.key);

/** Scalar-normalise a value from a Prisma row (Decimal/Date/undefined/empty string → JSON-safe). */
function norm(value, kind) {
  if (value === undefined || value === null) return null;
  if (kind === 'number' && typeof value === 'object' && value !== null && typeof value.toNumber === 'function') {
    return value.toNumber();
  }
  if (kind === 'number' && typeof value === 'number') return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10); // YYYY-MM-DD (contract §8.1)
  if (typeof value === 'string' && value.trim() === '') return null;
  return value;
}

/** Extract the flattenable comparable value from a PhoneAssignmentDetail row by field key. */
function outField(pd, { key, kind }) {
  let v = pd?.[key];
  if (key === 'condition') {
    v = null; // condition lives on the PRIMARY AssignmentItem, supplied by caller
  }
  return norm(v, kind);
}

/**
 * Resolve a kind:'id' comparable field to a human-readable label (BE-1):
 *  - Bitrix account   → Account.email ?? Account.identifier
 *  - charger cable/adapter asset → `code — name`
 * Falls back to the raw stored id only when the referenced row is missing (so the
 * comparison never falsely treats a present-but-unresolved value as absent).
 */
function resolveLabel(pd, f) {
  const raw = pd?.[f.key];
  if (f.key === 'bitrixAccountId') {
    const a = pd?.bitrixAccount;
    return a ? (a.email || a.identifier) : (raw ?? null);
  }
  const rel = f.key === 'chargerCableAssetId' ? 'chargerCableAsset' : f.key === 'chargerAdapterAssetId' ? 'chargerAdapterAsset' : null;
  const asset = rel ? pd?.[rel] : null;
  if (asset) return `${asset.code} — ${asset.name}`;
  return raw ?? null;
}

/** Return a photo row as a client-safe summary (no on-disk internals). */
function photoSummary(p) {
  return {
    id: p.id,
    type: p.type,
    fileName: p.fileName,
    mimeType: p.mimeType,
    sizeBytes: p.sizeBytes,
    context: p.context,
    createdAt: p.createdAt,
    url: `/api/v1/photos/${p.id}/file`,
  };
}

/** Split a hydrated assignment's photos into handover (HANDOVER) vs return (RETURN) sets (BE-1). */
function photoSets(assignment) {
  const photos = assignment.photos ?? [];
  return {
    handover: photos.filter((p) => p.context !== 'RETURN').map(photoSummary),
    return: photos.filter((p) => p.context === 'RETURN').map(photoSummary),
  };
}

/** Build the `out` snapshot object for the return form (contract §8.1) from a hydrated assignment. */
function buildOutSnapshot(assignment) {
  const pd = assignment.phoneDetail ?? {};
  const primaryItem = (assignment.items ?? []).find((i) => i.role === 'PRIMARY');
  const out = {
    employeeFullName: assignment.employee?.fullName ?? null,
    workIdentityName: assignment.workIdentity?.name ?? null,
    assetCode: assignment.asset?.code ?? null,
    assetName: assignment.asset?.name ?? null,
    condition: norm(primaryItem?.conditionAtHandover ?? null, 'enum'),
  };
  for (const f of COMPARABLE_FIELDS) {
    if (f.key === 'condition') continue; // already set from primary item
    out[f.key] = f.kind === 'id' ? resolveLabel(pd, f) : outField(pd, f);
  }
  return out;
}

/**
 * Compare out vs return. `returnState` is the raw submitted `return` object whose omitted
 * keys are treated as unchanged (merged from out, contract §8.2). Returns the comparison
 * array shaped like the contract §8.2 response.
 */
function compare(out, returnState) {
  const merged = { ...(out ?? {}) };
  if (returnState && typeof returnState === 'object') Object.assign(merged, returnState);

  return COMPARABLE_FIELDS.map((f) => {
    const a = norm(out?.[f.key], f.kind);
    const b = norm(merged[f.key], f.kind);
    const same = scalarEqual(a, b);
    const { isDiscrepancy, severity } = classify(f, a, b, same);
    return { fieldKey: f.key, label: f.label, valueAtHandover: a, valueAtReturn: b, isDiscrepancy, severity };
  });
}

function scalarEqual(a, b) {
  // Normalise numeric-string drift (e.g. "12" vs 12) for a stable comparison.
  if (typeof a === 'number' && (typeof b === 'number' || b === null || b === '')) {
    if (b === null || b === '') return false;
    return a === Number(b);
  }
  if (a === null || a === undefined || a === '') return b === null || b === undefined || b === '';
  return a === b;
}

/**
 * Condition severity (F-07): ranked by the CONDITIONS order, a return condition worse than the
 * handover one is a discrepancy — WARNING, or CRITICAL when the asset comes back DAMAGED / DISPOSED.
 * The same or a better condition is informational. Returns null when either side is not a known
 * condition, so the generic rule in classify() decides (e.g. a condition that was removed).
 */
function classifyCondition(a, b) {
  const from = CONDITIONS.indexOf(a);
  const to = CONDITIONS.indexOf(b);
  if (from < 0 || to < 0) return null;
  if (to <= from) return { isDiscrepancy: false, severity: 'INFO' }; // same or better
  return { isDiscrepancy: true, severity: b === 'DAMAGED' || b === 'DISPOSED' ? 'CRITICAL' : 'WARNING' };
}

/**
 * Severity classifier (contract §8.2 + BE-2):
 *  - unchanged                     → INFO, isDiscrepancy:false
 *  - condition worse than at handover → WARNING, CRITICAL for DAMAGED/DISPOSED (classifyCondition);
 *                                       same/better → INFO, isDiscrepancy:false
 *  - required item missing at return (was present at out) → CRITICAL, isDiscrepancy:true
 *  - required item changed (still present)                → WARNING, isDiscrepancy:true
 *  - non-required chat/backup delta (both present)        → INFO,  isDiscrepancy:false  (informational drift)
 *  - non-required value removed                           → WARNING, isDiscrepancy:true
 */
function classify(f, a, b, same) {
  if (same) return { isDiscrepancy: false, severity: 'INFO' };
  if (f.key === 'condition') {
    const byRank = classifyCondition(a, b);
    if (byRank) return byRank;
  }
  const aMissing = a === null || a === undefined || a === '';
  const bMissing = b === null || b === undefined || b === '';

  if (f.requiredItem) {
    if (!aMissing && bMissing) return { isDiscrepancy: true, severity: 'CRITICAL' }; // item lost
    if (aMissing && !bMissing) return { isDiscrepancy: true, severity: 'CRITICAL' }; // appeared (unexpected)
    return { isDiscrepancy: true, severity: 'WARNING' }; // changed but present
  }
  if (!aMissing && bMissing) return { isDiscrepancy: true, severity: 'WARNING' }; // removed value
  return { isDiscrepancy: false, severity: 'INFO' }; // informational delta
}

/** Room facts needed to decide whether a TEAM_LEADER / CALL_CENTER_MANAGER may reach an assignment. */
const roomFacts = { roomId: true, room: { select: { teamType: true } } };

async function loadAssignment(id) {
  return prisma.assignment.findUnique({
    where: { id },
    include: {
      employee: { select: { id: true, fullName: true, ...roomFacts } },
      workIdentity: { select: { id: true, name: true, ...roomFacts } },
      asset: { select: { id: true, code: true, name: true } },
      items: { include: { asset: { select: { id: true, code: true, name: true } } } },
      phoneDetail: {
        include: {
          bitrixAccount: { select: { id: true, identifier: true, email: true } },
          chargerCableAsset: { select: { id: true, code: true, name: true } },
          chargerAdapterAsset: { select: { id: true, code: true, name: true } },
        },
      },
      // BE-1: carry both handover + return photos so the return form / result / timeline can compare old-vs-new.
      photos: { orderBy: { createdAt: 'asc' }, select: { id: true, type: true, context: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true } },
    },
  });
}

/**
 * Condition each involved asset comes back in (Phase 7 #5) → Map(assetId → AssetCondition).
 *  - PRIMARY asset: top-level `returnCondition`, else its `itemConditions` entry, else the legacy
 *    `return.condition` form field (the same precedence the primary item record already had).
 *  - every other involved asset (SIM / charger / bundled accessory): its submitted `itemConditions`
 *    entry; assets without one are simply absent from the map (their condition is left untouched).
 * Throws 400 when `itemConditions` names an asset that is not part of this assignment.
 */
function resolveReturnedConditions(assignment, { returnCondition, returnState, itemConditions }) {
  const pd = assignment.phoneDetail ?? {};
  const involved = new Set(
    [
      assignment.assetId,
      ...(assignment.items ?? []).map((i) => i.assetId),
      pd.sim1AssetId, pd.sim2AssetId, pd.chargerCableAssetId, pd.chargerAdapterAssetId,
    ].filter(Boolean),
  );

  const byAsset = new Map();
  for (const { assetId, condition } of itemConditions ?? []) {
    if (!involved.has(assetId)) throw badRequest(`itemConditions: asset ${assetId} is not part of this assignment`);
    byAsset.set(assetId, condition);
  }
  const primary = asCondition(returnCondition) ?? byAsset.get(assignment.assetId) ?? asCondition(returnState?.condition);
  if (primary) byAsset.set(assignment.assetId, primary);
  return byAsset;
}

/**
 * Release the returned assets back to inventory and store the condition each one came back in
 * (Phase 7 #5). Runs inside the return transaction. Per asset:
 *  - asset.condition ← its return condition (only when one is known and it differs);
 *  - status: ASSIGNED → AVAILABLE, or → DISPOSED when it comes back DISPOSED (see
 *    statusForReturnedCondition); an asset that is not ASSIGNED any more keeps its status unless
 *    it comes back DISPOSED; the holder is cleared whenever the status changes. The room is kept —
 *    the last known location stays on the asset so it can still be found (F-26).
 * Returns one summary per asset (primary first): { assetId, code, name, role, from, to, changed, status }.
 */
async function releaseAssets(tx, assignment, assetIds, conditionByAsset) {
  const roleByAsset = new Map((assignment.items ?? []).map((i) => [i.assetId, i.role]));
  const rows = await tx.asset.findMany({
    where: { id: { in: assetIds } },
    select: { id: true, code: true, name: true, condition: true, status: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const summaries = [];
  for (const id of assetIds) {
    const row = byId.get(id);
    if (!row) continue;
    const to = conditionByAsset.get(id) ?? row.condition;
    const status = row.status === 'ASSIGNED' || to === 'DISPOSED' ? statusForReturnedCondition(to) : row.status;

    const data = {};
    if (to !== row.condition) data.condition = to;
    if (status !== row.status) Object.assign(data, { status, currentHolderEmployeeId: null });
    if (Object.keys(data).length) await tx.asset.update({ where: { id }, data });

    summaries.push({
      assetId: id, code: row.code, name: row.name, role: roleByAsset.get(id) ?? null,
      from: row.condition, to, changed: to !== row.condition, status,
    });
  }
  return summaries;
}

/**
 * Execute the return close-out in one transaction (contract §8.2):
 *  - claim the ACTIVE → RETURNED transition first and atomically (F-01): when two returns race, the
 *    loser matches no ACTIVE row, throws 409 and has written nothing
 *  - ReturnRecord + ReturnComparisonField rows
 *  - flip assignment items inactive + set returnCondition (primary + any submitted itemConditions)
 *  - release the assets that came back (ASSIGNED → AVAILABLE / DISPOSED, clear the holder, keep the
 *    last known room) and store the condition each came back in on the asset itself (Phase 7 #5);
 *    required items that did NOT come back (SIM / charger cable / adapter) stay ASSIGNED to the employee
 *  - release every account still bound to this assignment, except a Bitrix account that did not come
 *    back — it stays bound to the assignment exactly like a missing asset (F-05 / F-06)
 *  - append RETURNED (+ DISCREPANCY if any) timeline entries, plus an UPDATED entry on every asset
 *    whose condition changed ({ field:'condition', from, to, assignmentCode })
 * Resolves { hasDiscrepancies, comparison, unreturnedItems, assetConditions, returnedAt, ... }.
 */
async function applyReturn(assignment, { returnCondition, returnNotes, returnState, itemConditions }, user) {
  const out = buildOutSnapshot(assignment);

  // Condition every involved asset comes back in (validated before anything is written).
  const conditionByAsset = resolveReturnedConditions(assignment, { returnCondition, returnState, itemConditions });
  const primaryCondition = conditionByAsset.get(assignment.assetId) ?? null;

  // The comparison sees the condition the primary asset really comes back in (a top-level
  // returnCondition wins over return.condition), so the condition row can never disagree with
  // what is written to the asset. Every other omitted key still means "unchanged" (contract §8.2).
  const comparison = compare(out, primaryCondition ? { ...(returnState ?? {}), condition: primaryCondition } : returnState);
  const hasDiscrepancies = comparison.some((c) => c.isDiscrepancy);
  const conditionField = comparison.find((c) => c.fieldKey === 'condition');

  // Which items came back, decided from the comparison rows (an item handed over but missing at
  // return is "lost"): only those are released; the rest stay bound to the employee as "not returned".
  const returnItems = resolveReturnItems(comparison, assignment);
  const released = assetsReturned(assignment, returnItems);
  const releasedSet = new Set(released);
  const bitrixAccountId = assignment.phoneDetail?.bitrixAccountId ?? null;
  const keepBoundAccountId = bitrixAccountId && wasLost(comparison, 'bitrixAccountId') ? bitrixAccountId : null;

  const returnedAt = new Date();
  const snapshot = {
    assignmentCode: assignment.assignmentCode,
    returnedAt,
    returnedById: user.id,
    returnCondition: primaryCondition,
    returnNotes: returnNotes ?? null,
    out,
    returnState: returnState ?? null,
    comparison,
    photos: photoSets(assignment),
    returnItems: [],
    unreturnedItems: [],
  };

  return prisma.$transaction(async (tx) => {
    // F-01: claim the transition atomically. Concurrent returns of one assignment serialise on this row
    // (a loser waits for the winner's commit, re-evaluates `status = ACTIVE` and matches nothing), so
    // exactly one of them goes on to write a ReturnRecord / comparison / timeline.
    const { count } = await tx.assignment.updateMany({
      where: { id: assignment.id, status: 'ACTIVE' },
      data: { status: 'RETURNED', returnedAt },
    });
    if (count === 0) {
      const current = await tx.assignment.findUnique({ where: { id: assignment.id }, select: { status: true } });
      throw conflict(`Assignment is not ACTIVE (status: ${current?.status ?? 'unknown'}) — only ACTIVE assignments can be returned`);
    }

    const record = await tx.returnRecord.create({
      data: {
        assignmentId: assignment.id,
        returnedAt,
        returnedById: user.id,
        returnCondition: primaryCondition,
        returnNotes: returnNotes ?? null,
      },
    });

    await tx.returnComparisonField.createMany({
      data: comparison.map((c) => ({
        returnRecordId: record.id,
        fieldKey: c.fieldKey,
        label: c.label,
        valueAtHandover: c.valueAtHandover === null ? null : JSON.stringify(c.valueAtHandover),
        valueAtReturn: c.valueAtReturn === null ? null : JSON.stringify(c.valueAtReturn),
        isDiscrepancy: c.isDiscrepancy,
        severity: c.severity,
      })),
    });

    // Mark every item inactive and store the condition it came back in: the PRIMARY item gets the
    // return condition, any other returned item its submitted itemConditions entry (SIM/charger
    // items without one are left blank — they have no meaningful condition of their own).
    for (const [, item] of returnItems) {
      const data = { isActive: false };
      const itemCondition = releasedSet.has(item.assetId) ? conditionByAsset.get(item.assetId) : null;
      if (itemCondition) data.returnCondition = itemCondition;
      await tx.assignmentItem.updateMany({
        where: { assignmentId: assignment.id, assetId: item.assetId },
        data,
      });
    }

    // Release the returned assets and write the condition each one came back in onto the asset.
    const assetConditions = await releaseAssets(tx, assignment, released, conditionByAsset);

    // What did not come back: listed in the response and kept in the history.
    const unreturnedItems = await describeUnreturned(tx, assignment, returnItems, Boolean(keepBoundAccountId));
    snapshot.unreturnedItems = unreturnedItems;

    // Create per-item timeline entries
    for (const [, item] of returnItems) {
      const returnedCondition = releasedSet.has(item.assetId) ? conditionByAsset.get(item.assetId) ?? null : null;
      const itemSnapshot = {
        assignmentCode: assignment.assignmentCode,
        type: assignment.type,
        status: 'RETURNED',
        returnedAt,
        returnCondition: returnedCondition,
        returnState: item.returnState,
        missing: item.missing,
      };

      await tx.assignmentTimelineEntry.create({
        data: {
          assignmentId: assignment.id,
          assetId: item.assetId,
          employeeId: assignment.employeeId,
          workIdentityId: assignment.workIdentityId ?? null,
          eventType: item.returnState === 'RETURNED' ? 'RETURNED' : 'NOTE',
          snapshot: itemSnapshot,
          createdById: user.id,
        },
      });

      snapshot.returnItems.push({
        assetId: item.assetId,
        role: item.role,
        returnCondition: itemSnapshot.returnCondition,
        returnState: item.returnState,
        missing: item.missing,
      });
    }

    // Account release: every account bound to this assignment (WhatsApp-backup/Gmail and a Bitrix
    // account that came back) goes back to the pool. A Bitrix account that did not come back keeps
    // its currentAssignmentId — same rule as a missing asset — so it cannot be handed out again.
    await tx.account.updateMany({
      where: { currentAssignmentId: assignment.id, ...(keepBoundAccountId ? { id: { not: keepBoundAccountId } } : {}) },
      data: { currentAssignmentId: null },
    });

    const base = {
      assignmentId: assignment.id,
      assetId: assignment.assetId,
      employeeId: assignment.employeeId,
      workIdentityId: assignment.workIdentityId ?? null,
      createdById: user.id,
    };
    await tx.assignmentTimelineEntry.create({ data: { ...base, eventType: 'RETURNED', snapshot } });
    if (hasDiscrepancies) {
      await tx.assignmentTimelineEntry.create({
        data: { ...base, eventType: 'DISCREPANCY', snapshot: { ...snapshot, discrepancies: comparison.filter((c) => c.isDiscrepancy) } },
      });
    }

    // Asset history (Phase 7 #5): one UPDATED entry per asset whose condition changed on return.
    for (const c of assetConditions.filter((a) => a.changed)) {
      await tx.assignmentTimelineEntry.create({
        data: {
          ...base,
          assetId: c.assetId,
          eventType: 'UPDATED',
          snapshot: { field: 'condition', from: c.from, to: c.to, assignmentCode: assignment.assignmentCode },
        },
      });
    }

    return {
      hasDiscrepancies, comparison, conditionField, record, returnedAt,
      returnItems: snapshot.returnItems, assetConditions, unreturnedItems,
    };
  });
}

/** Items handed over with the phone that the return form can report as "not returned". Each field
 *  stands for one item: `role` is its assignment-item role (also the `kind` listed in
 *  unreturnedItems), `assetIdKey` the PhoneAssignmentDetail column that holds its asset. */
const RETURN_ITEM_FIELDS = [
  { fieldKey: 'sim1Number', role: 'SIM1', assetIdKey: 'sim1AssetId' },
  { fieldKey: 'sim2Number', role: 'SIM2', assetIdKey: 'sim2AssetId' },
  { fieldKey: 'chargerCableAssetId', role: 'CHARGER_CABLE', assetIdKey: 'chargerCableAssetId' },
  { fieldKey: 'chargerAdapterAssetId', role: 'CHARGER_ADAPTER', assetIdKey: 'chargerAdapterAssetId' },
];

/** Order unreturnedItems are listed in; BITRIX (an account, not an asset) comes last. */
const UNRETURNED_KIND_ORDER = [...RETURN_ITEM_FIELDS.map((f) => f.role), 'BITRIX'];

/** True when the comparison shows an item that was handed over but is missing at return — the
 *  "item lost" row (CRITICAL for the required items: SIM 1, charger cable / adapter, Bitrix; a lost SIM 2
 *  is only a WARNING row but is just as unreturned). Omitted return keys are unchanged, not lost. */
function wasLost(comparison, fieldKey) {
  const row = comparison.find((c) => c.fieldKey === fieldKey);
  return Boolean(row) && row.valueAtHandover != null && row.valueAtReturn == null;
}

/**
 * Resolve every item of the assignment into { role, assetId, returnState, missing }, keyed by assetId.
 * An item is missing when the return form drops something that was handed over (see wasLost): a SIM,
 * a charger cable / adapter. PRIMARY and BUNDLED items have no "missing" state in the return form:
 * the primary is always released and bundled accessories come back with it.
 */
function resolveReturnItems(comparison, assignment) {
  const pd = assignment.phoneDetail ?? {};
  const fieldByRole = new Map(RETURN_ITEM_FIELDS.map((f) => [f.role, f]));
  const items = new Map();
  const add = (role, assetId) => {
    const field = fieldByRole.get(role);
    const missing = Boolean(field) && wasLost(comparison, field.fieldKey);
    items.set(assetId, { role, assetId, returnState: missing ? 'NOT_RETURNED' : 'RETURNED', missing });
  };

  // First pass: every item the assignment carries.
  for (const item of assignment.items ?? []) add(item.role, item.assetId);

  // Second pass: SIM / charger assets carried only on the phone record (safety net for items
  // not present in `assignment.items`).
  for (const f of RETURN_ITEM_FIELDS) {
    const id = pd[f.assetIdKey];
    if (id && !items.has(id)) add(f.role, id);
  }

  return items;
}

/** The assets that get released back to inventory on return: the primary asset always, plus every
 *  item that came back. Required items that did not come back stay ASSIGNED to the employee so they
 *  remain blocked from reuse until found or formally disposed of. */
function assetsReturned(assignment, returnItems) {
  const released = new Set([assignment.assetId]);
  for (const item of returnItems.values()) {
    if (!item.missing) released.add(item.assetId);
  }
  return [...released];
}

/**
 * The items that did not come back, as the UI lists them: [{ kind, code, name }].
 *  - a missing asset: kind = its item role (SIM1 | SIM2 | CHARGER_CABLE | CHARGER_ADAPTER),
 *    code/name = the asset's code and name;
 *  - a Bitrix account that did not come back: kind 'BITRIX', code = the account identifier,
 *    name = its e-mail (or 'Bitrix account' when there is none / it equals the identifier).
 */
async function describeUnreturned(tx, assignment, returnItems, bitrixUnreturned) {
  const missing = [...returnItems.values()].filter((i) => i.missing);
  const assets = missing.length
    ? await tx.asset.findMany({ where: { id: { in: missing.map((i) => i.assetId) } }, select: { id: true, code: true, name: true } })
    : [];
  const byId = new Map(assets.map((a) => [a.id, a]));

  const list = missing.map((i) => ({ kind: i.role, code: byId.get(i.assetId)?.code ?? null, name: byId.get(i.assetId)?.name ?? null }));
  if (bitrixUnreturned) {
    const account = assignment.phoneDetail?.bitrixAccount;
    list.push({
      kind: 'BITRIX',
      code: account?.identifier ?? null,
      name: account?.email && account.email !== account.identifier ? account.email : 'Bitrix account',
    });
  }
  return list.sort((a, b) => UNRETURNED_KIND_ORDER.indexOf(a.kind) - UNRETURNED_KIND_ORDER.indexOf(b.kind));
}

/** Guard: an assignment must exist and be ACTIVE to return / pre-fill a return form. */
function assertReturnable(assignment) {
  if (!assignment) throw notFound('Assignment');
  if (assignment.status !== 'ACTIVE') throw conflict(`Assignment is not ACTIVE (status: ${assignment.status}) — only ACTIVE assignments can be returned`);
  return assignment;
}

module.exports = {
  COMPARABLE_FIELDS,
  comparableKeys,
  buildOutSnapshot,
  compare,
  classify,
  loadAssignment,
  applyReturn,
  assertReturnable,
  photoSummary,
  photoSets,
};