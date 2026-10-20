'use strict';
const prisma = require('../db');
const { conflict, notFound } = require('../utils/errors');

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
 * Severity classifier (contract §8.2 + BE-2):
 *  - unchanged                     → INFO, isDiscrepancy:false
 *  - required item missing at return (was present at out) → CRITICAL, isDiscrepancy:true
 *  - required item changed (still present)                → WARNING, isDiscrepancy:true
 *  - non-required chat/backup delta (both present)        → INFO,  isDiscrepancy:false  (informational drift)
 *  - non-required value removed                           → WARNING, isDiscrepancy:true
 */
function classify(f, a, b, same) {
  if (same) return { isDiscrepancy: false, severity: 'INFO' };
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

async function loadAssignment(id) {
  return prisma.assignment.findUnique({
    where: { id },
    include: {
      employee: { select: { id: true, fullName: true } },
      workIdentity: { select: { id: true, name: true, roomId: true } },
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
 * Resolve the set of asset ids genuinely tied to this assignment (primary phone + SIMs +
 * charger cable/adapter from items, plus the optional phoneDetail charger refs as a safety net).
 */
function involvedAssetIds(assignment) {
  const ids = new Set((assignment.items ?? []).map((i) => i.assetId));
  const pd = assignment.phoneDetail ?? {};
  for (const k of ['sim1AssetId', 'sim2AssetId', 'chargerCableAssetId', 'chargerAdapterAssetId']) {
    if (pd[k]) ids.add(pd[k]);
  }
  return [...ids];
}

/**
 * Execute the return close-out in one transaction (contract §8.2):
 *  - ReturnRecord + ReturnComparisonField rows
 *  - flip assignment items inactive + set returnCondition
 *  - assignment → RETURNED / returnedAt
 *  - release involved assets (ASSIGNED → AVAILABLE, clear holder + room)
 *  - release every account still bound to this assignment (incl. Bitrix)
 *  - append RETURNED (+ DISCREPANCY if any) timeline entries
 */
async function applyReturn(assignment, { returnCondition, returnNotes, returnState }, user) {
  const out = buildOutSnapshot(assignment);
  const comparison = compare(out, returnState);
  const hasDiscrepancies = comparison.some((c) => c.isDiscrepancy);
  const assetIds = involvedAssetIds(assignment);
  const conditionField = comparison.find((c) => c.fieldKey === 'condition');

  const snapshot = {
    assignmentCode: assignment.assignmentCode,
    returnedAt: new Date(),
    returnedById: user.id,
    returnCondition,
    returnNotes: returnNotes ?? null,
    out,
    comparison,
    photos: photoSets(assignment), // BE-1: handover vs return images for the timeline comparison
  };

  return prisma.$transaction(async (tx) => {
    const record = await tx.returnRecord.create({
      data: {
        assignmentId: assignment.id,
        returnedAt: new Date(),
        returnedById: user.id,
        returnCondition: returnCondition ?? null,
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

    await tx.assignmentItem.updateMany({ where: { assignmentId: assignment.id }, data: { isActive: false, ...(returnCondition ? { returnCondition } : {}) } });
    if (returnCondition) {
      // Bring the condition value into the item + mirror into the PRIMARY item for the detail UI.
      await tx.assignmentItem.updateMany({
        where: { assignmentId: assignment.id, role: 'PRIMARY' },
        data: { returnCondition },
      });
    }

    await tx.assignment.update({ where: { id: assignment.id }, data: { status: 'RETURNED', returnedAt: new Date() } });

    if (assetIds.length) {
      await tx.asset.updateMany({ where: { id: { in: assetIds }, status: 'ASSIGNED' }, data: { status: 'AVAILABLE', currentHolderEmployeeId: null, roomId: null } });
    }

    // Account release: Bitrix + any WhatsApp-backup/Gmail account bound to this assignment.
    await tx.account.updateMany({ where: { currentAssignmentId: assignment.id }, data: { currentAssignmentId: null } });

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

    return { hasDiscrepancies, comparison, conditionField, record };
  });
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