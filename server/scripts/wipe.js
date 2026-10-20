'use strict';
/**
 * Wipe business data from the DEV database so a fresh import can start clean.
 * Preserves base structure: User (admin/manager/tl), DepartmentTeam,
 * Room (TR1-TR4) and AssetCategory + AssetCategoryField.
 *
 * Deletes in FK-safe order. Resets asset + assignment code sequences.
 * This is DESTRUCTIVE — targets the dev DB only (DATABASE_URL in server/.env, db 'handovers').
 */
require('dotenv').config();
const prisma = require('../src/db');

async function main() {
  // Clear room manager refs before removing employees.
  await prisma.room.updateMany({ data: { managerEmployeeId: null } });

  // Depth-first delete of everything that is not base structure.
  await prisma.photo.deleteMany();
  await prisma.returnComparisonField.deleteMany();
  await prisma.returnRecord.deleteMany();
  await prisma.phoneAssignmentDetail.deleteMany();
  await prisma.assignmentTimelineEntry.deleteMany();
  await prisma.assignmentItem.deleteMany();
  await prisma.assignment.deleteMany();
  await prisma.account.deleteMany();
  await prisma.assetCustomFieldValue.deleteMany();
  await prisma.phoneDetail.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.workIdentity.deleteMany();
  await prisma.employee.deleteMany();

  // Reset per-prefix asset code sequences and the assignment code sequence.
  const seqs = await prisma.$queryRawUnsafe(
    `SELECT sequencename FROM pg_sequences WHERE schemaname='public' AND (sequencename LIKE 'asset_code_seq_%' OR sequencename='assignment_code_seq')`,
  );
  for (const s of seqs) {
    await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${s.sequencename}"`);
    console.log('dropped sequence', s.sequencename);
  }

  // Report remaining counts for the structure we keep.
  const [users, depts, rooms, cats, fields] = await Promise.all([
    prisma.user.count(),
    prisma.departmentTeam.count(),
    prisma.room.count(),
    prisma.assetCategory.count(),
    prisma.assetCategoryField.count(),
  ]);
  const [assets, accounts, assignments, employees, workIds] = await Promise.all([
    prisma.asset.count(),
    prisma.account.count(),
    prisma.assignment.count(),
    prisma.employee.count(),
    prisma.workIdentity.count(),
  ]);

  console.log('WIPE COMPLETE');
  console.log('kept | users=%d departments=%d rooms=%d categories=%d fields=%d', users, depts, rooms, cats, fields);
  console.log('business | assets=%d accounts=%d assignments=%d employees=%d workIdentities=%d', assets, accounts, assignments, employees, workIds);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());