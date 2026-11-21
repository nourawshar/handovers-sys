'use strict';
/**
 * Phase 8 BE-1 (card t_ee4299d6): handover condition write-back (R4), richer assignment detail (R3) and photo
 * tagging (R5) — assignment.service.js + assignments.routes.js.
 *
 *   R4  a handover stores its condition on AssignmentItem.conditionAtHandover — the submitted value, else the
 *       asset's CURRENT condition (never a hard-coded GOOD) — for the primary asset and every SIM / charger /
 *       accessory item; when that differs from asset.condition the asset is updated in the same transaction and
 *       gets an UPDATED timeline entry { field:'condition', from, to, assignmentCode, reason:'handover' }
 *   R3  GET /assignments/:id → employee.department / room, items[].asset { serialNumber, qty, notes, category, room,
 *       phone, customFields[{key,label,type,value}] } (+ photos = the asset gallery only)
 *   R5  photos[] = THIS assignment's photos { id, type, context, assetId, url, createdAt };
 *       POST /assignments/:id/photos takes `assetId` (must be an item, else 400) and `context` (HANDOVER | RETURN)
 *
 * Same pattern as tests/assign.fixes.test.js: it talks to a RUNNING server (BASE_URL) and also uses Prisma directly
 * (DATABASE_URL), so BOTH must point at the same, throw-away, freshly seeded database — never the shared dev DB
 * behind :4000. Both variables are mandatory (no defaults) and :4000 is refused:
 *
 *   createdb scratch_db
 *   DATABASE_URL='postgresql://postgres@localhost:5432/scratch_db?schema=public' npx prisma migrate deploy
 *   DATABASE_URL='…same…' npm run seed
 *   DATABASE_URL='…same…' LOGIN_RATE_LIMIT=1000 PORT=3001 node src/server.js &
 *   DATABASE_URL='…same…' BASE_URL=http://localhost:3001 node --test tests/phase8.assign.test.js
 *
 * Needs the standard seed (logins, rooms TR1–TR4, the call-centre people) but nothing else: every category and
 * asset the tests use is found by name or created here (the "P8 …" categories carry the custom columns the detail
 * test asserts on, so it does not depend on the seed's Laptops / Computers columns). Everything the tests create
 * (assets, assignments, photos) is returned / removed in the final hook; assets that gained history end DISPOSED,
 * and a category stays while such assets reference it (the next run finds it again by name).
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// Fail fast, before anything can load .env and quietly aim Prisma at the dev database.
const BASE = process.env.BASE_URL || '';
if (!BASE || !process.env.DATABASE_URL) {
  throw new Error('phase8.assign.test.js needs BOTH BASE_URL (your own server, e.g. http://localhost:3001) and DATABASE_URL (the same scratch DB that server uses)');
}
if (new URL(BASE).port === '4000') throw new Error('refusing to run against :4000 (the shared dev server) — start your own server on another port');

const prisma = require('../src/db');

/* ───────────────────────────── tiny API client ───────────────────────────── */

const PW = { admin: 'Admin#12345', 'tl.tr1': 'Leader#12345' };
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

const made = { assignments: [], assets: [], categories: [], photos: [] };
let counter = 0;
const digits = (n) => String(Date.now() * 1000 + (counter += 1)).slice(-n);
const phoneNo = () => `9053${digits(8)}`; // 12 digits, unique per call
const imei = () => `35${digits(13)}`; // 15 digits, unique per call
const tag = () => `${Date.now().toString(36)}${(counter += 1)}`;

const letter = (i) => String.fromCharCode(65 + (i % 26));
/** `count` unused 2–5 letter code prefixes (the "preferred" ones first), picked from a random start. */
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

/** Custom columns of the "P8 …" categories. Two columns share sortOrder 30 on purpose (label breaks the tie). */
const KIT_FIELDS = [
  { key: 'p8_empty', label: 'Not filled in', type: 'string', sortOrder: 5 },
  { key: 'p8_cpu', label: 'Processor', type: 'string', sortOrder: 10 },
  { key: 'p8_ram', label: 'RAM (GB)', type: 'number', sortOrder: 15 },
  { key: 'p8_touch', label: 'Touch screen', type: 'boolean', sortOrder: 20 },
  { key: 'p8_zeta', label: 'Zeta', type: 'string', sortOrder: 30 },
  { key: 'p8_alpha', label: 'Alpha', type: 'string', sortOrder: 30 },
];

/** The categories the tests need. Production rules look some of them up BY NAME (Phones, SIM Cards, Charger Cables,
 *  Charger Adapters), so those are found by name and created — with what a SIM asset requires — only when the
 *  database lacks them. The "P8 …" ones belong to this file: their columns are (re)created whenever missing. */
const CATEGORIES = {
  Phones: { prefix: 'PHN' },
  'SIM Cards': { prefix: 'SIM', fields: [{ key: 'phone_number', label: 'Phone number', type: 'string', required: true, isSearchable: true, isIdentifier: true }] },
  Chargers: { prefix: 'CHG' },
  'Charger Cables': { prefix: 'CBL', parent: 'Chargers' },
  'Charger Adapters': { prefix: 'ADP', parent: 'Chargers' },
  Laptops: { prefix: 'LAP' },
  Printers: { prefix: 'PRN' },
  'P8 Kit': { prefix: 'PKT', owned: true, fields: KIT_FIELDS },
  'P8 Kit Mini': { prefix: 'PKM', parent: 'P8 Kit', owned: true, fields: [{ key: 'p8_child', label: 'Child column', type: 'string', sortOrder: 12 }] },
  'P8 Other': { prefix: 'PKO', owned: true, fields: [{ key: 'p8_other', label: 'Foreign column', type: 'string', sortOrder: 1 }] },
};
const categories = new Map();
function ensureCategory(name) {
  if (!categories.has(name)) {
    categories.set(name, (async () => {
      const def = CATEGORIES[name];
      assert.ok(def, `unknown test category ${name}`);
      const admin = await as('admin');
      const flat = (await admin.req('GET', '/asset-categories?includeInactive=true&includeFields=true')).body.flat;
      let category = flat.find((c) => c.name === name && c.isActive);
      let have = new Set((category?.fields ?? []).map((f) => f.key));
      if (!category) {
        const parentId = def.parent ? (await ensureCategory(def.parent)).id : null;
        const [codePrefix] = freePrefixes(new Set(flat.map((c) => c.codePrefix)), 1, [def.prefix]);
        const r = await admin.req('POST', '/asset-categories', { body: { name, parentId, kind: 'physical', codePrefix } });
        assert.equal(r.status, 201, `create category ${name}: ${JSON.stringify(r.body)}`);
        made.categories.push(r.body.data.id);
        category = r.body.data;
        have = new Set();
      } else if (!def.owned) {
        return category; // a seeded category is used as it is
      }
      for (const f of def.fields ?? []) {
        if (have.has(f.key)) continue;
        const rf = await admin.req('POST', `/asset-categories/${category.id}/fields`, { body: f });
        assert.equal(rf.status, 201, `create field ${f.key}: ${JSON.stringify(rf.body)}`);
      }
      return category;
    })());
  }
  return categories.get(name);
}

let seeded;
/** Seeded reference data the logins depend on anyway: rooms TR1–TR4 and the call-centre people. */
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
    return {
      room,
      me: (await admin.req('GET', '/auth/me')).body.user,
      sofia: await employee('Sofia Petrova'), // Call Center, room TR1
      ayse: await employee('Ayse Celik'), // Banko, NO room (assets held by her stay invisible to room-scoped users)
      can: await employee('Can Ozturk'), // Muhasebe, NO room — the "someone else holds it" employee of the 409 scenarios
    };
  })();
  return seeded;
}

async function newAsset(categoryName, label, extra = {}) {
  const category = await ensureCategory(categoryName);
  const admin = await as('admin');
  const r = await admin.req('POST', '/assets', { body: { categoryId: category.id, name: `P8 ${label} ${tag()}`, condition: 'GOOD', ...extra } });
  assert.equal(r.status, 201, `create ${categoryName} asset: ${JSON.stringify(r.body)}`);
  made.assets.push(r.body.data.id);
  return r.body.data;
}
const newPhone = (label = 'phone', extra = {}) => newAsset('Phones', label, { ...extra, phone: { imei: imei(), ...(extra.phone ?? {}) } });
const newSim = (label = 'sim', extra = {}) => newAsset('SIM Cards', label, { ...extra, customFields: { phone_number: phoneNo(), ...(extra.customFields ?? {}) } });

async function post(path, body) {
  const admin = await as('admin');
  const r = await admin.req('POST', path, { body });
  if (r.status === 201 && r.body?.data?.id) made.assignments.push(r.body.data.id);
  return r;
}
const assignPhone = (body) => post('/assignments/phone', body);
/** NB: no default condition — leaving `conditionAtHandover` out is exactly what several tests exercise. */
const assignGeneric = (body) => post('/assignments/generic', { type: 'LAPTOP', ...body });

const dbAsset = (id) => prisma.asset.findUnique({ where: { id }, select: { condition: true, status: true, currentHolderEmployeeId: true } });
/** The asset's UPDATED-condition timeline entries, oldest first. */
const conditionEntries = async (assetId) => (await prisma.assignmentTimelineEntry.findMany({ where: { assetId, eventType: 'UPDATED' }, orderBy: { createdAt: 'asc' } }))
  .filter((e) => e.snapshot?.field === 'condition');
const handoverSnapshot = (assignmentCode, from, to) => ({ field: 'condition', from, to, assignmentCode, reason: 'handover' });
const itemOf = (assignment, assetId) => assignment.items.find((i) => i.assetId === assetId);
const err = (r) => r.body?.error ?? {};
const getDetail = async (client, id) => { const r = await client.req('GET', `/assignments/${id}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data; };
/** conditionAtHandover of one asset's item, read through GET /assignments/:id. */
const detailItemCondition = async (assignmentId, assetId) => itemOf(await getDetail(await as('admin'), assignmentId), assetId).conditionAtHandover;
/** items[].asset keyed by asset id — the create response and the detail list their items in no guaranteed order. */
const assetsById = (assignment) => Object.fromEntries(assignment.items.map((i) => [i.asset.id, i.asset]));

/** A phone handover kit: a phone, its SIM(s) and chargers, each created in the given condition. */
async function phoneKit({ phone = 'GOOD', sim1 = 'GOOD', sim2 = null, cable = 'GOOD', adapter = 'GOOD' } = {}) {
  return {
    phone: await newPhone('kit phone', { condition: phone }),
    sim1: sim1 && await newSim('kit sim1', { condition: sim1 }),
    sim2: sim2 && await newSim('kit sim2', { condition: sim2 }),
    cable: cable && await newAsset('Charger Cables', 'kit cable', { condition: cable }),
    adapter: adapter && await newAsset('Charger Adapters', 'kit adapter', { condition: adapter }),
  };
}
const kitBody = (employeeId, kit) => ({
  employeeId,
  phoneAssetId: kit.phone.id,
  ...(kit.sim1 && { sim1AssetId: kit.sim1.id }),
  ...(kit.sim2 && { sim2AssetId: kit.sim2.id }),
  ...(kit.cable && { chargerCableAssetId: kit.cable.id }),
  ...(kit.adapter && { chargerAdapterAssetId: kit.adapter.id }),
});

async function uploadAssignmentPhoto(assignmentId, fields = {}) {
  const admin = await as('admin');
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('photos', new Blob([PNG], { type: 'image/png' }), 'p8.png');
  const r = await admin.req('POST', `/assignments/${assignmentId}/photos`, { form: fd });
  if (r.status === 201) made.photos.push(...r.body.data.map((p) => p.id));
  return r;
}

after(async () => {
  try {
    const admin = await as('admin');
    for (const id of made.photos) await admin.req('DELETE', `/photos/${id}`); // row + file on disk
    for (const id of made.assignments) await admin.req('POST', `/assignments/${id}/return`, { body: { returnCondition: 'GOOD' } }); // 409 when already returned
    for (const id of made.assets) await admin.req('DELETE', `/assets/${id}`); // hard delete, or soft-dispose when it has history
    for (const id of made.categories.reverse()) await admin.req('DELETE', `/asset-categories/${id}`); // refused while assets reference it
  } finally {
    await prisma.$disconnect();
  }
});

/* ───────────────────────────── R4 — handover condition ───────────────────────────── */

test('R4 generic: a different handover condition is written back to the asset (+ UPDATED entry); the same one writes nothing; omitted = the asset\'s current condition, never GOOD', async () => {
  const { ayse, me } = await seed();
  const admin = await as('admin');

  // 1) FAIR laptop handed over as GOOD → item says GOOD, the asset itself becomes GOOD, one UPDATED entry on it.
  const fair = await newAsset('Laptops', 'fair to good', { condition: 'FAIR' });
  const a = await assignGeneric({ employeeId: ayse.id, assetId: fair.id, conditionAtHandover: 'GOOD' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const code = a.body.data.assignmentCode;
  assert.equal(itemOf(a.body.data, fair.id).conditionAtHandover, 'GOOD', 'create response');
  assert.equal(itemOf(await getDetail(admin, a.body.data.id), fair.id).conditionAtHandover, 'GOOD', 'detail');
  assert.deepEqual(await dbAsset(fair.id), { condition: 'GOOD', status: 'ASSIGNED', currentHolderEmployeeId: ayse.id }, 'asset.condition was written back in the same transaction as the handover');
  const entries = await conditionEntries(fair.id);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].snapshot, handoverSnapshot(code, 'FAIR', 'GOOD'));
  assert.deepEqual([entries[0].assignmentId, entries[0].employeeId, entries[0].createdById], [a.body.data.id, ayse.id, me.id]);
  // …and clients see it where they look: the asset detail and the assignment timeline.
  const viaAsset = (await admin.req('GET', `/assets/${fair.id}`)).body.data;
  assert.equal(viaAsset.condition, 'GOOD');
  assert.deepEqual(viaAsset.timelineEntries.filter((e) => e.eventType === 'UPDATED').map((e) => e.snapshot), [handoverSnapshot(code, 'FAIR', 'GOOD')]);
  const viaTimeline = (await admin.req('GET', `/assignments/${a.body.data.id}/timeline?eventType=UPDATED`)).body.data;
  assert.deepEqual(viaTimeline.map((e) => [e.assetId, e.snapshot.reason]), [[fair.id, 'handover']]);
  assert.ok(viaAsset.timelineEntries.some((e) => e.eventType === 'ASSIGNED'), 'the ASSIGNED entry is still written');

  // 2) the same condition → no write, no entry.
  const same = await newAsset('Laptops', 'same condition', { condition: 'GOOD' });
  const s = await assignGeneric({ employeeId: ayse.id, assetId: same.id, conditionAtHandover: 'GOOD' });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal((await dbAsset(same.id)).condition, 'GOOD');
  assert.equal((await conditionEntries(same.id)).length, 0, 'nothing changed → no UPDATED entry');

  // 3) omitted conditionAtHandover (or null) → the asset's CURRENT condition, not GOOD; nothing is written.
  for (const [label, extra] of [['omitted', {}], ['null', { conditionAtHandover: null }]]) {
    const poor = await newAsset('Laptops', `poor ${label}`, { condition: 'POOR' });
    const r = await assignGeneric({ employeeId: ayse.id, assetId: poor.id, ...extra });
    assert.equal(r.status, 201, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(itemOf(r.body.data, poor.id).conditionAtHandover, 'POOR', `${label} → current condition`);
    assert.equal((await dbAsset(poor.id)).condition, 'POOR');
    assert.equal((await conditionEntries(poor.id)).length, 0);
  }

  // 4) the stored handover condition is what the return flow compares against.
  const nw = await newAsset('Laptops', 'new to damaged', { condition: 'NEW' });
  const n = await assignGeneric({ employeeId: ayse.id, assetId: nw.id, conditionAtHandover: 'DAMAGED' });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  assert.equal((await dbAsset(nw.id)).condition, 'DAMAGED');
  assert.deepEqual((await conditionEntries(nw.id)).map((e) => e.snapshot), [handoverSnapshot(n.body.data.assignmentCode, 'NEW', 'DAMAGED')]);
  assert.equal((await admin.req('GET', `/assignments/${n.body.data.id}/return-form`)).body.data.out.condition, 'DAMAGED');
});

test('R4 generic accessories: each accessory defaults to its own condition; accessoryConditions are written back; the primary follows conditionAtHandover', async () => {
  const { ayse } = await seed();
  const primary = await newAsset('Laptops', 'bundle primary', { condition: 'POOR' });
  const worn = await newAsset('Printers', 'worn accessory', { condition: 'FAIR' }); // no entry → stays FAIR (not GOOD)
  const upgrade = await newAsset('Printers', 'upgraded accessory', { condition: 'GOOD' }); // entry NEW → written back
  const steady = await newAsset('Printers', 'steady accessory', { condition: 'GOOD' }); // entry GOOD = current → nothing
  const r = await assignGeneric({
    type: 'GENERAL', employeeId: ayse.id, assetId: primary.id, // no conditionAtHandover: the primary keeps POOR
    accessoryAssetIds: [worn.id, upgrade.id, steady.id],
    accessoryConditions: [{ assetId: upgrade.id, condition: 'NEW' }, { assetId: steady.id, condition: 'GOOD' }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const code = r.body.data.assignmentCode;
  const stored = Object.fromEntries(r.body.data.items.map((i) => [i.assetId, i.conditionAtHandover]));
  assert.deepEqual(stored, { [primary.id]: 'POOR', [worn.id]: 'FAIR', [upgrade.id]: 'NEW', [steady.id]: 'GOOD' });
  assert.deepEqual(r.body.data.items.map((i) => i.role).sort(), ['BUNDLED', 'BUNDLED', 'BUNDLED', 'PRIMARY']);
  // items come in print order: the main asset first, then the accessories by code (create response and detail alike)
  for (const items of [r.body.data.items, (await getDetail(await as('admin'), r.body.data.id)).items]) {
    assert.deepEqual(items.map((i) => i.role), ['PRIMARY', 'BUNDLED', 'BUNDLED', 'BUNDLED']);
    const codes = items.slice(1).map((i) => i.asset.code);
    assert.deepEqual(codes, [...codes].sort(), 'accessories ordered by code');
  }

  assert.deepEqual((await Promise.all([primary, worn, upgrade, steady].map((a) => dbAsset(a.id)))).map((a) => a.condition), ['POOR', 'FAIR', 'NEW', 'GOOD']);
  assert.deepEqual((await conditionEntries(upgrade.id)).map((e) => e.snapshot), [handoverSnapshot(code, 'GOOD', 'NEW')]);
  for (const untouched of [primary, worn, steady]) assert.equal((await conditionEntries(untouched.id)).length, 0, `${untouched.name}: unchanged → no entry`);

  // the primary can be changed as well, independently of the accessories
  const p2 = await newAsset('Laptops', 'bundle primary 2', { condition: 'GOOD' });
  const acc2 = await newAsset('Printers', 'accessory 2', { condition: 'GOOD' });
  const r2 = await assignGeneric({ type: 'GENERAL', employeeId: ayse.id, assetId: p2.id, conditionAtHandover: 'FAIR', accessoryAssetIds: [acc2.id] });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.deepEqual(Object.fromEntries(r2.body.data.items.map((i) => [i.assetId, i.conditionAtHandover])), { [p2.id]: 'FAIR', [acc2.id]: 'GOOD' });
  assert.equal((await dbAsset(p2.id)).condition, 'FAIR');
  assert.equal((await dbAsset(acc2.id)).condition, 'GOOD');
  assert.deepEqual((await conditionEntries(p2.id)).map((e) => e.snapshot), [handoverSnapshot(r2.body.data.assignmentCode, 'GOOD', 'FAIR')]);
  assert.equal((await conditionEntries(acc2.id)).length, 0);
});

test('R4 phone: phoneCondition is honoured and defaults to the phone\'s own condition (never GOOD); `condition` covers the SIM / charger items only', async () => {
  const { ayse } = await seed();

  // 1) nothing submitted → every asset (phone, both SIMs, cable, adapter) keeps / is handed over in ITS OWN condition.
  const own = await phoneKit({ phone: 'POOR', sim1: 'FAIR', sim2: 'NEW', cable: 'DAMAGED', adapter: 'FAIR' });
  const r1 = await assignPhone(kitBody(ayse.id, own));
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.deepEqual(
    Object.fromEntries(r1.body.data.items.map((i) => [i.role, i.conditionAtHandover])),
    { PRIMARY: 'POOR', SIM1: 'FAIR', SIM2: 'NEW', CHARGER_CABLE: 'DAMAGED', CHARGER_ADAPTER: 'FAIR' },
  );
  for (const [asset, expected] of [[own.phone, 'POOR'], [own.sim1, 'FAIR'], [own.sim2, 'NEW'], [own.cable, 'DAMAGED'], [own.adapter, 'FAIR']]) {
    assert.equal((await dbAsset(asset.id)).condition, expected, `${asset.code} unchanged`);
    assert.equal((await conditionEntries(asset.id)).length, 0, `${asset.code}: no entry when nothing differs`);
  }

  // 2) phoneCondition changes the phone; `condition` changes the SIM / charger items (and only those).
  const kit = await phoneKit({ phone: 'POOR', sim1: 'FAIR', sim2: 'FAIR', cable: 'FAIR', adapter: 'GOOD' });
  const r2 = await assignPhone({ ...kitBody(ayse.id, kit), phoneCondition: 'DAMAGED', condition: 'GOOD' });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  const code = r2.body.data.assignmentCode;
  assert.deepEqual(
    Object.fromEntries(r2.body.data.items.map((i) => [i.role, i.conditionAtHandover])),
    { PRIMARY: 'DAMAGED', SIM1: 'GOOD', SIM2: 'GOOD', CHARGER_CABLE: 'GOOD', CHARGER_ADAPTER: 'GOOD' },
  );
  assert.deepEqual(
    (await Promise.all([kit.phone, kit.sim1, kit.sim2, kit.cable, kit.adapter].map((a) => dbAsset(a.id)))).map((a) => a.condition),
    ['DAMAGED', 'GOOD', 'GOOD', 'GOOD', 'GOOD'],
  );
  assert.deepEqual((await conditionEntries(kit.phone.id)).map((e) => e.snapshot), [handoverSnapshot(code, 'POOR', 'DAMAGED')]);
  for (const sim of [kit.sim1, kit.sim2]) assert.deepEqual((await conditionEntries(sim.id)).map((e) => e.snapshot), [handoverSnapshot(code, 'FAIR', 'GOOD')]);
  assert.deepEqual((await conditionEntries(kit.cable.id)).map((e) => e.snapshot), [handoverSnapshot(code, 'FAIR', 'GOOD')]);
  assert.equal((await conditionEntries(kit.adapter.id)).length, 0, 'the adapter was already GOOD');
  assert.equal(await detailItemCondition(r2.body.data.id, kit.phone.id), 'DAMAGED', 'detail');

  // 3) `condition` alone never touches the phone: the phone defaults to its own condition.
  const only = await phoneKit({ phone: 'FAIR', sim1: 'POOR', cable: null, adapter: null });
  const r3 = await assignPhone({ ...kitBody(ayse.id, only), condition: 'NEW' });
  assert.equal(r3.status, 201, JSON.stringify(r3.body));
  assert.deepEqual(Object.fromEntries(r3.body.data.items.map((i) => [i.role, i.conditionAtHandover])), { PRIMARY: 'FAIR', SIM1: 'NEW' });
  assert.equal((await dbAsset(only.phone.id)).condition, 'FAIR');
  assert.equal((await dbAsset(only.sim1.id)).condition, 'NEW');
  assert.equal((await conditionEntries(only.phone.id)).length, 0);

  // 4) phoneCondition alone leaves the SIM / chargers in their own condition; a phone with no parts works too.
  const lone = await phoneKit({ phone: 'GOOD', sim1: 'FAIR', cable: null, adapter: null });
  const r4 = await assignPhone({ ...kitBody(ayse.id, lone), phoneCondition: 'FAIR' });
  assert.equal(r4.status, 201, JSON.stringify(r4.body));
  assert.deepEqual(Object.fromEntries(r4.body.data.items.map((i) => [i.role, i.conditionAtHandover])), { PRIMARY: 'FAIR', SIM1: 'FAIR' });
  assert.equal((await dbAsset(lone.phone.id)).condition, 'FAIR');
  assert.equal((await dbAsset(lone.sim1.id)).condition, 'FAIR');
  assert.equal((await conditionEntries(lone.sim1.id)).length, 0);
  const bare = await newPhone('bare phone', { condition: 'POOR' });
  const r5 = await assignPhone({ employeeId: ayse.id, phoneAssetId: bare.id });
  assert.equal(r5.status, 201, JSON.stringify(r5.body));
  assert.equal(r5.body.data.items[0].conditionAtHandover, 'POOR', 'a phone handed over with no body condition at all keeps its own — not GOOD');
});

test('R4: invalid condition enums are a 400 on every field; a refused handover leaves every condition untouched; racing handovers write back exactly once', async () => {
  const { ayse, can } = await seed();
  const ghost = '11111111-1111-4111-8111-111111111111';

  // 400 for a value outside the enum — on all four condition fields — and nothing is written.
  const kit = await phoneKit({ phone: 'POOR', sim1: 'FAIR', cable: null, adapter: null });
  for (const bad of [{ phoneCondition: 'BROKEN' }, { condition: 'BROKEN' }, { phoneCondition: 'good' }, { phoneCondition: 5 }]) {
    const r = await assignPhone({ ...kitBody(ayse.id, kit), ...bad });
    assert.equal(r.status, 400, `${JSON.stringify(bad)} → ${JSON.stringify(r.body)}`);
    assert.equal(err(r).code, 'VALIDATION_ERROR');
  }
  const lap = await newAsset('Laptops', 'bad enums', { condition: 'FAIR' });
  const acc = await newAsset('Printers', 'bad enums acc', { condition: 'FAIR' });
  for (const bad of [{ conditionAtHandover: 'BROKEN' }, { accessoryAssetIds: [acc.id], accessoryConditions: [{ assetId: acc.id, condition: 'BROKEN' }] }]) {
    const r = await assignGeneric({ type: 'GENERAL', employeeId: ayse.id, assetId: lap.id, ...bad });
    assert.equal(r.status, 400, `${JSON.stringify(bad)} → ${JSON.stringify(r.body)}`);
  }
  assert.equal((await assignGeneric({ type: 'GENERAL', employeeId: ayse.id, assetId: lap.id, accessoryAssetIds: [acc.id], accessoryConditions: [{ assetId: ghost, condition: 'GOOD' }] })).status, 400);
  for (const a of [kit.phone, kit.sim1, lap, acc]) assert.equal((await dbAsset(a.id)).status, 'AVAILABLE', 'rejected requests leave the assets free');
  assert.deepEqual([(await dbAsset(kit.phone.id)).condition, (await dbAsset(lap.id)).condition], ['POOR', 'FAIR']);

  // A handover that is refused AFTER the condition was chosen (a held accessory / SIM → 409) writes nothing at all.
  // (Held by Can, who has no room: assets that stay held must not show up for room-scoped users of the other suites.)
  const heldAcc = await newAsset('Printers', 'held accessory', { condition: 'FAIR' });
  await prisma.asset.update({ where: { id: heldAcc.id }, data: { status: 'ASSIGNED', currentHolderEmployeeId: can.id } });
  const refused = await assignGeneric({ type: 'GENERAL', employeeId: ayse.id, assetId: lap.id, conditionAtHandover: 'GOOD', accessoryAssetIds: [heldAcc.id], accessoryConditions: [{ assetId: heldAcc.id, condition: 'GOOD' }] });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.deepEqual(await dbAsset(lap.id), { condition: 'FAIR', status: 'AVAILABLE', currentHolderEmployeeId: null }, 'the primary keeps its condition');
  assert.equal((await dbAsset(heldAcc.id)).condition, 'FAIR');
  assert.equal((await conditionEntries(lap.id)).length + (await conditionEntries(heldAcc.id)).length, 0);
  const heldSim = await newSim('held sim', { condition: 'FAIR' });
  await prisma.asset.update({ where: { id: heldSim.id }, data: { status: 'ASSIGNED', currentHolderEmployeeId: can.id } });
  const refusedPhone = await assignPhone({ employeeId: ayse.id, phoneAssetId: kit.phone.id, phoneCondition: 'GOOD', sim1AssetId: heldSim.id, condition: 'GOOD' });
  assert.equal(refusedPhone.status, 409, JSON.stringify(refusedPhone.body));
  assert.deepEqual([(await dbAsset(kit.phone.id)).condition, (await dbAsset(heldSim.id)).condition], ['POOR', 'FAIR']);
  assert.equal((await conditionEntries(kit.phone.id)).length, 0);

  // Racing handovers of one asset: one winner, and the write-back happened exactly once (the losers rolled back).
  const N = 4;
  const raced = await newAsset('Laptops', 'race', { condition: 'FAIR' });
  const results = await Promise.all(Array.from({ length: N }, () => assignGeneric({ employeeId: ayse.id, assetId: raced.id, conditionAtHandover: 'GOOD' })));
  assert.equal(results.map((r) => r.status).sort().join(','), `201,${Array(N - 1).fill(409).join(',')}`);
  const winner = results.find((r) => r.status === 201);
  assert.equal((await dbAsset(raced.id)).condition, 'GOOD');
  assert.deepEqual((await conditionEntries(raced.id)).map((e) => [e.assignmentId, e.snapshot.from, e.snapshot.to]), [[winner.body.data.id, 'FAIR', 'GOOD']]);
});

/* ───────────────────────────── R3 — assignment detail ───────────────────────────── */

test('R3: GET /assignments/:id → employee department/room and items[].asset (serial, qty, notes, category, room, labelled custom fields, phone block)', async () => {
  const { ayse, sofia, room } = await seed();
  const admin = await as('admin');
  const tr1 = room('TR1');

  // Category tree with its own custom columns (see KIT_FIELDS) + a column of an unrelated category.
  const kitCategory = await ensureCategory('P8 Kit');
  const miniCategory = await ensureCategory('P8 Kit Mini');
  const otherCategory = await ensureCategory('P8 Other');
  const foreignField = await prisma.assetCategoryField.findFirst({ where: { categoryId: otherCategory.id, key: 'p8_other' } });
  assert.ok(foreignField, 'the unrelated category has its column');

  const kit = await newAsset('P8 Kit', 'kit', {
    qty: 3, serialNumber: `KIT-${tag()}`, notes: 'Handle with care', roomId: tr1.id,
    customFields: { p8_cpu: 'Core i7', p8_ram: 16, p8_touch: false, p8_zeta: 'last', p8_alpha: 'first' }, // p8_empty stays empty
  });
  // The sub-category inherits the parent's columns and adds its own; a whitespace-only value is stored as "" and
  // must count as empty, and a stale value of a column that does not apply to the category is never shown.
  // (Both assets sit in TR1: while Sofia holds them they are visible to room-scoped users, who must find them in their room.)
  const mini = await newAsset('P8 Kit Mini', 'mini', { roomId: tr1.id, customFields: { p8_child: 'mini column', p8_cpu: 'Celeron', p8_touch: true, p8_zeta: '   ' } });
  await prisma.assetCustomFieldValue.create({ data: { assetId: mini.id, fieldId: foreignField.id, value: 'stale value of another category' } });

  const r = await assignGeneric({ type: 'GENERAL', employeeId: sofia.id, assetId: kit.id, accessoryAssetIds: [mini.id], conditionAtHandover: 'GOOD', notes: 'detail check' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.data.id;
  const detail = await getDetail(admin, id);
  const field = (key, label, type, value) => ({ key, label, type, value });

  // employee: department + room (an employee without a room gets room: null — checked below with Ayse)
  const sofiaApi = (await admin.req('GET', `/employees/${sofia.id}`)).body.data;
  assert.deepEqual(detail.employee, { id: sofia.id, fullName: 'Sofia Petrova', department: sofiaApi.departmentTeam, room: { id: tr1.id, code: 'TR1' } });
  assert.equal(detail.employee.department.name, 'Call Center');

  // items[].asset — exactly the documented keys
  const kitItem = itemOf(detail, kit.id);
  assert.deepEqual(Object.keys(kitItem.asset).sort(), ['category', 'code', 'customFields', 'id', 'name', 'notes', 'phone', 'photos', 'qty', 'room', 'serialNumber']);
  assert.deepEqual(
    { ...kitItem.asset, customFields: undefined },
    { id: kit.id, code: kit.code, name: kit.name, serialNumber: kit.serialNumber, qty: 3, notes: 'Handle with care', category: { id: kitCategory.id, name: 'P8 Kit' }, room: { id: tr1.id, code: 'TR1' }, phone: null, photos: [], customFields: undefined },
  );
  // customFields: labelled from the definition, non-empty only (0/false would stay), ordered by sortOrder then label
  assert.deepEqual(kitItem.asset.customFields, [
    field('p8_cpu', 'Processor', 'string', 'Core i7'),
    field('p8_ram', 'RAM (GB)', 'number', 16),
    field('p8_touch', 'Touch screen', 'boolean', false),
    field('p8_alpha', 'Alpha', 'string', 'first'), // same sortOrder (30) as Zeta → label order
    field('p8_zeta', 'Zeta', 'string', 'last'),
  ]);
  const miniItem = itemOf(detail, mini.id);
  assert.equal(miniItem.role, 'BUNDLED');
  assert.deepEqual(miniItem.asset.category, { id: miniCategory.id, name: 'P8 Kit Mini' });
  assert.deepEqual(miniItem.asset.room, { id: tr1.id, code: 'TR1' });
  assert.deepEqual(miniItem.asset.customFields, [
    field('p8_cpu', 'Processor', 'string', 'Celeron'), // the parent's column (inherited)
    field('p8_child', 'Child column', 'string', 'mini column'),
    field('p8_touch', 'Touch screen', 'boolean', true),
  ], 'inherited + own columns; the empty and the foreign value are left out');

  // the existing fields are all still there (other pages use them)
  assert.ok(detail.items.every((i) => i.id && i.assetId === i.asset.id && typeof i.isActive === 'boolean' && 'returnCondition' in i && 'conditionAtHandover' in i));
  assert.equal(kitItem.role, 'PRIMARY');
  assert.deepEqual([detail.assignmentCode, detail.status, detail.type, detail.notes, detail.asset.id], [r.body.data.assignmentCode, 'ACTIVE', 'GENERAL', 'detail check', kit.id]);
  for (const key of ['workIdentity', 'phoneDetail', 'photos', 'timelineEntries', 'returnRecords', 'assignedAt', 'expectedReturnAt']) assert.ok(key in detail, `${key} still present`);
  assert.deepEqual(assetsById(r.body.data), assetsById(detail), 'the create response carries the same enriched assets');
  assert.deepEqual(r.body.data.employee, detail.employee);

  // a room-scoped reader opens the same payload (Sofia's assignment is in TR1)
  const tl = await as('tl.tr1');
  assert.equal((await getDetail(tl, id)).employee.department.name, 'Call Center');

  // the employee without a room (and an asset without one: room: null)
  const a2 = await assignGeneric({ employeeId: ayse.id, assetId: (await newAsset('Laptops', 'no room')).id, conditionAtHandover: 'GOOD' });
  assert.equal(a2.status, 201, JSON.stringify(a2.body));
  const d2 = await getDetail(admin, a2.body.data.id);
  assert.deepEqual(d2.employee, { id: ayse.id, fullName: 'Ayse Celik', department: { id: ayse.departmentTeam.id, name: 'Banko' }, room: null });
  assert.equal(d2.items[0].asset.room, null, 'an asset without a room → room: null');
  assert.deepEqual(d2.items[0].asset.customFields, [], 'no custom values → an empty list');

  // hand the TR1 kit back right away: assets held by a TR1 employee are visible to room-scoped users
  assert.equal((await admin.req('POST', `/assignments/${id}/return`, { body: { returnCondition: 'GOOD' } })).status, 200);
});

test('R3 phone: the phone block (imei, make, model, color, storage) and the SIM\'s labelled phone_number', async () => {
  const { ayse } = await seed();
  const admin = await as('admin');
  const phoneData = { imei: imei(), make: 'Samsung', model: 'Galaxy A54', color: 'Graphite', storage: '128 GB', carrier: 'Turkcell' };
  const phone = await newPhone('detail phone', { phone: phoneData, condition: 'FAIR', serialNumber: `SN-${tag()}`, notes: 'cracked corner' });
  const sim = await newSim('detail sim', { serialNumber: '8990011234567890123' });
  const cable = await newAsset('Charger Cables', 'detail cable');
  const r = await assignPhone({ employeeId: ayse.id, phoneAssetId: phone.id, sim1AssetId: sim.id, chargerCableAssetId: cable.id, phoneCondition: 'GOOD' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const detail = await getDetail(admin, r.body.data.id);

  const phoneItem = itemOf(detail, phone.id);
  assert.deepEqual(detail.items.map((i) => i.role), ['PRIMARY', 'SIM1', 'CHARGER_CABLE'], 'print order: phone, SIM 1, charger cable');
  assert.deepEqual(r.body.data.items.map((i) => i.role), ['PRIMARY', 'SIM1', 'CHARGER_CABLE'], 'same order in the create response');
  assert.equal(phoneItem.role, 'PRIMARY');
  assert.deepEqual(phoneItem.asset.phone, { imei: phoneData.imei, make: 'Samsung', model: 'Galaxy A54', color: 'Graphite', storage: '128 GB' }, 'exactly these five fields (no carrier)');
  assert.equal(phoneItem.asset.category.name, 'Phones');
  assert.equal(phoneItem.asset.notes, 'cracked corner');
  assert.equal(phoneItem.asset.serialNumber, phone.serialNumber);
  assert.equal(phoneItem.conditionAtHandover, 'GOOD', 'the chosen phone condition, not the recorded FAIR');
  assert.equal(detail.asset.id, phone.id);
  assert.ok('phoneDetail' in detail && detail.phoneDetail !== null, 'the assignment-level phoneDetail is still there');

  const simItem = itemOf(detail, sim.id);
  assert.equal(simItem.role, 'SIM1');
  assert.equal(simItem.asset.phone, null, 'only phones carry a phone block');
  assert.equal(simItem.asset.serialNumber, '8990011234567890123');
  const numberField = simItem.asset.customFields.find((f) => f.key === 'phone_number');
  assert.deepEqual(numberField, { key: 'phone_number', label: 'Phone number', type: 'string', value: sim.customFields.phone_number });
  assert.equal(itemOf(detail, cable.id).asset.phone, null);
  assert.deepEqual(itemOf(detail, cable.id).asset.customFields, [], 'no custom values → empty list, never missing');

  // the phone wizard's create response has the same shape as the detail
  assert.deepEqual(assetsById(r.body.data), assetsById(detail));
  assert.equal(r.body.data.employee.department.name, 'Banko');
});

/* ───────────────────────────── R5 — photos ───────────────────────────── */

test('R5: POST /assignments/:id/photos takes assetId (an item, else 400) and context; photos[] lists ONLY this assignment\'s photos', async () => {
  const { ayse } = await seed();
  const admin = await as('admin');
  const laptop = await newAsset('Laptops', 'photo laptop');
  const accessory = await newAsset('Printers', 'photo accessory');
  const stranger = await newAsset('Laptops', 'not in the assignment');
  const mine = await assignGeneric({ type: 'GENERAL', employeeId: ayse.id, assetId: laptop.id, accessoryAssetIds: [accessory.id], conditionAtHandover: 'GOOD' });
  const other = await assignGeneric({ employeeId: ayse.id, assetId: (await newAsset('Laptops', 'other assignment')).id, conditionAtHandover: 'GOOD' });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const id = mine.body.data.id;
  const photoCount = (assignmentId) => prisma.photo.count({ where: { assignmentId } });
  const shape = ['assetId', 'context', 'createdAt', 'fileName', 'id', 'mimeType', 'sizeBytes', 'type', 'url'];

  // The asset's own gallery photo (an inventory photo: assignmentId null) — it must never show up in photos[].
  const gallery = new FormData(); gallery.append('type', 'GENERAL'); gallery.append('photos', new Blob([PNG], { type: 'image/png' }), 'gallery.png');
  const g = await admin.req('POST', `/assets/${laptop.id}/photos`, { form: gallery });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  made.photos.push(g.body.data[0].id);
  const galleryPhoto = g.body.data[0];

  // 1) no assetId / context → whole handover, HANDOVER
  const whole = await uploadAssignmentPhoto(id, { type: 'FRONT' });
  assert.equal(whole.status, 201, JSON.stringify(whole.body));
  assert.deepEqual(Object.keys(whole.body.data[0]).sort(), shape);
  assert.deepEqual([whole.body.data[0].type, whole.body.data[0].context, whole.body.data[0].assetId], ['FRONT', 'HANDOVER', null]);
  // 2) tagged to the primary asset, 3) tagged to an accessory, 4) a RETURN photo of the whole assignment
  const ofPrimary = await uploadAssignmentPhoto(id, { type: 'BACK', assetId: laptop.id });
  const ofAccessory = await uploadAssignmentPhoto(id, { type: 'CONDITION', assetId: accessory.id, context: 'HANDOVER' });
  const atReturn = await uploadAssignmentPhoto(id, { type: 'FRONT', context: 'RETURN' });
  assert.deepEqual([ofPrimary, ofAccessory, atReturn].map((x) => x.status), [201, 201, 201]);
  assert.deepEqual([ofPrimary.body.data[0].context, ofPrimary.body.data[0].assetId], ['HANDOVER', laptop.id]);
  assert.deepEqual([ofAccessory.body.data[0].context, ofAccessory.body.data[0].assetId], ['HANDOVER', accessory.id]);
  assert.deepEqual([atReturn.body.data[0].context, atReturn.body.data[0].assetId], ['RETURN', null]);
  const tagged = await uploadAssignmentPhoto(id, { type: 'GENERAL', context: 'RETURN', assetId: accessory.id }); // both fields together
  assert.equal(tagged.status, 201, JSON.stringify(tagged.body));
  assert.deepEqual([tagged.body.data[0].context, tagged.body.data[0].assetId], ['RETURN', accessory.id]);
  // …stored on the Photo row, not just echoed
  const rows = await prisma.photo.findMany({ where: { id: { in: [whole, ofPrimary, ofAccessory, atReturn, tagged].map((x) => x.body.data[0].id) } } });
  assert.deepEqual(Object.fromEntries(rows.map((p) => [p.id, [p.assignmentId, p.assetId, p.context]])), {
    [whole.body.data[0].id]: [id, null, 'HANDOVER'],
    [ofPrimary.body.data[0].id]: [id, laptop.id, 'HANDOVER'],
    [ofAccessory.body.data[0].id]: [id, accessory.id, 'HANDOVER'],
    [atReturn.body.data[0].id]: [id, null, 'RETURN'],
    [tagged.body.data[0].id]: [id, accessory.id, 'RETURN'],
  });

  // Rejected uploads: 400 and nothing stored (the validation runs before a file is written).
  const before = await photoCount(id);
  const ghost = '11111111-1111-4111-8111-111111111111';
  for (const [why, fields] of [
    ['an asset that is not an item of the assignment', { assetId: stranger.id }],
    ['an unknown asset id', { assetId: ghost }],
    ['an asset of ANOTHER assignment', { assetId: other.body.data.items[0].assetId }],
    ['a malformed asset id', { assetId: 'not-a-uuid' }],
    ['an unknown context', { context: 'ARCHIVE' }],
    ['a lower-case context', { context: 'return' }],
    ['an unknown type', { type: 'SIDE' }],
  ]) {
    const r = await uploadAssignmentPhoto(id, fields);
    assert.equal(r.status, 400, `${why}: ${JSON.stringify(r.body)}`);
  }
  assert.match(err(await uploadAssignmentPhoto(id, { assetId: stranger.id })).message, /item of this assignment/);
  assert.equal(await photoCount(id), before, 'no photo row was created by a rejected upload');
  assert.equal((await uploadAssignmentPhoto('00000000-0000-4000-8000-000000000000', { type: 'FRONT' })).status, 404);

  // Another assignment gets its own photos (one of them tagged to its own primary asset).
  const otherPhoto = await uploadAssignmentPhoto(other.body.data.id, { type: 'FRONT' });
  const otherTagged = await uploadAssignmentPhoto(other.body.data.id, { type: 'BACK', assetId: other.body.data.items[0].assetId });
  assert.deepEqual([otherPhoto.status, otherTagged.status], [201, 201]);

  // And a photo uploaded through the existing return route (context RETURN) belongs to this assignment too.
  const fd = new FormData(); fd.append('type', 'BACK'); fd.append('photos', new Blob([PNG], { type: 'image/png' }), 'return.png');
  const viaReturnRoute = await admin.req('POST', `/assignments/${id}/return/photos`, { form: fd });
  assert.equal(viaReturnRoute.status, 201, JSON.stringify(viaReturnRoute.body));
  made.photos.push(viaReturnRoute.body.data[0].id);

  // photos[] = exactly this assignment's photos (every context, every tag) — no gallery photo, no other assignment's
  const detail = await getDetail(admin, id);
  const expected = [whole, ofPrimary, ofAccessory, atReturn, tagged].map((x) => x.body.data[0].id).concat(viaReturnRoute.body.data[0].id);
  assert.deepEqual(detail.photos.map((p) => p.id).sort(), [...expected].sort());
  assert.ok(!detail.photos.some((p) => [galleryPhoto.id, otherPhoto.body.data[0].id, otherTagged.body.data[0].id].includes(p.id)));
  for (const p of detail.photos) {
    for (const key of ['id', 'type', 'context', 'assetId', 'url', 'createdAt']) assert.ok(key in p, `photos[].${key}`);
    assert.equal(p.url, `/api/v1/photos/${p.id}/file`);
    assert.ok(['HANDOVER', 'RETURN'].includes(p.context));
    assert.ok(p.assetId === null || [laptop.id, accessory.id].includes(p.assetId));
  }
  const byId = Object.fromEntries(detail.photos.map((p) => [p.id, p]));
  assert.deepEqual([byId[ofPrimary.body.data[0].id].assetId, byId[ofAccessory.body.data[0].id].assetId, byId[whole.body.data[0].id].assetId], [laptop.id, accessory.id, null]);
  assert.equal(byId[viaReturnRoute.body.data[0].id].context, 'RETURN');
  assert.deepEqual(detail.photos.map((p) => p.createdAt), detail.photos.map((p) => p.createdAt).sort(), 'oldest first');
  assert.equal(await admin.status(detail.photos[0].url), 200, 'the photo URL opens');

  // items[].asset.photos = the asset GALLERY only: the inventory photo yes, the assignment's photos tagged with the asset no
  assert.deepEqual(itemOf(detail, laptop.id).asset.photos.map(({ id, type, url }) => ({ id, type, url })), [{ id: galleryPhoto.id, type: 'GENERAL', url: `/api/v1/photos/${galleryPhoto.id}/file` }]);
  assert.deepEqual(itemOf(detail, accessory.id).asset.photos, [], 'photos tagged to the accessory belong to the assignment, not to the accessory\'s gallery');
  const otherDetail = await getDetail(admin, other.body.data.id);
  assert.deepEqual(otherDetail.photos.map((p) => p.id).sort(), [otherPhoto.body.data[0].id, otherTagged.body.data[0].id].sort());
  assert.deepEqual(otherDetail.items[0].asset.photos, [], 'its tagged photo is not in the asset gallery either');
});
