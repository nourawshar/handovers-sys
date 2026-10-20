'use strict';
const prisma = require('../db');
const { conflict, badRequest, notFound } = require('../utils/errors');

/**
 * BE-1 — Assignment creation + listing + detail (phone wizard persistence layer).
 *
 * Owns the create-and-activate transaction, the dual-active guard, the handover
 * snapshot builder, and the generic DRAFT→ACTIVE activation path (shared with the
 * phone wizard and reused by Phase-3/4 "other types").
 */

/** Default expected return = assignedAt + 1 month (assumption A2 / README §8). */
const DEFAULT_RETURN_MONTHS = 1;

/**
 * Next human-friendly assignment code, e.g. A-000042 (per-prefix PostgreSQL sequence).
 * Assignment codes use the single-letter prefix "A" (contract §7.1), which the asset
 * code generator rejects (it requires 2–5 letters), so this is its own sequence.
 */
async function nextAssignmentCode(tx = prisma) {
  const seq = 'assignment_code_seq';
  await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${seq}" START 1`);
  const [{ n }] = await tx.$queryRawUnsafe(`SELECT nextval('"${seq}"')::int AS n`);
  return `A-${String(n).padStart(6, '0')}`;
}

/**
 * Assert that none of the given asset ids is already part of an ACTIVE assignment.
 * Throws 409 CONFLICT on the first offender (dual-active guard, contract §7.3/§7.6).
 * @param {string[]} assetIds
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} [excludeAssignmentId] skip items belonging to this assignment (its own DRAFT-reserved items)
 */
async function assertAssetsFree(assetIds, tx = prisma, excludeAssignmentId) {
  const unique = [...new Set(assetIds.filter(Boolean))];
  if (!unique.length) return;
  const active = await tx.assignmentItem.findFirst({
    where: { assetId: { in: unique }, isActive: true, ...(excludeAssignmentId ? { assignmentId: { not: excludeAssignmentId } } : {}) },
    select: { asset: { select: { id: true, code: true, name: true } } },
  });
  if (active) {
    throw conflict(`Asset "${active.asset.code} (${active.asset.name})" is already part of an active assignment`);
  }
}

/**
 * Assert that none of the given account ids is currently bound to an ACTIVE assignment.
 * Throws 409 CONFLICT on the first offender (dual-active guard for accounts, §7.6).
 * @param {string[]} accountIds
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 */
async function assertAccountsFree(accountIds, tx = prisma) {
  const unique = [...new Set(accountIds.filter(Boolean))];
  if (!unique.length) return;
  const used = await tx.account.findFirst({
    where: { id: { in: unique }, currentAssignmentId: { not: null } },
    select: { id: true, identifier: true, currentAssignment: { select: { assignmentCode: true, status: true } } },
  });
  if (used) {
    throw conflict(`Account "${used.identifier}" is already in use by assignment ${used.currentAssignment?.assignmentCode ?? '(unknown)'}`);
  }
}

/**
 * Assert that the given IMEI is not already assigned to an ACTIVE phone assignment.
 * The IMEI lives on the phone's PhoneDetail; a phone already in an ACTIVE assignment
 * is caught by assertAssetsFree, but the IMEI is checked explicitly for clarity.
 * @param {string} imei
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 */
async function assertImeiFree(imei, tx = prisma) {
  if (!imei) return;
  const phone = await tx.phoneDetail.findUnique({ where: { imei }, select: { assetId: true } });
  if (!phone) return;
  const active = await tx.assignmentItem.findFirst({ where: { assetId: phone.assetId, isActive: true }, select: { id: true } });
  if (active) throw conflict(`IMEI ${imei} is already assigned to an active assignment`);
}

/**
 * Resolve a WorkIdentity on-the-fly from { name, departmentTeamId, roomId },
 * creating it or re-activating an existing seat (CHANGE 4, contract §5.10).
 *
 * - Call-center identities (roomId set) use the @unique([name, roomId]) upsert.
 * - Non-call-center identities (roomId null) must NOT use upsert on the compound
 *   key: Postgres treats NULL as distinct in a unique index, so a NULL-room
 *   "name_roomId" upsert can never match. We match explicitly on
 *   name + departmentTeamId via findFirst instead (unique constraint §5.1).
 *
 * Returns the resolved WorkIdentity row ({ id, ... }). Caller uses `.id`.
 */
async function resolveWorkIdentity({ name, departmentTeamId, roomId }, tx = prisma) {
  const n = String(name ?? '').trim();
  if (!n) throw badRequest('workIdentity.name is required');
  if (roomId) {
    // Call-center seat: unique index @unique([name, roomId]) matches exactly.
    return tx.workIdentity.upsert({
      where: { name_roomId: { name: n, roomId } },
      update: { departmentTeamId: departmentTeamId ?? null, isActive: true },
      create: { name: n, departmentTeamId: departmentTeamId ?? null, roomId, isActive: true },
    });
  }
  // Non-call-center: room is null. Match explicitly by name + department.
  const existing = await tx.workIdentity.findFirst({ where: { name: n, departmentTeamId: departmentTeamId ?? null } });
  if (existing) {
    return tx.workIdentity.update({ where: { id: existing.id }, data: { isActive: true, roomId: null } });
  }
  return tx.workIdentity.create({ data: { name: n, departmentTeamId: departmentTeamId ?? null, roomId: null, isActive: true } });
}

/**
 * Build the handover snapshot JSON for a timeline entry (contract §7.6 step 7).
 * Captures the assignment + phoneDetail + item conditions at handover time.
 */
function buildSnapshot(assignment, phoneDetail, items) {
  return {
    assignmentCode: assignment.assignmentCode,
    type: assignment.type,
    status: assignment.status,
    assignedAt: assignment.assignedAt,
    expectedReturnAt: assignment.expectedReturnAt,
    employeeId: assignment.employeeId,
    workIdentityId: assignment.workIdentityId ?? null,
    assetId: assignment.assetId,
    notes: assignment.notes ?? null,
    phoneDetail: phoneDetail ?? null,
    items: (items ?? []).map((i) => ({
      assetId: i.assetId,
      role: i.role,
      conditionAtHandover: i.conditionAtHandover,
    })),
  };
}

/**
 * Resolve the set of asset ids involved in a phone assignment (primary + SIMs + chargers).
 * Used by the dual-active guard and the asset-status flip.
 */
function phoneAssetIds({ phoneAssetId, sim1AssetId, sim2AssetId, chargerCableAssetId, chargerAdapterAssetId }) {
  return [phoneAssetId, sim1AssetId, sim2AssetId, chargerCableAssetId, chargerAdapterAssetId].filter(Boolean);
}

/**
 * Resolve the set of account ids involved in a phone assignment (Bitrix + WhatsApp backups).
 * WhatsApp backup accounts are those whose identifier matches a wa*PhoneNumber or whose
 * isWhatsAppBackup flag is set; the Bitrix account is explicit.
 */
async function resolvePhoneAccountIds({ bitrixAccountId, wa1PhoneNumber, wa2PhoneNumber }, tx = prisma) {
  const ids = new Set(bitrixAccountId ? [bitrixAccountId] : []);
  if (wa1PhoneNumber) {
    const a = await tx.account.findFirst({ where: { identifier: wa1PhoneNumber }, select: { id: true } });
    if (a) ids.add(a.id);
  }
  if (wa2PhoneNumber) {
    const a = await tx.account.findFirst({ where: { identifier: wa2PhoneNumber }, select: { id: true } });
    if (a) ids.add(a.id);
  }
  return [...ids];
}

/**
 * Create a DRAFT assignment (contract §7.3). Generic or pre-scoped.
 * @returns the created assignment (with generated code).
 */
async function createDraft({ type, employeeId, workIdentityId, assetId, expectedReturnAt, notes }, userId) {
  return prisma.$transaction(async (tx) => {
    await assertAssetsFree([assetId], tx);
    const code = await nextAssignmentCode(tx);
    const assignment = await tx.assignment.create({
      data: {
        assignmentCode: code,
        type,
        employeeId,
        workIdentityId: workIdentityId ?? null,
        assetId,
        status: 'DRAFT',
        expectedReturnAt: expectedReturnAt ? new Date(expectedReturnAt) : null,
        notes: notes ?? null,
        createdById: userId,
      },
    });
    // Reserve the primary asset as an active item (DRAFT-reserved, §8).
    await tx.assignmentItem.create({
      data: { assignmentId: assignment.id, assetId, role: 'PRIMARY', conditionAtHandover: 'GOOD', isActive: true },
    });
    return assignment;
  });
}

/**
 * Activate a DRAFT assignment (contract §7.4). Shared by the generic endpoint and the
 * phone wizard. Flips involved assets to ASSIGNED, sets holder + room, writes the
 * ASSIGNED timeline snapshot, and binds accounts.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} assignmentId
 * @param {object} opts { employeeId, workIdentityId, assetIds, accountIds, phoneDetail, items, notes }
 */
async function activate(tx, assignmentId, opts) {
  const assignment = await tx.assignment.findUnique({ where: { id: assignmentId } });
  if (!assignment) throw notFound('Assignment');
  if (assignment.status !== 'DRAFT') throw conflict(`Assignment is not DRAFT (status: ${assignment.status})`);

  const { employeeId, workIdentityId, assetIds = [], accountIds = [], phoneDetail = null, items = [], notes } = opts;
  await assertAssetsFree(assetIds, tx, assignmentId);
  await assertAccountsFree(accountIds, tx);

  const now = new Date();
  const expectedReturnAt = assignment.expectedReturnAt ?? new Date(now.getTime() + DEFAULT_RETURN_MONTHS * 30 * 24 * 3600 * 1000);

  const updated = await tx.assignment.update({
    where: { id: assignmentId },
    data: {
      status: 'ACTIVE',
      assignedAt: now,
      expectedReturnAt,
      ...(employeeId ? { employeeId } : {}),
      ...(workIdentityId !== undefined ? { workIdentityId: workIdentityId ?? null } : {}),
      ...(notes !== undefined ? { notes: notes ?? null } : {}),
    },
  });

  // Flip involved assets to ASSIGNED + set holder + room (from the work identity's room).
  if (assetIds.length) {
    const workIdentity = workIdentityId ? await tx.workIdentity.findUnique({ where: { id: workIdentityId }, select: { roomId: true } }) : null;
    await tx.asset.updateMany({
      where: { id: { in: assetIds } },
      data: {
        status: 'ASSIGNED',
        currentHolderEmployeeId: employeeId ?? null,
        ...(workIdentity?.roomId ? { roomId: workIdentity.roomId } : {}),
      },
    });
  }

  // Bind accounts to this assignment.
  if (accountIds.length) {
    await tx.account.updateMany({ where: { id: { in: accountIds } }, data: { currentAssignmentId: assignmentId } });
  }

  // Write the ASSIGNED handover snapshot timeline entry.
  const snapshot = buildSnapshot(updated, phoneDetail, items);
  await tx.assignmentTimelineEntry.create({
    data: {
      assignmentId,
      assetId: assignment.assetId,
      employeeId: updated.employeeId,
      workIdentityId: updated.workIdentityId ?? null,
      eventType: 'ASSIGNED',
      snapshot,
      createdById: updated.createdById,
    },
  });

  return { assignment: updated, snapshot };
}

/**
 * The core phone wizard (contract §7.6): create + activate atomically in one transaction.
 * @returns the fully hydrated ACTIVE assignment.
 */
async function createPhoneAssignment(body, userId) {
  const {
    employeeId, workIdentityId, workIdentity, phoneAssetId, imei,
    sim1Number, sim1AssetId,
    wa1Business, wa1PhoneNumber, wa1BackupEmail, wa1BackupDate, wa1BackupUsedGB, wa1BackupTotalGB,
    wa1ChatNormalCount, wa1ChatArchivedCount, wa1AppVariant,
    sim2Number, sim2AssetId,
    wa2Business, wa2PhoneNumber, wa2BackupEmail, wa2BackupDate, wa2BackupUsedGB, wa2BackupTotalGB,
    wa2ChatNormalCount, wa2ChatArchivedCount, wa2AppVariant,
    bitrixAccountId, chargerCableAssetId, chargerAdapterAssetId,
    expectedReturnAt, notes,
  } = body;

  const assetIds = phoneAssetIds({ phoneAssetId, sim1AssetId, sim2AssetId, chargerCableAssetId, chargerAdapterAssetId });

    // SIM-single-source invariant (SIM_WHATSAPP_CORRECTIONS_PLAN): the SIM number and the
    // WhatsApp number must be the same. Enforce server-side so a bad client can't corrupt the record.
    if (sim1Number && wa1PhoneNumber && String(sim1Number).trim() !== String(wa1PhoneNumber).trim()) {
      throw badRequest('sim1Number and wa1PhoneNumber must be equal (the SIM number is the single source)');
    }
    if (sim2Number && wa2PhoneNumber && String(sim2Number).trim() !== String(wa2PhoneNumber).trim()) {
      throw badRequest('sim2Number and wa2PhoneNumber must be equal (the SIM number is the single source)');
    }

    return prisma.$transaction(async (tx) => {
    // workIdentityId (legacy) takes precedence; otherwise upsert the seat on-the-fly.
    const wid = workIdentityId ?? (workIdentity && (await resolveWorkIdentity(workIdentity, tx)).id);

    // Validate the phone asset is a Phones-category asset.
    const phoneAsset = await tx.asset.findUnique({
      where: { id: phoneAssetId },
      include: { category: { select: { name: true } }, phoneDetail: { select: { imei: true } } },
    });
    if (!phoneAsset) throw badRequest('phoneAssetId does not exist');
    if (phoneAsset.category.name !== 'Phones') throw badRequest('phoneAssetId must be a Phones-category asset');

    // Dual-active guards: assets, IMEI, accounts.
    await assertAssetsFree(assetIds, tx);
    await assertImeiFree(imei ?? phoneAsset.phoneDetail?.imei, tx);
    const accountIds = await resolvePhoneAccountIds({ bitrixAccountId, wa1PhoneNumber, wa2PhoneNumber }, tx);
    await assertAccountsFree(accountIds, tx);

    const code = await nextAssignmentCode(tx);
    const now = new Date();
    const expReturn = expectedReturnAt ? new Date(expectedReturnAt) : new Date(now.getTime() + DEFAULT_RETURN_MONTHS * 30 * 24 * 3600 * 1000);

    const assignment = await tx.assignment.create({
      data: {
        assignmentCode: code,
        type: 'PHONE',
        employeeId,
        workIdentityId: wid ?? null,
        assetId: phoneAssetId,
        status: 'ACTIVE',
        assignedAt: now,
        expectedReturnAt: expReturn,
        notes: notes ?? null,
        createdById: userId,
      },
    });

    // Assignment items: PRIMARY + SIM1 + SIM2 + CHARGER_CABLE + CHARGER_ADAPTER (only for present assets).
    const items = [
      { assetId: phoneAssetId, role: 'PRIMARY', conditionAtHandover: phoneAsset.condition },
      ...(sim1AssetId ? [{ assetId: sim1AssetId, role: 'SIM1', conditionAtHandover: 'GOOD' }] : []),
      ...(sim2AssetId ? [{ assetId: sim2AssetId, role: 'SIM2', conditionAtHandover: 'GOOD' }] : []),
      ...(chargerCableAssetId ? [{ assetId: chargerCableAssetId, role: 'CHARGER_CABLE', conditionAtHandover: 'GOOD' }] : []),
      ...(chargerAdapterAssetId ? [{ assetId: chargerAdapterAssetId, role: 'CHARGER_ADAPTER', conditionAtHandover: 'GOOD' }] : []),
    ];
    await tx.assignmentItem.createMany({
      data: items.map((i) => ({ ...i, assignmentId: assignment.id, isActive: true })),
    });

    // Phone assignment detail (full §3.2 field set).
    const phoneDetail = await tx.phoneAssignmentDetail.create({
      data: {
        assignmentId: assignment.id,
        sim1Number: sim1Number ?? null,
        sim1AssetId: sim1AssetId ?? null,
        wa1Business: wa1Business ?? false,
        wa1PhoneNumber: wa1PhoneNumber ?? null,
        wa1BackupEmail: wa1BackupEmail ?? null,
        wa1BackupDate: wa1BackupDate ? new Date(wa1BackupDate) : null,
        wa1BackupUsedGB: wa1BackupUsedGB ?? null,
        wa1BackupTotalGB: wa1BackupTotalGB ?? null,
        wa1ChatNormalCount: wa1ChatNormalCount ?? null,
        wa1ChatArchivedCount: wa1ChatArchivedCount ?? null,
        wa1AppVariant: wa1AppVariant ?? null,
        sim2Number: sim2Number ?? null,
        sim2AssetId: sim2AssetId ?? null,
        wa2Business: wa2Business ?? false,
        wa2PhoneNumber: wa2PhoneNumber ?? null,
        wa2BackupEmail: wa2BackupEmail ?? null,
        wa2BackupDate: wa2BackupDate ? new Date(wa2BackupDate) : null,
        wa2BackupUsedGB: wa2BackupUsedGB ?? null,
        wa2BackupTotalGB: wa2BackupTotalGB ?? null,
        wa2ChatNormalCount: wa2ChatNormalCount ?? null,
        wa2ChatArchivedCount: wa2ChatArchivedCount ?? null,
        wa2AppVariant: wa2AppVariant ?? null,
        bitrixAccountId: bitrixAccountId ?? null,
        chargerCableAssetId: chargerCableAssetId ?? null,
        chargerAdapterAssetId: chargerAdapterAssetId ?? null,
        notes: notes ?? null,
      },
    });

    // Flip assets to ASSIGNED + holder + room.
    const widRoom = wid ? await tx.workIdentity.findUnique({ where: { id: wid }, select: { roomId: true } }) : null;
    await tx.asset.updateMany({
      where: { id: { in: assetIds } },
      data: {
        status: 'ASSIGNED',
        currentHolderEmployeeId: employeeId,
        ...(widRoom?.roomId ? { roomId: widRoom.roomId } : {}),
      },
    });

    // Bind accounts.
    if (accountIds.length) {
      await tx.account.updateMany({ where: { id: { in: accountIds } }, data: { currentAssignmentId: assignment.id } });
    }

    // Handover snapshot timeline entry.
    const snapshot = buildSnapshot(assignment, phoneDetail, items);
    await tx.assignmentTimelineEntry.create({
      data: {
        assignmentId: assignment.id,
        assetId: phoneAssetId,
        employeeId,
        workIdentityId: wid ?? null,
        eventType: 'ASSIGNED',
        snapshot,
        createdById: userId,
      },
    });

    return { assignment, phoneDetail, items, snapshot };
  });
}

/**
 * CHANGE 1 — create + activate a NON-phone assignment atomically in one transaction.
 * Accepts LAPTOP / PRINTER / SIM / GENERAL asset types. PHONE is rejected by the
 * route-level schema (phones must go through /assignments/phone).
 *
 * Flipping the PRIMARY asset to ASSIGNED, setting holder + room from the resolved
 * work identity, writing an ASSIGNED timeline snapshot (phoneDetail:null),
 * and honouring expectedReturnAt.
 *
 * @returns {Promise<{assignment, items, snapshot}>}
 */
async function createGenericAssignment(body, userId) {
  const {
    type, employeeId, workIdentityId, workIdentity, assetId,
    conditionAtHandover, expectedReturnAt, notes,
  } = body;

  return prisma.$transaction(async (tx) => {
    // The PRIMARY asset must exist and must not be a Phones-category asset.
    const asset = await tx.asset.findUnique({ where: { id: assetId }, include: { category: { select: { name: true } } } });
    if (!asset) throw badRequest('assetId does not exist');
    if (asset.category.name === 'Phones') throw badRequest('phone assets must be assigned via /assignments/phone');

    // Dual-active guard (asset already part of an ACTIVE assignment).
    await assertAssetsFree([assetId], tx);

    // workIdentityId (legacy) takes precedence; otherwise upsert the seat on-the-fly.
    const wid = workIdentityId ?? (workIdentity && (await resolveWorkIdentity(workIdentity, tx)).id);

    const code = await nextAssignmentCode(tx);
    const now = new Date();
    const expReturn = expectedReturnAt ? new Date(expectedReturnAt) : new Date(now.getTime() + DEFAULT_RETURN_MONTHS * 30 * 24 * 3600 * 1000);

    const assignment = await tx.assignment.create({
      data: {
        assignmentCode: code,
        type,
        employeeId,
        workIdentityId: wid ?? null,
        assetId,
        status: 'ACTIVE',
        assignedAt: now,
        expectedReturnAt: expReturn,
        notes: notes ?? null,
        createdById: userId,
      },
    });

    const items = [{ assignmentId: assignment.id, assetId, role: 'PRIMARY', conditionAtHandover, isActive: true }];
    await tx.assignmentItem.createMany({ data: items });

    // Flip the asset to ASSIGNED + holder + room (from the work identity's room).
    const widRoom = wid ? await tx.workIdentity.findUnique({ where: { id: wid }, select: { roomId: true } }) : null;
    await tx.asset.updateMany({
      where: { id: assetId },
      data: {
        status: 'ASSIGNED',
        currentHolderEmployeeId: employeeId,
        ...(widRoom?.roomId ? { roomId: widRoom.roomId } : {}),
      },
    });

    // ASSIGNED handover snapshot (no phone detail for generic types).
    const snapshot = buildSnapshot(assignment, null, items);
    await tx.assignmentTimelineEntry.create({
      data: {
        assignmentId: assignment.id,
        assetId,
        employeeId,
        workIdentityId: wid ?? null,
        eventType: 'ASSIGNED',
        snapshot,
        createdById: userId,
      },
    });

    return { assignment, items, snapshot };
  });
}

module.exports = {
  DEFAULT_RETURN_MONTHS,
  nextAssignmentCode,
  assertAssetsFree,
  assertAccountsFree,
  assertImeiFree,
  resolveWorkIdentity,
  buildSnapshot,
  phoneAssetIds,
  resolvePhoneAccountIds,
  createDraft,
  activate,
  createPhoneAssignment,
  createGenericAssignment,
};
