'use strict';
/**
 * Phase 7 QA fixes — card t_7ee6991c: asset guards, WhatsApp/SIM dual use, room-scope leaks, photos,
 * CSV export and audit-log dates (QA_REPORT_PHASE7 F-02/03/04/08/09/10/12/13/14/15/16/17/20/22/25/29).
 *
 * Same pattern as tests/api.test.js: it talks to a RUNNING server (BASE_URL) and also uses Prisma directly
 * (DATABASE_URL), so BOTH must point at the same, throw-away, freshly seeded database — never the shared
 * dev DB behind :4000. Both variables are mandatory (no defaults) and :4000 is refused:
 *
 *   createdb scratch_db
 *   DATABASE_URL='postgresql://postgres@localhost:5432/scratch_db?schema=public' npx prisma migrate deploy
 *   DATABASE_URL='…same…' npm run seed
 *   DATABASE_URL='…same…' PORT=3001 node src/server.js &
 *   DATABASE_URL='…same…' BASE_URL=http://localhost:3001 node --test tests/assign.fixes.test.js
 *
 * Needs the standard seed (logins, rooms TR1–TR4, the call-centre people and seats) but NOT the Excel
 * import: every category and asset the tests use is created here when it is missing (verified on a DB
 * with those categories removed). Everything created (assets, assignments, accounts, a room) is
 * returned/removed in the final hook, so repeated runs leave the data as they found it — assets that
 * gained history end DISPOSED, and a category the tests had to create stays while such assets reference it.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// Fail fast, before anything can load .env and quietly aim Prisma at the dev database.
const BASE = process.env.BASE_URL || '';
if (!BASE || !process.env.DATABASE_URL) {
  throw new Error('assign.fixes.test.js needs BOTH BASE_URL (your own server, e.g. http://localhost:3001) and DATABASE_URL (the same scratch DB that server uses)');
}
if (new URL(BASE).port === '4000') throw new Error('refusing to run against :4000 (the shared dev server) — start your own server on another port');

const prisma = require('../src/db');
const { toCsv } = require('../src/services/report.service');

/* ───────────────────────────── tiny API client ───────────────────────────── */

const PW = { admin: 'Admin#12345', manager: 'Manager#12345', 'tl.tr1': 'Leader#12345', 'tl.tr2': 'Leader#12345', 'mr.mahmoud': 'Mahmoud#12345' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

class Client {
  constructor() { this.cookies = {}; }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, path, { body, form } = {}) {
    const headers = { Cookie: this.cookieHeader() };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: form ?? (body ? JSON.stringify(body) : undefined) });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (v) this.cookies[pair.slice(0, i)] = v; else delete this.cookies[pair.slice(0, i)];
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, text, headers: res.headers };
  }
  /** Status of a raw (non-/api/v1-prefixed) GET, e.g. a photo URL taken from a response. */
  async status(path) { return (await fetch(`${BASE}${path}`, { headers: { Cookie: this.cookieHeader() } })).status; }
}

const sessions = new Map();
async function as(username) {
  if (!sessions.has(username)) {
    sessions.set(username, (async () => {
      const c = new Client();
      const r = await c.req('POST', '/auth/login', { body: { username, password: PW[username] } });
      assert.equal(r.status, 200, `login ${username}`);
      return c;
    })());
  }
  return sessions.get(username);
}

/* ───────────────────────────── fixtures + cleanup ───────────────────────────── */

const made = { assignments: [], assets: [], accounts: [], categories: [], rooms: [], photos: [] };
let counter = 0;
const digits = (n) => String(Date.now() * 1000 + (counter += 1)).slice(-n);
const phoneNo = () => `9053${digits(8)}`; // 12 digits, unique per call
const imei = () => `35${digits(13)}`; // 15 digits, unique per call
const tag = () => `${Date.now().toString(36)}${(counter += 1)}`;

const letter = (i) => String.fromCharCode(65 + (i % 26));
/** `count` unused 2–5 letter code prefixes ("preferred" ones first), picked from a random start. */
function freePrefixes(used, count, preferred = []) {
  const out = [];
  for (const p of preferred) if (out.length < count && !used.has(p)) { out.push(p); used.add(p); }
  const start = Math.floor(Math.random() * 26 ** 3);
  for (let i = 0; out.length < count && i < 26 ** 3; i += 1) {
    const n = (start + i) % 26 ** 3;
    const p = `Z${letter(n)}${letter(Math.floor(n / 26))}${letter(Math.floor(n / 676))}`;
    if (!used.has(p)) { out.push(p); used.add(p); }
  }
  assert.equal(out.length, count, 'enough free code prefixes');
  return out;
}

/** The categories the tests need. Production rules look some of them up BY NAME (Phones, SIM Cards, Charger
 *  Cables, Charger Adapters), so they are found by name and created — with what a SIM asset requires — only
 *  when the database lacks them. Nothing here comes from the Excel import. */
const CATEGORIES = {
  Phones: { prefix: 'PHN' },
  'SIM Cards': { prefix: 'SIM', fields: [{ key: 'phone_number', label: 'Phone number', type: 'string', required: true, isSearchable: true, isIdentifier: true }] },
  Chargers: { prefix: 'CHG' },
  'Charger Cables': { prefix: 'CBL', parent: 'Chargers' },
  'Charger Adapters': { prefix: 'ADP', parent: 'Chargers' },
  Laptops: { prefix: 'LAP' },
  Printers: { prefix: 'PRN' },
};
const categories = new Map();
function ensureCategory(name) {
  if (!categories.has(name)) {
    categories.set(name, (async () => {
      const def = CATEGORIES[name];
      assert.ok(def, `unknown test category ${name}`);
      const admin = await as('admin');
      const flat = (await admin.req('GET', '/asset-categories?includeInactive=true')).body.flat;
      const found = flat.find((c) => c.name === name && c.isActive);
      if (found) return found;
      const parentId = def.parent ? (await ensureCategory(def.parent)).id : null;
      const [codePrefix] = freePrefixes(new Set(flat.map((c) => c.codePrefix)), 1, [def.prefix]);
      const r = await admin.req('POST', '/asset-categories', { body: { name, parentId, kind: 'physical', codePrefix } });
      assert.equal(r.status, 201, `create category ${name}: ${JSON.stringify(r.body)}`);
      made.categories.push(r.body.data.id);
      for (const f of def.fields ?? []) {
        const rf = await admin.req('POST', `/asset-categories/${r.body.data.id}/fields`, { body: f });
        assert.equal(rf.status, 201, `create field ${f.key}: ${JSON.stringify(rf.body)}`);
      }
      return r.body.data;
    })());
  }
  return categories.get(name);
}

let seeded;
/** Seeded reference data the logins depend on anyway: rooms TR1–TR4, the call-centre people and seats. */
async function seed() {
  seeded ??= (async () => {
    const admin = await as('admin');
    const rooms = (await admin.req('GET', '/rooms')).body.data;
    const room = (code) => { const r = rooms.find((x) => x.code === code); assert.ok(r, `seed room ${code}`); return r; };
    const employee = async (fullName) => {
      const e = (await admin.req('GET', `/employees?q=${encodeURIComponent(fullName)}&pageSize=100`)).body.data.find((x) => x.fullName === fullName);
      assert.ok(e, `seed employee ${fullName}`);
      return e;
    };
    const seats = (await admin.req('GET', '/work-identities')).body.data;
    const seat = (name, roomCode) => { const s = seats.find((x) => x.name === name && x.room?.code === roomCode); assert.ok(s, `seed seat ${name}`); return s; };
    return {
      room, seat,
      sofia: await employee('Sofia Petrova'), // TR1, seat "sofia"
      ahmet: await employee('Ahmet Yilmaz'), // TR1, no seat
      elif: await employee('Elif Demir'), // TR2
      mehmet: await employee('Mehmet Kaya'), // TR3
      ayse: await employee('Ayse Celik'), // Banko, no room
      can: await employee('Can Ozturk'), // Muhasebe, no room
    };
  })();
  return seeded;
}

async function newAsset(categoryName, label, extra = {}) {
  const category = await ensureCategory(categoryName);
  const admin = await as('admin');
  const r = await admin.req('POST', '/assets', { body: { categoryId: category.id, name: `FIX ${label} ${tag()}`, condition: 'GOOD', ...extra } });
  assert.equal(r.status, 201, `create ${categoryName} asset: ${JSON.stringify(r.body)}`);
  made.assets.push(r.body.data.id);
  return r.body.data;
}
const newPhone = (label = 'phone') => newAsset('Phones', label, { phone: { imei: imei() } });
const newSim = (number = phoneNo()) => newAsset('SIM Cards', `sim ${number}`, { customFields: { phone_number: number } });

async function post(path, body) {
  const admin = await as('admin');
  const r = await admin.req('POST', path, { body });
  if (r.status === 201 && r.body?.data?.id) made.assignments.push(r.body.data.id);
  return r;
}
const assignPhone = (body) => post('/assignments/phone', body);
const assignGeneric = (body) => post('/assignments/generic', { type: 'LAPTOP', conditionAtHandover: 'GOOD', ...body });
/** What a return with missing items leaves behind: asset ASSIGNED + held, but in no active assignment. */
const forceHeld = (assetId, holder) => prisma.asset.update({ where: { id: assetId }, data: { status: 'ASSIGNED', currentHolderEmployeeId: holder.id } });
const dbAsset = (id) => prisma.asset.findUnique({ where: { id }, select: { status: true, currentHolderEmployeeId: true } });
const err = (r) => r.body?.error ?? {};

async function uploadPhoto(path) {
  const admin = await as('admin');
  const fd = new FormData(); fd.append('type', 'FRONT'); fd.append('photos', new Blob([PNG], { type: 'image/png' }), 'fix.png');
  const r = await admin.req('POST', path, { form: fd });
  assert.equal(r.status, 201, `upload ${path}: ${JSON.stringify(r.body)}`);
  made.photos.push(r.body.data[0].id);
  return r.body.data[0];
}

after(async () => {
  try {
    const admin = await as('admin');
    for (const id of made.photos) await admin.req('DELETE', `/photos/${id}`); // row + file on disk
    for (const id of made.assignments) await admin.req('POST', `/assignments/${id}/return`, { body: { returnCondition: 'GOOD' } }); // 409 when already returned
    for (const id of made.assets) await admin.req('DELETE', `/assets/${id}`); // hard delete, or soft-dispose when it has history
    for (const id of made.rooms) await admin.req('DELETE', `/rooms/${id}`);
    for (const id of made.accounts) await admin.req('DELETE', `/accounts/${id}`);
    for (const id of made.categories.reverse()) await admin.req('DELETE', `/asset-categories/${id}`);
  } finally {
    await prisma.$disconnect();
  }
});

/* ───────────────────────────── DATA INTEGRITY ───────────────────────────── */

test('F-03/F-09: only AVAILABLE, unheld assets can be handed over — phone + generic paths, SIM/charger/accessory ids', async () => {
  const { sofia, ayse } = await seed();
  const admin = await as('admin');

  // F-03: an asset that is ASSIGNED + held but has no active item (what a return with missing items leaves).
  const heldSim = await newSim();
  await forceHeld(heldSim.id, sofia);
  const g = await assignGeneric({ type: 'SIM', employeeId: ayse.id, assetId: heldSim.id });
  assert.equal(g.status, 409);
  assert.match(err(g).message, new RegExp(heldSim.code), '409 names the asset');
  assert.match(err(g).message, /status ASSIGNED/, '409 names the status');
  assert.match(err(g).message, /Sofia Petrova/, '409 names the holder');
  assert.deepEqual([err(g).details.status, err(g).details.heldBy.fullName], ['ASSIGNED', 'Sofia Petrova']);
  assert.equal((await dbAsset(heldSim.id)).currentHolderEmployeeId, sofia.id, 'the holder was not silently changed');

  // …the same guard on the phone path for the SIM and charger ids, and on generic accessories.
  const phone1 = await newPhone();
  const heldSim2 = await newSim(); await forceHeld(heldSim2.id, sofia);
  const p1 = await assignPhone({ employeeId: ayse.id, phoneAssetId: phone1.id, sim1AssetId: heldSim2.id });
  assert.equal(p1.status, 409, JSON.stringify(p1.body));
  assert.match(err(p1).message, /Sofia Petrova/);
  assert.equal((await dbAsset(phone1.id)).status, 'AVAILABLE', 'a rejected request leaves the phone untouched');
  const heldCable = await newAsset('Charger Cables', 'held cable'); await forceHeld(heldCable.id, sofia);
  assert.equal((await assignPhone({ employeeId: ayse.id, phoneAssetId: phone1.id, chargerCableAssetId: heldCable.id })).status, 409);
  const heldAcc = await newAsset('Printers', 'held accessory'); await forceHeld(heldAcc.id, sofia);
  const lap = await newAsset('Laptops', 'bundle primary');
  assert.equal((await assignGeneric({ type: 'GENERAL', employeeId: ayse.id, assetId: lap.id, accessoryAssetIds: [heldAcc.id] })).status, 409);
  assert.equal((await dbAsset(lap.id)).status, 'AVAILABLE', 'the primary stays free when an accessory is refused');

  // F-09: IN_REPAIR / DISPOSED assets are refused with a message that says why.
  const repairPhone = await newPhone('repair');
  assert.equal((await admin.req('PATCH', `/assets/${repairPhone.id}`, { body: { status: 'IN_REPAIR' } })).status, 200);
  const r1 = await assignPhone({ employeeId: ayse.id, phoneAssetId: repairPhone.id });
  assert.equal(r1.status, 409);
  assert.match(err(r1).message, /IN_REPAIR/);
  const disposed = await newAsset('Laptops', 'disposed');
  assert.equal((await admin.req('PATCH', `/assets/${disposed.id}`, { body: { status: 'DISPOSED' } })).status, 200);
  const r2 = await assignGeneric({ employeeId: ayse.id, assetId: disposed.id });
  assert.equal(r2.status, 409);
  assert.match(err(r2).message, /DISPOSED/);
  const repairLap = await newAsset('Laptops', 'repair');
  assert.equal((await admin.req('PATCH', `/assets/${repairLap.id}`, { body: { status: 'IN_REPAIR' } })).status, 200);
  assert.equal((await assignGeneric({ employeeId: ayse.id, assetId: repairLap.id })).status, 409);

  // An asset that is part of an active assignment is still refused, and the message names that assignment.
  const free = await newAsset('Laptops', 'free');
  const first = await assignGeneric({ employeeId: sofia.id, assetId: free.id });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await assignGeneric({ employeeId: ayse.id, assetId: free.id });
  assert.equal(again.status, 409);
  assert.match(err(again).message, new RegExp(first.body.data.assignmentCode));

  // Control: ordinary AVAILABLE, unheld assets are unaffected (full phone handover incl. SIM + chargers).
  const okPhone = await newPhone('ok');
  const okSim = await newSim();
  const okCable = await newAsset('Charger Cables', 'ok cable');
  const ok = await assignPhone({ employeeId: ayse.id, phoneAssetId: okPhone.id, sim1AssetId: okSim.id, chargerCableAssetId: okCable.id });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  for (const a of [okPhone, okSim, okCable]) assert.deepEqual(await dbAsset(a.id), { status: 'ASSIGNED', currentHolderEmployeeId: ayse.id });
});

test('F-02: a WhatsApp / SIM number can belong to only one ACTIVE assignment (409 names it)', async () => {
  const { sofia, ayse } = await seed();
  const admin = await as('admin');

  // 1) number with a WHATSAPP account: the account is bound to the first assignment and stays there.
  const wa = phoneNo();
  const acc = await admin.req('POST', '/accounts', { body: { kind: 'WHATSAPP', identifier: wa, password: 'n/a-whatsapp-uses-sms' } });
  assert.equal(acc.status, 201, JSON.stringify(acc.body));
  made.accounts.push(acc.body.data.id);
  const [p1, p2] = [await newPhone(), await newPhone()];
  const first = await assignPhone({ employeeId: sofia.id, phoneAssetId: p1.id, wa1PhoneNumber: wa });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const code = first.body.data.assignmentCode;
  assert.equal((await prisma.account.findUnique({ where: { id: acc.body.data.id } })).currentAssignmentId, first.body.data.id);

  const second = await assignPhone({ employeeId: ayse.id, phoneAssetId: p2.id, wa1PhoneNumber: wa });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.match(err(second).message, new RegExp(code), 'names the assignment that already uses the number');
  assert.equal(err(second).details.assignmentCode, code);
  const otherSlot = await assignPhone({ employeeId: ayse.id, phoneAssetId: p2.id, wa2PhoneNumber: wa });
  assert.equal(otherSlot.status, 409, 'the other WhatsApp slot is covered too');
  assert.equal((await prisma.account.findUnique({ where: { id: acc.body.data.id } })).currentAssignmentId, first.body.data.id, 'the account was not silently moved');
  assert.equal((await dbAsset(p2.id)).status, 'AVAILABLE', 'refused request leaves its phone free');

  // 2) numbers are compared digits-only ("+90 530 …" is the same number).
  const spaced = `+${wa.slice(0, 2)} ${wa.slice(2, 5)} ${wa.slice(5, 8)} ${wa.slice(8, 10)} ${wa.slice(10)}`;
  assert.equal((await assignPhone({ employeeId: ayse.id, phoneAssetId: p2.id, wa1PhoneNumber: spaced })).status, 409);

  // 3) a number that has no Account row is protected through the phone detail alone; SIM slots share the namespace.
  const bare = phoneNo();
  const [p3, p4] = [await newPhone(), await newPhone()];
  const b1 = await assignPhone({ employeeId: sofia.id, phoneAssetId: p3.id, wa2PhoneNumber: bare });
  assert.equal(b1.status, 201, JSON.stringify(b1.body));
  const b2 = await assignPhone({ employeeId: ayse.id, phoneAssetId: p4.id, sim1Number: bare });
  assert.equal(b2.status, 409);
  assert.match(err(b2).message, new RegExp(b1.body.data.assignmentCode));
  const simNo = phoneNo();
  const s1 = await assignPhone({ employeeId: sofia.id, phoneAssetId: (await newPhone()).id, sim1Number: simNo });
  assert.equal(s1.status, 201);
  const s2 = await assignPhone({ employeeId: ayse.id, phoneAssetId: (await newPhone()).id, sim2Number: simNo });
  assert.equal(s2.status, 409);
  assert.match(err(s2).message, /SIM 1/);

  // 4) one number cannot fill both slots of one request (400, nothing written).
  const dup = phoneNo();
  assert.equal((await assignPhone({ employeeId: ayse.id, phoneAssetId: (await newPhone()).id, sim1Number: dup, wa2PhoneNumber: dup })).status, 400);

  // 5) the number is free again once the assignment is RETURNED.
  const ret = await admin.req('POST', `/assignments/${s1.body.data.id}/return`, { body: { returnCondition: 'GOOD' } });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  const reuse = await assignPhone({ employeeId: ayse.id, phoneAssetId: (await newPhone()).id, sim2Number: simNo });
  assert.equal(reuse.status, 201, JSON.stringify(reuse.body));
});

test('F-02/F-03: concurrent handovers of the same asset or number produce exactly one winner', async () => {
  const { ayse } = await seed();
  const N = 4;
  const outcome = (rs) => rs.map((r) => r.status).sort().join(',');
  const one = `201,${Array(N - 1).fill(409).join(',')}`;

  const lap = await newAsset('Laptops', 'race');
  const byAsset = await Promise.all(Array.from({ length: N }, () => assignGeneric({ employeeId: ayse.id, assetId: lap.id })));
  assert.equal(outcome(byAsset), one);
  assert.equal(await prisma.assignmentItem.count({ where: { assetId: lap.id, isActive: true } }), 1);
  assert.match(err(byAsset.find((r) => r.status === 409)).message, /not available for handover/, 'losers get the readable 409, not a unique-index error');

  const number = phoneNo();
  const phones = await Promise.all(Array.from({ length: N }, () => newPhone('race')));
  const byNumber = await Promise.all(phones.map((p) => assignPhone({ employeeId: ayse.id, phoneAssetId: p.id, sim1Number: number, wa1PhoneNumber: number })));
  assert.equal(outcome(byNumber), one);
  assert.equal(await prisma.phoneAssignmentDetail.count({ where: { sim1Number: number, assignment: { status: 'ACTIVE' } } }), 1);
  assert.equal(await prisma.asset.count({ where: { id: { in: phones.map((p) => p.id) }, status: 'AVAILABLE' } }), N - 1, 'losing phones were not touched');
});

test('F-10/F-08/F-22/F-25: SIM/charger/accessory ids are validated (400), imei must match, accessories keep their own condition, items expose role+isActive', async () => {
  const { ayse } = await seed();
  const ghost = '11111111-1111-4111-8111-111111111111';

  // F-10: wrong category / unknown id → 400 (never a 409 FK), and the phone stays free.
  const phone = await newPhone();
  const laptop = await newAsset('Laptops', 'not a sim');
  const cases = [
    [{ sim1AssetId: laptop.id }, /sim1AssetId must be .*SIM Cards/],
    [{ sim2AssetId: laptop.id }, /sim2AssetId must be .*SIM Cards/],
    [{ sim2AssetId: ghost }, /sim2AssetId does not exist/],
    [{ chargerCableAssetId: ghost }, /chargerCableAssetId does not exist/],
    [{ chargerAdapterAssetId: ghost }, /chargerAdapterAssetId does not exist/],
    [{ chargerCableAssetId: (await newAsset('Charger Adapters', 'adapter as cable')).id }, /chargerCableAssetId must be .*Charger Cables/],
    [{ chargerAdapterAssetId: (await newAsset('Charger Cables', 'cable as adapter')).id }, /chargerAdapterAssetId must be .*Charger Adapters/],
  ];
  for (const [extra, pattern] of cases) {
    const r = await assignPhone({ employeeId: ayse.id, phoneAssetId: phone.id, ...extra });
    assert.equal(r.status, 400, `${JSON.stringify(extra)} → ${JSON.stringify(r.body)}`);
    assert.match(err(r).message, pattern);
  }
  const twice = await newSim();
  assert.equal((await assignPhone({ employeeId: ayse.id, phoneAssetId: phone.id, sim1AssetId: twice.id, sim2AssetId: twice.id })).status, 400, 'one SIM in two slots');
  assert.equal((await dbAsset(phone.id)).status, 'AVAILABLE');

  // F-08: a request IMEI that differs from the phone's is refused; the matching one is accepted.
  const imeiPhone = await newPhone('imei');
  const real = (await prisma.phoneDetail.findUnique({ where: { assetId: imeiPhone.id } })).imei;
  const bad = await assignPhone({ employeeId: ayse.id, phoneAssetId: imeiPhone.id, imei: '111111111111111' });
  assert.equal(bad.status, 400);
  assert.match(err(bad).message, /imei does not match/);
  assert.equal((await dbAsset(imeiPhone.id)).status, 'AVAILABLE');

  // A fully loaded handover with every part in the right category still works; items expose role + isActive (F-25).
  const sim1 = await newSim(); const sim2 = await newSim();
  const cable = await newAsset('Charger Cables', 'cable'); const adapter = await newAsset('Charger Adapters', 'adapter');
  const full = await assignPhone({ employeeId: ayse.id, phoneAssetId: imeiPhone.id, imei: real, sim1AssetId: sim1.id, sim2AssetId: sim2.id, chargerCableAssetId: cable.id, chargerAdapterAssetId: adapter.id });
  assert.equal(full.status, 201, JSON.stringify(full.body));
  const roles = (items) => items.map((i) => i.role).sort();
  const expectedRoles = ['CHARGER_ADAPTER', 'CHARGER_CABLE', 'PRIMARY', 'SIM1', 'SIM2'];
  assert.deepEqual(roles(full.body.data.items), expectedRoles, 'create response');
  const admin = await as('admin');
  const detail = (await admin.req('GET', `/assignments/${full.body.data.id}`)).body.data;
  assert.deepEqual(roles(detail.items), expectedRoles, 'detail');
  assert.ok(detail.items.every((i) => typeof i.role === 'string' && i.isActive === true), 'every item carries role + isActive');
  assert.equal((await admin.req('POST', `/assignments/${full.body.data.id}/return`, { body: { returnCondition: 'GOOD' } })).status, 200);
  const returned = (await admin.req('GET', `/assignments/${full.body.data.id}`)).body.data;
  assert.ok(returned.items.every((i) => i.isActive === false), 'isActive flips to false once returned');

  // F-22: generic accessories carry their own handover condition (default GOOD); unknown ids → 400.
  const primary = await newAsset('Laptops', 'primary');
  const acc1 = await newAsset('Printers', 'acc1'); const acc2 = await newAsset('Printers', 'acc2');
  const g = await assignGeneric({ type: 'GENERAL', employeeId: ayse.id, assetId: primary.id, conditionAtHandover: 'FAIR', accessoryAssetIds: [acc1.id, acc2.id], accessoryConditions: [{ assetId: acc1.id, condition: 'POOR' }] });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const cond = Object.fromEntries(g.body.data.items.map((i) => [i.assetId, i.conditionAtHandover]));
  assert.deepEqual(cond, { [primary.id]: 'FAIR', [acc1.id]: 'POOR', [acc2.id]: 'GOOD' });
  const free = await newAsset('Laptops', 'free primary');
  const unknown = await assignGeneric({ type: 'GENERAL', employeeId: ayse.id, assetId: free.id, accessoryAssetIds: [ghost] });
  assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  assert.match(err(unknown).message, new RegExp(ghost));
  const stray = await assignGeneric({ type: 'GENERAL', employeeId: ayse.id, assetId: free.id, accessoryAssetIds: [acc1.id], accessoryConditions: [{ assetId: ghost, condition: 'POOR' }] });
  assert.equal(stray.status, 400, 'a condition for an asset that is not an accessory');
  assert.equal((await assignGeneric({ type: 'GENERAL', employeeId: ayse.id, assetId: free.id, accessoryAssetIds: [free.id] })).status, 400, 'primary listed as its own accessory');
  const nullAcc = await assignGeneric({ employeeId: ayse.id, assetId: free.id, accessoryAssetIds: null, accessoryConditions: null });
  assert.equal(nullAcc.status, 201, `null accessory lists behave like "not provided": ${JSON.stringify(nullAcc.body)}`);
});

/* ───────────────────────────── RBAC / SCOPE ───────────────────────────── */

test('F-04/F-29: GET /employees/:id and the roomId filter obey the same room scope as the list', async () => {
  const { ahmet, elif, mehmet, ayse, can, room } = await seed();
  const [admin, manager, tl1, ccm] = await Promise.all(['admin', 'manager', 'tl.tr1', 'mr.mahmoud'].map(as));
  const detail = (c, e) => c.req('GET', `/employees/${e.id}`);

  // TEAM_LEADER of TR1: own room only; other rooms look like "not found".
  assert.equal((await detail(tl1, ahmet)).status, 200);
  for (const other of [elif, mehmet]) {
    const r = await detail(tl1, other);
    assert.equal(r.status, 404, `${other.fullName} (another room)`);
    assert.equal(err(r).code, 'NOT_FOUND');
    assert.ok(!JSON.stringify(r.body).includes('internalEmail'), 'nothing of the record leaks in the 404');
  }
  assert.equal((await detail(tl1, ayse)).status, 404, 'no room at all is out of scope for a team leader');

  // CALL_CENTER_MANAGER: only employees of call-centre rooms.
  for (const e of [ahmet, elif, mehmet]) assert.equal((await detail(ccm, e)).status, 200, e.fullName);
  for (const e of [ayse, can]) assert.equal((await detail(ccm, e)).status, 404, `${e.fullName} sits in no call-centre room`);

  // ADMIN / MANAGER are unrestricted.
  for (const c of [admin, manager]) for (const e of [ahmet, elif, ayse, can]) assert.equal((await detail(c, e)).status, 200);

  // F-29: roomId narrows within the scope — a team leader asking for another room gets nothing.
  const other = await tl1.req('GET', `/employees?roomId=${room('TR2').id}&pageSize=100`);
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.data, [], 'TR1 team leader + roomId=TR2 → no rows (never TR1 rows)');
  assert.equal(other.body.meta.total, 0);
  const own = await tl1.req('GET', `/employees?roomId=${room('TR1').id}&pageSize=100`);
  assert.ok(own.body.data.length >= 2 && own.body.data.every((e) => e.room?.code === 'TR1'));
  const ccmList = (await ccm.req('GET', '/employees?pageSize=100')).body.data;
  assert.ok(ccmList.length > 0 && ccmList.every((e) => e.room), 'CCM list: call-centre rooms only');
  const ccmTr2 = (await ccm.req('GET', `/employees?roomId=${room('TR2').id}&pageSize=100`)).body.data;
  assert.ok(ccmTr2.length >= 1 && ccmTr2.every((e) => e.room?.code === 'TR2'));
  const adminTr2 = (await admin.req('GET', `/employees?roomId=${room('TR2').id}&pageSize=100`)).body.data;
  assert.ok(adminTr2.length >= 1 && adminTr2.every((e) => e.room?.code === 'TR2'), 'admin filter unchanged');
});

test('F-12: assignment list, roomId filter and detail share one room rule (seat room, else employee room)', async () => {
  const { ahmet, elif, room, seat } = await seed();
  const [admin, tl1, tl2, ccm] = await Promise.all(['admin', 'tl.tr1', 'tl.tr2', 'mr.mahmoud'].map(as));
  const ids = (r) => r.body.data.map((a) => a.id);

  // Ahmet sits in TR1 but has no work seat → his assignment belongs to TR1 through the employee.
  const noSeat = await assignGeneric({ employeeId: ahmet.id, assetId: (await newAsset('Laptops', 'no seat')).id });
  assert.equal(noSeat.status, 201, JSON.stringify(noSeat.body));
  const noSeatId = noSeat.body.data.id;
  // Elif (employee room TR2) works at a TR1 seat → the seat wins: the assignment belongs to TR1.
  const seatTr1 = await assignGeneric({ employeeId: elif.id, workIdentityId: seat('sofia', 'TR1').id, assetId: (await newAsset('Laptops', 'seat TR1')).id });
  assert.equal(seatTr1.status, 201, JSON.stringify(seatTr1.body));
  const seatId = seatTr1.body.data.id;

  assert.ok(ids(await tl1.req('GET', '/assignments?pageSize=100')).includes(noSeatId), 'TR1 team leader lists the no-seat TR1 assignment');
  assert.ok(ids(await tl1.req('GET', '/assignments?pageSize=100')).includes(seatId), 'and the TR1-seat one');
  for (const id of [noSeatId, seatId]) {
    assert.ok(!ids(await tl2.req('GET', '/assignments?pageSize=100')).includes(id), 'TR2 team leader never lists them (Elif is in TR2, but the seat is in TR1)');
    assert.equal((await tl1.req('GET', `/assignments/${id}`)).status, 200, 'every listed row opens');
    assert.equal((await tl2.req('GET', `/assignments/${id}`)).status, 404);
    assert.equal((await ccm.req('GET', `/assignments/${id}`)).status, 200, 'call-centre manager opens it too');
    assert.ok(ids(await ccm.req('GET', '/assignments?pageSize=100')).includes(id));
  }

  // Admin's roomId filter uses the same rule; a scoped user asking for another room gets nothing.
  assert.ok(ids(await admin.req('GET', `/assignments?roomId=${room('TR1').id}&pageSize=100`)).includes(noSeatId));
  assert.ok(ids(await admin.req('GET', `/assignments?roomId=${room('TR1').id}&pageSize=100`)).includes(seatId));
  assert.ok(!ids(await admin.req('GET', `/assignments?roomId=${room('TR2').id}&pageSize=100`)).some((id) => [noSeatId, seatId].includes(id)));
  const crossed = await tl1.req('GET', `/assignments?roomId=${room('TR2').id}&pageSize=100`);
  assert.equal(crossed.status, 200);
  assert.deepEqual(ids(crossed), [], 'TR1 team leader + roomId=TR2 → nothing');
  // list filters still compose with the scope
  const q = await tl1.req('GET', `/assignments?q=${noSeat.body.data.assignmentCode}&pageSize=100`);
  assert.deepEqual(ids(q), [noSeatId]);
});

test('F-13/F-14: GET /photos/:id/file follows the parent asset / assignment visibility (TL room, CCM call-centre rooms)', async () => {
  const { ahmet, elif, sofia, room, seat } = await seed();
  const [admin, manager, tl1, tl2, ccm] = await Promise.all(['admin', 'manager', 'tl.tr1', 'tl.tr2', 'mr.mahmoud'].map(as));
  const who = { admin, manager, tl1, tl2, ccm };
  const matrix = async (photo) => Object.fromEntries(await Promise.all(Object.entries(who).map(async ([k, c]) => [k, await c.status(photo.url)])));

  // Asset in TR1 (room set): TR1 TL + any call-centre manager + admin/manager see it, TR2 TL does not.
  const printer = await newAsset('Printers', 'TR1 printer', { roomId: room('TR1').id });
  assert.deepEqual(await matrix(await uploadPhoto(`/assets/${printer.id}/photos`)), { admin: 200, manager: 200, tl1: 200, tl2: 404, ccm: 200 });
  assert.equal((await ccm.req('GET', `/assets/${printer.id}`)).status, 200, 'same visibility as the asset detail');

  // Asset with no room, held by a TR1 employee → visible through the holder.
  const held = await newAsset('Laptops', 'held by TR1');
  assert.equal((await assignGeneric({ employeeId: sofia.id, assetId: held.id })).status, 201);
  assert.deepEqual(await matrix(await uploadPhoto(`/assets/${held.id}/photos`)), { admin: 200, manager: 200, tl1: 200, tl2: 404, ccm: 200 });

  // Asset nobody holds and no room: out of every scoped user's reach (before the fix a CCM saw any unheld asset's photos).
  const loose = await newAsset('Laptops', 'no room no holder');
  assert.deepEqual(await matrix(await uploadPhoto(`/assets/${loose.id}/photos`)), { admin: 200, manager: 200, tl1: 404, tl2: 404, ccm: 404 });
  assert.equal((await ccm.req('GET', `/assets/${loose.id}`)).status, 404, 'the asset detail is hidden too');

  // Asset in a room that is NOT a call-centre room: CCM must not see its photos.
  const hospital = await admin.req('POST', '/rooms', { body: { code: `FIXH-${tag()}`, teamType: 'HOSPITAL' } });
  assert.equal(hospital.status, 201, JSON.stringify(hospital.body));
  made.rooms.push(hospital.body.data.id);
  const hospitalAsset = await newAsset('Printers', 'hospital printer', { roomId: hospital.body.data.id });
  assert.deepEqual(await matrix(await uploadPhoto(`/assets/${hospitalAsset.id}/photos`)), { admin: 200, manager: 200, tl1: 404, tl2: 404, ccm: 404 });

  // F-14: assignment photos. No seat → the employee's room decides (Ahmet: TR1).
  const noSeat = await assignGeneric({ employeeId: ahmet.id, assetId: (await newAsset('Laptops', 'photo no seat')).id });
  assert.equal(noSeat.status, 201, JSON.stringify(noSeat.body));
  const noSeatPhoto = await uploadPhoto(`/assignments/${noSeat.body.data.id}/photos`);
  assert.deepEqual(await matrix(noSeatPhoto), { admin: 200, manager: 200, tl1: 200, tl2: 404, ccm: 200 });
  const listed = (await tl1.req('GET', `/assignments/${noSeat.body.data.id}`)).body.data.photos;
  assert.deepEqual(listed.map((p) => p.url), [noSeatPhoto.url], 'the TL detail lists the photo…');
  assert.equal(await tl1.status(listed[0].url), 200, '…and its URL really opens for the TL');

  // With a seat → the seat's room decides (Elif's employee room is TR2, the seat is in TR1).
  const atSeat = await assignGeneric({ employeeId: elif.id, workIdentityId: seat('sofia', 'TR1').id, assetId: (await newAsset('Laptops', 'photo seat')).id });
  assert.equal(atSeat.status, 201, JSON.stringify(atSeat.body));
  assert.deepEqual(await matrix(await uploadPhoto(`/assignments/${atSeat.body.data.id}/photos`)), { admin: 200, manager: 200, tl1: 200, tl2: 404, ccm: 200 });
  const atTr2 = await assignGeneric({ employeeId: elif.id, workIdentityId: seat('coordinator', 'TR2').id, assetId: (await newAsset('Laptops', 'photo seat TR2')).id });
  assert.equal(atTr2.status, 201, JSON.stringify(atTr2.body));
  assert.deepEqual(await matrix(await uploadPhoto(`/assignments/${atTr2.body.data.id}/photos`)), { admin: 200, manager: 200, tl1: 404, tl2: 200, ccm: 200 });

  // Unknown photo → 404 for everyone.
  assert.equal(await admin.status('/api/v1/photos/00000000-0000-4000-8000-000000000000/file'), 404);
});

/* ───────────────────────────── REPORTS / AUDIT / CATEGORIES ───────────────────────────── */

test('F-15/F-16: CSV dates are ISO and formula cells are neutralised (serializer)', () => {
  const columns = [{ key: 'a', header: 'A' }, { key: 'b', header: 'B' }];
  const rows = [
    { a: new Date('2026-11-21T07:51:30.123Z'), b: '=1+1*2' },
    { a: new Date('2027-01-05T00:00:00.000Z'), b: '+SUM(1,2)' },
    { a: '-2+3', b: '@cmd' },
    { a: '\tTAB', b: '\rCR' },
    { a: -3, b: 'plain' }, // a real number keeps its minus sign
    { a: 'say "hi", ok', b: null },
    { a: 'ordinary - text', b: undefined },
    { a: ['LAP-000001', 'PHN-000002'], b: new Date('not a date') },
  ];
  const csv = toCsv(rows, columns);
  assert.ok(csv.startsWith('\uFEFFA,B\r\n'), 'BOM + CRLF are kept');
  assert.deepEqual(csv.slice(1).split('\r\n'), [
    'A,B',
    "2026-11-21T07:51:30Z,'=1+1*2",
    '2027-01-05T00:00:00Z,"\'+SUM(1,2)"',
    "'-2+3,'@cmd",
    "'\tTAB,\"'\rCR\"",
    '-3,plain',
    '"say ""hi"", ok",',
    'ordinary - text,',
    '"LAP-000001,PHN-000002",',
    '',
  ]);
  assert.ok(!/GMT|Coordinated/.test(csv));
});

/** The who-has-what export, fetched page by page until every wanted assignment code is in it. The export
 *  honours page / pageSize (25 rows by default), so on a database with many active assignments the rows
 *  just created are not on the first page. */
async function exportLinesWith(codes) {
  const admin = await as('admin');
  const seen = new Set();
  for (let page = 1; page <= 200; page += 1) {
    const r = await admin.req('GET', `/reports/who-has-what/export?page=${page}&pageSize=100`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    const fresh = r.text.split('\r\n').filter((l) => l && !seen.has(l));
    fresh.forEach((l) => seen.add(l));
    if (!fresh.length || codes.every((c) => [...seen].some((l) => l.includes(c)))) break;
  }
  return [...seen];
}

test('F-15/F-16: GET /reports/who-has-what/export — ISO dates, user text cannot become a formula', async () => {
  const { ayse } = await seed();
  const names = ['=1+1*2', '+1+1', '-1-1', '@SUM(1)'];
  const codes = {};
  for (const name of names) {
    const asset = await newAsset('Laptops', 'csv', { name });
    const r = await assignGeneric({ employeeId: ayse.id, assetId: asset.id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    codes[name] = r.body.data.assignmentCode;
  }
  const lines = await exportLinesWith(Object.values(codes));
  for (const name of names) {
    const line = lines.find((l) => l.includes(codes[name]));
    assert.ok(line, `row of ${codes[name]}`);
    const cells = line.split(',');
    assert.equal(cells[4], `'${name}`, `"${name}" is exported as text, not as a formula`);
    assert.match(cells[7], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'Assigned at is ISO-8601 UTC');
    assert.match(cells[8], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'Expected return at is ISO-8601 UTC');
  }
  assert.ok(!lines.some((l) => /GMT|Coordinated Universal Time/.test(l)), 'no JS Date.toString() left');
  // other roles keep their access rules
  assert.equal((await (await as('tl.tr1')).req('GET', '/reports/who-has-what/export')).status, 403);
});

test('F-17: audit-logs `to` given as a date-only value includes the whole day (UTC)', async () => {
  const admin = await as('admin');
  const asset = await newAsset('Laptops', 'audit day'); // writes an asset.create audit row right now
  const own = (qs) => admin.req('GET', `/audit-logs?targetId=${asset.id}&pageSize=5${qs}`);
  const row = (await own('')).body.data[0];
  assert.equal(row?.action, 'asset.create');
  const day = row.createdAt.slice(0, 10);
  const shift = (d, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

  assert.equal((await own(`&from=${day}&to=${day}`)).body.meta.total, 1, 'from = to = that day (date only) finds the row');
  assert.equal((await own(`&to=${day}`)).body.meta.total, 1, 'to alone, date only');
  assert.equal((await own(`&from=${day}T00:00:00Z&to=${day}T23:59:59Z`)).body.meta.total, 1, 'explicit full-day range is unchanged');
  assert.equal((await own(`&to=${shift(day, -1)}`)).body.meta.total, 0, 'the day before does not reach it');
  assert.equal((await own(`&from=${shift(day, 1)}&to=${shift(day, 1)}`)).body.meta.total, 0, 'the day after does not include it');
  const before = new Date(Date.parse(row.createdAt) - 1000).toISOString();
  assert.equal((await own(`&to=${encodeURIComponent(before)}`)).body.meta.total, 0, 'a timestamp `to` is still an exact inclusive bound');
  assert.equal((await own(`&to=${encodeURIComponent(row.createdAt)}`)).body.meta.total, 1, '…inclusive of the instant itself');
  assert.equal((await admin.req('GET', '/audit-logs?to=not-a-date')).status, 400);
});

test('F-20: category names are unique case-insensitively per level, code prefixes are unique (409)', async () => {
  const admin = await as('admin');
  const flat = (await admin.req('GET', '/asset-categories?includeInactive=true')).body.flat;
  const free = freePrefixes(new Set(flat.map((c) => c.codePrefix)), 4);
  const name = `FIX Cat ${tag()}`;
  const create = async (body) => {
    const r = await admin.req('POST', '/asset-categories', { body });
    if (r.status === 201) made.categories.push(r.body.data.id);
    return r;
  };

  const base = await create({ name, codePrefix: free[0] });
  assert.equal(base.status, 201, JSON.stringify(base.body));
  const dupName = await create({ name: name.toUpperCase(), codePrefix: free[1] });
  assert.equal(dupName.status, 409);
  assert.match(err(dupName).message, /already exists/);
  assert.equal((await create({ name: `  ${name.toLowerCase()}  `, codePrefix: free[1] })).status, 409, 'trimmed + case-insensitive');
  const dupPrefix = await create({ name: `${name} other`, codePrefix: free[0].toLowerCase() });
  assert.equal(dupPrefix.status, 409);
  assert.match(err(dupPrefix).message, new RegExp(`${free[0]}.*${name}`));
  assert.equal((await admin.req('GET', '/asset-categories')).body.flat.filter((c) => c.codePrefix === free[0]).length, 1, 'nothing was created by the rejected requests');

  // The same name one level down is a different sibling set → allowed (its prefix must still be unique).
  const child = await create({ name, parentId: base.body.data.id, codePrefix: free[1] });
  assert.equal(child.status, 201, JSON.stringify(child.body));
  assert.equal((await create({ name: name.toUpperCase(), parentId: base.body.data.id, codePrefix: free[2] })).status, 409, 'siblings under one parent');

  // PATCH: renaming / re-prefixing onto an existing one is refused; unchanged values never conflict.
  const other = await create({ name: `${name} two`, codePrefix: free[2] });
  assert.equal(other.status, 201);
  const patch = (id, body) => admin.req('PATCH', `/asset-categories/${id}`, { body });
  assert.equal((await patch(other.body.data.id, { name: name.toLowerCase() })).status, 409);
  assert.equal((await patch(other.body.data.id, { codePrefix: free[0] })).status, 409);
  assert.equal((await patch(other.body.data.id, { name: `${name} two`, codePrefix: free[2], isActive: false })).status, 200, 'same values → fine');
  assert.equal((await patch(other.body.data.id, { name: `${name} TWO` })).status, 200, 'a case-only rename of itself is allowed');
  assert.equal((await patch(child.body.data.id, { parentId: null })).status, 409, 'moving a category to a level that already has its name');
  assert.equal((await patch(other.body.data.id, { codePrefix: free[3] })).status, 200);
});
