'use strict';
/**
 * Phase 2 test fixture — creates ONE realistic ACTIVE phone assignment so the BE-2 return
 * flow can be demonstrated end-to-end (BE-1 assignment-creation endpoints land separately).
 * Safe to re-run: it deletes the fixture assignment first (by its fixed code) and rebuilds it,
 * so it is idempotent without touching other seed data.
 */
require('dotenv').config();
const prisma = require('../src/db');

const CODE = 'A-900001'; // deterministic fixture code (BE-1 will own the real A-<seq> generator)

async function findRefs() {
  const [phone, sim1, bitrix, cable, adapter, employee, wi] = await Promise.all([
    prisma.asset.findUnique({ where: { code: 'PHN-000001' }, include: { category: true } }),
    prisma.asset.findFirst({ where: { code: { startsWith: 'SIM-' } }, orderBy: { code: 'asc' } }),
    prisma.account.findUnique({ where: { kind_identifier: { kind: 'BITRIX', identifier: 'sofia@clinic.bitrix24.com' } } }),
    prisma.asset.findUnique({ where: { code: 'CBL-000001' } }),
    prisma.asset.findUnique({ where: { code: 'ADP-000001' } }),
    prisma.employee.findUnique({ where: { fullName_departmentTeamId: { fullName: 'Sofia Petrova', departmentTeamId: (await prisma.departmentTeam.findUnique({ where: { name: 'Call Center' } })).id } } }),
    prisma.workIdentity.findUnique({ where: { name_roomId: { name: 'sofia', roomId: (await prisma.room.findUnique({ where: { code: 'TR1' } })).id } } }),
  ]);
  if (!phone || !sim1 || !bitrix || !cable || !adapter || !employee || !wi) {
    throw new Error('Fixture refs not found — run npm run seed first');
  }
  return { phone, sim1, bitrix, cable, adapter, employee, wi };
}

async function cleanup(wi, phone, sim1, cable, adapter) {
  const existing = await prisma.assignment.findFirst({ where: { assignmentCode: CODE } });
  if (existing) {
    await prisma.asset.updateMany({
      where: { id: { in: [phone.id, sim1.id, cable.id, adapter.id] } },
      data: { status: 'AVAILABLE', currentHolderEmployeeId: null, roomId: null },
    });
    await prisma.account.updateMany({ where: { currentAssignmentId: existing.id }, data: { currentAssignmentId: null } });
    await prisma.assignmentItem.deleteMany({ where: { assignmentId: existing.id } });
    await prisma.phoneAssignmentDetail.deleteMany({ where: { assignmentId: existing.id } });
    await prisma.assignmentTimelineEntry.deleteMany({ where: { assignmentId: existing.id } });
    await prisma.returnRecord.deleteMany({ where: { assignmentId: existing.id } });
    await prisma.assignment.delete({ where: { id: existing.id } });
  }
}

async function main() {
  const { phone, sim1, bitrix, cable, adapter, employee, wi } = await findRefs();
  const admin = await prisma.user.findUnique({ where: { username: 'admin' }, select: { id: true } });
  await cleanup(wi, phone, sim1, cable, adapter);

  const code = 'A-900001'; // deterministic fixture code (BE-1 will own real A-<seq> generation)
  const assignedAt = new Date();
  const expectedReturnAt = new Date(assignedAt.getTime() + 30 * 24 * 3600 * 1000);

  const assignment = await prisma.$transaction(async (tx) => {
    const a = await tx.assignment.create({
      data: {
        assignmentCode: code,
        type: 'PHONE',
        employeeId: employee.id,
        workIdentityId: wi.id,
        assetId: phone.id,
        status: 'ACTIVE',
        assignedAt,
        expectedReturnAt,
        createdById: admin.id,
      },
    });

    await tx.assignmentItem.createMany({
      data: [
        { assignmentId: a.id, assetId: phone.id, role: 'PRIMARY', conditionAtHandover: 'GOOD' },
        { assignmentId: a.id, assetId: sim1.id, role: 'SIM1', conditionAtHandover: 'NEW' },
        { assignmentId: a.id, assetId: cable.id, role: 'CHARGER_CABLE', conditionAtHandover: 'GOOD' },
        { assignmentId: a.id, assetId: adapter.id, role: 'CHARGER_ADAPTER', conditionAtHandover: 'GOOD' },
      ],
    });

    await tx.phoneAssignmentDetail.create({
      data: {
        assignmentId: a.id,
        sim1Number: '905369700889',
        sim1AssetId: sim1.id,
        wa1Business: true,
        wa1PhoneNumber: '905369700889',
        wa1BackupEmail: 'class3447@gmail.com',
        wa1BackupDate: new Date('2026-05-17T00:00:00Z'),
        wa1BackupUsedGB: 12,
        wa1BackupTotalGB: 15,
        wa1ChatNormalCount: 4500,
        wa1ChatArchivedCount: 210,
        wa1AppVariant: 'BUSINESS',
        bitrixAccountId: bitrix.id,
        chargerCableAssetId: cable.id,
        chargerAdapterAssetId: adapter.id,
        notes: 'Fixture: test assignment for BE-2 return flow',
      },
    });

    // Mark assets ASSIGNED + holder, matching what BE-1's activate step does.
    await tx.asset.updateMany({ where: { id: { in: [phone.id, sim1.id, cable.id, adapter.id] }, status: 'AVAILABLE' }, data: { status: 'ASSIGNED', currentHolderEmployeeId: employee.id, roomId: wi.roomId } });

    // Bind the Bitrix account (in-use release target on return).
    await tx.account.update({ where: { id: bitrix.id }, data: { currentAssignmentId: a.id } });

    const snapshot = { assignmentCode: code, assignedAt, employeeId: employee.id, assetId: phone.id };
    await tx.assignmentTimelineEntry.create({
      data: {
        assignmentId: a.id, assetId: phone.id, employeeId: employee.id, workIdentityId: wi.id,
        eventType: 'ASSIGNED', snapshot, createdById: admin.id,
      },
    });
    return a;
  });

  const out = await prisma.assignment.findUnique({
    where: { id: assignment.id },
    include: {
      employee: { select: { id: true, fullName: true } },
      workIdentity: { select: { id: true, name: true } },
      asset: { select: { id: true, code: true, name: true, status: true } },
      items: { include: { asset: { select: { id: true, code: true, name: true } } } },
      phoneDetail: { select: { id: true, sim1Number: true, wa1ChatNormalCount: true, wa1BackupUsedGB: true, wa1BackupTotalGB: true, bitrixAccountId: true, chargerCableAssetId: true, chargerAdapterAssetId: true } },
    },
  });
  console.log('FIXTURE=' + JSON.stringify(out));
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());