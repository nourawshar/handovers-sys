'use strict';
/**
 * Integration smoke tests against a RUNNING server with the seed loaded.
 *   BASE_URL=http://localhost:4000 npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const API = `${BASE}/api/v1`;
const PW = { admin: 'Admin#12345', manager: 'Manager#12345', 'tl.tr1': 'Leader#12345' };

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
  const other = all.data.find((a) => a.room?.code === 'TR3');
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
