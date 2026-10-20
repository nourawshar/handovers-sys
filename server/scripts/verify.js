'use strict';
require('dotenv').config();
const prisma = require('../src/db');

async function main() {
  const [employees, workIds, assignments, accounts, assets] = await Promise.all([
    prisma.employee.count(),
    prisma.workIdentity.count(),
    prisma.assignment.count(),
    prisma.account.count(),
    prisma.asset.count(),
  ]);
  console.log('TOTALS  employees=%d workIdentities=%d assignments=%d accounts=%d assets=%d', employees, workIds, assignments, accounts, assets);

  // per-room employees + assignments
  const rooms = await prisma.room.findMany({ orderBy: { code: 'asc' }, include: { _count: { select: { employees: true, workIdentities: true } } } });
  for (const r of rooms) {
    const asg = await prisma.assignment.count({ where: { workIdentity: { roomId: r.id } } });
    const phones = await prisma.asset.count({ where: { roomId: r.id, category: { name: 'Phones' } } });
    const pcs = await prisma.asset.count({ where: { roomId: r.id, category: { name: 'Computers' } } });
    console.log(`ROOM ${r.code}: employees=${r._count.employees} workIdentities=${r._count.workIdentities} assignments=${asg} phones=${phones} pcs=${pcs}`);
  }

  // assets by category
  const cats = await prisma.assetCategory.findMany({ include: { _count: { select: { assets: true } } } });
  for (const c of cats) if (c._count.assets) console.log(`CAT ${c.name}: ${c._count.assets}`);

  // accounts by kind
  const kinds = await prisma.account.groupBy({ by: ['kind'], _count: true });
  for (const k of kinds) console.log(`ACCOUNT ${k.kind}: ${k._count}`);

  // assignments by type
  const atypes = await prisma.assignment.groupBy({ by: ['type'], _count: true });
  for (const a of atypes) console.log(`ASSIGNMENT ${a.type}: ${a._count}`);

  // spot-checks
  const spot = async (empName, label) => {
    const emp = await prisma.employee.findFirst({ where: { fullName: empName }, include: { room: true, assignments: { include: { asset: { include: { phoneDetail: true } }, workIdentity: true, phoneDetail: true } } } });
    if (!emp) { console.log(`SPOT ${label}: employee "${empName}" NOT FOUND`); return; }
    console.log(`\nSPOT ${label}: employee="${emp.fullName}" room=${emp.room?.code}`);
    for (const a of emp.assignments) {
      console.log(`   assignment ${a.assignmentCode} type=${a.type} status=${a.status} asset=${a.asset.name} imei=${a.asset.phoneDetail?.imei} wid=${a.workIdentity?.name} sim1=${a.phoneDetail?.sim1Number} wa1=${a.phoneDetail?.wa1PhoneNumber} backup=${a.phoneDetail?.wa1BackupEmail} storage=${a.asset.phoneDetail?.storage}`);
    }
  };
  await spot('essin', 'sofia (jessica)');
  await spot('osama abo alqomsan', 'Adel');
  await spot('Hazim', 'Hazim (PC-only)');
  await spot('Huda Mesfin Hussein', 'Huda TR3');

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });