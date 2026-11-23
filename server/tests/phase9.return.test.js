'use strict';
/**
 * Phase 9 BE-R (card t_b107f492) — P5a: the return record, the items that did not come back, and settling them.
 *
 *   return.service.js  getUnreturned() · buildReturnRecord() · resolveUnreturned()
 *   returns.routes.js  GET  /assignments/:id/return-record     (404 when never returned; room scope = the detail's)
 *                      GET  /assignments/:id/unreturned
 *                      POST /assignments/:id/unreturned/resolve (ADMIN; RETURNED | LOST for one OPEN asset / account)
 *
 * Integration tests against a RUNNING server (BASE_URL) on a throw-away, freshly seeded database — never the shared
 * dev server behind :4000 (refused). Every fixture is created through the API with unique "P9R …" names, so the file
 * can be re-run; whatever a test leaves owed is settled (RETURNED) in the final hook and the photos it uploaded are
 * deleted. The two tests that call getUnreturned() directly (contract + "no N+1") also need DATABASE_URL — the SAME
 * scratch database the server uses — and are skipped without it:
 *
 *   createdb scratch_db
 *   DATABASE_URL='postgresql://postgres@localhost:5432/scratch_db?schema=public' npx prisma migrate deploy && npm run seed
 *   DATABASE_URL='…same…' LOGIN_RATE_LIMIT=1000 PORT=3001 node src/server.js &
 *   DATABASE_URL='…same…' BASE_URL=http://localhost:3001 node --test tests/phase9.return.test.js
 *
 * Needs the standard seed (logins admin / manager / tl.tr1 / tl.tr2 / mr.mahmoud, rooms TR1 + TR2, the "Call Center"
 * department and the Phones / SIM Cards / Charger Cables / Charger Adapters / Laptops categories).
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.BASE_URL || '';
if (!BASE) throw new Error('phase9.return.test.js needs BASE_URL (your own server, e.g. http://localhost:3001)');
if (new URL(BASE).port === '4000') throw new Error('refusing to run against :4000 (the shared dev server) — start your own server on another port');
const API = `${BASE}/api/v1`;
const HAS_DB = Boolean(process.env.DATABASE_URL);
const NEEDS_DB = HAS_DB ? false : 'needs DATABASE_URL (the scratch database the server runs on)';

/* ───────────────────────────── tiny API client ───────────────────────────── */

const PW = { admin: 'Admin#12345', manager: 'Manager#12345', 'tl.tr1': 'Leader#12345', 'tl.tr2': 'Leader#12345', 'mr.mahmoud': 'Mahmoud#12345' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

class Client {
  constructor() { this.cookies = {}; }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, path, { body, form } = {}) {
    const headers = { Cookie: this.cookieHeader() };
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
    return { status: res.status, body: json };
  }
  /** Status of a raw (non-/api/v1-prefixed) GET, e.g. a photo URL taken from a response. */
  async status(path) { return (await fetch(`${BASE}${path}`, { headers: { Cookie: this.cookieHeader() } })).status; }
}

const sessions = new Map();
function as(username) {
  if (!sessions.has(username)) {
    sessions.set(username, (async () => {
      const c = new Client();
      const r = await c.req('POST', '/auth/login', { body: { username, password: PW[username] } });
      assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(r.body)}`);
      return c;
    })());
  }
  return sessions.get(username);
}
/** A client without a session. */
const anonymous = () => new Client();

/* ───────────────────────────── fixtures + cleanup ───────────────────────────── */

const stamp = Date.now().toString(36);
let seq = 0;
const uid = () => `${stamp}-${++seq}`;
const digits = (n) => `${Date.now()}${String(++seq).padStart(3, '0')}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`.slice(-n).padStart(n, '7');
const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111'; // a well-formed uuid that exists nowhere

/** What the final hook has to tidy up. */
const made = { returned: new Set(), active: new Set(), photos: [] };

after(async () => {
  const admin = await as('admin');
  for (const id of made.active) await admin.req('POST', `/assignments/${id}/return`, { body: { returnCondition: 'GOOD' } }); // 409 when already returned
  for (const id of made.returned) {
    const list = (await admin.req('GET', `/assignments/${id}/unreturned`)).body.data ?? [];
    for (const e of list.filter((x) => x.status === 'OPEN')) {
      await admin.req('POST', `/assignments/${id}/unreturned/resolve`, { body: { ...(e.assetId ? { assetId: e.assetId } : { accountId: e.accountId }), resolution: 'RETURNED' } });
    }
  }
  for (const id of made.photos) await admin.req('DELETE', `/photos/${id}`); // row + file on disk
  if (dbHandles.length) await Promise.all(dbHandles.map((h) => h.$disconnect()));
});
const dbHandles = []; // Prisma clients the DB-backed tests opened

let worldPromise;
/** Seeded lookups, by name (loaded once). */
function world(admin) {
  worldPromise ??= (async () => {
    const cats = (await admin.req('GET', '/asset-categories')).body.flat;
    const rooms = (await admin.req('GET', '/rooms')).body.data;
    const deps = (await admin.req('GET', '/departments')).body.data;
    let hospital = rooms.find((r) => r.code === 'P9R-HOSPITAL'); // one fixed HOSPITAL room, reused across runs
    if (!hospital) {
      const created = await admin.req('POST', '/rooms', { body: { code: 'P9R-HOSPITAL', teamType: 'HOSPITAL' } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      hospital = created.body.data;
    }
    const pick = (list, key, what) => (name) => { const x = list.find((i) => i[key] === name); assert.ok(x, `seed ${what} ${name}`); return x; };
    return { cat: pick(cats, 'name', 'category'), room: pick([...rooms, hospital], 'code', 'room'), dept: pick(deps, 'name', 'department') };
  })();
  return worldPromise;
}

const fx = {
  async employee(admin, w, label, { room = null } = {}) {
    const r = await admin.req('POST', '/employees', { body: { fullName: `P9R ${label} ${uid()}`, departmentTeamId: w.dept('Call Center').id, ...(room && { roomId: room.id }) } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  },
  /** A fresh GOOD / AVAILABLE asset of a seeded category, with a serial number. */
  async asset(admin, w, category, label, extra = {}) {
    const r = await admin.req('POST', '/assets', { body: { categoryId: w.cat(category).id, name: `P9R ${label} ${uid()}`, serialNumber: `P9R-SN-${uid()}`, condition: 'GOOD', ...extra } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  },
  /** A Bitrix account whose e-mail differs from its identifier (so the unreturned entry has a real name). */
  async bitrix(admin, label) {
    const id = `p9r-${label.replace(/[^a-z0-9]+/gi, '-')}-${uid()}`;
    const r = await admin.req('POST', '/accounts', { body: { kind: 'BITRIX', identifier: id, email: `${id}@clinic.local`, password: 'P9rPass#12345' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  },
  /** A phone assignment carrying what the options ask for (default: SIM, both chargers, a Bitrix account). */
  async phoneKit(admin, w, employee, label, { sim = true, sim2 = false, cable = true, adapter = true, bitrix = true, workIdentity } = {}) {
    const simNumber = `905${digits(9)}`;
    const sim2Number = `905${digits(9)}`;
    const [phone, simA, sim2A, cableA, adapterA, bitrixA] = await Promise.all([
      fx.asset(admin, w, 'Phones', `${label} phone`, { phone: { imei: digits(15) } }),
      sim ? fx.asset(admin, w, 'SIM Cards', `${label} sim`, { customFields: { phone_number: simNumber } }) : null, // SIM Cards requires its number
      sim2 ? fx.asset(admin, w, 'SIM Cards', `${label} sim2`, { customFields: { phone_number: sim2Number } }) : null,
      cable ? fx.asset(admin, w, 'Charger Cables', `${label} cable`) : null,
      adapter ? fx.asset(admin, w, 'Charger Adapters', `${label} adapter`) : null,
      bitrix ? fx.bitrix(admin, label) : null,
    ]);
    const r = await admin.req('POST', '/assignments/phone', {
      body: {
        employeeId: employee.id, phoneAssetId: phone.id, condition: 'GOOD',
        ...(workIdentity && { workIdentity }),
        ...(simA && { sim1AssetId: simA.id, sim1Number: simNumber }),
        ...(sim2A && { sim2AssetId: sim2A.id, sim2Number }),
        ...(cableA && { chargerCableAssetId: cableA.id }),
        ...(adapterA && { chargerAdapterAssetId: adapterA.id }),
        ...(bitrixA && { bitrixAccountId: bitrixA.id }),
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    made.active.add(r.body.data.id);
    return { assignment: r.body.data, phone, sim: simA, sim2: sim2A, cable: cableA, adapter: adapterA, bitrix: bitrixA, simNumber, sim2Number };
  },
  /** A LAPTOP assignment (one asset, nothing that can go missing). */
  async laptop(admin, w, employee, label, { workIdentity } = {}) {
    const asset = await fx.asset(admin, w, 'Laptops', `${label} laptop`);
    const r = await admin.req('POST', '/assignments/generic', { body: { type: 'LAPTOP', employeeId: employee.id, assetId: asset.id, conditionAtHandover: 'GOOD', ...(workIdentity && { workIdentity }) } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    made.active.add(r.body.data.id);
    return { assignment: r.body.data, asset };
  },
  async ret(admin, id, body) {
    const r = await admin.req('POST', `/assignments/${id}/return`, { body });
    if (r.status === 200) { made.active.delete(id); made.returned.add(id); }
    return r;
  },
  /** The card's scenario: a phone kit returned with the charger adapter and the Bitrix account missing. */
  async returnedWithMissing(admin, w, employee, label, opts) {
    const kit = await fx.phoneKit(admin, w, employee, label, opts);
    const ret = await fx.ret(admin, kit.assignment.id, { returnCondition: 'GOOD', return: { chargerAdapterAssetId: null, bitrixAccountId: null } });
    assert.equal(ret.status, 200, JSON.stringify(ret.body));
    return { ...kit, id: kit.assignment.id, code: kit.assignment.assignmentCode, ret: ret.body.data };
  },
  /** Upload one image to the assignment (context HANDOVER | RETURN, optionally tagged with the asset it shows). */
  async photo(admin, assignmentId, { type = 'GENERAL', context = 'HANDOVER', assetId } = {}) {
    const fd = new FormData();
    fd.append('type', type);
    fd.append('context', context);
    if (assetId) fd.append('assetId', assetId);
    fd.append('photos', new Blob([PNG], { type: 'image/png' }), 'p9r.png');
    const r = await admin.req('POST', `/assignments/${assignmentId}/photos`, { form: fd });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    made.photos.push(r.body.data[0].id);
    return r.body.data[0];
  },
  /** The dedicated return-photo route (only while the assignment is ACTIVE). */
  async returnPhoto(admin, assignmentId, type) {
    const fd = new FormData();
    fd.append('type', type);
    fd.append('photos', new Blob([PNG], { type: 'image/png' }), 'p9r-return.png');
    const r = await admin.req('POST', `/assignments/${assignmentId}/return/photos`, { form: fd });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    made.photos.push(r.body.data[0].id);
    return r.body.data[0];
  },
  resolve: (client, id, body) => client.req('POST', `/assignments/${id}/unreturned/resolve`, { body }),
  record: (client, id) => client.req('GET', `/assignments/${id}/return-record`),
  unreturned: (client, id) => client.req('GET', `/assignments/${id}/unreturned`),
  async getAsset(admin, id) {
    const r = await admin.req('GET', `/assets/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data;
  },
  async account(admin, id) {
    const r = await admin.req('GET', `/accounts/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data;
  },
  async timeline(admin, id, query = '') {
    const r = await admin.req('GET', `/assignments/${id}/timeline?pageSize=100${query}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data;
  },
  async auditRows(admin, id) {
    const r = await admin.req('GET', `/audit-logs?action=assignment.unreturned.resolve&targetId=${id}&pageSize=100`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data;
  },
};

/** The unreturned entry the API is expected to list (see the doc: P5a). */
const assetEntry = (asset, role, status = 'OPEN', resolution = null) => ({ kind: 'ASSET', assetId: asset.id, accountId: null, code: asset.code, name: asset.name, role, status, resolution });
const accountEntry = (account, status = 'OPEN', resolution = null) => ({ kind: 'ACCOUNT', assetId: null, accountId: account.id, code: account.identifier, name: account.email, role: 'BITRIX', status, resolution });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* ───────────────────────────── GET return-record / unreturned ───────────────────────────── */

test('return-record: a phone returned with a missing adapter + Bitrix account → the full payload of the doc, both items OPEN, `returned` false for the adapter only', async () => {
  const admin = await as('admin');
  const w = await world(admin);
  const me = (await admin.req('GET', '/auth/me')).body.user;
  const emp = await fx.employee(admin, w, 'record', { room: w.room('TR2') });
  const { assignment, phone, sim, cable, adapter, bitrix } = await fx.phoneKit(admin, w, emp, 'record');
  const id = assignment.id;

  // photos: handover — one of the phone, one of the whole handover; return — one before closing, one tagged to the adapter after
  const hPhone = await fx.photo(admin, id, { type: 'FRONT', context: 'HANDOVER', assetId: phone.id });
  const hWhole = await fx.photo(admin, id, { type: 'BACK', context: 'HANDOVER' });
  const rWhole = await fx.returnPhoto(admin, id, 'CONDITION');

  const ret = await fx.ret(admin, id, {
    returnCondition: 'FAIR',
    returnNotes: 'adapter and Bitrix login missing',
    itemConditions: [{ assetId: sim.id, condition: 'DAMAGED' }],
    return: { chargerAdapterAssetId: null, bitrixAccountId: null },
  });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  const rAdapter = await fx.photo(admin, id, { type: 'GENERAL', context: 'RETURN', assetId: adapter.id });

  const r = await fx.record(admin, id);
  assert.equal(r.status, 200, JSON.stringify(r.body)); // reachable: not shadowed by GET /assignments/:id
  const rec = r.body.data;

  // exactly the payload of the doc — no missing, no extra keys
  assert.deepEqual(Object.keys(rec).sort(), ['assignmentCode', 'assignmentId', 'comparison', 'employee', 'hasDiscrepancies', 'id', 'items', 'photos', 'returnCondition', 'returnNotes', 'returnedAt', 'returnedBy', 'unreturned', 'workIdentity']);
  assert.match(rec.id, UUID);
  assert.equal(rec.assignmentId, id);
  assert.equal(rec.assignmentCode, assignment.assignmentCode);
  assert.equal(rec.returnedAt, ret.body.data.returnedAt);
  assert.deepEqual(rec.returnedBy, { id: me.id, fullName: me.fullName });
  assert.equal(rec.returnCondition, 'FAIR');
  assert.equal(rec.returnNotes, 'adapter and Bitrix login missing');
  assert.deepEqual(rec.employee, { id: emp.id, fullName: emp.fullName, department: { id: w.dept('Call Center').id, name: 'Call Center' }, room: { id: w.room('TR2').id, code: 'TR2' } });
  assert.equal(rec.workIdentity, null);

  // items: assignment items in role order, with the serial number, the condition at both ends and the `returned` flag
  assert.deepEqual(
    rec.items.map((i) => Object.keys(i).sort().join()),
    Array(4).fill('assetId,code,conditionAtHandover,name,returnCondition,returned,role,serialNumber'),
  );
  assert.deepEqual(rec.items, [
    { assetId: phone.id, code: phone.code, name: phone.name, role: 'PRIMARY', serialNumber: phone.serialNumber, conditionAtHandover: 'GOOD', returnCondition: 'FAIR', returned: true },
    { assetId: sim.id, code: sim.code, name: sim.name, role: 'SIM1', serialNumber: sim.serialNumber, conditionAtHandover: 'GOOD', returnCondition: 'DAMAGED', returned: true },
    { assetId: cable.id, code: cable.code, name: cable.name, role: 'CHARGER_CABLE', serialNumber: cable.serialNumber, conditionAtHandover: 'GOOD', returnCondition: null, returned: true },
    { assetId: adapter.id, code: adapter.code, name: adapter.name, role: 'CHARGER_ADAPTER', serialNumber: adapter.serialNumber, conditionAtHandover: 'GOOD', returnCondition: null, returned: false },
  ]);
  assert.ok(phone.serialNumber && sim.serialNumber, 'the fixtures do carry serial numbers');

  // comparison: the full field list, decoded — exactly what the return itself answered with
  assert.deepEqual(rec.comparison, ret.body.data.comparison);
  assert.ok(rec.comparison.length > rec.comparison.filter((c) => c.isDiscrepancy).length, 'unflagged rows are listed too');
  assert.deepEqual(rec.comparison.filter((c) => c.isDiscrepancy).map((c) => [c.fieldKey, c.severity]).sort(), [['bitrixAccountId', 'CRITICAL'], ['chargerAdapterAssetId', 'CRITICAL'], ['condition', 'WARNING']]);
  assert.equal(rec.hasDiscrepancies, true);
  assert.equal(rec.hasDiscrepancies, ret.body.data.hasDiscrepancies);

  // unreturned: both missing items, OPEN (assets first, the Bitrix account last)
  assert.deepEqual(rec.unreturned, [assetEntry(adapter, 'CHARGER_ADAPTER'), accountEntry(bitrix)]);
  assert.deepEqual(ret.body.data.unreturnedItems.map((u) => u.kind), ['CHARGER_ADAPTER', 'BITRIX'], 'the return itself reported the same two');

  // photos split by context, in upload order, with the asset each one shows
  const shaped = (p, type, assetId) => ({ id: p.id, type, assetId, url: `/api/v1/photos/${p.id}/file` });
  assert.deepEqual(rec.photos, {
    handover: [shaped(hPhone, 'FRONT', phone.id), shaped(hWhole, 'BACK', null)],
    return: [shaped(rWhole, 'CONDITION', null), shaped(rAdapter, 'GENERAL', adapter.id)],
  });
  assert.equal(await admin.status(rec.photos.return[1].url), 200, 'the photo url is the existing file endpoint');

  // /unreturned lists the same two entries
  const u = await fx.unreturned(admin, id);
  assert.equal(u.status, 200);
  assert.deepEqual(u.body, { data: rec.unreturned });
});

test('return-record: a return with nothing missing → unreturned [], every item returned, no discrepancy; the other assignment endpoints still answer', async () => {
  const admin = await as('admin');
  const w = await world(admin);
  const emp = await fx.employee(admin, w, 'complete');
  const { assignment, phone, sim, cable, adapter, bitrix, simNumber } = await fx.phoneKit(admin, w, emp, 'complete');
  const id = assignment.id;

  // existing endpoints, before: the detail and the return form (they must not be shadowed by the new routes either)
  assert.equal((await admin.req('GET', `/assignments/${id}`)).body.data.assignmentCode, assignment.assignmentCode);
  const form = await admin.req('GET', `/assignments/${id}/return-form`);
  assert.equal(form.status, 200, JSON.stringify(form.body));
  assert.equal(form.body.data.out.bitrixAccountId, bitrix.email);

  // the web form sends every key back
  const ret = await fx.ret(admin, id, {
    returnCondition: 'GOOD',
    return: { condition: 'GOOD', sim1Number: simNumber, sim2Number: null, bitrixAccountId: form.body.data.out.bitrixAccountId, chargerCableAssetId: form.body.data.out.chargerCableAssetId, chargerAdapterAssetId: form.body.data.out.chargerAdapterAssetId },
  });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  assert.deepEqual(ret.body.data.unreturnedItems, []);

  const rec = (await fx.record(admin, id)).body.data;
  assert.deepEqual(rec.unreturned, []);
  assert.equal(rec.hasDiscrepancies, false);
  assert.deepEqual(rec.items.map((i) => [i.assetId, i.returned]), [phone, sim, cable, adapter].map((a) => [a.id, true]));
  assert.deepEqual(rec.photos, { handover: [], return: [] });
  assert.deepEqual((await fx.unreturned(admin, id)).body, { data: [] });

  // existing endpoints, after: a second return is still a 409, the timeline and the detail are untouched
  assert.equal((await fx.ret(admin, id, { returnCondition: 'GOOD' })).status, 409);
  assert.equal((await admin.req('GET', `/assignments/${id}/return-form`)).status, 409);
  assert.equal((await admin.req('GET', `/assignments/${id}`)).body.data.returnRecords.length, 1);
  assert.ok((await fx.timeline(admin, id)).some((e) => e.eventType === 'RETURNED'));
});

test('an assignment that was never returned: return-record 404, unreturned [] (nothing owed), resolving its own asset 409; unknown ids 404, malformed 400, no session 401', async () => {
  const admin = await as('admin');
  const w = await world(admin);
  const emp = await fx.employee(admin, w, 'active');
  const { assignment, phone, adapter, bitrix } = await fx.phoneKit(admin, w, emp, 'active');
  const id = assignment.id;

  const rec = await fx.record(admin, id);
  assert.equal(rec.status, 404, JSON.stringify(rec.body));
  assert.equal(rec.body.error.code, 'NOT_FOUND');
  assert.deepEqual((await fx.unreturned(admin, id)).body, { data: [] });
  // belongs to the assignment (so not a 400), but nothing is owed yet → 409
  for (const body of [{ assetId: adapter.id, resolution: 'RETURNED' }, { assetId: phone.id, resolution: 'LOST' }, { accountId: bitrix.id, resolution: 'RETURNED' }]) {
    const r = await fx.resolve(admin, id, body);
    assert.equal(r.status, 409, JSON.stringify(r.body));
  }
  assert.equal((await fx.getAsset(admin, adapter.id)).status, 'ASSIGNED', 'nothing was touched');
  assert.equal((await fx.account(admin, bitrix.id)).currentAssignment?.id, id);

  for (const path of ['return-record', 'unreturned']) {
    assert.equal((await admin.req('GET', `/assignments/${UNKNOWN_ID}/${path}`)).status, 404, `unknown ${path}`);
    assert.equal((await admin.req('GET', `/assignments/not-a-uuid/${path}`)).status, 400, `malformed ${path}`);
    assert.equal((await anonymous().req('GET', `/assignments/${id}/${path}`)).status, 401, `no session ${path}`);
  }
  assert.equal((await fx.resolve(admin, UNKNOWN_ID, { assetId: adapter.id, resolution: 'LOST' })).status, 404);
  assert.equal((await fx.resolve(anonymous(), id, { assetId: adapter.id, resolution: 'LOST' })).status, 401);
});

/* ───────────────────────────── POST unreturned/resolve — effects ───────────────────────────── */

test('resolve RETURNED with condition DAMAGED → asset AVAILABLE, no holder, condition DAMAGED, UPDATED + NOTE timeline entries, an audit row; the record shows the item RESOLVED', async () => {
  const admin = await as('admin');
  const w = await world(admin);
  const me = (await admin.req('GET', '/auth/me')).body.user;
  const emp = await fx.employee(admin, w, 'resolve returned');
  const k = await fx.returnedWithMissing(admin, w, emp, 'resolve returned');

  const before = await fx.getAsset(admin, k.adapter.id);
  assert.deepEqual([before.status, before.condition, before.currentHolder?.id], ['ASSIGNED', 'GOOD', emp.id], 'still held by the employee after the return');

  const res = await fx.resolve(admin, k.id, { assetId: k.adapter.id, resolution: 'RETURNED', condition: 'DAMAGED', notes: 'came back cracked' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const resolution = { kind: 'RETURNED', at: res.body.data.item.resolution.at, by: { id: me.id, fullName: me.fullName }, notes: 'came back cracked', condition: 'DAMAGED' };
  assert.deepEqual(res.body.data.item, assetEntry(k.adapter, 'CHARGER_ADAPTER', 'RESOLVED', resolution));
  assert.ok(Math.abs(Date.now() - Date.parse(resolution.at)) < 60_000, 'resolution.at is when it was settled');
  assert.equal(res.body.data.assignmentId, k.id);
  assert.equal(res.body.data.assignmentCode, k.code);
  assert.deepEqual(res.body.data.unreturned, [accountEntry(k.bitrix), assetEntry(k.adapter, 'CHARGER_ADAPTER', 'RESOLVED', resolution)], 'the whole list after the change: owed first, settled after');

  // the asset: released, condition written, both timeline entries
  const after = await fx.getAsset(admin, k.adapter.id);
  assert.equal(after.status, 'AVAILABLE');
  assert.equal(after.currentHolder, null);
  assert.equal(after.condition, 'DAMAGED');
  const updated = after.timelineEntries.filter((e) => e.eventType === 'UPDATED' && e.snapshot.reason === 'return-resolved');
  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0].snapshot, { field: 'condition', from: 'GOOD', to: 'DAMAGED', assignmentCode: k.code, reason: 'return-resolved' });
  const notes = after.timelineEntries.filter((e) => e.eventType === 'NOTE' && e.snapshot.kind === 'UNRETURNED_RESOLVED');
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0].snapshot, { kind: 'UNRETURNED_RESOLVED', assetId: k.adapter.id, resolution: 'RETURNED', condition: 'DAMAGED', notes: 'came back cracked' });

  // the NOTE entry is on the assignment's own timeline, written by the admin
  const entry = (await fx.timeline(admin, k.id, '&eventType=NOTE')).find((e) => e.snapshot.kind === 'UNRETURNED_RESOLVED');
  assert.ok(entry, 'NOTE entry on the assignment timeline');
  assert.equal(entry.assetId, k.adapter.id);
  assert.deepEqual(entry.createdBy, { id: me.id, fullName: me.fullName });

  // the audit trail
  const rows = await fx.auditRows(admin, k.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targetType, 'Assignment');
  assert.equal(rows[0].actor.username, 'admin');
  assert.deepEqual(
    { resolution: rows[0].meta.resolution, assetId: rows[0].meta.assetId, assignmentCode: rows[0].meta.assignmentCode, assetStatus: rows[0].meta.assetStatus, conditionFrom: rows[0].meta.conditionFrom, conditionTo: rows[0].meta.conditionTo },
    { resolution: 'RETURNED', assetId: k.adapter.id, assignmentCode: k.code, assetStatus: 'AVAILABLE', conditionFrom: 'GOOD', conditionTo: 'DAMAGED' },
  );

  // the return record and the list agree: the adapter is RESOLVED (and now counts as returned), the Bitrix account is still OPEN
  const rec = (await fx.record(admin, k.id)).body.data;
  assert.deepEqual(rec.unreturned, res.body.data.unreturned);
  assert.equal(rec.items.find((i) => i.assetId === k.adapter.id).returned, true);
  assert.deepEqual((await fx.unreturned(admin, k.id)).body.data, rec.unreturned);
});

test('resolve RETURNED: no condition → the asset keeps its own and gets no UPDATED entry (same for the condition it already has); condition DISPOSED → written off, like a return', async () => {
  const admin = await as('admin');
  const w = await world(admin);
  const emp = await fx.employee(admin, w, 'resolve conditions');
  const k = await fx.phoneKit(admin, w, emp, 'resolve conditions', { sim2: true });
  const ret = await fx.ret(admin, k.assignment.id, { returnCondition: 'GOOD', return: { sim2Number: null, chargerAdapterAssetId: null, chargerCableAssetId: null } });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  assert.deepEqual(ret.body.data.unreturnedItems.map((u) => u.kind), ['SIM2', 'CHARGER_CABLE', 'CHARGER_ADAPTER'], 'the Bitrix account came back; these three did not');
  const id = k.assignment.id;
  const noted = async (asset) => (await fx.getAsset(admin, asset.id)).timelineEntries.filter((e) => e.snapshot.kind === 'UNRETURNED_RESOLVED' || e.snapshot.reason === 'return-resolved');

  // 1) no condition at all
  assert.equal((await fx.resolve(admin, id, { assetId: k.sim2.id, resolution: 'RETURNED' })).status, 200);
  const sim2 = await fx.getAsset(admin, k.sim2.id);
  assert.deepEqual([sim2.status, sim2.condition, sim2.currentHolder], ['AVAILABLE', 'GOOD', null]);
  assert.deepEqual((await noted(k.sim2)).map((e) => [e.eventType, e.snapshot]), [['NOTE', { kind: 'UNRETURNED_RESOLVED', assetId: k.sim2.id, resolution: 'RETURNED', condition: null, notes: null }]]);

  // 2) the condition it already has
  assert.equal((await fx.resolve(admin, id, { assetId: k.adapter.id, resolution: 'RETURNED', condition: 'GOOD' })).status, 200);
  const adapter = await fx.getAsset(admin, k.adapter.id);
  assert.deepEqual([adapter.status, adapter.condition, adapter.currentHolder], ['AVAILABLE', 'GOOD', null]);
  assert.deepEqual((await noted(k.adapter)).map((e) => [e.eventType, e.snapshot.condition]), [['NOTE', 'GOOD']], 'recorded as given, but nothing changed → no UPDATED entry');

  // 3) it comes back DISPOSED → not reusable
  assert.equal((await fx.resolve(admin, id, { assetId: k.cable.id, resolution: 'RETURNED', condition: 'DISPOSED' })).status, 200);
  const cable = await fx.getAsset(admin, k.cable.id);
  assert.deepEqual([cable.status, cable.condition, cable.currentHolder], ['DISPOSED', 'DISPOSED', null]);
  assert.deepEqual((await noted(k.cable)).map((e) => [e.eventType, e.snapshot.from ?? null, e.snapshot.to ?? null]).sort(), [['NOTE', null, null], ['UPDATED', 'GOOD', 'DISPOSED']]);

  // the room is kept (as on any return) — SIM 2 sat in no room, so none appears
  assert.equal(sim2.room, null);
  assert.deepEqual((await fx.unreturned(admin, id)).body.data.map((e) => [e.role, e.status]), [['SIM2', 'RESOLVED'], ['CHARGER_CABLE', 'RESOLVED'], ['CHARGER_ADAPTER', 'RESOLVED']]);
});

test('resolve a Bitrix account RETURNED → unbound (still active), free to be handed out again; its NOTE entry hangs off the primary asset', async () => {
  const admin = await as('admin');
  const w = await world(admin);
  const me = (await admin.req('GET', '/auth/me')).body.user;
  const emp = await fx.employee(admin, w, 'resolve bitrix');
  const k = await fx.returnedWithMissing(admin, w, emp, 'resolve bitrix');

  const before = await fx.account(admin, k.bitrix.id);
  assert.equal(before.currentAssignment?.id, k.id, 'a Bitrix account that did not come back stays bound');
  // …so it cannot be handed out again
  const blocked = await admin.req('POST', '/assignments/phone', { body: { employeeId: emp.id, phoneAssetId: (await fx.asset(admin, w, 'Phones', 'blocked', { phone: { imei: digits(15) } })).id, bitrixAccountId: k.bitrix.id } });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));

  const res = await fx.resolve(admin, k.id, { accountId: k.bitrix.id, resolution: 'RETURNED', notes: 'login handed in' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.item, accountEntry(k.bitrix, 'RESOLVED', { kind: 'RETURNED', at: res.body.data.item.resolution.at, by: { id: me.id, fullName: me.fullName }, notes: 'login handed in', condition: null }));

  const after = await fx.account(admin, k.bitrix.id);
  assert.equal(after.currentAssignment, null, 'unbound');
  assert.equal(after.isActive, true, 'and still usable');

  const entry = (await fx.timeline(admin, k.id, '&eventType=NOTE')).find((e) => e.snapshot.kind === 'UNRETURNED_RESOLVED');
  assert.deepEqual(entry.snapshot, { kind: 'UNRETURNED_RESOLVED', accountId: k.bitrix.id, resolution: 'RETURNED', condition: null, notes: 'login handed in' });
  assert.equal(entry.assetId, k.phone.id, 'an account has no asset: the entry hangs off the primary asset');
  const rows = await fx.auditRows(admin, k.id);
  assert.deepEqual([rows.length, rows[0].meta.accountId, rows[0].meta.resolution, rows[0].meta.accountActive], [1, k.bitrix.id, 'RETURNED', true]);

  // free again: a new phone handover with that very account goes through
  const again = await admin.req('POST', '/assignments/phone', { body: { employeeId: emp.id, phoneAssetId: (await fx.asset(admin, w, 'Phones', 'reuse', { phone: { imei: digits(15) } })).id, bitrixAccountId: k.bitrix.id } });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  made.active.add(again.body.data.id);
  assert.equal((await fx.account(admin, k.bitrix.id)).currentAssignment?.id, again.body.data.id);
});

test('resolve LOST → asset DISPOSED (AssetStatus has no LOST) with a note and no holder, condition untouched and the sent condition ignored; account deactivated and unbound', async () => {
  const admin = await as('admin');
  const w = await world(admin);
  const emp = await fx.employee(admin, w, 'resolve lost');
  // an adapter that already carries a note of its own — the lost note is appended, never replacing it
  const [phone, adapter, bitrix] = await Promise.all([
    fx.asset(admin, w, 'Phones', 'lost phone', { phone: { imei: digits(15) } }),
    fx.asset(admin, w, 'Charger Adapters', 'lost adapter', { notes: 'bought 2026-01' }),
    fx.bitrix(admin, 'lost'),
  ]);
  const handover = await admin.req('POST', '/assignments/phone', { body: { employeeId: emp.id, phoneAssetId: phone.id, chargerAdapterAssetId: adapter.id, bitrixAccountId: bitrix.id } });
  assert.equal(handover.status, 201, JSON.stringify(handover.body));
  const id = handover.body.data.id;
  const code = handover.body.data.assignmentCode;
  assert.equal((await fx.ret(admin, id, { returnCondition: 'GOOD', return: { chargerAdapterAssetId: null, bitrixAccountId: null } })).status, 200);

  // the asset
  const lost = await fx.resolve(admin, id, { assetId: adapter.id, resolution: 'LOST', condition: 'POOR', notes: 'fell into the sea' });
  assert.equal(lost.status, 200, JSON.stringify(lost.body));
  assert.equal(lost.body.data.item.status, 'RESOLVED');
  assert.deepEqual([lost.body.data.item.resolution.kind, lost.body.data.item.resolution.notes, lost.body.data.item.resolution.condition], ['LOST', 'fell into the sea', null], 'a sent condition is not recorded for LOST');
  const asset = await fx.getAsset(admin, adapter.id);
  assert.equal(asset.status, 'DISPOSED', 'AssetStatus has no LOST value → DISPOSED + a note');
  assert.equal(asset.currentHolder, null);
  assert.equal(asset.condition, 'GOOD', 'nobody has seen it: its condition is left alone');
  assert.match(asset.notes, /^bought 2026-01\nLost — not returned from assignment A-\d+ \(\d{4}-\d{2}-\d{2}\)\. fell into the sea$/);
  assert.ok(asset.notes.includes(code));
  assert.equal(asset.timelineEntries.filter((e) => e.snapshot.reason === 'return-resolved').length, 0, 'no condition entry');
  const note = asset.timelineEntries.find((e) => e.snapshot.kind === 'UNRETURNED_RESOLVED');
  assert.deepEqual(note.snapshot, { kind: 'UNRETURNED_RESOLVED', assetId: adapter.id, resolution: 'LOST', condition: null, notes: 'fell into the sea' });
  // a written-off asset is not handed out again
  const reuse = await admin.req('POST', '/assignments/generic', { body: { type: 'GENERAL', employeeId: emp.id, assetId: adapter.id } });
  assert.equal(reuse.status, 409, JSON.stringify(reuse.body));

  // the account
  const lostAccount = await fx.resolve(admin, id, { accountId: bitrix.id, resolution: 'LOST', condition: 'DAMAGED' });
  assert.equal(lostAccount.status, 200, JSON.stringify(lostAccount.body));
  assert.deepEqual([lostAccount.body.data.item.resolution.kind, lostAccount.body.data.item.resolution.condition], ['LOST', null], 'a condition means nothing for an account');
  const account = await fx.account(admin, bitrix.id);
  assert.deepEqual([account.isActive, account.currentAssignment], [false, null]);
  const accountNote = (await fx.timeline(admin, id, '&eventType=NOTE')).find((e) => e.snapshot.accountId === bitrix.id);
  assert.deepEqual(accountNote.snapshot, { kind: 'UNRETURNED_RESOLVED', accountId: bitrix.id, resolution: 'LOST', condition: null, notes: null });
  const audit = await fx.auditRows(admin, id);
  assert.deepEqual(audit.map((a) => [a.meta.resolution, a.meta.assetStatus ?? a.meta.accountActive]).sort(), [['LOST', 'DISPOSED'], ['LOST', false]].sort());

  // the record: both settled; the lost adapter did NOT come back (returned:false), everything else did
  const rec = (await fx.record(admin, id)).body.data;
  assert.deepEqual(rec.unreturned.map((e) => [e.role, e.status, e.resolution.kind]), [['CHARGER_ADAPTER', 'RESOLVED', 'LOST'], ['BITRIX', 'RESOLVED', 'LOST']]);
  assert.deepEqual(rec.items.map((i) => [i.role, i.returned]), [['PRIMARY', true], ['CHARGER_ADAPTER', false]]);
});

/* ───────────────────────────── POST unreturned/resolve — guards ───────────────────────────── */

test('resolving twice → 409 (asset and account), nothing written twice; parallel resolves of one item → exactly one 200', async () => {
  const admin = await as('admin');
  const w = await world(admin);
  const emp = await fx.employee(admin, w, 'twice');
  const k = await fx.returnedWithMissing(admin, w, emp, 'twice');

  const first = await fx.resolve(admin, k.id, { assetId: k.adapter.id, resolution: 'RETURNED', condition: 'FAIR' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  for (const resolution of ['RETURNED', 'LOST']) {
    const again = await fx.resolve(admin, k.id, { assetId: k.adapter.id, resolution });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.error.code, 'CONFLICT');
    assert.match(again.body.error.message, /already resolved \(RETURNED\)/);
  }
  assert.equal((await fx.resolve(admin, k.id, { accountId: k.bitrix.id, resolution: 'RETURNED' })).status, 200);
  assert.equal((await fx.resolve(admin, k.id, { accountId: k.bitrix.id, resolution: 'LOST' })).status, 409, 'the account as well — and LOST must not deactivate it afterwards');
  assert.equal((await fx.account(admin, k.bitrix.id)).isActive, true);
  // the second attempt wrote nothing: still the first resolution, one NOTE entry, one UPDATED entry, one audit row each
  const asset = await fx.getAsset(admin, k.adapter.id);
  assert.deepEqual([asset.status, asset.condition], ['AVAILABLE', 'FAIR']);
  assert.equal(asset.timelineEntries.filter((e) => e.snapshot.kind === 'UNRETURNED_RESOLVED').length, 1);
  assert.equal(asset.timelineEntries.filter((e) => e.snapshot.reason === 'return-resolved').length, 1);
  assert.equal((await fx.auditRows(admin, k.id)).length, 2, 'one audit row per settled item');

  // a race: six requests settle the same item at once, each wanting a different condition
  const k2 = await fx.returnedWithMissing(admin, w, emp, 'race');
  const conditions = ['DAMAGED', 'POOR', 'FAIR', 'NEW', 'DAMAGED', 'POOR'];
  const results = await Promise.all(conditions.map((condition) => fx.resolve(admin, k2.id, { assetId: k2.adapter.id, resolution: 'RETURNED', condition })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409], JSON.stringify(results.map((r) => [r.status, r.body.error?.code])));
  for (const r of results.filter((x) => x.status === 409)) assert.equal(r.body.error.code, 'CONFLICT');
  const winner = conditions[results.findIndex((r) => r.status === 200)];
  const raced = await fx.getAsset(admin, k2.adapter.id);
  assert.equal(raced.condition, winner, "the asset carries the winner's condition only");
  assert.equal(raced.timelineEntries.filter((e) => e.snapshot.kind === 'UNRETURNED_RESOLVED').length, 1, 'one NOTE entry');
  assert.equal(raced.timelineEntries.filter((e) => e.snapshot.reason === 'return-resolved').length, 1, 'one UPDATED entry');
  assert.equal((await fx.auditRows(admin, k2.id)).length, 1, 'one audit row');

  // two DIFFERENT items of one assignment settled at the same moment: both go through (they only queue up behind each other)
  const k3 = await fx.returnedWithMissing(admin, w, emp, 'two at once');
  const both = await Promise.all([
    fx.resolve(admin, k3.id, { assetId: k3.adapter.id, resolution: 'RETURNED', condition: 'FAIR' }),
    fx.resolve(admin, k3.id, { accountId: k3.bitrix.id, resolution: 'RETURNED' }),
  ]);
  assert.deepEqual(both.map((r) => r.status), [200, 200], JSON.stringify(both.map((r) => r.body)));
  assert.deepEqual((await fx.unreturned(admin, k3.id)).body.data.map((e) => e.status), ['RESOLVED', 'RESOLVED']);
  assert.equal((await fx.auditRows(admin, k3.id)).length, 2);
});

test('an item of another assignment (or of none) → 400 and nothing changes — in either assignment', async () => {
  const admin = await as('admin');
  const w = await world(admin);
  const [e1, e2] = await Promise.all([fx.employee(admin, w, 'other A'), fx.employee(admin, w, 'other B')]);
  const a = await fx.returnedWithMissing(admin, w, e1, 'other A');
  const b = await fx.returnedWithMissing(admin, w, e2, 'other B');
  const stray = await fx.asset(admin, w, 'Charger Adapters', 'stray');

  // B's items are OPEN — in B. Through A they are refused.
  const attempts = [
    { assetId: b.adapter.id, resolution: 'RETURNED' },
    { assetId: b.adapter.id, resolution: 'LOST' },
    { accountId: b.bitrix.id, resolution: 'RETURNED' },
    { accountId: b.bitrix.id, resolution: 'LOST' },
    { assetId: stray.id, resolution: 'RETURNED' }, // an asset of no assignment at all
    { assetId: UNKNOWN_ID, resolution: 'RETURNED' }, // does not exist
    { accountId: UNKNOWN_ID, resolution: 'LOST' },
  ];
  for (const body of attempts) {
    const r = await fx.resolve(admin, a.id, body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'BAD_REQUEST');
  }
  const untouchedB = await fx.getAsset(admin, b.adapter.id);
  assert.deepEqual([untouchedB.status, untouchedB.currentHolder?.id], ['ASSIGNED', e2.id]);
  assert.equal((await fx.account(admin, b.bitrix.id)).currentAssignment?.id, b.id);
  assert.deepEqual((await fx.unreturned(admin, b.id)).body.data, [assetEntry(b.adapter, 'CHARGER_ADAPTER'), accountEntry(b.bitrix)]);
  assert.deepEqual((await fx.unreturned(admin, a.id)).body.data, [assetEntry(a.adapter, 'CHARGER_ADAPTER'), accountEntry(a.bitrix)]);
  assert.equal((await fx.auditRows(admin, a.id)).length + (await fx.auditRows(admin, b.id)).length, 0, 'refused attempts leave no audit row');
  // …and each assignment still settles its own items
  assert.equal((await fx.resolve(admin, b.id, { assetId: b.adapter.id, resolution: 'RETURNED' })).status, 200);
});

test('resolve validation: exactly one of assetId / accountId, a real resolution and condition, no unknown keys, notes ≤ 1000 → 400 VALIDATION_ERROR', async () => {
  const admin = await as('admin');
  const w = await world(admin);
  const emp = await fx.employee(admin, w, 'validation');
  const k = await fx.returnedWithMissing(admin, w, emp, 'validation');
  const bad = [
    ['neither id', { resolution: 'RETURNED' }],
    ['both ids', { assetId: k.adapter.id, accountId: k.bitrix.id, resolution: 'RETURNED' }],
    ['null ids', { assetId: null, accountId: null, resolution: 'LOST' }],
    ['no resolution', { assetId: k.adapter.id }],
    ['unknown resolution', { assetId: k.adapter.id, resolution: 'FOUND' }],
    ['lowercase resolution', { assetId: k.adapter.id, resolution: 'returned' }],
    ['unknown condition', { assetId: k.adapter.id, resolution: 'RETURNED', condition: 'BROKEN' }],
    ['assetId not a uuid', { assetId: 'abc', resolution: 'RETURNED' }],
    ['accountId not a uuid', { accountId: 'abc', resolution: 'RETURNED' }],
    ['unknown key', { assetId: k.adapter.id, resolution: 'RETURNED', returned: true }],
    ['notes too long', { assetId: k.adapter.id, resolution: 'LOST', notes: 'x'.repeat(1001) }],
    ['notes not a string', { assetId: k.adapter.id, resolution: 'LOST', notes: 5 }],
  ];
  for (const [what, body] of bad) {
    const r = await fx.resolve(admin, k.id, body);
    assert.equal(r.status, 400, `${what} → ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR', what);
  }
  assert.equal((await admin.req('POST', `/assignments/${k.id}/unreturned/resolve`)).status, 400, 'no body at all');
  assert.equal((await fx.resolve(admin, 'not-a-uuid', { assetId: k.adapter.id, resolution: 'LOST' })).status, 400, 'malformed assignment id');
  // none of it touched anything; a null condition / null notes are fine ("not given")
  assert.deepEqual((await fx.unreturned(admin, k.id)).body.data.map((e) => e.status), ['OPEN', 'OPEN']);
  const ok = await fx.resolve(admin, k.id, { assetId: k.adapter.id, resolution: 'RETURNED', condition: null, notes: null });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.data.item.resolution.notes, ok.body.data.item.resolution.condition], [null, null]);
});

test('the same charger taken out twice by one employee is owed by the LATER assignment only; the earlier, completely returned one is not flagged and cannot settle it', async () => {
  const admin = await as('admin');
  const w = await world(admin);
  const emp = await fx.employee(admin, w, 'twice charger');
  const adapter = await fx.asset(admin, w, 'Charger Adapters', 'shared adapter');
  const handOut = async (label) => {
    const phone = await fx.asset(admin, w, 'Phones', `${label} phone`, { phone: { imei: digits(15) } });
    const r = await admin.req('POST', '/assignments/phone', { body: { employeeId: emp.id, phoneAssetId: phone.id, chargerAdapterAssetId: adapter.id } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    made.active.add(r.body.data.id);
    return r.body.data;
  };
  const first = await handOut('first');
  assert.equal((await fx.ret(admin, first.id, { returnCondition: 'GOOD' })).status, 200, 'the first handover comes back complete');
  const second = await handOut('second');
  assert.equal((await fx.ret(admin, second.id, { returnCondition: 'GOOD', return: { chargerAdapterAssetId: null } })).status, 200, 'the second one loses the adapter');

  assert.equal((await fx.getAsset(admin, adapter.id)).currentHolder?.id, emp.id, 'the adapter is still with the employee');
  assert.deepEqual((await fx.unreturned(admin, second.id)).body.data, [assetEntry(adapter, 'CHARGER_ADAPTER')]);
  assert.deepEqual((await fx.unreturned(admin, first.id)).body.data, [], 'the earlier assignment owes nothing — the adapter was released before the second handover');
  const rec = (await fx.record(admin, first.id)).body.data;
  assert.deepEqual(rec.unreturned, []);
  assert.equal(rec.items.find((i) => i.assetId === adapter.id).returned, true);
  assert.equal((await fx.record(admin, second.id)).body.data.items.find((i) => i.assetId === adapter.id).returned, false);

  assert.equal((await fx.resolve(admin, first.id, { assetId: adapter.id, resolution: 'LOST' })).status, 409, 'through the earlier assignment it is not owed');
  assert.equal((await fx.getAsset(admin, adapter.id)).status, 'ASSIGNED', 'nothing was written off');
  assert.equal((await fx.resolve(admin, second.id, { assetId: adapter.id, resolution: 'RETURNED' })).status, 200);
  assert.deepEqual((await fx.unreturned(admin, first.id)).body.data, [], 'and settling the later one does not conjure up an entry on the earlier one');
  assert.deepEqual((await fx.unreturned(admin, second.id)).body.data.map((e) => e.status), ['RESOLVED']);
});

/* ───────────────────────────── room scope + RBAC ───────────────────────────── */

test('room scope on both GET endpoints = the detail\'s rule (seat room, else employee room): TEAM_LEADER own room, CALL_CENTER_MANAGER call-centre rooms, MANAGER / ADMIN all; always 404, never 403', async () => {
  const admin = await as('admin');
  const [tl1, tl2, ccm, manager] = await Promise.all([as('tl.tr1'), as('tl.tr2'), as('mr.mahmoud'), as('manager')]);
  const w = await world(admin);
  const [tr1, tr2, hospital] = [w.room('TR1'), w.room('TR2'), w.room('P9R-HOSPITAL')];
  const [inTr1, inTr2, noRoom] = await Promise.all([fx.employee(admin, w, 'scope TR1', { room: tr1 }), fx.employee(admin, w, 'scope TR2', { room: tr2 }), fx.employee(admin, w, 'scope none')]);
  const seat = (roomId) => ({ name: `P9R seat ${uid()}`, ...(roomId ? { roomId } : { departmentTeamId: w.dept('Call Center').id }) });

  // [label, employee, seat, TL TR1, TL TR2, CCM]
  const cases = [
    ['no seat, employee in TR1', inTr1, null, true, false, true],
    ['no seat, employee in TR2', inTr2, null, false, true, true],
    ['no seat, employee without a room', noRoom, null, false, false, false],
    ['seat in TR2, employee in TR1 (the seat wins)', inTr1, seat(tr2.id), false, true, true],
    ['seat in TR1, employee in TR2 (the seat wins)', inTr2, seat(tr1.id), true, false, true],
    ['seat without a room, employee in TR1 (falls back to the employee)', inTr1, seat(null), true, false, true],
    ['seat in a HOSPITAL room, employee in TR1', inTr1, seat(hospital.id), false, false, false],
  ];
  for (const [label, employee, workIdentity, expectTl1, expectTl2, expectCcm] of cases) {
    const { assignment } = await fx.laptop(admin, w, employee, `scope ${uid()}`, { workIdentity });
    assert.equal((await fx.ret(admin, assignment.id, { returnCondition: 'GOOD' })).status, 200);
    if (workIdentity) {
      const rec = (await fx.record(admin, assignment.id)).body.data;
      assert.deepEqual(Object.keys(rec.workIdentity).sort(), ['id', 'name'], label);
      assert.equal(rec.workIdentity.name, workIdentity.name, label);
    }
    for (const [who, client, allowed] of [['TL TR1', tl1, expectTl1], ['TL TR2', tl2, expectTl2], ['CCM', ccm, expectCcm], ['MANAGER', manager, true], ['ADMIN', admin, true]]) {
      for (const path of ['return-record', 'unreturned']) {
        const r = await client.req('GET', `/assignments/${assignment.id}/${path}`);
        assert.equal(r.status, allowed ? 200 : 404, `${who} GET ${path} — ${label}: ${JSON.stringify(r.body).slice(0, 140)}`);
        if (!allowed) assert.equal(r.body.error.code, 'NOT_FOUND');
      }
    }
  }
});

test('only an ADMIN settles: TEAM_LEADER (even in their own room), MANAGER and CALL_CENTER_MANAGER get 403, no session 401 — and nothing is changed', async () => {
  const admin = await as('admin');
  const [tl1, ccm, manager] = await Promise.all([as('tl.tr1'), as('mr.mahmoud'), as('manager')]);
  const w = await world(admin);
  const emp = await fx.employee(admin, w, 'rbac', { room: w.room('TR1') });
  const k = await fx.returnedWithMissing(admin, w, emp, 'rbac');

  for (const [who, client] of [['TL in the assignment\'s room', tl1], ['MANAGER', manager], ['CALL_CENTER_MANAGER', ccm], ['anonymous', anonymous()]]) {
    for (const body of [{ assetId: k.adapter.id, resolution: 'RETURNED', condition: 'GOOD' }, { accountId: k.bitrix.id, resolution: 'LOST' }]) {
      const r = await fx.resolve(client, k.id, body);
      assert.equal(r.status, who === 'anonymous' ? 401 : 403, `${who} → ${JSON.stringify(r.body)}`);
    }
  }
  // the scoped reader sees the items (so the 403 is about writing, not about the room) and nothing moved
  assert.deepEqual((await fx.unreturned(tl1, k.id)).body.data.map((e) => e.status), ['OPEN', 'OPEN']);
  assert.equal((await fx.getAsset(admin, k.adapter.id)).status, 'ASSIGNED');
  assert.equal((await fx.account(admin, k.bitrix.id)).isActive, true);
  assert.equal((await fx.auditRows(admin, k.id)).length, 0);
  assert.equal((await fx.resolve(admin, k.id, { assetId: k.adapter.id, resolution: 'RETURNED' })).status, 200, 'the admin can');
});

/* ───────────────────────────── getUnreturned() itself (needs the scratch DB) ───────────────────────────── */

test('getUnreturned(): a Map with EVERY requested id (an empty array when nothing is owed), ids de-duplicated, falsy ignored; entries as the API lists them', { skip: NEEDS_DB }, async () => {
  const { getUnreturned } = require('../src/services/return.service');
  dbHandles.push(require('../src/db'));
  const admin = await as('admin');
  const w = await world(admin);
  const emp = await fx.employee(admin, w, 'helper contract');
  const owed = await fx.returnedWithMissing(admin, w, emp, 'helper owed');
  const settled = await fx.returnedWithMissing(admin, w, emp, 'helper settled');
  assert.equal((await fx.resolve(admin, settled.id, { assetId: settled.adapter.id, resolution: 'LOST', notes: 'gone' })).status, 200);
  const complete = (await fx.laptop(admin, w, emp, 'helper complete')).assignment;
  assert.equal((await fx.ret(admin, complete.id, { returnCondition: 'GOOD' })).status, 200);
  const active = (await fx.laptop(admin, w, emp, 'helper active')).assignment;

  const ids = [owed.id, settled.id, complete.id, active.id, UNKNOWN_ID];
  const map = await getUnreturned([...ids, owed.id, '', null, undefined]);
  assert.ok(map instanceof Map);
  assert.deepEqual([...map.keys()].sort(), [...ids].sort(), 'every requested id is a key');
  for (const id of [complete.id, active.id, UNKNOWN_ID]) assert.deepEqual(map.get(id), [], 'nothing owed → an empty array, never undefined');
  assert.deepEqual(map.get(owed.id).map((e) => [e.kind, e.role, e.status]), [['ASSET', 'CHARGER_ADAPTER', 'OPEN'], ['ACCOUNT', 'BITRIX', 'OPEN']]);
  assert.deepEqual(map.get(settled.id).map((e) => [e.role, e.status, e.resolution?.kind]), [['BITRIX', 'OPEN', undefined], ['CHARGER_ADAPTER', 'RESOLVED', 'LOST']], 'owed first, then the settled history');
  assert.ok(map.get(settled.id)[1].resolution.at instanceof Date);

  // the very entries the API serves
  for (const id of [owed.id, settled.id]) assert.deepEqual(JSON.parse(JSON.stringify(map.get(id))), (await fx.unreturned(admin, id)).body.data);
  assert.equal((await getUnreturned([])).size, 0);
  assert.equal((await getUnreturned()).size, 0);
  assert.equal((await getUnreturned([null, ''])).size, 0);
});

test('getUnreturned() is batched: the same number of SQL queries for 1 assignment as for 12 (no N+1)', { skip: NEEDS_DB }, async (t) => {
  const { PrismaClient } = require('@prisma/client');
  const { getUnreturned } = require('../src/services/return.service');
  const counting = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  dbHandles.push(counting);
  let queries = 0;
  counting.$on('query', () => { queries += 1; });

  const admin = await as('admin');
  const w = await world(admin);
  const emp = await fx.employee(admin, w, 'helper batch');

  // The baseline assignment exercises EVERY round of the helper: a settled item (the resolution lookup has rows)
  // and an asset that is still owed (the "handed over again?" lookup runs). SIM 2 + adapter go missing, the adapter is settled.
  const base = await fx.phoneKit(admin, w, emp, 'batch base', { sim: false, sim2: true, cable: false, bitrix: false });
  const baseRet = await fx.ret(admin, base.assignment.id, { returnCondition: 'GOOD', return: { sim2Number: null, chargerAdapterAssetId: null } });
  assert.equal(baseRet.status, 200, JSON.stringify(baseRet.body));
  assert.equal((await fx.resolve(admin, base.assignment.id, { assetId: base.adapter.id, resolution: 'RETURNED' })).status, 200);

  // …plus 11 more that each still owe their adapter: 12 assignments in all
  const ids = [base.assignment.id];
  for (let i = 0; i < 11; i += 1) {
    const k = await fx.phoneKit(admin, w, emp, `batch ${i}`, { sim: false, cable: false, bitrix: false });
    const ret = await fx.ret(admin, k.assignment.id, { returnCondition: 'GOOD', return: { chargerAdapterAssetId: null } });
    assert.equal(ret.status, 200, JSON.stringify(ret.body));
    ids.push(k.assignment.id);
  }

  const measure = async (list) => {
    queries = 0;
    const map = await getUnreturned(list, counting);
    await new Promise((resolve) => setTimeout(resolve, 100)); // Prisma delivers its query log events asynchronously — let them land
    return { queries, map };
  };
  const one = await measure([base.assignment.id]);
  const many = await measure(ids);
  assert.equal(ids.length, 12);
  assert.ok(one.queries > 0, 'queries were counted');
  assert.equal(many.queries, one.queries, `1 assignment → ${one.queries} SQL queries, 12 assignments → ${many.queries}`);
  t.diagnostic(`getUnreturned: ${one.queries} SQL queries for 1 assignment, ${many.queries} for 12`);
  assert.equal(many.map.size, 12);
  assert.ok([...many.map.values()].every((entries) => entries.some((e) => e.status === 'OPEN')), 'every one of the 12 still owes something');
  assert.deepEqual(many.map.get(base.assignment.id).map((e) => [e.role, e.status]), [['SIM2', 'OPEN'], ['CHARGER_ADAPTER', 'RESOLVED']]);
  assert.equal(many.map.get(ids[11]).length, 1);
});
