'use strict';
/**
 * Phase 8 — card t_8f2598ff (BE-2), docs/PHASE_8_REQUESTS.md: R1/R2 seed categories, R4 rule 5
 * `lastConditionCheck`, R5 asset side (`photos` = gallery only, new `photoHistory`).
 *
 * Same pattern as tests/assign.fixes.test.js: it talks to a RUNNING server (BASE_URL) and also uses Prisma
 * directly (DATABASE_URL) — for the Photo rows and the handover-shaped timeline entries that the assignment
 * endpoints of the other Phase 8 card produce — so BOTH must point at the same throw-away, freshly seeded
 * database, never the shared dev DB behind :4000. Both variables are mandatory (no defaults); :4000 is refused:
 *
 *   createdb scratch_db
 *   DATABASE_URL='postgresql://postgres@localhost:5432/scratch_db?schema=public' npx prisma migrate deploy
 *   DATABASE_URL='…same…' npm run seed
 *   DATABASE_URL='…same…' PORT=3001 node src/server.js &
 *   DATABASE_URL='…same…' BASE_URL=http://localhost:3001 node --test tests/phase8.assets.test.js
 *
 * The seed test does not look at that database's categories (an older seed may have filled it): it creates a
 * database of its own next to it (needs the CREATEDB privilege), runs `prisma migrate deploy` + the real seed
 * there and drops it again. Everything else creates its fixtures through the API with unique "P8A …" names;
 * the final hook returns the assignments it opened and disposes / deletes the assets, so repeated runs leave
 * the data as they found it (assets that gained history end DISPOSED). Hand-over holders are Ayse Celik (no
 * room → invisible to team-leader / call-centre-manager scopes) or assets sit in TR1, so the room assertions of
 * the other suites that run in parallel are not disturbed.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Fail fast, before anything can load .env and quietly aim Prisma at the dev database.
const BASE = process.env.BASE_URL || '';
if (!BASE || !process.env.DATABASE_URL) {
  throw new Error('phase8.assets.test.js needs BOTH BASE_URL (your own server, e.g. http://localhost:3001) and DATABASE_URL (the same scratch DB that server uses)');
}
if (new URL(BASE).port === '4000') throw new Error('refusing to run against :4000 (the shared dev server) — start your own server on another port');

const prisma = require('../src/db');
const { PrismaClient } = require('@prisma/client');

const SERVER_DIR = path.join(__dirname, '..');

/* ───────────────────────────── tiny API client ───────────────────────────── */

const PW = { admin: 'Admin#12345', manager: 'Manager#12345', 'tl.tr1': 'Leader#12345', 'mr.mahmoud': 'Mahmoud#12345' };
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
    return { status: res.status, body: json };
  }
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

const made = { assets: [], assignments: [], photoRows: [], uploaded: [], databases: [] };
let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter += 1)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seeded category by name (root level); created with a free prefix when the server's DB lacks it. */
const categories = new Map();
function category(name) {
  if (!categories.has(name)) {
    categories.set(name, (async () => {
      const admin = await as('admin');
      const flat = (await admin.req('GET', '/asset-categories?includeInactive=true')).body.flat;
      const found = flat.find((c) => c.name === name && !c.parentId && c.isActive);
      if (found) return found;
      const used = new Set(flat.map((c) => c.codePrefix));
      let codePrefix;
      do codePrefix = `Z${[0, 1, 2].map(() => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')}`; while (used.has(codePrefix));
      const r = await admin.req('POST', '/asset-categories', { body: { name, kind: 'physical', codePrefix } });
      assert.equal(r.status, 201, `create category ${name}: ${JSON.stringify(r.body)}`);
      return r.body.data;
    })());
  }
  return categories.get(name);
}

let worldPromise;
/** Seeded reference data: rooms TR1/TR2, three employees (Ahmet → TR1, Elif → TR2, Ayse → no room) and the admin's id. */
function world() {
  worldPromise ??= (async () => {
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
      ahmet: await employee('Ahmet Yilmaz'),
      elif: await employee('Elif Demir'),
      ayse: await employee('Ayse Celik'),
      adminId: (await admin.req('GET', '/auth/me')).body.user.id,
    };
  })();
  return worldPromise;
}

async function newAsset(categoryName, label, extra = {}) {
  const admin = await as('admin');
  const cat = await category(categoryName);
  const r = await admin.req('POST', '/assets', { body: { categoryId: cat.id, name: `P8A ${label} ${tag()}`, condition: 'GOOD', ...extra } });
  assert.equal(r.status, 201, `create ${categoryName} asset: ${JSON.stringify(r.body)}`);
  made.assets.push(r.body.data.id);
  return r.body.data;
}

async function getAsset(client, id) {
  const r = await client.req('GET', `/assets/${id}`);
  assert.equal(r.status, 200, `GET /assets/${id}: ${JSON.stringify(r.body)}`);
  return r.body.data;
}

/** Hand `asset` (+ optional accessories) over through the real endpoint. The handover condition is the asset's
 *  current one unless given, so no condition write-back is involved whatever the assignment card does with it. */
async function assign(employeeId, asset, { accessories = [], condition = asset.condition } = {}) {
  const admin = await as('admin');
  const r = await admin.req('POST', '/assignments/generic', {
    body: { type: accessories.length ? 'GENERAL' : 'LAPTOP', employeeId, assetId: asset.id, accessoryAssetIds: accessories.map((a) => a.id), conditionAtHandover: condition },
  });
  assert.equal(r.status, 201, `assign: ${JSON.stringify(r.body)}`);
  made.assignments.push(r.body.data.id);
  return r.body.data;
}

async function giveBack(assignment, returnCondition = 'GOOD') {
  const admin = await as('admin');
  const r = await admin.req('POST', `/assignments/${assignment.id}/return`, { body: { returnCondition } });
  assert.equal(r.status, 200, `return ${assignment.assignmentCode}: ${JSON.stringify(r.body)}`);
  return r.body.data;
}

/** A Photo row written directly (the assignment-photo endpoint belongs to the other Phase 8 card). Each row gets
 *  its own, strictly increasing createdAt so the expected order never depends on millisecond ties. */
const photoClock = Date.now();
async function addPhoto({ assignmentId = null, assetId = null, context = 'HANDOVER', type = 'FRONT' }) {
  const n = (counter += 1);
  const row = await prisma.photo.create({
    data: { assignmentId, assetId, context, type, fileName: `p8-${n}.png`, path: `assignments/p8-assets-test/${tag()}.png`, mimeType: 'image/png', sizeBytes: PNG.length, createdAt: new Date(photoClock + n) },
    select: { id: true },
  });
  made.photoRows.push(row.id);
  return row.id;
}

/** A condition timeline entry written directly, in the snapshot shape of the handover write-back / return flow. */
async function addTimelineEntry(assignmentId, assetId, snapshot, { eventType = 'UPDATED' } = {}) {
  const { adminId } = await world();
  const a = await prisma.assignment.findUnique({ where: { id: assignmentId }, select: { employeeId: true, workIdentityId: true } });
  return prisma.assignmentTimelineEntry.create({
    data: { assignmentId, assetId, employeeId: a.employeeId, workIdentityId: a.workIdentityId, eventType, snapshot, createdById: adminId },
  });
}

const pngForm = (type) => {
  const form = new FormData();
  form.append('type', type);
  form.append('photos', new Blob([PNG], { type: 'image/png' }), `p8-${tag()}.png`);
  return form;
};

after(async () => {
  const admin = await as('admin');
  for (const id of made.assignments) await admin.req('POST', `/assignments/${id}/return`, { body: { returnCondition: 'GOOD' } }); // 409 when already returned — fine
  for (const id of made.uploaded) await admin.req('DELETE', `/photos/${id}`); // row + file on disk
  await prisma.photo.deleteMany({ where: { id: { in: made.photoRows } } });
  for (const id of made.assets) await admin.req('DELETE', `/assets/${id}`); // hard delete, or soft-dispose once it has history
  for (const name of made.databases) await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await prisma.$disconnect();
});

/* ───────────────────────────── R1 / R2 — the seed ───────────────────────────── */

const ACCESSORY_CATEGORIES = [['Computers', 'COM'], ['Monitors', 'MON'], ['Mouse', 'MOU'], ['Keyboards', 'KEY'], ['Headphones', 'HDP']];
const HARDWARE_KEYS = ['model', 'cpu', 'ram_gb', 'disk', 'gpu'];

const urlOfDatabase = (name) => { const u = new URL(process.env.DATABASE_URL); u.pathname = `/${name}`; return u.toString(); };
const runNode = (script, args, databaseUrl) =>
  execFileSync(process.execPath, [script, ...args], { cwd: SERVER_DIR, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', stdio: 'pipe', timeout: 180_000 });

/** The catalogue the seed owns, in a comparable form (ids included: a re-run must not recreate rows). */
async function catalogue(db) {
  const cats = await db.assetCategory.findMany({ include: { parent: { select: { name: true } }, fields: true } });
  const by = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    categories: cats
      .map((c) => ({ id: c.id, name: c.name, parent: c.parent?.name ?? null, kind: c.kind, codePrefix: c.codePrefix, isActive: c.isActive }))
      .sort((a, b) => by(`${a.parent}/${a.name}`, `${b.parent}/${b.name}`)),
    fields: cats
      .flatMap((c) => c.fields.map((f) => ({ id: f.id, category: c.name, key: f.key, label: f.label, type: f.type, sortOrder: f.sortOrder, required: f.required })))
      .sort((a, b) => by(`${a.category}/${a.key}`, `${b.category}/${b.key}`)),
    counts: {
      users: await db.user.count(), rooms: await db.room.count(), departments: await db.departmentTeam.count(),
      employees: await db.employee.count(), assets: await db.asset.count(), accounts: await db.account.count(),
    },
  };
}
const root = (snap, name) => snap.categories.filter((c) => c.parent === null && c.name.toLowerCase() === name.toLowerCase());
const assertNoDuplicates = (snap, label) => {
  const cats = snap.categories.map((c) => `${c.parent}/${c.name.toLowerCase()}`);
  assert.equal(new Set(cats).size, cats.length, `${label}: no duplicate categories`);
  const fields = snap.fields.map((f) => `${f.category}/${f.key}`);
  assert.equal(new Set(fields).size, fields.length, `${label}: no duplicate custom columns`);
};

test('seed: no Accounts / GMail category, the accessory categories + hardware columns exist, and re-running it (also on a legacy DB) changes nothing', async () => {
  // A database of its own, migrated and seeded for real — nothing here depends on what the server's DB holds.
  const dbName = `p8_seed_${Date.now().toString(36)}_${process.pid}`;
  const url = urlOfDatabase(dbName);
  await prisma.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  made.databases.push(dbName);
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    runNode(require.resolve('prisma/build/index.js'), ['migrate', 'deploy'], url);
    runNode(path.join(SERVER_DIR, 'prisma', 'seed.js'), [], url);
    const first = await catalogue(db);

    // R1: the seed no longer creates the noise categories …
    assert.deepEqual(first.categories.filter((c) => /^accounts$|gmail/i.test(c.name)), [], 'no Accounts / GMail-for-WhatsApp-Backup category');
    assert.deepEqual(first.categories.filter((c) => c.kind === 'account'), [], 'no category of kind account');
    // … and keeps everything else
    for (const name of ['Phones', 'SIM Cards', 'Laptops', 'Chargers', 'Printers', 'Networking']) assert.equal(root(first, name).length, 1, `seed keeps ${name}`);
    for (const name of ['Charger Cables', 'Charger Adapters']) assert.equal(first.categories.filter((c) => c.name === name && c.parent === 'Chargers').length, 1, `seed keeps ${name}`);

    // R2: root physical categories for the accessory picker
    for (const [name, codePrefix] of ACCESSORY_CATEGORIES) {
      const rows = root(first, name);
      assert.equal(rows.length, 1, `exactly one root category ${name}`);
      assert.equal(rows[0].name, name);
      assert.equal(rows[0].kind, 'physical');
      assert.equal(rows[0].codePrefix, codePrefix);
      assert.equal(rows[0].isActive, true);
    }
    // R3 columns: processor / RAM / storage / GPU for PCs and laptops (same keys → same labels on the receipt)
    for (const name of ['Computers', 'Laptops']) {
      assert.deepEqual(first.fields.filter((f) => f.category === name).sort((a, b) => a.sortOrder - b.sortOrder).map((f) => f.key), HARDWARE_KEYS, `${name} columns`);
      assert.ok(first.fields.filter((f) => f.category === name).every((f) => f.required === false), `${name}: no required column — PCs can still be created without specs`);
    }
    assertNoDuplicates(first, 'fresh seed');

    // Idempotent on a database that already holds data: re-run twice, nothing is recreated or duplicated.
    runNode(path.join(SERVER_DIR, 'prisma', 'seed.js'), [], url);
    assert.deepEqual(await catalogue(db), first, 're-running the seed on its own output changes nothing');

    // Legacy DB (older seed + owner edits): the leftover categories stay, nothing the owner changed is rewritten,
    // and a category that is missing is simply created again.
    const accounts = await db.assetCategory.create({ data: { name: 'Accounts', kind: 'account', codePrefix: 'ACC' } });
    await db.assetCategory.create({ data: { name: 'GMail-for-WhatsApp-Backup', parentId: accounts.id, kind: 'account', codePrefix: 'ACC' } });
    await db.assetCategory.update({ where: { id: root(first, 'Keyboards')[0].id }, data: { codePrefix: 'KBD' } }); // as the Excel import names it
    await db.assetCategory.update({ where: { id: root(first, 'Mouse')[0].id }, data: { isActive: false } });
    await db.assetCategory.delete({ where: { id: root(first, 'Headphones')[0].id } });
    await db.assetCategoryField.updateMany({ where: { categoryId: root(first, 'Computers')[0].id, key: 'cpu' }, data: { label: 'Processor' } });

    runNode(path.join(SERVER_DIR, 'prisma', 'seed.js'), [], url);
    const legacy = await catalogue(db);
    assert.equal(root(legacy, 'Accounts').length, 1, 'the seed never deletes the leftover Accounts category');
    assert.equal(legacy.categories.filter((c) => c.name === 'GMail-for-WhatsApp-Backup').length, 1, 'nor its child');
    assert.equal(root(legacy, 'Keyboards').length, 1, 'no second Keyboards');
    assert.equal(root(legacy, 'Keyboards')[0].codePrefix, 'KBD', 'an existing category keeps its code prefix');
    assert.equal(root(legacy, 'Mouse')[0].isActive, false, 'a deactivated category stays deactivated');
    assert.equal(root(legacy, 'Headphones').length, 1, 'a missing category is created again');
    assert.equal(root(legacy, 'Headphones')[0].codePrefix, 'HDP');
    assert.equal(legacy.fields.find((f) => f.category === 'Computers' && f.key === 'cpu').label, 'Processor', "the owner's column label survives");
    assert.equal(legacy.categories.length, first.categories.length + 2, 'only the two legacy categories were added');
    assert.deepEqual(legacy.counts, first.counts, 'no other table changed');
    assertNoDuplicates(legacy, 'legacy DB');

    runNode(path.join(SERVER_DIR, 'prisma', 'seed.js'), [], url);
    assert.deepEqual(await catalogue(db), legacy, 'and once more: still nothing changes');
  } finally {
    await db.$disconnect();
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  }
});

test('the accessory categories are usable on the server database: one root physical category each, assets get its code prefix', async () => {
  const admin = await as('admin');
  const flat = (await admin.req('GET', '/asset-categories')).body.flat;
  for (const [name] of ACCESSORY_CATEGORIES) {
    const rows = flat.filter((c) => !c.parentId && c.name.toLowerCase() === name.toLowerCase());
    assert.equal(rows.length, 1, `one root category ${name} on the server's DB (run the seed)`);
    assert.equal(rows[0].kind, 'physical');
    const asset = await newAsset(name, name.toLowerCase());
    assert.match(asset.code, new RegExp(`^${rows[0].codePrefix}-\\d{6}$`), `${name} asset code uses the category prefix`);
    assert.equal(asset.category.id, rows[0].id);
  }
});

/* ───────────────────────────── R4 rule 5 — lastConditionCheck ───────────────────────────── */

test('lastConditionCheck: created → hand edit → (hand-over) → return → delivery entry → hand edit → dispose; the newest record wins', async () => {
  const admin = await as('admin');
  const { ayse } = await world();
  const keys = (o) => Object.keys(o).sort();
  const laptop = await newAsset('Laptops', 'condition', { condition: 'GOOD' });

  // 1 · never touched → the creation
  let d = await getAsset(admin, laptop.id);
  assert.deepEqual(keys(d.lastConditionCheck), ['assignmentCode', 'at', 'condition', 'source']);
  assert.deepEqual(d.lastConditionCheck, { condition: 'GOOD', at: d.createdAt, source: 'created', assignmentCode: null });

  // 2 · editing another field, or sending the condition it already has, is no condition check
  assert.equal((await admin.req('PATCH', `/assets/${laptop.id}`, { body: { notes: 'just a note' } })).status, 200);
  assert.equal((await admin.req('PATCH', `/assets/${laptop.id}`, { body: { condition: 'GOOD' } })).status, 200);
  assert.deepEqual((await getAsset(admin, laptop.id)).lastConditionCheck, { condition: 'GOOD', at: d.createdAt, source: 'created', assignmentCode: null });

  // 3 · a hand edit of the condition → manual, no assignment behind it
  const t0 = Date.now() - 2000;
  const edit = await admin.req('PATCH', `/assets/${laptop.id}`, { body: { condition: 'FAIR' } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  d = await getAsset(admin, laptop.id);
  assert.equal(d.condition, 'FAIR');
  assert.deepEqual(keys(d.lastConditionCheck), ['assignmentCode', 'at', 'condition', 'source']);
  assert.equal(d.lastConditionCheck.source, 'manual');
  assert.equal(d.lastConditionCheck.condition, 'FAIR');
  assert.equal(d.lastConditionCheck.assignmentCode, null);
  assert.ok(Date.parse(d.lastConditionCheck.at) >= t0, 'at = when the edit happened');
  assert.notEqual(d.lastConditionCheck.at, d.createdAt);
  const manualAt = d.lastConditionCheck.at;
  // the record behind it: one audit row, written with the edit, carrying the transition (a no-op edit above wrote none)
  const audited = (await admin.req('GET', `/audit-logs?targetId=${laptop.id}&action=asset.condition.update`)).body.data;
  assert.deepEqual(audited.map((r) => r.meta), [{ from: 'GOOD', to: 'FAIR' }]);

  // 4 · handed over in the condition it has: only ASSIGNED timeline entries appear — they are no condition record
  const a1 = await assign(ayse.id, d, { condition: 'FAIR' });
  d = await getAsset(admin, laptop.id);
  assert.equal(d.status, 'ASSIGNED');
  assert.ok(d.timelineEntries.some((e) => e.eventType === 'ASSIGNED'));
  assert.deepEqual(d.lastConditionCheck, { condition: 'FAIR', at: manualAt, source: 'manual', assignmentCode: null });

  // 5 · the return flow's entry — { field:'condition', from, to, assignmentCode } WITHOUT a reason — is a return
  await sleep(20);
  await giveBack(a1, 'POOR');
  d = await getAsset(admin, laptop.id);
  const returned = d.timelineEntries.find((e) => e.eventType === 'UPDATED' && e.snapshot.field === 'condition');
  assert.ok(returned, 'the return wrote its UPDATED condition entry');
  assert.ok([undefined, 'return'].includes(returned.snapshot.reason), 'today the return flow writes no reason at all — the source rule covers that case (and an explicit "return")');
  assert.deepEqual(d.lastConditionCheck, { condition: 'POOR', at: returned.createdAt, source: 'return', assignmentCode: a1.assignmentCode });

  // 6 · entries tagged the way the handover write-back tags them, and the explicit / unknown tags
  await sleep(20);
  await addTimelineEntry(a1.id, laptop.id, { field: 'condition', from: 'POOR', to: 'GOOD', assignmentCode: a1.assignmentCode, reason: 'handover' });
  d = await getAsset(admin, laptop.id);
  assert.deepEqual({ ...d.lastConditionCheck, at: undefined }, { condition: 'GOOD', at: undefined, source: 'delivery', assignmentCode: a1.assignmentCode });

  await sleep(20);
  await addTimelineEntry(a1.id, laptop.id, { field: 'condition', from: 'GOOD', to: 'NEW', assignmentCode: a1.assignmentCode, reason: 'delivery' }); // the spec's other name for it
  d = await getAsset(admin, laptop.id);
  assert.deepEqual({ ...d.lastConditionCheck, at: undefined }, { condition: 'NEW', at: undefined, source: 'delivery', assignmentCode: a1.assignmentCode });

  await sleep(20);
  await addTimelineEntry(a1.id, laptop.id, { field: 'condition', from: 'NEW', to: 'FAIR', assignmentCode: a1.assignmentCode, reason: 'return' });
  d = await getAsset(admin, laptop.id);
  assert.deepEqual({ ...d.lastConditionCheck, at: undefined }, { condition: 'FAIR', at: undefined, source: 'return', assignmentCode: a1.assignmentCode });

  await sleep(20);
  await addTimelineEntry(a1.id, laptop.id, { field: 'condition', from: 'FAIR', to: 'NEW', assignmentCode: a1.assignmentCode, reason: 'recount' });
  d = await getAsset(admin, laptop.id);
  assert.equal(d.lastConditionCheck.source, 'manual', 'an unknown reason is not a delivery / return');
  assert.equal(d.lastConditionCheck.condition, 'NEW');

  await sleep(20);
  await addTimelineEntry(a1.id, laptop.id, { field: 'condition', from: 'NEW', to: 'GOOD' }); // no reason, no assignmentCode
  d = await getAsset(admin, laptop.id);
  assert.deepEqual({ ...d.lastConditionCheck, at: undefined }, { condition: 'GOOD', at: undefined, source: 'manual', assignmentCode: null });

  // a newer entry that is not about the condition (a NOTE, an ASSIGNED snapshot) never counts
  await sleep(20);
  await addTimelineEntry(a1.id, laptop.id, { note: 'checked by IT', assignmentCode: a1.assignmentCode }, { eventType: 'NOTE' });
  assert.equal((await getAsset(admin, laptop.id)).lastConditionCheck.source, 'manual');
  assert.equal((await getAsset(admin, laptop.id)).lastConditionCheck.condition, 'GOOD');

  // 7 · a hand edit made after the newest entry wins over it …
  await sleep(20);
  assert.equal((await admin.req('PATCH', `/assets/${laptop.id}`, { body: { condition: 'DAMAGED' } })).status, 200);
  d = await getAsset(admin, laptop.id);
  assert.deepEqual({ ...d.lastConditionCheck, at: undefined }, { condition: 'DAMAGED', at: undefined, source: 'manual', assignmentCode: null });
  const damagedAt = d.lastConditionCheck.at;

  // … and a handover entry written after the hand edit wins over the edit
  await sleep(20);
  await addTimelineEntry(a1.id, laptop.id, { field: 'condition', from: 'DAMAGED', to: 'POOR', assignmentCode: a1.assignmentCode, reason: 'handover' });
  d = await getAsset(admin, laptop.id);
  assert.equal(d.lastConditionCheck.source, 'delivery');
  assert.equal(d.lastConditionCheck.condition, 'POOR');
  assert.ok(Date.parse(d.lastConditionCheck.at) > Date.parse(damagedAt));

  // 8 · disposing an asset that has history (soft delete) is a hand edit of the condition as well
  await sleep(20);
  const disposed = await admin.req('DELETE', `/assets/${laptop.id}`);
  assert.equal(disposed.status, 200, JSON.stringify(disposed.body));
  assert.equal(disposed.body.data.softDeleted, true);
  d = await getAsset(admin, laptop.id);
  assert.equal(d.condition, 'DISPOSED');
  assert.deepEqual({ ...d.lastConditionCheck, at: undefined }, { condition: 'DISPOSED', at: undefined, source: 'manual', assignmentCode: null });
});

/* ───────────────────────────── R5 — gallery vs photoHistory ───────────────────────────── */

test('photos = the asset gallery only; photoHistory = one block per assignment (newest first) with this asset\'s handover / return photos', async () => {
  const admin = await as('admin');
  const { ayse } = await world();
  const pc = await newAsset('Computers', 'pc');
  const monitor = await newAsset('Monitors', 'monitor');
  const lonely = await newAsset('Mouse', 'never assigned');

  // The asset's own inventory photo: POST /assets/:id/photos stays the gallery (no assignment)
  const up = await admin.req('POST', `/assets/${pc.id}/photos`, { form: pngForm('GENERAL') });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const galleryId = up.body.data[0].id;
  made.uploaded.push(galleryId);
  const row = await prisma.photo.findUnique({ where: { id: galleryId } });
  assert.equal(row.assetId, pc.id);
  assert.equal(row.assignmentId, null, 'an asset upload carries no assignment');
  assert.equal(row.context, 'HANDOVER'); // the column default; irrelevant for gallery photos

  // A0: no photos at all · A1: PC + monitor, with photos, returned · A2: the PC again, with photos, still active
  const a0 = await assign(ayse.id, pc);
  await giveBack(a0);
  await sleep(10);
  const a1 = await assign(ayse.id, pc, { accessories: [monitor] });
  const h = {
    pcFront: await addPhoto({ assignmentId: a1.id, assetId: pc.id, type: 'FRONT' }),
    whole: await addPhoto({ assignmentId: a1.id, assetId: null, type: 'BACK' }),
    monitor: await addPhoto({ assignmentId: a1.id, assetId: monitor.id, type: 'CONDITION' }),
  };
  const r = {
    whole: await addPhoto({ assignmentId: a1.id, assetId: null, context: 'RETURN', type: 'FRONT' }),
    pc: await addPhoto({ assignmentId: a1.id, assetId: pc.id, context: 'RETURN', type: 'BACK' }),
    monitor: await addPhoto({ assignmentId: a1.id, assetId: monitor.id, context: 'RETURN', type: 'GENERAL' }),
  };
  await giveBack(a1);
  await sleep(10);
  const a2 = await assign(ayse.id, pc);
  const h2 = { pcFront: await addPhoto({ assignmentId: a2.id, assetId: pc.id, type: 'FRONT' }), whole: await addPhoto({ assignmentId: a2.id, assetId: null, type: 'BACK' }) };
  // a photo that belongs to nothing at all (no asset, no assignment) must not show up anywhere
  await addPhoto({});

  const photoShape = (id, type) => ({ id, type, url: `/api/v1/photos/${id}/file` });
  const strip = (list) => list.map(({ id, type, url }) => ({ id, type, url }));
  const detail = await getAsset(admin, pc.id);

  // gallery only
  assert.deepEqual(detail.photos.map((p) => p.id), [galleryId], 'photos = the gallery; the assignment photos are not in it');
  assert.equal(detail.photos[0].url, `/api/v1/photos/${galleryId}/file`);
  assert.equal(detail._count.photos, 1, 'the gallery count');

  // photoHistory: newest assignment first, the empty A0 is left out
  assert.deepEqual(detail.photoHistory.map((b) => b.assignmentCode), [a2.assignmentCode, a1.assignmentCode]);
  const [b2, b1] = detail.photoHistory;
  assert.deepEqual(Object.keys(b1).sort(), ['assignedAt', 'assignmentCode', 'assignmentId', 'employeeName', 'handover', 'return', 'returnedAt', 'role', 'status']);
  for (const p of [...b1.handover, ...b1.return]) assert.deepEqual(Object.keys(p).sort(), ['createdAt', 'id', 'type', 'url']);

  assert.equal(b1.assignmentId, a1.id);
  assert.equal(b1.status, 'RETURNED');
  assert.equal(b1.employeeName, 'Ayse Celik');
  assert.equal(b1.role, 'PRIMARY');
  assert.ok(Date.parse(b1.assignedAt) > 0 && Date.parse(b1.returnedAt) >= Date.parse(b1.assignedAt));
  // PRIMARY: its own tagged photos + the whole-handover / whole-return ones; the monitor's are not here. Oldest first.
  assert.deepEqual(strip(b1.handover), [photoShape(h.pcFront, 'FRONT'), photoShape(h.whole, 'BACK')]);
  assert.deepEqual(strip(b1.return), [photoShape(r.whole, 'FRONT'), photoShape(r.pc, 'BACK')]);

  assert.equal(b2.assignmentId, a2.id);
  assert.equal(b2.status, 'ACTIVE');
  assert.equal(b2.returnedAt, null);
  assert.equal(b2.role, 'PRIMARY');
  assert.deepEqual(strip(b2.handover), [photoShape(h2.pcFront, 'FRONT'), photoShape(h2.whole, 'BACK')]);
  assert.deepEqual(b2.return, [], 'no return photo yet — the arrays are always there');

  // the accessory: only what is tagged with IT, and its role; no whole-handover photos (it is not the PRIMARY item)
  const mon = await getAsset(admin, monitor.id);
  assert.deepEqual(mon.photoHistory.map((b) => [b.assignmentCode, b.role]), [[a1.assignmentCode, 'BUNDLED']]);
  assert.deepEqual(strip(mon.photoHistory[0].handover), [photoShape(h.monitor, 'CONDITION')]);
  assert.deepEqual(strip(mon.photoHistory[0].return), [photoShape(r.monitor, 'GENERAL')]);
  assert.deepEqual(mon.photos, [], 'photos tagged to the monitor by an assignment are not its gallery');
  assert.equal(mon._count.photos, 0);

  // an asset that was never handed over: empty history, its gallery works as before
  const lone = await getAsset(admin, lonely.id);
  assert.deepEqual(lone.photoHistory, []);
  assert.deepEqual(lone.photos, []);

  // list endpoint: _count.photos = gallery count
  const listed = (await admin.req('GET', `/assets?q=${encodeURIComponent(pc.name)}&pageSize=10`)).body.data.find((a) => a.id === pc.id);
  assert.equal(listed._count.photos, 1);
  const listedMonitor = (await admin.req('GET', `/assets?q=${encodeURIComponent(monitor.name)}&pageSize=10`)).body.data.find((a) => a.id === monitor.id);
  assert.equal(listedMonitor._count.photos, 0);

  // the gallery file still streams, and a second gallery upload joins the gallery (not the history)
  const file = await fetch(`${BASE}${detail.photos[0].url}`, { headers: { Cookie: admin.cookieHeader() } });
  assert.equal(file.status, 200);
  const up2 = await admin.req('POST', `/assets/${pc.id}/photos`, { form: pngForm('FRONT') });
  assert.equal(up2.status, 201);
  made.uploaded.push(up2.body.data[0].id);
  const after2 = await getAsset(admin, pc.id);
  assert.deepEqual(after2.photos.map((p) => p.id), [galleryId, up2.body.data[0].id]);
  assert.equal(after2._count.photos, 2);
  assert.deepEqual(after2.photoHistory.map((b) => b.assignmentCode), [a2.assignmentCode, a1.assignmentCode], 'history unchanged');
});

test('photoHistory only lists the assignments the viewer may open (team leader: own room; call-centre manager: call-centre rooms)', async () => {
  const [admin, manager, tl1, ccm] = await Promise.all(['admin', 'manager', 'tl.tr1', 'mr.mahmoud'].map(as));
  const { ahmet, elif, room } = await world();
  // An asset that sits in TR1; first handed over to Elif (employee room TR2, no seat → a TR2 assignment), then to Ahmet (TR1).
  const pc = await newAsset('Computers', 'scoped pc', { roomId: room('TR1').id });
  const s1 = await assign(elif.id, pc);
  const p1 = await addPhoto({ assignmentId: s1.id, assetId: pc.id, type: 'FRONT' });
  await giveBack(s1);
  await sleep(10);
  const s2 = await assign(ahmet.id, pc);
  const p2 = await addPhoto({ assignmentId: s2.id, assetId: null, type: 'BACK' }); // whole handover, PRIMARY

  const history = async (client) => (await getAsset(client, pc.id)).photoHistory.map((b) => [b.assignmentCode, b.handover.map((p) => p.id)]);
  const both = [[s2.assignmentCode, [p2]], [s1.assignmentCode, [p1]]];
  assert.deepEqual(await history(admin), both);
  assert.deepEqual(await history(manager), both, 'MANAGER is unrestricted');
  assert.deepEqual(await history(ccm), both, 'both rooms are call-centre rooms');
  // the TR1 team leader sees the asset (it sits in TR1) but not its earlier hand-over to a TR2 employee
  assert.deepEqual(await history(tl1), [[s2.assignmentCode, [p2]]]);
  const raw = JSON.stringify((await getAsset(tl1, pc.id)).photoHistory);
  assert.ok(!raw.includes(p1) && !raw.includes('Elif'), 'nothing of the TR2 hand-over (photo, employee) leaks through photoHistory');
});
