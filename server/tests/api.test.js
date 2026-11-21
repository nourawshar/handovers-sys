'use strict';
/**
 * Integration smoke tests against a RUNNING server with the seed loaded.
 *   BASE_URL=http://localhost:4000 npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const API = `${BASE}/api/v1`;
const PW = { admin: 'Admin#12345', manager: 'Manager#12345', 'tl.tr1': 'Leader#12345', 'mr.mahmoud': 'Mahmoud#12345' };

class Client {
  constructor() { this.cookies = {}; }
  async req(method, path, { body, form } = {}) {
    const headers = { Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${path}`, { method, headers, body: form ?? (body ? JSON.stringify(body) : undefined) });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (v) this.cookies[pair.slice(0, i)] = v; else delete this.cookies[pair.slice(0, i)];
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }
  async login(u) { const r = await this.req('POST', '/auth/login', { body: { username: u, password: PW[u] } }); assert.equal(r.status, 200); return r; }
}
const as = async (u) => { const c = new Client(); await c.login(u); return c; };

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('auth: bad credentials rejected, unauthenticated blocked', async () => {
  const c = new Client();
  assert.equal((await c.req('POST', '/auth/login', { body: { username: 'admin', password: 'nope' } })).status, 401);
  assert.equal((await c.req('GET', '/assets')).status, 401);
  assert.equal((await c.req('GET', '/auth/me')).status, 401);
});

test('auth: login sets HttpOnly cookies; refresh rotates; old refresh token is rejected (reuse detection)', async () => {
  const c = new Client();
  const login = await c.login('admin');
  const setCookies = login.headers.getSetCookie().join('\n');
  assert.match(setCookies, /access_token=.*HttpOnly/i);
  assert.match(setCookies, /refresh_token=.*HttpOnly/i);
  const oldRefresh = c.cookies.refresh_token;
  assert.equal((await c.req('POST', '/auth/refresh')).status, 200);
  assert.notEqual(c.cookies.refresh_token, oldRefresh);
  assert.equal((await c.req('GET', '/auth/me')).status, 200);
  const replay = new Client(); replay.cookies.refresh_token = oldRefresh;
  const r = await replay.req('POST', '/auth/refresh');
  assert.equal(r.status, 401); assert.equal(r.body.error.code, 'REFRESH_REUSE');
  // reuse revoked the whole family -> the newest token is dead as well
  assert.equal((await c.req('POST', '/auth/refresh')).status, 401);
});

test('auth: logout invalidates the refresh token', async () => {
  const c = await as('admin');
  const rt = c.cookies.refresh_token;
  assert.equal((await c.req('POST', '/auth/logout')).status, 204);
  const r = new Client(); r.cookies.refresh_token = rt;
  assert.equal((await r.req('POST', '/auth/refresh')).status, 401);
});

test('RBAC: manager is read-only; team leader read-only & no accounts/exports', async () => {
  const m = await as('manager');
  assert.equal((await m.req('GET', '/assets')).status, 200);
  assert.equal((await m.req('GET', '/accounts')).status, 200);
  assert.equal((await m.req('POST', '/asset-categories', { body: { name: 'X' } })).status, 403);
  assert.equal((await m.req('POST', '/assets', { body: {} })).status, 403);
  assert.equal((await m.req('GET', '/users')).status, 403);
  const acc = (await m.req('GET', '/accounts')).body.data[0];
  assert.equal(acc.password, '••••••••');
  assert.equal((await m.req('GET', `/accounts/${acc.id}/decrypt`)).status, 403);

  const t = await as('tl.tr1');
  assert.equal((await t.req('GET', '/assets')).status, 200);
  assert.equal((await t.req('GET', '/accounts')).status, 403);
  assert.equal((await t.req('POST', '/assets', { body: {} })).status, 403);
  assert.equal((await t.req('DELETE', `/accounts/${acc.id}`)).status, 403);
});

test('RBAC: team leader only sees assets of own room', async () => {
  const t = await as('tl.tr1');
  const rooms = (await t.req('GET', '/rooms')).body.data;
  assert.equal(rooms.length, 1); assert.equal(rooms[0].code, 'TR1');
  const list = (await t.req('GET', '/assets?pageSize=100')).body.data;
  assert.ok(list.length > 0);
  assert.ok(list.every((a) => a.room?.code === 'TR1'), 'all visible assets must be in TR1');
  const admin = await as('admin');
  const all = (await admin.req('GET', '/assets?pageSize=100')).body;
  assert.ok(all.meta.total > list.length);
  // Pick a TR3 asset through the room filter, not from the first page of the unfiltered newest-first list:
  // on a DB with >99 newer assets the seeded TR3 asset (PHN-000005, the oldest row) is not on that page.
  const tr3 = (await admin.req('GET', '/rooms')).body.data.find((r) => r.code === 'TR3');
  assert.ok(tr3, 'TR3 room seeded');
  const other = (await admin.req('GET', `/assets?roomId=${tr3.id}&pageSize=1`)).body.data[0];
  assert.ok(other, 'at least one asset is in TR3');
  assert.equal(other.room?.code, 'TR3');
  assert.equal((await t.req('GET', `/assets/${other.id}`)).status, 404);
});

test('categories + custom column designer + asset EAV round trip', async () => {
  const a = await as('admin');
  const name = `TestCat ${Date.now()}`;
  const cat = (await a.req('POST', '/asset-categories', { body: { name, codePrefix: 'tst' } })).body.data;
  assert.equal(cat.codePrefix, 'TST');
  const f1 = await a.req('POST', `/asset-categories/${cat.id}/fields`, { body: { key: 'size', label: 'Size', type: 'select', options: ['S', 'M'], required: true } });
  assert.equal(f1.status, 201);
  assert.equal((await a.req('POST', `/asset-categories/${cat.id}/fields`, { body: { key: 'size', label: 'dup', type: 'string' } })).status, 409);
  assert.equal((await a.req('POST', `/asset-categories/${cat.id}/fields`, { body: { key: 'bad', label: 'x', type: 'select' } })).status, 400);
  await a.req('POST', `/asset-categories/${cat.id}/fields`, { body: { key: 'weight', label: 'Weight', type: 'number' } });

  assert.equal((await a.req('POST', '/assets', { body: { categoryId: cat.id, name: 'no size' } })).status, 400); // required missing
  assert.equal((await a.req('POST', '/assets', { body: { categoryId: cat.id, name: 'x', customFields: { size: 'XL' } } })).status, 400); // bad option
  assert.equal((await a.req('POST', '/assets', { body: { categoryId: cat.id, name: 'x', customFields: { size: 'S', nope: 1 } } })).status, 400); // unknown key
  const created = await a.req('POST', '/assets', { body: { categoryId: cat.id, name: 'Thing', customFields: { size: 'M', weight: '12.5' } } });
  assert.equal(created.status, 201);
  assert.match(created.body.data.code, /^TST-\d{6}$/);
  const id = created.body.data.id;
  const detail = (await a.req('GET', `/assets/${id}`)).body.data;
  assert.deepEqual(detail.customFields, { size: 'M', weight: 12.5 });
  assert.equal(detail.customFieldDefinitions.length, 2);
  const patched = await a.req('PATCH', `/assets/${id}`, { body: { condition: 'FAIR', customFields: { weight: 20 } } });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.data.customFields, { size: 'M', weight: 20 });
  assert.equal((await a.req('PATCH', `/assets/${id}`, { body: { customFields: { size: null } } })).status, 400); // cannot clear required
  assert.equal((await a.req('DELETE', `/asset-categories/${cat.id}`)).status, 409); // in use

  // photo upload: valid png ok; non-image & fake png rejected
  const fd = new FormData(); fd.append('type', 'FRONT'); fd.append('photos', new Blob([PNG], { type: 'image/png' }), 'a.png');
  const up = await a.req('POST', `/assets/${id}/photos`, { form: fd });
  assert.equal(up.status, 201);
  const file = await fetch(`${BASE}${up.body.data[0].url}`, { headers: { Cookie: `access_token=${a.cookies.access_token}` } });
  assert.equal(file.status, 200); assert.equal(file.headers.get('content-type'), 'image/png');
  const bad = new FormData(); bad.append('photos', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
  assert.equal((await a.req('POST', `/assets/${id}/photos`, { form: bad })).status, 400);
  const fake = new FormData(); fake.append('photos', new Blob(['not really a png'], { type: 'image/png' }), 'b.png');
  assert.equal((await a.req('POST', `/assets/${id}/photos`, { form: fake })).status, 400);
  const big = new FormData(); big.append('photos', new Blob([Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)])], { type: 'image/png' }), 'big.png');
  assert.equal((await a.req('POST', `/assets/${id}/photos`, { form: big })).status, 413);

  // cleanup: delete asset (no history -> hard delete), then category
  assert.equal((await a.req('DELETE', `/assets/${id}`)).status, 204);
  assert.equal((await a.req('DELETE', `/asset-categories/${cat.id}`)).status, 204);
});

test('unique constraints: duplicate IMEI rejected', async () => {
  const a = await as('admin');
  const phones = (await a.req('GET', '/asset-categories')).body.flat.find((c) => c.name === 'Phones');
  const r = await a.req('POST', '/assets', { body: { categoryId: phones.id, name: 'dup', phone: { imei: '356938035643809' } } });
  assert.equal(r.status, 409);
  const bad = await a.req('POST', '/assets', { body: { categoryId: phones.id, name: 'dup', phone: { imei: '12' } } });
  assert.equal(bad.status, 400);
});

test('accounts: password encrypted at rest, masked in API, admin-only decrypt', async () => {
  const a = await as('admin');
  const ident = `t${Date.now()}@gmail.com`;
  const c = await a.req('POST', '/accounts', { body: { kind: 'GMAIL', identifier: ident, email: ident, password: 'S3cret!pass', isWhatsAppBackup: true } });
  assert.equal(c.status, 201);
  assert.equal(c.body.data.password, '••••••••');
  assert.ok(!JSON.stringify(c.body).includes('S3cret'));
  assert.equal((await a.req('POST', '/accounts', { body: { kind: 'GMAIL', identifier: ident, password: 'x' } })).status, 409);
  const d = await a.req('GET', `/accounts/${c.body.data.id}/decrypt`);
  assert.equal(d.status, 200); assert.equal(d.body.data.password, 'S3cret!pass');
  assert.equal(d.headers.get('cache-control'), 'no-store');
  assert.equal((await a.req('PATCH', `/accounts/${c.body.data.id}`, { body: { password: 'N3w!pass' } })).status, 200);
  assert.equal((await a.req('GET', `/accounts/${c.body.data.id}/decrypt`)).body.data.password, 'N3w!pass');
  assert.equal((await a.req('DELETE', `/accounts/${c.body.data.id}`)).status, 204);
});

test('validation & error handler: malformed ids / json / unknown route', async () => {
  const a = await as('admin');
  assert.equal((await a.req('GET', '/assets/not-a-uuid')).status, 400);
  assert.equal((await a.req('GET', '/assets?pageSize=9999')).status, 400);
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(r.status, 400);
  assert.equal((await a.req('GET', '/nope')).status, 404);
});

test('rooms: full CRUD — create/read/set-manager/delete + 409/400 guards', async () => {
  const prismaMod = require('../src/db');
  const admin = await as('admin');
  const manager = await as('manager');
  const code = `TST-${Date.now()}`;
  const emp = await prismaMod.employee.findFirst({ select: { id: true, fullName: true } });

  // 0) RBAC: writes are Admin-only (people:write)
  assert.equal((await manager.req('POST', '/rooms', { body: { code } })).status, 403);
  assert.equal((await manager.req('DELETE', '/rooms/00000000-0000-0000-0000-000000000000')).status, 403);

  // 1) create -> 201; teamType defaults CALLCENTER; legacy shape (bare data + _count)
  const created = await admin.req('POST', '/rooms', { body: { code } });
  assert.equal(created.status, 201);
  const room = created.body.data;
  assert.equal(room.teamType, 'CALLCENTER');
  assert.equal(room.managerEmployee, null);
  assert.ok('employees' in room._count && 'workIdentities' in room._count);
  const id = room.id;

  // 2) list + detail preserve the legacy shape the FE (useRooms) depends on
  const list = await admin.req('GET', '/rooms');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.data));
  assert.ok(list.body.data.some((r) => r.id === id && r.managerEmployee !== undefined && r._count));
  const detail = await admin.req('GET', `/rooms/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.id, id);

  // 3) duplicate code -> 409 (P2002)
  assert.equal((await admin.req('POST', '/rooms', { body: { code } })).status, 409);

  // 4) unknown manager -> 400
  assert.equal((await admin.req('POST', '/rooms', { body: { code: `${code}-x`, managerEmployeeId: '00000000-0000-0000-0000-000000000000' } })).status, 400);

  // 5) set manager -> 200; clear via null; patch teamType
  const setMgr = await admin.req('PATCH', `/rooms/${id}`, { body: { managerEmployeeId: emp.id } });
  assert.equal(setMgr.status, 200);
  assert.equal(setMgr.body.data.managerEmployee.id, emp.id);
  assert.equal((await admin.req('PATCH', `/rooms/${id}`, { body: { managerEmployeeId: null } })).body.data.managerEmployee, null);
  assert.equal((await admin.req('PATCH', `/rooms/${id}`, { body: { teamType: 'HOSPITAL' } })).body.data.teamType, 'HOSPITAL');

  // 6) delete blocked (409) while referenced — here by a WorkIdentity
  const wi = await prismaMod.workIdentity.create({ data: { name: `t-${Date.now()}`, roomId: id } });
  assert.equal((await admin.req('DELETE', `/rooms/${id}`)).status, 409);
  await prismaMod.workIdentity.delete({ where: { id: wi.id } });

  // 7) clean delete -> 204, then 404 on read
  assert.equal((await admin.req('DELETE', `/rooms/${id}`)).status, 204);
  assert.equal((await admin.req('GET', `/rooms/${id}`)).status, 404);

  await prismaMod.$disconnect();
});

test('return flow: return-form → return (discrepancies) → timeline → double-return 409', async () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  // Deterministic ACTIVE fixture (BE-1 assignment-creation endpoint lands separately).
  execFileSync('node', [path.join(__dirname, '..', 'scripts', 'fixture-return.cjs')], { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
  const prisma = require('../src/db');
  const assignment = await prisma.assignment.findUnique({ where: { assignmentCode: 'A-900001' } });
  const id = assignment.id;
  const admin = await as('admin');

  // 1) return-form pre-fills out-state
  const form = await admin.req('GET', `/assignments/${id}/return-form`);
  assert.equal(form.status, 200);
  assert.equal(form.body.data.out.assetCode, 'PHN-000001');
  assert.equal(form.body.data.out.wa1ChatNormalCount, 4500);

  // 2) submit return with two CRITICAL discrepancies (missing Bitrix + charger cable)
  const ret = await admin.req('POST', `/assignments/${id}/return`, {
    body: { returnCondition: 'FAIR', returnNotes: 'Charger cable missing', return: { wa1ChatNormalCount: 5120, bitrixAccountId: null, chargerCableAssetId: null } },
  });
  assert.equal(ret.status, 200);
  assert.equal(ret.body.data.status, 'RETURNED');
  assert.equal(ret.body.data.hasDiscrepancies, true);
  const crit = ret.body.data.discrepancies.filter((c) => c.isDiscrepancy && c.severity === 'CRITICAL').map((c) => c.fieldKey);
  assert.ok(crit.includes('bitrixAccountId') && crit.includes('chargerCableAssetId'));

  // 3) timeline shows ASSIGNED → RETURNED (+ DISCREPANCY)
  const tl = (await admin.req('GET', `/assignments/${id}/timeline?pageSize=20`)).body.data;
  const types = tl.map((e) => e.eventType);
  assert.ok(types.includes('ASSIGNED') && types.includes('RETURNED') && types.includes('DISCREPANCY'));

  // 4) double-return → 409 (idempotent guard)
  assert.equal((await admin.req('POST', `/assignments/${id}/return`, { body: { returnCondition: 'GOOD', return: {} } })).status, 409);
  // return-form on non-ACTIVE → 409
  assert.equal((await admin.req('GET', `/assignments/${id}/return-form`)).status, 409);

  // 5) the phone goes back to AVAILABLE and loses its holder but keeps its last known room (F-26). The Bitrix
  //    account was dropped from the return (bitrixAccountId: null → CRITICAL) and the charger cable too, so —
  //    like a missing charger — it stays bound to the assignment instead of being freed (F-05 / F-06).
  const tr1 = await prisma.room.findUnique({ where: { code: 'TR1' }, select: { id: true } });
  const phone = await prisma.asset.findUnique({ where: { code: 'PHN-000001' }, select: { status: true, currentHolderEmployeeId: true, roomId: true } });
  assert.equal(phone.status, 'AVAILABLE'); assert.equal(phone.currentHolderEmployeeId, null); assert.equal(phone.roomId, tr1.id);
  const bitrix = await prisma.account.findFirst({ where: { identifier: 'sofia@clinic.bitrix24.com' }, select: { currentAssignmentId: true } });
  assert.equal(bitrix.currentAssignmentId, id);
  assert.deepEqual(ret.body.data.unreturnedItems.map((i) => i.kind), ['CHARGER_CABLE', 'BITRIX']);

  // 6) RBAC: TEAM_LEADER read-only & room-scoped; POST requires Admin
  const tlUser = await as('tl.tr1');
  assert.equal((await tlUser.req('POST', `/assignments/${id}/return`, { body: { return: {} } })).status, 403);
  assert.equal((await tlUser.req('GET', `/assignments/${id}/timeline`)).status, 200);
  await prisma.$disconnect();
});

test('BE-9: assets list items expose customFields with phone_number (SIM dots bug)', async () => {
  const prismaMod = require('../src/db');
  const admin = await as('admin');
  // The seeded SIM Cards category has a required phone_number field; grab its field + a SIM asset.
  const simsCat = await prismaMod.assetCategory.findFirst({ where: { name: 'SIM Cards' }, select: { id: true } });
  assert.ok(simsCat, 'SIM Cards category seeded');
  const sim = await prismaMod.asset.findFirst({ where: { categoryId: simsCat.id }, include: { customValues: true } });
  assert.ok(sim, 'SIM asset seeded');
  const numField = await prismaMod.assetCategoryField.findFirst({ where: { categoryId: simsCat.id, key: 'phone_number' } });
  const expectedNumber = sim.customValues.find((v) => v.fieldId === numField.id)?.value;

  // list (paginated) must include customFields.phone_number — no dots / no "SIM1 number required"
  // narrowed by the SIM's code, so the lookup does not depend on where the row sits in a large category
  const list = await admin.req('GET', `/assets?categoryId=${simsCat.id}&code=${encodeURIComponent(sim.code)}&pageSize=100`);
  assert.equal(list.status, 200);
  const item = list.body.data.find((a) => a.id === sim.id);
  assert.ok(item, 'SIM asset present in category-filtered list');
  assert.equal(item.customFields.phone_number, expectedNumber);
  assert.ok(!('customValues' in item), 'raw EAV rows are not leaked into the list response');

  // raw smoke: some list item shaped at all (customValues rows dropped, customFields map present)
  const all = await admin.req('GET', '/assets?pageSize=100');
  assert.ok(all.body.data.every((a) => 'customFields' in a && !('customValues' in a)), 'every list item is shaped without raw rows');

  // detail still shapes the same way
  const detail = await admin.req('GET', `/assets/${sim.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.customFields.phone_number, expectedNumber);

  await prismaMod.$disconnect();
});

test('BE-9: departments full CRUD — create/read/patch/delete + 409/400 guards, legacy list shape', async () => {
  const prismaMod = require('../src/db');
  const admin = await as('admin');
  const manager = await as('manager');
  const name = `BE9-Dept ${Date.now()}`;
  const parentName = `BE9-Parent ${Date.now()}`;

  // 0) RBAC: writes are Admin-only (people:write); reads open to people:read
  assert.equal((await manager.req('POST', '/departments', { body: { name } })).status, 403);
  assert.equal((await manager.req('DELETE', '/departments/00000000-0000-0000-0000-000000000000')).status, 403);
  assert.equal((await manager.req('GET', '/departments')).status, 200);

  // 1) legacy list shape: bare { data: [...] }, ordered type asc, sortOrder asc, name asc
  const legacy = await admin.req('GET', '/departments');
  assert.equal(legacy.status, 200);
  assert.ok(Array.isArray(legacy.body.data), 'legacy bare array shape preserved');
  assert.ok(legacy.body.data.length >= 12, 'seed departments present');

  // 2) parent + child; parentId must exist -> 400
  const parent = await admin.req('POST', '/departments', { body: { name: parentName, type: 'HOSPITAL', sortOrder: 5 } });
  assert.equal(parent.status, 201);
  assert.equal(parent.body.data.type, 'HOSPITAL');
  assert.equal(parent.body.data.sortOrder, 5);
  const parentId = parent.body.data.id;
  assert.equal((await admin.req('POST', '/departments', { body: { name: `${name}-orphan`, parentId: '00000000-0000-0000-0000-000000000000' } })).status, 400);

  // 3) create child -> 201, type default CALLCENTER, parent linked
  const created = await admin.req('POST', '/departments', { body: { name, parentId } });
  assert.equal(created.status, 201);
  const dept = created.body.data;
  assert.equal(dept.type, 'CALLCENTER');
  assert.equal(dept.parentId, parentId);
  const id = dept.id;

  // 4) duplicate name -> 409 (P2002)
  assert.equal((await admin.req('POST', '/departments', { body: { name } })).status, 409);

  // 5) PATCH: rename + type + sortOrder; parent cleared via null -> 200
  const patched = await admin.req('PATCH', `/departments/${id}`, { body: { name: `${name}-r`, type: 'HOSPITAL', sortOrder: 9, parentId: null } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.name, `${name}-r`);
  assert.equal(patched.body.data.type, 'HOSPITAL');
  assert.equal(patched.body.data.sortOrder, 9);
  assert.equal(patched.body.data.parentId, null);
  // PATCH dangerous guards
  assert.equal((await admin.req('PATCH', `/departments/${id}`, { body: { parentId: id } })).status, 400, 'self-parent rejected');
  assert.equal((await admin.req('PATCH', `/departments/${id}`, { body: { parentId: '00000000-0000-0000-0000-000000000000' } })).status, 400, 'unknown parent rejected');
  assert.equal((await admin.req('PATCH', `/departments/${id}`, { body: { name: parentName } })).status, 409, 'duplicate name on PATCH rejected');
  // restore clean state
  const restored = await admin.req('PATCH', `/departments/${id}`, { body: { name, type: 'CALLCENTER', sortOrder: 0 } });
  assert.equal(restored.status, 200);

  // 6) delete blocked (409) while referenced by an Employee
  const emp = await prismaMod.employee.create({ data: { fullName: `t-${Date.now()}`, departmentTeamId: id } });
  assert.equal((await admin.req('DELETE', `/departments/${id}`)).status, 409);
  await prismaMod.employee.delete({ where: { id: emp.id } });

  // delete blocked (409) while it has a child department
  const child = await prismaMod.departmentTeam.create({ data: { name: `t-child-${Date.now()}`, type: 'CALLCENTER', parentId: id } });
  assert.equal((await admin.req('DELETE', `/departments/${id}`)).status, 409);
  await prismaMod.departmentTeam.delete({ where: { id: child.id } });

  // 7) clean delete -> 204
  assert.equal((await admin.req('DELETE', `/departments/${id}`)).status, 204);
  assert.equal((await admin.req('DELETE', `/departments/${parentId}`)).status, 204);
  const gone = await prismaMod.departmentTeam.count({ where: { id } });
  assert.equal(gone, 0);

  await prismaMod.$disconnect();
});

test('phase5: generic assignment + work-identity upsert idempotency + account-by-number lookup', async () => {
  const prisma = require('../src/db');
  const admin = await as('admin');

  // ---- Fixtures from seed ----
  const laptopsCat = await prisma.assetCategory.findFirst({ where: { name: 'Laptops' }, select: { id: true } });
  const phonesCat = await prisma.assetCategory.findFirst({ where: { name: 'Phones' }, select: { id: true } });
  const banko = await prisma.departmentTeam.findFirst({ where: { name: 'Banko' }, select: { id: true } });
  const cc = await prisma.departmentTeam.findFirst({ where: { name: 'Call Center' }, select: { id: true } });
  const tr1 = await prisma.room.findFirst({ where: { code: 'TR1' }, select: { id: true } });
  const ayse = await prisma.employee.findFirst({ where: { fullName: 'Ayse Celik' }, select: { id: true } });
  const sofia = await prisma.employee.findFirst({ where: { fullName: 'Sofia Petrova' }, select: { id: true } });

  // ---- Create two fresh AVAILABLE laptop assets ----
  const mkLap = async (tag) => {
    const r = await admin.req('POST', '/assets', { body: { categoryId: laptopsCat.id, name: `Ph5 Laptop ${Date.now()}${tag}` } });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.status, 'AVAILABLE');
    return r.body.data;
  };
  const lap1 = await mkLap('a');
  const lap2 = await mkLap('b');

  // ---- CHANGE 5: account-by-number lookup ----
  const found = await admin.req('GET', '/accounts?kind=WHATSAPP&identifier=905369700889');
  assert.equal(found.status, 200);
  assert.equal(found.body.data.length, 1);
  assert.equal(found.body.data[0].identifier, '905369700889');
  assert.ok('email' in found.body.data[0] && 'isWhatsAppBackup' in found.body.data[0]);
  const missing = await admin.req('GET', '/accounts?kind=WHATSAPP&identifier=999000111222');
  assert.equal(missing.status, 200);
  assert.equal(missing.body.data.length, 0); // empty list, not 404

  // ---- Non-call-center WIP (roomId null) + generic create ----
  const wid = { name: `Ph5 Seat ${Date.now()}`, departmentTeamId: banko.id, roomId: null };
  const expReturn = '2027-06-15';
  const g1 = await admin.req('POST', '/assignments/generic', {
    body: { type: 'LAPTOP', employeeId: ayse.id, workIdentity: wid, assetId: lap1.id, conditionAtHandover: 'GOOD', expectedReturnAt: expReturn, notes: 'ph5 test' },
  });
  assert.equal(g1.status, 201);
  assert.equal(g1.body.data.status, 'ACTIVE');
  assert.equal(g1.body.data.type, 'LAPTOP');
  assert.equal(g1.body.data.workIdentity.name, wid.name);
  assert.equal(g1.body.data.workIdentity.roomId, null);
  assert.equal(new Date(g1.body.data.expectedReturnAt).toISOString().slice(0, 10), expReturn);
  const widId = g1.body.data.workIdentity.id;

  const a1 = await prisma.asset.findUnique({ where: { id: lap1.id }, select: { status: true, currentHolderEmployeeId: true } });
  assert.equal(a1.status, 'ASSIGNED');
  assert.equal(a1.currentHolderEmployeeId, ayse.id);

  const tl = (await admin.req('GET', `/assignments/${g1.body.data.id}/timeline?pageSize=20`)).body.data;
  const assigned = tl.find((e) => e.eventType === 'ASSIGNED');
  assert.ok(assigned, 'ASSIGNED timeline entry written');
  assert.equal(assigned.snapshot.phoneDetail, null);

  // ---- WIP upsert idempotency (null-room path): same name+dept → reuse, no duplicate ----
  const g2 = await admin.req('POST', '/assignments/generic', {
    body: { type: 'LAPTOP', employeeId: ayse.id, workIdentity: wid, assetId: lap2.id, conditionAtHandover: 'NEW' },
  });
  assert.equal(g2.status, 201);
  assert.equal(g2.body.data.workIdentity.id, widId, 'null-room WIP must be reused, not duplicated');
  const wids = await prisma.workIdentity.count({ where: { name: wid.name } });
  assert.equal(wids, 1);

  // ---- Generic guards: dual-active 409, PHONE 400 ----
  assert.equal(
    (await admin.req('POST', '/assignments/generic', { body: { type: 'LAPTOP', employeeId: ayse.id, workIdentity: wid, assetId: lap1.id, conditionAtHandover: 'GOOD' } })).status,
    409,
  );
  assert.equal(
    (await admin.req('POST', '/assignments/generic', { body: { type: 'PHONE', employeeId: ayse.id, assetId: lap2.id, conditionAtHandover: 'GOOD' } })).status,
    400,
  );

  // ---- CHANGE 4 via /phone: call-center WIP upsert (name+roomId) idempotent ----
  const mkPhone = async (tag, imei) => {
    const r = await admin.req('POST', '/assets', { body: { categoryId: phonesCat.id, name: `Ph5 Phone ${Date.now()}${tag}`, phone: { imei } } });
    assert.equal(r.status, 201);
    return r.body.data;
  };
  // 14-17 digit IMEIs; rotate a few trailing digits to guarantee uniqueness across runs.
  const baseImei = `35${String(Date.now()).slice(-12)}`;
  const p1 = await mkPhone('a', `${baseImei}01`);
  const p2 = await mkPhone('b', `${baseImei}02`);
  const ccWip = { name: `Ph5 CC Seat ${Date.now()}`, departmentTeamId: cc.id, roomId: tr1.id };
  const ph1 = await admin.req('POST', '/assignments/phone', { body: { employeeId: sofia.id, workIdentity: ccWip, phoneAssetId: p1.id } });
  assert.equal(ph1.status, 201);
  const ccWipId = ph1.body.data.workIdentity.id;
  const ph2 = await admin.req('POST', '/assignments/phone', { body: { employeeId: sofia.id, workIdentity: ccWip, phoneAssetId: p2.id } });
  assert.equal(ph2.status, 201);
  assert.equal(ph2.body.data.workIdentity.id, ccWipId, 'call-center WIP must be reused via name_roomId upsert');

    await prisma.$disconnect();
  });

  test('BE-17: CALL_CENTER_MANAGER reads all CALLCENTER data, cannot write/see accounts/decrypt', async () => {
    const ccm = await as('mr.mahmoud');
    const admin = await as('admin');

    // Reads across ALL call-center rooms (assets, employees, rooms, assignments, reports).
    assert.equal((await ccm.req('GET', '/assets?pageSize=100')).status, 200);
    assert.equal((await ccm.req('GET', '/employees?pageSize=100')).status, 200);
    assert.equal((await ccm.req('GET', '/rooms')).status, 200);
    assert.equal((await ccm.req('GET', '/assignments?pageSize=100')).status, 200);
    assert.equal((await ccm.req('GET', '/reports/who-has-what')).status, 200);

    // Rooms list is restricted to CALLCENTER rooms only.
    const rooms = (await ccm.req('GET', '/rooms')).body.data;
    assert.ok(rooms.length > 0);
    assert.ok(rooms.every((r) => r.teamType === 'CALLCENTER'), 'CALL_CENTER_MANAGER sees only CALLCENTER rooms');

    // Assets visible are all in CALLCENTER rooms (or held by a CALLCENTER employee).
    const assets = (await ccm.req('GET', '/assets?pageSize=100')).body.data;
    assert.ok(assets.length > 0);
    const adminAssets = (await admin.req('GET', '/assets?pageSize=100')).body.data;
    assert.ok(adminAssets.length >= assets.length, 'CALL_CENTER_MANAGER sees a subset of all assets');

    // Cannot write (403), cannot see accounts (403), cannot decrypt (403), cannot manage users (403).
    assert.equal((await ccm.req('POST', '/assets', { body: {} })).status, 403);
    assert.equal((await ccm.req('POST', '/rooms', { body: { code: 'X' } })).status, 403);
    assert.equal((await ccm.req('GET', '/accounts')).status, 403);
    assert.equal((await ccm.req('GET', '/users')).status, 403);
    const acc = (await admin.req('GET', '/accounts')).body.data[0];
    assert.equal((await ccm.req('GET', `/accounts/${acc.id}/decrypt`)).status, 403);

    // Cannot export reports (reports:export = ADMIN/MANAGER only).
    assert.equal((await ccm.req('GET', '/reports/who-has-what/export')).status, 403);
  });

  test('BE-17: GET /audit-logs is ADMIN-only, paginated and filterable', async () => {
    const admin = await as('admin');
    const manager = await as('manager');
    const ccm = await as('mr.mahmoud');

    // Non-ADMIN roles are denied.
    assert.equal((await manager.req('GET', '/audit-logs')).status, 403);
    assert.equal((await ccm.req('GET', '/audit-logs')).status, 403);

    // ADMIN can read; envelope has data + meta.
    const list = await admin.req('GET', '/audit-logs?pageSize=5');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.data));
    assert.ok(list.body.meta.total > 0);
    assert.ok(list.body.meta.totalPages >= 1);
    assert.ok(list.body.data.length <= 5);

    // Each row carries actor{id,fullName,username}, action, targetType, targetId, meta, ip, createdAt.
    const row = list.body.data[0];
    assert.ok(row.id && row.action && row.createdAt);
    assert.ok(row.actor === null || (row.actor.id && row.actor.fullName && row.actor.username));
    assert.ok('targetType' in row && 'targetId' in row && 'meta' in row && 'ip' in row);

    // Ordered createdAt desc.
    const times = list.body.data.map((r) => new Date(r.createdAt).getTime());
    assert.ok(times.every((t, i) => i === 0 || t <= times[i - 1]), 'logs ordered newest-first');

    // Filter by action (substring, insensitive).
    const filtered = await admin.req('GET', `/audit-logs?action=${encodeURIComponent('asset.create')}`);
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.data.every((r) => r.action.toLowerCase().includes('asset.create')));

    // Filter by q (matches action or targetType).
    const q = await admin.req('GET', '/audit-logs?q=asset');
    assert.equal(q.status, 200);
    assert.ok(q.body.data.every((r) => r.action.toLowerCase().includes('asset') || (r.targetType || '').toLowerCase().includes('asset')));

    // Filter by actorId.
      const me = (await admin.req('GET', '/auth/me')).body.user;
      const byActor = await admin.req('GET', `/audit-logs?actorId=${me.id}`);
      assert.equal(byActor.status, 200);
      assert.ok(byActor.body.data.every((r) => r.actor?.id === me.id));
    });

  test('BE-18: generic assignment with accessories — COMPUTERS type + BUNDLED items + all assets flip', async () => {
    const prisma = require('../src/db');
    const admin = await as('admin');

    // Fixtures: the Computers / Monitors categories only exist after the Excel import, so create them
    // when they are missing (fresh seed) instead of assuming them.
    const ensureCategory = async (name, codePrefix) => {
      const found = await prisma.assetCategory.findFirst({ where: { name }, select: { id: true } });
      if (found) return found;
      const r = await admin.req('POST', '/asset-categories', { body: { name, codePrefix } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return { id: r.body.data.id };
    };
    const computersCat = await ensureCategory('Computers', 'COM');
    const monitorsCat = await ensureCategory('Monitors', 'MON');
    const cc = await prisma.departmentTeam.findFirst({ where: { name: 'Call Center' }, select: { id: true } });
    const tr1 = await prisma.room.findFirst({ where: { code: 'TR1' }, select: { id: true } });
    const ayse = await prisma.employee.findFirst({ where: { fullName: 'Ayse Celik' }, select: { id: true } });

    // Create a PC + 2 accessories (monitor + mouse) as AVAILABLE assets
    const mkAsset = async (catId, name) => {
      const r = await admin.req('POST', '/assets', { body: { categoryId: catId, name, condition: 'GOOD', status: 'AVAILABLE', roomId: tr1.id } });
      assert.equal(r.status, 201);
      assert.equal(r.body.data.status, 'AVAILABLE');
      return r.body.data;
    };
    const pc = await mkAsset(computersCat.id, `BE18 PC ${Date.now()}`);
    const mon = await mkAsset(monitorsCat.id, `BE18 Monitor ${Date.now()}`);
    const mouse = await mkAsset(monitorsCat.id, `BE18 Mouse ${Date.now()}`);

    // Route accepts COMPUTERS + accessoryAssetIds; creates one ACTIVE assignment
    const wid = { name: `BE18 Seat ${Date.now()}`, departmentTeamId: cc.id, roomId: tr1.id };
    const g = await admin.req('POST', '/assignments/generic', {
      body: { type: 'COMPUTERS', employeeId: ayse.id, workIdentity: wid, assetId: pc.id, accessoryAssetIds: [mon.id, mouse.id], conditionAtHandover: 'GOOD' },
    });
    assert.equal(g.status, 201);
    assert.equal(g.body.data.status, 'ACTIVE');
    assert.equal(g.body.data.type, 'COMPUTERS');

    // Items: PRIMARY (PC) + 2 BUNDLED (accessories)
    const items = g.body.data.items;
    assert.equal(items.length, 3);
    const primary = items.find((i) => i.assetId === pc.id);
    assert.equal(primary.role, 'PRIMARY');
    const bundled = items.filter((i) => i.assetId === mon.id || i.assetId === mouse.id);
    assert.equal(bundled.length, 2);
    assert.ok(bundled.every((i) => i.role === 'BUNDLED'));

    // All assets flipped to ASSIGNED + holder + room
    for (const id of [pc.id, mon.id, mouse.id]) {
      const a = await prisma.asset.findUnique({ where: { id }, select: { status: true, currentHolderEmployeeId: true, roomId: true } });
      assert.equal(a.status, 'ASSIGNED');
      assert.equal(a.currentHolderEmployeeId, ayse.id);
      assert.equal(a.roomId, tr1.id);
    }

    // ASSIGNED timeline written with all items in snapshot
    const tl = (await admin.req('GET', `/assignments/${g.body.data.id}/timeline?pageSize=20`)).body.data;
    const assigned = tl.find((e) => e.eventType === 'ASSIGNED');
    assert.ok(assigned, 'ASSIGNED timeline entry written');
    assert.equal(assigned.snapshot.items.length, 3);

    // Route rejects PHONE (400) and already-active asset (409)
    assert.equal(
      (await admin.req('POST', '/assignments/generic', { body: { type: 'PHONE', employeeId: ayse.id, assetId: pc.id, conditionAtHandover: 'GOOD' } })).status,
      400,
    );
    assert.equal(
      (await admin.req('POST', '/assignments/generic', { body: { type: 'COMPUTERS', employeeId: ayse.id, workIdentity: wid, assetId: pc.id, conditionAtHandover: 'GOOD' } })).status,
      409,
    );
    // An accessory already in an ACTIVE assignment is also rejected (409)
    assert.equal(
      (await admin.req('POST', '/assignments/generic', { body: { type: 'COMPUTERS', employeeId: ayse.id, workIdentity: wid, assetId: pc.id, accessoryAssetIds: [mon.id], conditionAtHandover: 'GOOD' } })).status,
      409,
    );

    await prisma.$disconnect();
  });

test('BE-19: return without required charger cable/adapter - items tracked, inventory not released, discrepancy visible in detail', async () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  execFileSync('node', [path.join(__dirname, '..', 'scripts', 'fixture-return.cjs')], { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
  const prisma = require('../src/db');
  const assignment = await prisma.assignment.findUnique({ where: { assignmentCode: 'A-900001' } });
  const id = assignment.id;
  const admin = await as('admin');

  // 1) return-form pre-fills out-state: charger cable/adapter present at handover
  const form = await admin.req('GET', `/assignments/${id}/return-form`);
  assert.equal(form.status, 200);
  assert.equal(form.body.data.out.chargerCableAssetId, 'CBL-000001 — USB-C charger cable');
  assert.equal(form.body.data.out.chargerAdapterAssetId, 'ADP-000001 — 15W USB adapter');

  // 2) submit return WITHOUT the charger cable and adapter -> two CRITICAL discrepancies
  const ret = await admin.req('POST', `/assignments/${id}/return`, {
    body: { returnCondition: 'FAIR', returnNotes: 'Charger cable and adapter missing', return: { chargerCableAssetId: null, chargerAdapterAssetId: null } },
  });
  assert.equal(ret.status, 200);
  assert.equal(ret.body.data.status, 'RETURNED');
  assert.equal(ret.body.data.hasDiscrepancies, true);
  const crit = ret.body.data.discrepancies.filter((c) => c.isDiscrepancy && c.severity === 'CRITICAL').map((c) => c.fieldKey);
  assert.ok(crit.includes('chargerCableAssetId') && crit.includes('chargerAdapterAssetId'));

  // 3) timeline shows ASSIGNED -> RETURNED (+ DISCREPANCY)
  const tl = (await admin.req('GET', `/assignments/${id}/timeline?pageSize=20`)).body.data;
  const types = tl.map((e) => e.eventType);
  assert.ok(types.includes('ASSIGNED') && types.includes('RETURNED') && types.includes('DISCREPANCY'));

  // 4) double-return -> 409
  assert.equal((await admin.req('POST', `/assignments/${id}/return`, { body: { returnCondition: 'GOOD', return: {} } })).status, 409);

  // 5) inventory: primary released (holder cleared, last known room kept — F-26), but the MISSING required
  //    charger items stay ASSIGNED (not returned to inventory) and are listed as unreturned
  const tr1 = await prisma.room.findUnique({ where: { code: 'TR1' }, select: { id: true } });
  const phone = await prisma.asset.findUnique({ where: { code: 'PHN-000001' }, select: { status: true, currentHolderEmployeeId: true, roomId: true } });
  assert.equal(phone.status, 'AVAILABLE');
  assert.equal(phone.currentHolderEmployeeId, null);
  assert.equal(phone.roomId, tr1.id);
  assert.deepEqual(ret.body.data.unreturnedItems.map((i) => i.kind), ['CHARGER_CABLE', 'CHARGER_ADAPTER']);
  const cable = await prisma.asset.findUnique({ where: { code: 'CBL-000001' }, select: { status: true } });
  const adapter = await prisma.asset.findUnique({ where: { code: 'ADP-000001' }, select: { status: true } });
  assert.equal(cable.status, 'ASSIGNED', 'missing charger cable must NOT be released to AVAILABLE');
  assert.equal(adapter.status, 'ASSIGNED', 'missing charger adapter must NOT be released to AVAILABLE');

  // 6) discrepancy visible in assignment detail (returnRecords + comparisonFields)
  const detail = (await admin.req('GET', `/assignments/${id}`)).body.data;
  assert.ok(detail.returnRecords && detail.returnRecords.length > 0, 'returnRecords present');
  const discFields = detail.returnRecords.flatMap((r) => r.comparisonFields ?? []);
  assert.ok(discFields.some((f) => f.fieldKey === 'chargerCableAssetId'), 'chargerCableAssetId discrepancy visible');
  assert.ok(discFields.some((f) => f.fieldKey === 'chargerAdapterAssetId'), 'chargerAdapterAssetId discrepancy visible');

  // Bitrix account released
  const bitrix = await prisma.account.findFirst({ where: { identifier: 'sofia@clinic.bitrix24.com' }, select: { currentAssignmentId: true } });
  assert.equal(bitrix.currentAssignmentId, null);

  await prisma.$disconnect();
});

/* ------------------------------------------------------------------------------------------ *
 * Phase 7 — #5 a return writes the asset's own condition; #4 assignment detail carries each
 * item's asset photos. API-only (uses fresh assets in seeded categories, no direct DB access).
 * ------------------------------------------------------------------------------------------ */
const p7 = {
  async ctx(admin) {
    const emp = (await admin.req('GET', '/employees?pageSize=1')).body.data[0];
    const cats = (await admin.req('GET', '/asset-categories')).body.flat;
    return { emp, cat: (name) => cats.find((c) => c.name === name) };
  },
  /** A fresh GOOD / AVAILABLE asset. */
  async asset(admin, category, label) {
    const r = await admin.req('POST', '/assets', { body: { categoryId: category.id, name: `P7 ${label} ${Date.now()}`, condition: 'GOOD' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.condition, 'GOOD');
    assert.equal(r.body.data.status, 'AVAILABLE');
    return r.body.data;
  },
  /** Generic assignment (single asset, or a GENERAL bundle with accessories); returns the created detail. */
  async assign(admin, emp, asset, accessories = []) {
    const r = await admin.req('POST', '/assignments/generic', {
      body: { type: accessories.length ? 'GENERAL' : 'LAPTOP', employeeId: emp.id, assetId: asset.id, accessoryAssetIds: accessories.map((x) => x.id), conditionAtHandover: 'GOOD' },
    });
    assert.equal(r.status, 201);
    return r.body.data;
  },
  async getAsset(admin, id) {
    const r = await admin.req('GET', `/assets/${id}`);
    assert.equal(r.status, 200);
    return r.body.data;
  },
};

test('Phase 7 #5: return writes asset.condition (DAMAGED stays AVAILABLE, DISPOSED → DISPOSED) + UPDATED timeline entry', async () => {
  const admin = await as('admin');
  const { emp, cat } = await p7.ctx(admin);

  // Condition → resulting asset status: only DISPOSED changes the status rule.
  const cases = [['DAMAGED', 'AVAILABLE'], ['POOR', 'AVAILABLE'], ['FAIR', 'AVAILABLE'], ['DISPOSED', 'DISPOSED']];
  for (const [returned, expectedStatus] of cases) {
    const asset = await p7.asset(admin, cat('Laptops'), `return ${returned}`);
    const a = await p7.assign(admin, emp, asset);
    assert.equal((await p7.getAsset(admin, asset.id)).status, 'ASSIGNED');

    const ret = await admin.req('POST', `/assignments/${a.id}/return`, { body: { returnCondition: returned, returnNotes: `p7 ${returned}` } });
    assert.equal(ret.status, 200, JSON.stringify(ret.body));
    // the response reports what happened to the asset
    assert.deepEqual(
      ret.body.data.assetConditions.map(({ assetId, role, from, to, changed, status }) => ({ assetId, role, from, to, changed, status })),
      [{ assetId: asset.id, role: 'PRIMARY', from: 'GOOD', to: returned, changed: true, status: expectedStatus }],
    );

    // GET the asset: new condition, status by the rule, released from the holder
    const after = await p7.getAsset(admin, asset.id);
    assert.equal(after.condition, returned, `asset.condition after returning ${returned}`);
    assert.equal(after.status, expectedStatus, `asset.status after returning ${returned}`);
    assert.equal(after.currentHolder, null);
    assert.equal(after.currentHolderEmployeeId, null);

    // asset history: exactly one UPDATED entry { field, from, to, assignmentCode } tied to this assignment
    const updated = after.timelineEntries.filter((e) => e.eventType === 'UPDATED');
    assert.equal(updated.length, 1, 'one UPDATED timeline entry on the asset');
    assert.deepEqual(updated[0].snapshot, { field: 'condition', from: 'GOOD', to: returned, assignmentCode: a.assignmentCode });
    assert.equal(updated[0].assignmentId, a.id);
    assert.ok(after.timelineEntries.some((e) => e.eventType === 'RETURNED'), 'RETURNED entry still written');

    // the assignment shows the same: return condition on the item + the UPDATED entry on its timeline
    const detail = (await admin.req('GET', `/assignments/${a.id}`)).body.data;
    assert.equal(detail.status, 'RETURNED');
    assert.equal(detail.items.find((i) => i.role === 'PRIMARY').returnCondition, returned);
    const tl = (await admin.req('GET', `/assignments/${a.id}/timeline?pageSize=20&eventType=UPDATED`)).body.data;
    assert.equal(tl.length, 1);
    assert.equal(tl[0].assetId, asset.id);
  }

  // Returned in the same condition → condition untouched and NO UPDATED entry (nothing changed).
  const same = await p7.asset(admin, cat('Laptops'), 'return GOOD');
  const sa = await p7.assign(admin, emp, same);
  const r = await admin.req('POST', `/assignments/${sa.id}/return`, { body: { returnCondition: 'GOOD' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.assetConditions[0].changed, false);
  const sameAfter = await p7.getAsset(admin, same.id);
  assert.equal(sameAfter.condition, 'GOOD');
  assert.equal(sameAfter.status, 'AVAILABLE');
  assert.equal(sameAfter.timelineEntries.filter((e) => e.eventType === 'UPDATED').length, 0);

  // No returnCondition at all → the asset keeps its condition (and is still released).
  const keep = await p7.asset(admin, cat('Laptops'), 'return unspecified');
  const ka = await p7.assign(admin, emp, keep);
  assert.equal((await admin.req('POST', `/assignments/${ka.id}/return`, { body: {} })).status, 200);
  const keepAfter = await p7.getAsset(admin, keep.id);
  assert.equal(keepAfter.condition, 'GOOD');
  assert.equal(keepAfter.status, 'AVAILABLE');
});

test('Phase 7 #5: bundle return — itemConditions set each accessory’s condition; accessories are released; bad itemConditions → 400', async () => {
  const admin = await as('admin');
  const { emp, cat } = await p7.ctx(admin);
  const primary = await p7.asset(admin, cat('Laptops'), 'bundle primary');
  const printer = await p7.asset(admin, cat('Printers'), 'bundle printer');
  const cable = await p7.asset(admin, cat('Charger Cables'), 'bundle cable');
  const stranger = await p7.asset(admin, cat('Laptops'), 'bundle stranger');
  const a = await p7.assign(admin, emp, primary, [printer, cable]);
  const returnUrl = `/assignments/${a.id}/return`;

  // Invalid itemConditions are rejected before anything is written (the assignment stays ACTIVE).
  const notInvolved = await admin.req('POST', returnUrl, { body: { returnCondition: 'GOOD', itemConditions: [{ assetId: stranger.id, condition: 'DAMAGED' }] } });
  assert.equal(notInvolved.status, 400);
  const dup = await admin.req('POST', returnUrl, { body: { itemConditions: [{ assetId: printer.id, condition: 'POOR' }, { assetId: printer.id, condition: 'GOOD' }] } });
  assert.equal(dup.status, 400);
  const badEnum = await admin.req('POST', returnUrl, { body: { itemConditions: [{ assetId: printer.id, condition: 'BROKEN' }] } });
  assert.equal(badEnum.status, 400);
  assert.equal((await p7.getAsset(admin, stranger.id)).condition, 'GOOD', 'unrelated asset untouched');
  assert.equal((await admin.req('GET', `/assignments/${a.id}`)).body.data.status, 'ACTIVE', 'rejected returns do not close the assignment');

  // Primary comes back FAIR, printer DAMAGED, cable has no entry (keeps its condition).
  const ret = await admin.req('POST', returnUrl, { body: { returnCondition: 'FAIR', itemConditions: [{ assetId: printer.id, condition: 'DAMAGED' }] } });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  const byAsset = Object.fromEntries(ret.body.data.assetConditions.map((c) => [c.assetId, c]));
  assert.equal(ret.body.data.assetConditions[0].assetId, primary.id, 'primary listed first');
  assert.deepEqual([byAsset[primary.id].from, byAsset[primary.id].to, byAsset[primary.id].changed], ['GOOD', 'FAIR', true]);
  assert.deepEqual([byAsset[printer.id].from, byAsset[printer.id].to, byAsset[printer.id].changed], ['GOOD', 'DAMAGED', true]);
  assert.deepEqual([byAsset[cable.id].from, byAsset[cable.id].to, byAsset[cable.id].changed], ['GOOD', 'GOOD', false]);

  const [pAfter, prAfter, cAfter] = await Promise.all([primary, printer, cable].map((x) => p7.getAsset(admin, x.id)));
  assert.equal(pAfter.condition, 'FAIR');
  assert.equal(prAfter.condition, 'DAMAGED');
  assert.equal(cAfter.condition, 'GOOD');
  for (const x of [pAfter, prAfter, cAfter]) {
    // bundled accessories travel with the primary: released to inventory, holder cleared
    assert.equal(x.status, 'AVAILABLE');
    assert.equal(x.currentHolder, null);
  }
  const updatedOn = (x) => x.timelineEntries.filter((e) => e.eventType === 'UPDATED').map((e) => `${e.snapshot.from}>${e.snapshot.to}`);
  assert.deepEqual(updatedOn(pAfter), ['GOOD>FAIR']);
  assert.deepEqual(updatedOn(prAfter), ['GOOD>DAMAGED']);
  assert.deepEqual(updatedOn(cAfter), []);
  assert.ok(prAfter.timelineEntries.some((e) => e.eventType === 'RETURNED'), 'accessory has a RETURNED entry, not a "missing" NOTE');

  // Per-item return condition is stored on the assignment items and visible in the detail.
  const detail = (await admin.req('GET', `/assignments/${a.id}`)).body.data;
  const rc = Object.fromEntries(detail.items.map((i) => [i.asset.id, i.returnCondition]));
  assert.deepEqual(rc, { [primary.id]: 'FAIR', [printer.id]: 'DAMAGED', [cable.id]: null });
  assert.ok(detail.items.every((i) => i.isActive === false));
});

test('Phase 7 #5: phone return with the return-form payload — PHN-000001 comes back DAMAGED, UPDATED entry, SIM/charger released unchanged', async () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  execFileSync('node', [path.join(__dirname, '..', 'scripts', 'fixture-return.cjs')], { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
  const admin = await as('admin');
  const asg = (await admin.req('GET', '/assignments?q=A-900001&pageSize=1')).body.data[0];
  assert.equal(asg.assignmentCode, 'A-900001');
  const phone = async () => (await admin.req('GET', `/assets/${asg.assetId}`)).body.data;
  assert.equal((await phone()).condition, 'GOOD', 'fixture phone starts GOOD');

  // Same shape the web return form sends: top-level returnCondition + return{…, condition} with the
  // handover labels for Bitrix / charger dropdowns (so nothing is flagged missing).
  const ret = await admin.req('POST', `/assignments/${asg.id}/return`, {
    body: {
      returnCondition: 'DAMAGED',
      returnNotes: 'dropped',
      return: {
        condition: 'DAMAGED', sim1Number: '905369700889', bitrixAccountId: 'sofia@clinic.bitrix24.com',
        chargerCableAssetId: 'CBL-000001 — USB-C charger cable', chargerAdapterAssetId: 'ADP-000001 — 15W USB adapter',
      },
    },
  });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  const ac = ret.body.data.assetConditions;
  assert.equal(ac[0].assetId, asg.assetId, 'primary first');
  assert.deepEqual(ac.slice(0, 1).map((c) => [c.role, c.from, c.to, c.changed, c.status]), [['PRIMARY', 'GOOD', 'DAMAGED', true, 'AVAILABLE']]);
  assert.deepEqual(ac.slice(1).map((c) => c.role).sort(), ['CHARGER_ADAPTER', 'CHARGER_CABLE', 'SIM1']);
  assert.ok(ac.slice(1).every((c) => c.changed === false && c.status === 'AVAILABLE'), 'SIM/chargers released, conditions untouched');

  const after = await phone();
  assert.equal(after.condition, 'DAMAGED');
  assert.equal(after.status, 'AVAILABLE');
  assert.equal(after.currentHolder, null);
  const updated = after.timelineEntries.filter((e) => e.eventType === 'UPDATED');
  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0].snapshot, { field: 'condition', from: 'GOOD', to: 'DAMAGED', assignmentCode: 'A-900001' });

  // Leave the seeded sample phone as the seed made it (the shared dev data should not keep a DAMAGED phone).
  assert.equal((await admin.req('PATCH', `/assets/${asg.assetId}`, { body: { condition: 'GOOD' } })).status, 200);
});

test('Phase 7 #4: assignment detail returns each item asset’s own photos as [{id,type,url}]', async () => {
  const admin = await as('admin');
  const { emp, cat } = await p7.ctx(admin);
  const laptop = await p7.asset(admin, cat('Laptops'), 'photo laptop');
  const printer = await p7.asset(admin, cat('Printers'), 'photo printer');
  const created = await p7.assign(admin, emp, laptop, [printer]);

  // Photo arrays are always present, empty while the assets have no pictures (create response + detail).
  for (const items of [created.items, (await admin.req('GET', `/assignments/${created.id}`)).body.data.items]) {
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => Array.isArray(i.asset.photos) && i.asset.photos.length === 0));
  }

  // Give the laptop a FRONT + BACK picture and the printer a CONDITION one (the assets' own photos).
  const upload = async (assetId, type) => {
    const fd = new FormData(); fd.append('type', type); fd.append('photos', new Blob([PNG], { type: 'image/png' }), `${type}.png`);
    const r = await admin.req('POST', `/assets/${assetId}/photos`, { form: fd });
    assert.equal(r.status, 201);
    return r.body.data[0];
  };
  const front = await upload(laptop.id, 'FRONT');
  const back = await upload(laptop.id, 'BACK');
  const cond = await upload(printer.id, 'CONDITION');

  const res = await admin.req('GET', `/assignments/${created.id}`);
  assert.equal(res.status, 200);
  const detail = res.body.data;
  const item = (assetId) => detail.items.find((i) => i.asset.id === assetId);

  // items[].asset.photos[] = [{ id, type, url }] — url is the existing photo-file endpoint
  assert.deepEqual(item(laptop.id).asset.photos.map(({ id, type, url }) => ({ id, type, url })), [
    { id: front.id, type: 'FRONT', url: `/api/v1/photos/${front.id}/file` },
    { id: back.id, type: 'BACK', url: `/api/v1/photos/${back.id}/file` },
  ]);
  assert.deepEqual(item(printer.id).asset.photos.map(({ id, type, url }) => ({ id, type, url })), [
    { id: cond.id, type: 'CONDITION', url: `/api/v1/photos/${cond.id}/file` },
  ]);
  const file = await fetch(`${BASE}${item(laptop.id).asset.photos[0].url}`, { headers: { Cookie: `access_token=${admin.cookies.access_token}` } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');

  // Existing fields are unchanged: asset id/code/name, handover condition, assignment-level photos…
  assert.equal(item(laptop.id).asset.code, laptop.code);
  assert.equal(item(laptop.id).asset.name, laptop.name);
  assert.equal(item(laptop.id).conditionAtHandover, 'GOOD');
  assert.ok(Array.isArray(detail.photos) && detail.photos.length === 0, 'assignment-level photos stay separate from asset photos');
  assert.equal(detail.asset.id, laptop.id);
  assert.equal(detail.employee.id, emp.id);
  // …and the items now identify themselves (id / role / assetId) so clients can address them.
  assert.deepEqual(detail.items.map((i) => i.role).sort(), ['BUNDLED', 'PRIMARY']);
  assert.ok(detail.items.every((i) => i.id && i.assetId === i.asset.id));

  // Tidy up: return the bundle so these assets are not left ASSIGNED (RBAC tests inspect who holds what).
  assert.equal((await admin.req('POST', `/assignments/${created.id}/return`, { body: { returnCondition: 'GOOD' } })).status, 200);
});
