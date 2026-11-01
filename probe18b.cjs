const BASE = 'http://localhost:3001';
const API = BASE + '/api/v1';
const { PrismaClient } = require('./server/node_modules/.prisma/client');
const p = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
async function main() {
  const login = await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'Admin#12345' }) });
  let cookie = '';
  for (const sc of login.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); const v = pair.slice(i + 1); if (v) cookie += (cookie ? ';' : '') + pair.slice(0, i) + '=' + v; }
  const [computersCat, monitorsCat, cc, tr1, ayse] = await Promise.all([
    p.assetCategory.findFirst({ where: { name: 'Computers' }, select: { id: true } }),
    p.assetCategory.findFirst({ where: { name: 'Monitors' }, select: { id: true } }),
    p.departmentTeam.findFirst({ where: { name: 'Call Center' }, select: { id: true } }),
    p.room.findFirst({ where: { code: 'TR1' }, select: { id: true } }),
    p.employee.findFirst({ where: { fullName: 'Ayse Celik' }, select: { id: true } }),
  ]);
  const mkAsset = async (catId, name) => {
    const r = await fetch(API + '/assets', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ categoryId: catId, name, condition: 'GOOD', status: 'AVAILABLE', roomId: tr1.id }) });
    const j = await r.json();
    console.log('  mkAsset', name, 'status', r.status, 'code', j.data ? j.data.code : JSON.stringify(j.error));
    return j.data;
  };
  const [pc, mon, mouse] = await Promise.all([mkAsset(computersCat.id, 'BE18 PC'), mkAsset(monitorsCat.id, 'BE18 Monitor'), mkAsset(monitorsCat.id, 'BE18 Mouse')]);
  const wid = { name: 'BE18 Seat', departmentTeamId: cc.id, roomId: tr1.id };
  const g = await fetch(API + '/assignments/generic', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'COMPUTERS', employeeId: ayse.id, workIdentity: wid, assetId: pc.id, accessoryAssetIds: [mon.id, mouse.id], conditionAtHandover: 'GOOD' }),
  });
  console.log('generic create status:', g.status);
  const j = await g.json();
  console.log('generic body:', JSON.stringify(j).slice(0, 800));
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
