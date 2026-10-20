'use strict';
require('dotenv').config();
const prisma = require('../src/db');
async function main() {
  const depts = await prisma.departmentTeam.findMany({ orderBy: [{ type: 'asc' }, { name: 'asc' }], select: { name: true, type: true } });
  console.log('departments (%d):', depts.length);
  for (const d of depts) console.log('  ', d.type, d.name);
  const rooms = await prisma.room.findMany({ select: { code: true } });
  console.log('rooms:', rooms.map((r) => r.code).join(','));
  const users = await prisma.user.findMany({ select: { username: true, role: true } });
  console.log('users:', users.map((u) => `${u.username}(${u.role})`).join(', '));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
