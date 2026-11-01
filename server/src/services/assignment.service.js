'use strict';

const prisma = require('../db');
const { conflict, badRequest, notFound } = require('../utils/errors');

const DEFAULT_RETURN_MONTHS = 1;

async function nextAssignmentCode(tx = prisma) {
  const seq = 'assignment_code_seq';
  await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${seq}" START 1`);
  const [{ n }] = await tx.$queryRawUnsafe(`SELECT nextval('${seq}')::int AS n`);
  return `A-${String(n).padStart(6, 0)}`;
}

async function assertAssetsFree(assetIds, tx = prisma, excludeAssignmentId) {
  const unique = [...new Set(assetIds.filter(Boolean))];
  if (!unique.length) return;
  const active = await tx.assignmentItem.findFirst({
    where: { assetId: { in: unique }, isActive: true, ...(excludeAssignmentId ? { assignmentId: { not: excludeAssignmentId } } : {}) },
    select: { asset: { select: { id: true, code: true, name: true } } },
  });
  if (active) {
    throw conflict(`Asset "${active.asset.code}" (${active.asset.name}) is already part of an active assignment`);
  }
}

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

async function assertImeiFree(imei, tx = prisma) {
  if (!imei) return;
  const phone = await tx.phoneDetail.findUnique({ where: { imei }, select: { assetId: true } });
  if (!phone) return;
  const active = await tx.assignmentItem.findFirst({ where: { assetId: phone.assetId, isActive: true }, select: { id: true } });
  if (active) throw conflict(`IMEI ${imei} is already assigned to an active assignment`);
}

async function resolveWorkIdentity({ name, departmentTeamId, roomId }, tx = prisma) {
  const n = String(name ?? '').trim();
  if (!n) throw badRequest('workIdentity.name is required');
  if (roomId) {
    return tx.workIdentity.upsert({
      where: { name_roomId: { name: n, roomId } },
      update: { departmentTeamId: departmentTeamId ?? null, isActive: true },
      create: { name: n, departmentTeamId: departmentTeamId ?? null, roomId, isActive: true },
    });
  }
  const existing = await tx.workIdentity.findFirst({ where: { name: n, departmentTeamId } });
  if (existing) return existing;
  return tx.workIdentity.create({ data: { name: n, departmentTeamId, roomId, isActive: true } });
}

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
    condition,
  } = body;

  const assetIds = phoneAssetIds({ phoneAssetId, sim1AssetId, sim2AssetId, chargerCableAssetId, chargerAdapterAssetId });

  if (sim1Number && wa1PhoneNumber && String(sim1Number).trim() !== String(wa1PhoneNumber).trim()) {
    throw badRequest('sim1Number and wa1PhoneNumber must be equal');
  }
  if (sim2Number && wa2PhoneNumber && String(sim2Number).trim() !== String(wa2PhoneNumber).trim()) {
    throw badRequest('sim2Number and wa2PhoneNumber must be equal');
  }

  return prisma.$transaction(async (tx) => {
    const wid = workIdentityId ?? (workIdentity && (await resolveWorkIdentity(workIdentity, tx)).id);

    const phoneAsset = await tx.asset.findUnique({
      where: { id: phoneAssetId },
      include: { category: { select: { name: true } }, phoneDetail: { select: { imei: true } } },
    });
    if (!phoneAsset) throw badRequest('phoneAssetId does not exist');
    if (phoneAsset.category.name !== 'Phones') throw badRequest('phoneAssetId must be a Phones-category asset');

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

    const items = [
      { assetId: phoneAssetId, role: 'PRIMARY', conditionAtHandover: phoneAsset.condition },
      ...(sim1AssetId ? [{ assetId: sim1AssetId, role: 'SIM1', conditionAtHandover: condition ?? 'GOOD' }] : []),
      ...(sim2AssetId ? [{ assetId: sim2AssetId, role: 'SIM2', conditionAtHandover: condition ?? 'GOOD' }] : []),
      ...(chargerCableAssetId ? [{ assetId: chargerCableAssetId, role: 'CHARGER_CABLE', conditionAtHandover: condition ?? 'GOOD' }] : []),
      ...(chargerAdapterAssetId ? [{ assetId: chargerAdapterAssetId, role: 'CHARGER_ADAPTER', conditionAtHandover: condition ?? 'GOOD' }] : []),
    ];
    await tx.assignmentItem.createMany({
      data: items.map((i) => ({ ...i, assignmentId: assignment.id, isActive: true })),
    });

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

    const widRoom = wid ? await tx.workIdentity.findUnique({ where: { id: wid }, select: { roomId: true } }) : null;
    await tx.asset.updateMany({
      where: { id: { in: assetIds } },
      data: {
        status: 'ASSIGNED',
        currentHolderEmployeeId: employeeId,
        ...(widRoom?.roomId ? { roomId: widRoom.roomId } : {}),
      },
    });

    if (accountIds.length) {
      await tx.account.updateMany({ where: { id: { in: accountIds } }, data: { currentAssignmentId: assignment.id } });
    }

    const snapshot = buildSnapshot(assignment, phoneDetail, items);
    await tx.assignmentTimelineEntry.create({
      data: {
        assignment: { connect: { id: assignment.id } },
        asset: { connect: { id: phoneAssetId } },
        employee: { connect: { id: assignment.employeeId } },
        createdBy: { connect: { id: userId } },
        eventType: 'ASSIGNED',
        snapshot,
        createdById: userId,
      },
    });

    for (const item of items) {
      if (item.assetId === phoneAssetId) continue;
      await tx.assignmentTimelineEntry.create({
        data: {
          assignment: { connect: { id: assignment.id } },
          asset: { connect: { id: item.assetId } },
          employee: { connect: { id: assignment.employeeId } },
          createdBy: { connect: { id: userId } },
          eventType: 'ASSIGNED',
          snapshot,
          createdById: userId,
        },
      });
    }

    return { assignment, phoneDetail, items, snapshot };
  });
}

function buildSnapshot(assignment, phoneDetail, items) {
  return {
    assignmentCode: assignment.assignmentCode,
    type: assignment.type,
    status: assignment.status,
    assignedAt: assignment.assignedAt,
    expectedReturnAt: assignment.expectedReturnAt,
    employeeId: assignment.employeeId,
    workIdentityId: assignment.workIdentityId,
    assetId: assignment.assetId,
    notes: assignment.notes ?? null,
    phoneDetail: phoneDetail ?? null,
    items: items?.map((i) => ({
      assetId: i.assetId,
      role: i.role,
      conditionAtHandover: i.conditionAtHandover,
      isActive: i.isActive ?? true,
    })) ?? [],
  };
}

function phoneAssetIds({ phoneAssetId, sim1AssetId, sim2AssetId, chargerCableAssetId, chargerAdapterAssetId }) {
  const ids = [phoneAssetId];
  if (sim1AssetId) ids.push(sim1AssetId);
  if (sim2AssetId) ids.push(sim2AssetId);
  if (chargerCableAssetId) ids.push(chargerCableAssetId);
  if (chargerAdapterAssetId) ids.push(chargerAdapterAssetId);
  return ids;
}

async function resolvePhoneAccountIds({ bitrixAccountId, wa1PhoneNumber, wa2PhoneNumber }) {
  const accounts = [];
  if (bitrixAccountId) accounts.push(bitrixAccountId);
  if (wa1PhoneNumber) accounts.push(`wa1:${wa1PhoneNumber}`);
  if (wa2PhoneNumber) accounts.push(`wa2:${wa2PhoneNumber}`);
  return accounts;
}

async function createDraft(body, userId) {
  const code = await nextAssignmentCode();
  const now = new Date();
  const expReturn = new Date(now.getTime() + DEFAULT_RETURN_MONTHS * 30 * 24 * 3600 * 1000);
  return prisma.assignment.create({
    data: {
      assignmentCode: code,
      type: 'PHONE',
      employeeId: body.employeeId,
      phoneAssetId: body.phoneAssetId,
      status: 'DRAFT',
      assignedAt: now,
      expectedReturnAt: expReturn,
      notes: body.notes ?? null,
      createdById: userId,
    },
  });
}

async function activate(assignmentId, userId) {
  return prisma.assignment.update({
    where: { id: assignmentId },
    data: { status: 'ACTIVE', updatedAt: new Date() },
  });
}

async function createGenericAssignment(body, userId) {
  const {
    employeeId, workIdentityId, workIdentity, assetId, accessoryAssetIds = [],
    conditionAtHandover, expectedReturnAt, notes,
  } = body;

  return prisma.$transaction(async (tx) => {
    const asset = await tx.asset.findUnique({
      where: { id: assetId },
      include: { category: { select: { name: true } } },
    });
    if (!asset) throw badRequest('assetId does not exist');
    if (asset.category.name === 'Phones') throw badRequest('phone assets must be assigned via /assignments/phone');

    const allAssetIds = [assetId, ...accessoryAssetIds];
    await assertAssetsFree(allAssetIds, tx);

    const wid = workIdentityId ?? (workIdentity && (await resolveWorkIdentity(workIdentity, tx)).id);

    const code = await nextAssignmentCode(tx);
    const now = new Date();
    const expReturn = expectedReturnAt ? new Date(expectedReturnAt) : new Date(now.getTime() + DEFAULT_RETURN_MONTHS * 30 * 24 * 3600 * 1000);

    const assignment = await tx.assignment.create({
      data: {
        assignmentCode: code,
        type: 'GENERIC',
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

    const items = [
      { assignmentId: assignment.id, assetId, role: 'PRIMARY', conditionAtHandover: conditionAtHandover ?? 'GOOD', isActive: true },
      ...accessoryAssetIds.map((id) => ({ assignmentId: assignment.id, assetId: id, role: 'BUNDLED', conditionAtHandover: 'GOOD', isActive: true })),
    ];
    await tx.assignmentItem.createMany({ data: items });

    const widRoom = wid ? await tx.workIdentity.findUnique({ where: { id: wid }, select: { roomId: true } }) : null;
    await tx.asset.updateMany({
      where: { id: { in: allAssetIds } },
      data: {
        status: 'ASSIGNED',
        currentHolderEmployeeId: employeeId,
        ...(widRoom?.roomId ? { roomId: widRoom.roomId } : {}),
      },
    });

    const snapshot = buildSnapshot(assignment, null, items);
    await tx.assignmentTimelineEntry.create({
      data: {
        assignment: { connect: { id: assignment.id } },
        asset: { connect: { id: assignment.assetId } },
        employee: { connect: { id: assignment.employeeId } },
        createdBy: { connect: { id: userId } },
        eventType: 'ASSIGNED',
        snapshot,
        createdById: userId,
      },
    });

    for (const item of items) {
      if (item.assetId === assetId) continue;
      await tx.assignmentTimelineEntry.create({
        data: {
          assignment: { connect: { id: assignment.id } },
          asset: { connect: { id: item.assetId } },
          employee: { connect: { id: assignment.employeeId } },
          createdBy: { connect: { id: userId } },
          eventType: 'ASSIGNED',
          snapshot,
          createdById: userId,
        },
      });
    }

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
