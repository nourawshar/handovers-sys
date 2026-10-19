'use strict';
// Sanity-check DB-level guarantees: node scripts/check-db.js
require('dotenv').config();
const prisma = require('../src/db');

(async () => {
  const idx = await prisma.$queryRaw`SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('AssignmentItem','PhoneDetail','Asset') AND indexdef ILIKE '%UNIQUE%' ORDER BY indexname`;
  console.log('Unique indexes:');
  idx.forEach((i) => console.log(' -', i.indexname, '\n    ', i.indexdef));
  const acc = await prisma.account.findFirst({ select: { identifier: true, passwordEnc: true } });
  console.log('\nAccount.passwordEnc at rest:', acc.identifier, '->', acc.passwordEnc.slice(0, 40) + '...');
  const tables = await prisma.$queryRaw`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name <> '_prisma_migrations'`;
  console.log('Tables:', tables[0].n);
  const audit = await prisma.auditLog.groupBy({ by: ['action'], _count: true });
  console.log('Audit actions recorded:', audit.map((a) => `${a.action}=${a._count}`).join(', '));
})().finally(() => prisma.$disconnect());
