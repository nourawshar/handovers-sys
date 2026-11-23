'use strict';
/**
 * Phase 9 — card BE-A2 (docs/PHASE_9_REQUESTS.md): P2 `sort` + `order` on GET /assets and GET /assignments, P5a the return
 * summary + the assigned date range on the assignments list, P5b GET /assets/:id/handover-history, and the asset
 * timeline source of a late return (`lastConditionCheck.source` 'return' for reason 'return-resolved').
 *
 * Integration tests against a RUNNING server (BASE_URL) on a throw-away, freshly seeded database — never the shared dev
 * server behind :4000 (refused):
 *
 *   createdb scratch_db
 *   DATABASE_URL='postgresql://postgres@localhost:5432/scratch_db?schema=public' npx prisma migrate deploy && npm run seed
 *   DATABASE_URL='…same…' LOGIN_RATE_LIMIT=1000 PORT=3001 node src/server.js &
 *   DATABASE_URL='…same…' BASE_URL=http://localhost:3001 node --test tests/phase9.assets.test.js
 *
 * Everything is created through the API with unique "P9A <RUN> …" names (every list is read through `q` / `employeeId`,
 * so suites running in parallel against the same server cannot disturb it), the final hook returns what is still handed
 * out, settles what is still owed and removes the photos / assets / employees it made. Three tests also write to the
 * database directly — the exact day boundaries of the date filter (the handover date is not settable through the API),
 * a legacy second ReturnRecord, rows that tie in every sort column — and need DATABASE_URL, the SAME scratch database the
 * server uses; without it they are skipped.
 *
 * String order is only asserted between values that differ in a plain letter at the same position (Alpha < Bravo < …,
 * the code prefixes CBL < COM < LAP), which every PostgreSQL collation (C, en_US, tr_TR) orders alike.
 *
 * Needs the standard seed: logins admin / manager / tl.tr1 / tl.tr2 / mr.mahmoud, rooms TR1 + TR2 (both call-centre
 * rooms), the "Call Center" department and the Phones / Charger Cables / Charger Adapters / Laptops / Computers categories.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.BASE_URL || '';
if (!BASE) throw new Error('phase9.assets.test.js needs BASE_URL (your own server, e.g. http://localhost:3001)');
if (new URL(BASE).port === '4000') throw new Error('refusing to run against :4000 (the shared dev server) — start your own server on another port');
const API = `${BASE}/api/v1`;
const NEEDS_DB = process.env.DATABASE_URL ? false : 'needs DATABASE_URL (the scratch database the server runs on)';

let dbClient;
/** Prisma on the scratch database — only for the tests that need DATABASE_URL (it is never loaded without it). */
function db() {
  dbClient ??= require('../src/db');
  return dbClient;
}

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

const RUN = Date.now().toString(36); // lowercase base-36: unique per run, identical in every fixture of the run
let seq = 0;
const uid = () => `${RUN}-${++seq}`;
const digits = (n) => `${Date.now()}${String(++seq).padStart(3, '0')}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`.slice(-n).padStart(n, '7');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111'; // a well-formed uuid that exists nowhere

const made = { assets: [], employees: [], active: new Set(), returned: new Set(), photos: [] };
const names = new Map(); // id → readable name, only so a failed assertion prints "Alpha, Bravo" instead of uuids
const nameOf = (rows) => rows.map((r) => names.get(r.id) ?? r.id);
const ids = (rows) => rows.map((r) => r.id);

let worldPromise;
/** Seeded lookups, by name (loaded once). */
function world() {
  worldPromise ??= (async () => {
    const admin = await as('admin');
    const cats = (await admin.req('GET', '/asset-categories')).body.flat;
    const rooms = (await admin.req('GET', '/rooms')).body.data;
    const deps = (await admin.req('GET', '/departments')).body.data;
    const pick = (list, key, what) => (name) => { const x = list.find((i) => i[key] === name); assert.ok(x, `seed ${what} ${name}`); return x; };
    return { cat: pick(cats, 'name', 'category'), room: pick(rooms, 'code', 'room'), dept: pick(deps, 'name', 'department'), adminId: (await admin.req('GET', '/auth/me')).body.user.id };
  })();
  return worldPromise;
}

const fx = {
  async employee(label, { room } = {}) {
    const admin = await as('admin');
    const w = await world();
    const r = await admin.req('POST', '/employees', { body: { fullName: `P9A ${RUN} ${label}`, departmentTeamId: w.dept('Call Center').id, ...(room && { roomId: w.room(room).id }) } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    made.employees.push(r.body.data.id);
    names.set(r.body.data.id, label);
    return r.body.data;
  },
  /** An asset of a seeded category (none of them has a required custom field); `name` is used as given. */
  async asset(category, name, extra = {}) {
    const admin = await as('admin');
    const w = await world();
    const r = await admin.req('POST', '/assets', { body: { categoryId: w.cat(category).id, name, serialNumber: `P9A-SN-${uid()}`, condition: 'GOOD', ...extra } });
    assert.equal(r.status, 201, `${name}: ${JSON.stringify(r.body)}`);
    made.assets.push(r.body.data.id);
    names.set(r.body.data.id, name.replace(`P9A ${RUN} `, ''));
    await sleep(5); // createdAt has millisecond resolution: keep "newest first" unambiguous
    return r.body.data;
  },
  /** A non-phone assignment (one asset); it stays ACTIVE until giveBack(). */
  async assign(employee, asset, { type = 'LAPTOP', condition = 'GOOD' } = {}) {
    const admin = await as('admin');
    const r = await admin.req('POST', '/assignments/generic', { body: { type, employeeId: employee.id, assetId: asset.id, conditionAtHandover: condition } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    made.active.add(r.body.data.id);
    names.set(r.body.data.id, employee.fullName.replace(`P9A ${RUN} `, ''));
    await sleep(5);
    return r.body.data;
  },
  /** The return, as the web form would send it (body = the POST /assignments/:id/return body). */
  async giveBack(assignment, body = { returnCondition: 'GOOD' }) {
    const admin = await as('admin');
    const r = await admin.req('POST', `/assignments/${assignment.id}/return`, { body });
    assert.equal(r.status, 200, `return ${assignment.assignmentCode}: ${JSON.stringify(r.body)}`);
    made.active.delete(assignment.id);
    made.returned.add(assignment.id);
    return r.body.data;
  },
  /** A phone assignment: the phone, a charger adapter (+ a charger cable); ACTIVE until giveBack(). */
  async phoneKit(employee, label, { cable = false } = {}) {
    const admin = await as('admin');
    const phone = await fx.asset('Phones', `P9A ${RUN} ${label} phone`, { phone: { imei: digits(15) } });
    const adapter = await fx.asset('Charger Adapters', `P9A ${RUN} ${label} adapter`);
    const cableAsset = cable ? await fx.asset('Charger Cables', `P9A ${RUN} ${label} cable`) : null;
    const r = await admin.req('POST', '/assignments/phone', {
      body: { employeeId: employee.id, phoneAssetId: phone.id, condition: 'GOOD', chargerAdapterAssetId: adapter.id, ...(cableAsset && { chargerCableAssetId: cableAsset.id }) },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    made.active.add(r.body.data.id);
    return { assignment: r.body.data, phone, adapter, cable: cableAsset };
  },
  /** Upload one image to the assignment (context HANDOVER | RETURN, optionally tagged with the asset it shows). */
  async photo(assignmentId, { type = 'GENERAL', context = 'HANDOVER', assetId } = {}) {
    const admin = await as('admin');
    const fd = new FormData();
    fd.append('type', type);
    fd.append('context', context);
    if (assetId) fd.append('assetId', assetId);
    fd.append('photos', new Blob([PNG], { type: 'image/png' }), 'p9a.png');
    const r = await admin.req('POST', `/assignments/${assignmentId}/photos`, { form: fd });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    made.photos.push(r.body.data[0].id);
    return r.body.data[0];
  },
  resolve: async (assignmentId, body) => (await as('admin')).req('POST', `/assignments/${assignmentId}/unreturned/resolve`, { body }),
};

after(async () => {
  const admin = await as('admin');
  for (const id of made.active) await admin.req('POST', `/assignments/${id}/return`, { body: { returnCondition: 'GOOD' } }); // 409 once returned — fine
  for (const id of [...made.active, ...made.returned]) {
    const owed = (await admin.req('GET', `/assignments/${id}/unreturned`)).body.data ?? [];
    for (const e of owed.filter((x) => x.status === 'OPEN')) await admin.req('POST', `/assignments/${id}/unreturned/resolve`, { body: { ...(e.assetId ? { assetId: e.assetId } : { accountId: e.accountId }), resolution: 'RETURNED' } });
  }
  for (const id of made.photos) await admin.req('DELETE', `/photos/${id}`); // row + file on disk
  for (const id of made.assets) await admin.req('DELETE', `/assets/${id}`); // hard delete, or soft-dispose once it has history
  for (const id of made.employees) await admin.req('DELETE', `/employees/${id}`); // soft-deleted (LEFT) once it has history
  if (dbClient) await dbClient.$disconnect();
});

/* ───────────────────────────── helpers ───────────────────────────── */

const qs = (params) => new URLSearchParams(params).toString();

/** GET a list endpoint and require 200. */
async function list(client, path, params = {}) {
  const r = await client.req('GET', `${path}?${qs(params)}`);
  assert.equal(r.status, 200, `GET ${path}?${qs(params)} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** The fixture rows, in this exact order, for `sort` / `order` (either may be left out = the endpoint's default). */
async function assertOrder(client, path, filters, { sort, order }, expected) {
  const { data } = await list(client, path, { ...filters, pageSize: 100, ...(sort && { sort }), ...(order && { order }) });
  assert.deepEqual(nameOf(data), nameOf(expected), `GET ${path} sort=${sort ?? '(default)'} order=${order ?? '(default)'}`);
}

/** Both directions of one key. */
async function assertBothWays(client, path, filters, sort, asc, desc) {
  await assertOrder(client, path, filters, { sort, order: 'asc' }, asc);
  await assertOrder(client, path, filters, { sort, order: 'desc' }, desc);
}

/**
 * Walk every page of a filtered, sorted list: no row may appear on two pages or be skipped, the pages must add up to the
 * one-page order, and a second walk must return exactly the same rows (equal sort values must not shuffle between calls).
 */
async function assertStablePaging(client, path, filters, pageSize, expectedCount) {
  const whole = (await list(client, path, { ...filters, pageSize: 100 })).data;
  assert.equal(whole.length, expectedCount, `${path} ${JSON.stringify(filters)}: size of the fixture set`);
  for (const attempt of [1, 2]) {
    const rows = [];
    let page = 1;
    let totalPages = 1;
    do {
      const body = await list(client, path, { ...filters, page, pageSize });
      assert.equal(body.meta.total, expectedCount);
      rows.push(...body.data);
      totalPages = body.meta.totalPages;
      page += 1;
    } while (page <= totalPages);
    assert.equal(new Set(ids(rows)).size, rows.length, `${path} ${JSON.stringify(filters)} pageSize=${pageSize} #${attempt}: a row is on two pages`);
    assert.deepEqual(nameOf(rows), nameOf(whole), `${path} ${JSON.stringify(filters)} pageSize=${pageSize} #${attempt}: the pages do not add up to the one-page order`);
  }
  return whole;
}

const SORT_ORDERS = ['asc', 'desc'];
const history = (client, assetId) => client.req('GET', `/assets/${assetId}/handover-history`);
async function historyOf(client, assetId) {
  const r = await history(client, assetId);
  assert.equal(r.status, 200, `GET /assets/${assetId}/handover-history → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}
async function getAsset(client, id) {
  const r = await client.req('GET', `/assets/${id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data;
}

/* ═════════════════════════════ P2 — GET /assets ═════════════════════════════ */

test('BE-A2 assets: sort + order on every key (asc/desc) — newest first by default, ties by code, then id', async () => {
  const admin = await as('admin');
  const prefix = `P9A ${RUN} asrt`;
  // Created in this order, so createdAt asc = Charlie, Delta, Bravo, Alpha. Laptops codes: Delta < Alpha (Delta is older).
  const Charlie = await fx.asset('Computers', `${prefix} Charlie`, { condition: 'POOR', status: 'DISPOSED' });
  const Delta = await fx.asset('Laptops', `${prefix} Delta`, { condition: 'FAIR', status: 'AVAILABLE' });
  const Bravo = await fx.asset('Charger Cables', `${prefix} Bravo`, { condition: 'NEW', status: 'AVAILABLE' });
  const Alpha = await fx.asset('Laptops', `${prefix} Alpha`, { condition: 'FAIR', status: 'IN_REPAIR' });
  const f = { q: prefix };
  assert.ok(Delta.code < Alpha.code && Bravo.code.startsWith('CBL-') && Charlie.code.startsWith('COM-') && Alpha.code.startsWith('LAP-'), 'the fixture codes are as the expectations assume');

  // No parameters at all = createdAt desc — the asset that was just added is the first row.
  await assertOrder(admin, '/assets', f, {}, [Alpha, Bravo, Delta, Charlie]);
  await assertBothWays(admin, '/assets', f, 'createdAt', [Charlie, Delta, Bravo, Alpha], [Alpha, Bravo, Delta, Charlie]);
  await assertBothWays(admin, '/assets', f, 'name', [Alpha, Bravo, Charlie, Delta], [Delta, Charlie, Bravo, Alpha]);
  await assertBothWays(admin, '/assets', f, 'code', [Bravo, Charlie, Delta, Alpha], [Alpha, Delta, Charlie, Bravo]); // CBL < COM < LAP
  // `category` sorts by the category NAME; the two Laptops tie and keep code order in BOTH directions (the documented tie-break).
  await assertBothWays(admin, '/assets', f, 'category', [Bravo, Charlie, Delta, Alpha], [Delta, Alpha, Charlie, Bravo]); // Charger Cables < Computers < Laptops
  // `condition` follows best → worst (NEW < GOOD < FAIR < POOR); the two FAIR ones tie → code order.
  await assertBothWays(admin, '/assets', f, 'condition', [Bravo, Delta, Alpha, Charlie], [Charlie, Delta, Alpha, Bravo]);
  // `status` follows the enum order (AVAILABLE < ASSIGNED < RETURNED < DISPOSED < IN_REPAIR); Bravo + Delta are both AVAILABLE → code order.
  await assertBothWays(admin, '/assets', f, 'status', [Bravo, Delta, Charlie, Alpha], [Alpha, Charlie, Bravo, Delta]);
  // `order` alone sorts the default key; `sort` alone takes the endpoint's default order (desc).
  await assertOrder(admin, '/assets', f, { order: 'asc' }, [Charlie, Delta, Bravo, Alpha]);
  await assertOrder(admin, '/assets', f, { sort: 'name' }, [Delta, Charlie, Bravo, Alpha]);
  // the pre-Phase-9 key still works (nothing that used it breaks), it is just not advertised
  await assertOrder(admin, '/assets', f, { sort: 'updatedAt', order: 'asc' }, [Charlie, Delta, Bravo, Alpha]);

  // the unfiltered list is newest first too (read robustly: other suites add assets while this one runs)
  const { data: all } = await list(admin, '/assets', { pageSize: 100 });
  for (let i = 1; i < all.length; i += 1) assert.ok(all[i - 1].createdAt >= all[i].createdAt, `unfiltered /assets is not newest first at row ${i}`);
});

test('BE-A2 assets: pages stay stable when the sort key has duplicates (name / condition / status / category all equal)', async () => {
  const admin = await as('admin');
  const prefix = `P9A ${RUN} apg`;
  const rows = [];
  for (let i = 0; i < 7; i += 1) rows.push(await fx.asset('Computers', `${prefix} same`, { condition: 'GOOD' }));
  for (const sort of ['name', 'condition', 'status', 'category', 'code', 'createdAt']) {
    for (const order of SORT_ORDERS) {
      for (const pageSize of [3, 1]) {
        const whole = await assertStablePaging(admin, '/assets', { q: prefix, sort, order }, pageSize, rows.length);
        const byCode = [...rows].sort((a, b) => (a.code < b.code ? -1 : 1)); // codes are zero-padded: plain string order = number order
        const expected = sort === 'code' || sort === 'createdAt' ? (order === 'asc' ? byCode : [...byCode].reverse()) : byCode; // equal keys → code asc, whatever the direction
        assert.deepEqual(ids(whole), ids(expected), `sort=${sort} order=${order}`);
      }
    }
  }
  // …and so does the default order, whatever the page size.
  await assertStablePaging(admin, '/assets', { q: prefix }, 2, rows.length);
});

test('BE-A2 assets: an unknown sort key / order → 400 VALIDATION_ERROR that lists the allowed keys; nothing else is reachable through `sort`', async () => {
  const admin = await as('admin');
  const KEYS = ['createdAt', 'code', 'name', 'condition', 'status', 'category'];
  for (const bad of ['bogus', 'password', 'phoneDetail', 'category.name', 'name,code', 'constructor', '__proto__', 'CODE', '']) {
    const r = await admin.req('GET', `/assets?${qs({ sort: bad })}`);
    assert.equal(r.status, 400, `sort=${JSON.stringify(bad)} → ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
    const issue = r.body.error.details.find((d) => d.path === 'sort');
    assert.ok(issue, `sort=${JSON.stringify(bad)}: the error points at "sort"`);
    for (const key of KEYS) assert.ok(issue.message.includes(key), `the message lists ${key}: ${issue.message}`);
    assert.ok(!issue.message.includes('updatedAt'), 'the legacy key is not advertised');
  }
  for (const bad of ['up', 'ASC', 'ascending', '']) {
    const r = await admin.req('GET', `/assets?${qs({ order: bad })}`);
    assert.equal(r.status, 400, `order=${JSON.stringify(bad)}`);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
    assert.ok(r.body.error.details.some((d) => d.path === 'order' && d.message.includes('asc') && d.message.includes('desc')));
  }
  assert.equal((await admin.req('GET', '/assets?sort=code&order=asc&pageSize=1')).status, 200);
  assert.equal((await anonymous().req('GET', '/assets?sort=code')).status, 401);
});

/* ═════════════════════════════ P2 — GET /assignments ═════════════════════════════ */

test('BE-A2 assignments: sort + order on every key (asc/desc) — newest first by default, ties newest first, then id', async () => {
  const admin = await as('admin');
  const prefix = `P9A ${RUN} gsrt`;
  const emp = {};
  for (const n of ['Charlie', 'Delta', 'Bravo', 'Alpha']) emp[n] = await fx.employee(`gsrt ${n}`);
  // Handed over in this order (assignedAt asc = code asc = Charlie, Delta, Bravo, Alpha); Charlie + Bravo are returned afterwards.
  const C = await fx.assign(emp.Charlie, await fx.asset('Computers', `${prefix} pc 1`), { type: 'LAPTOP' });
  const D = await fx.assign(emp.Delta, await fx.asset('Computers', `${prefix} pc 2`), { type: 'GENERAL' });
  const B = await fx.assign(emp.Bravo, await fx.asset('Computers', `${prefix} pc 3`), { type: 'LAPTOP' });
  const A = await fx.assign(emp.Alpha, await fx.asset('Computers', `${prefix} pc 4`), { type: 'COMPUTERS' });
  await fx.giveBack(C);
  await fx.giveBack(B);
  const f = { q: prefix };

  await assertOrder(admin, '/assignments', f, {}, [A, B, D, C]); // no parameters = assignedAt desc: the newest handover is the first row
  await assertBothWays(admin, '/assignments', f, 'assignedAt', [C, D, B, A], [A, B, D, C]);
  await assertBothWays(admin, '/assignments', f, 'assignmentCode', [C, D, B, A], [A, B, D, C]);
  await assertBothWays(admin, '/assignments', f, 'employee', [A, B, C, D], [D, C, B, A]); // by the employee's full name
  // `type` follows the enum order (LAPTOP < GENERAL < COMPUTERS); Charlie + Bravo are both LAPTOP → newest first (Bravo, Charlie) in BOTH directions.
  await assertBothWays(admin, '/assignments', f, 'type', [B, C, D, A], [A, D, B, C]);
  // `status` follows the enum order (ACTIVE < RETURNED): Delta + Alpha are ACTIVE, Charlie + Bravo RETURNED — each pair newest first.
  await assertBothWays(admin, '/assignments', f, 'status', [A, D, B, C], [B, C, A, D]);
  // `order` alone sorts the default key; `sort` alone takes the endpoint's default order (desc).
  await assertOrder(admin, '/assignments', f, { order: 'asc' }, [C, D, B, A]);
  await assertOrder(admin, '/assignments', f, { sort: 'employee' }, [D, C, B, A]);

  // the sort composes with the filters: a returned-only page sorted by employee
  await assertOrder(admin, '/assignments', { ...f, status: 'RETURNED' }, { sort: 'employee', order: 'asc' }, [B, C]);
  // …and with the team-leader scope (these employees have no room → invisible to a team leader, which stays an empty page)
  const tl = await as('tl.tr1');
  assert.deepEqual((await list(tl, '/assignments', { ...f, sort: 'employee' })).data, []);

  // the unfiltered list is newest first too, a DRAFT (no assignedAt) after the dated rows (read robustly: other suites add rows meanwhile)
  const { data: all } = await list(admin, '/assignments', { pageSize: 100 });
  for (let i = 1; i < all.length; i += 1) {
    const [p, c] = [all[i - 1].assignedAt, all[i].assignedAt];
    assert.ok(c === null || (p !== null && p >= c), `unfiltered /assignments is not newest first at row ${i}: ${p} then ${c}`);
  }
});

test('BE-A2 assignments: pages stay stable when the sort key has duplicates (employee / type / status all equal)', async () => {
  const admin = await as('admin');
  const prefix = `P9A ${RUN} gpg`;
  const emp = await fx.employee('gpg same');
  const rows = [];
  for (let i = 0; i < 7; i += 1) rows.push(await fx.assign(emp, await fx.asset('Computers', `${prefix} pc ${i}`), { type: 'LAPTOP' }));
  const newestFirst = [...rows].reverse();
  for (const sort of ['employee', 'type', 'status', 'assignedAt', 'assignmentCode']) {
    for (const order of SORT_ORDERS) {
      for (const pageSize of [3, 1]) {
        const whole = await assertStablePaging(admin, '/assignments', { employeeId: emp.id, sort, order }, pageSize, rows.length);
        // equal keys → newest first, whatever the direction; the date / code keys themselves are unique
        const expected = sort === 'assignedAt' || sort === 'assignmentCode' ? (order === 'asc' ? rows : newestFirst) : newestFirst;
        assert.deepEqual(ids(whole), ids(expected), `sort=${sort} order=${order}`);
      }
    }
  }
  await assertStablePaging(admin, '/assignments', { employeeId: emp.id }, 2, rows.length); // the default order too
});

test('BE-A2 assets + assignments: rows equal in EVERY sort column (one import transaction = one createdAt) page by id, in both directions', { skip: NEEDS_DB }, async () => {
  const admin = await as('admin');
  const same = new Date('2031-05-05T10:00:00.000Z');

  // five assets with the very same createdAt (what a bulk import writes) …
  const prefix = `P9A ${RUN} tie`;
  const assets = [];
  for (let i = 0; i < 5; i += 1) assets.push(await fx.asset('Computers', `${prefix} asset`));
  await db().asset.updateMany({ where: { id: { in: ids(assets) } }, data: { createdAt: same } });
  const byId = (rows) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const order of SORT_ORDERS) {
    for (const pageSize of [2, 1]) {
      const whole = await assertStablePaging(admin, '/assets', { q: prefix, sort: 'createdAt', order }, pageSize, assets.length);
      assert.deepEqual(ids(whole), ids(byId(assets)), `assets sort=createdAt order=${order}: equal rows end up in id order`);
    }
  }

  // … and five assignments with the very same assignedAt + createdAt, one employee, one type, one status
  const emp = await fx.employee('tie');
  const assignments = [];
  for (let i = 0; i < 5; i += 1) assignments.push(await fx.assign(emp, await fx.asset('Computers', `${prefix} pc ${i}`), { type: 'LAPTOP' }));
  await db().assignment.updateMany({ where: { id: { in: ids(assignments) } }, data: { assignedAt: same, createdAt: same } });
  for (const sort of ['assignedAt', 'employee', 'type', 'status']) {
    for (const order of SORT_ORDERS) {
      for (const pageSize of [2, 1]) {
        const whole = await assertStablePaging(admin, '/assignments', { employeeId: emp.id, sort, order }, pageSize, assignments.length);
        assert.deepEqual(ids(whole), ids(byId(assignments)), `assignments sort=${sort} order=${order}: equal rows end up in id order`);
      }
    }
  }
});

test('BE-A2 assignments: an unknown sort key / order / date → 400 VALIDATION_ERROR (allowed keys listed); no session → 401', async () => {
  const admin = await as('admin');
  const KEYS = ['assignedAt', 'assignmentCode', 'status', 'type', 'employee'];
  for (const bad of ['bogus', 'createdAt', 'employee.fullName', 'asset', 'returnedAt', 'constructor', '__proto__', '']) {
    const r = await admin.req('GET', `/assignments?${qs({ sort: bad })}`);
    assert.equal(r.status, 400, `sort=${JSON.stringify(bad)} → ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
    const issue = r.body.error.details.find((d) => d.path === 'sort');
    assert.ok(issue, `sort=${JSON.stringify(bad)}: the error points at "sort"`);
    for (const key of KEYS) assert.ok(issue.message.includes(key), `the message lists ${key}: ${issue.message}`);
  }
  for (const bad of ['up', 'DESC', '']) {
    const r = await admin.req('GET', `/assignments?${qs({ order: bad })}`);
    assert.equal(r.status, 400, `order=${JSON.stringify(bad)}`);
    assert.ok(r.body.error.details.some((d) => d.path === 'order' && d.message.includes('asc') && d.message.includes('desc')));
  }
  for (const [param, bad] of [['assignedFrom', 'nope'], ['assignedFrom', ''], ['assignedTo', '2026-13-45'], ['assignedTo', 'yesterday']]) {
    const r = await admin.req('GET', `/assignments?${qs({ [param]: bad })}`);
    assert.equal(r.status, 400, `${param}=${JSON.stringify(bad)} → ${r.status}`);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
    assert.ok(r.body.error.details.some((d) => d.path === param), `${param}: the error points at the parameter`);
  }
  assert.equal((await admin.req('GET', '/assignments?sort=employee&order=desc&pageSize=1')).status, 200);
  assert.equal((await anonymous().req('GET', '/assignments?sort=employee')).status, 401);
});

test('BE-A2 assignments: assignedFrom / assignedTo — inclusive bounds, a date-only `assignedTo` covers the whole day', async () => {
  const admin = await as('admin');
  const emp = await fx.employee('rng');
  const a1 = await fx.assign(emp, await fx.asset('Computers', `P9A ${RUN} rng pc 1`));
  await sleep(25);
  const a2 = await fx.assign(emp, await fx.asset('Computers', `P9A ${RUN} rng pc 2`));
  await sleep(25);
  const a3 = await fx.assign(emp, await fx.asset('Computers', `P9A ${RUN} rng pc 3`));
  assert.ok(a1.assignedAt < a2.assignedAt && a2.assignedAt < a3.assignedAt);
  const found = async (extra) => ids((await list(admin, '/assignments', { employeeId: emp.id, pageSize: 100, sort: 'assignedAt', order: 'asc', ...extra })).data);
  const all = [a1.id, a2.id, a3.id];
  const day = (iso) => iso.slice(0, 10);
  const shiftDay = (iso, days) => new Date(Date.parse(day(iso)) + days * 86400000).toISOString().slice(0, 10);

  assert.deepEqual(await found({}), all, 'no date filter: everything');
  // full timestamps are inclusive bounds at both ends
  assert.deepEqual(await found({ assignedFrom: a2.assignedAt }), [a2.id, a3.id]);
  assert.deepEqual(await found({ assignedTo: a2.assignedAt }), [a1.id, a2.id]);
  assert.deepEqual(await found({ assignedFrom: a2.assignedAt, assignedTo: a2.assignedAt }), [a2.id]);
  assert.deepEqual(await found({ assignedFrom: a3.assignedAt }), [a3.id]);
  assert.deepEqual(await found({ assignedTo: a1.assignedAt }), [a1.id]);
  // date-only: `from` starts at the beginning of the day, `to` runs through the END of its day (a handover at 14:23 is "on" that day)
  assert.deepEqual(await found({ assignedFrom: day(a1.assignedAt) }), all);
  assert.deepEqual(await found({ assignedTo: day(a3.assignedAt) }), all, 'assignedTo=<today> still contains today\'s handovers');
  assert.deepEqual(await found({ assignedFrom: day(a1.assignedAt), assignedTo: day(a3.assignedAt) }), all);
  assert.deepEqual(await found({ assignedFrom: shiftDay(a3.assignedAt, 1) }), [], 'from tomorrow: nothing');
  assert.deepEqual(await found({ assignedTo: shiftDay(a1.assignedAt, -1) }), [], 'through yesterday: nothing');
  assert.deepEqual(await found({ assignedFrom: shiftDay(a3.assignedAt, 1), assignedTo: shiftDay(a1.assignedAt, -1) }), [], 'from after to: empty, not an error');
  assert.deepEqual(await found({ assignedFrom: ` ${day(a1.assignedAt)} `, assignedTo: ` ${day(a3.assignedAt)} ` }), all, 'surrounding blanks are ignored');
  // …and they combine with the other filters and the sort
  assert.deepEqual(await found({ assignedFrom: a2.assignedAt, status: 'ACTIVE', order: 'desc' }), [a3.id, a2.id]);
  assert.deepEqual(await found({ assignedFrom: a2.assignedAt, status: 'RETURNED' }), []);
});

test('BE-A2 assignments: assignedFrom / assignedTo — the exact day boundaries (UTC) of a date-only filter, and of a timestamp', { skip: NEEDS_DB }, async () => {
  const admin = await as('admin');
  const emp = await fx.employee('bnd');
  const at = { before: '2031-03-09T23:59:59.999Z', start: '2031-03-10T00:00:00.000Z', end: '2031-03-10T23:59:59.999Z', after: '2031-03-11T00:00:00.000Z' };
  const row = {};
  for (const [key, when] of Object.entries(at)) {
    row[key] = await fx.assign(emp, await fx.asset('Computers', `P9A ${RUN} bnd pc ${key}`));
    await db().assignment.update({ where: { id: row[key].id }, data: { assignedAt: new Date(when) } }); // the handover date is not settable through the API
  }
  const found = async (extra) => ids((await list(admin, '/assignments', { employeeId: emp.id, pageSize: 100, sort: 'assignedAt', order: 'asc', ...extra })).data);
  const only = (...keys) => keys.map((k) => row[k].id);

  assert.deepEqual(await found({}), only('before', 'start', 'end', 'after'));
  assert.deepEqual(await found({ assignedFrom: '2031-03-10' }), only('start', 'end', 'after'));
  assert.deepEqual(await found({ assignedTo: '2031-03-10' }), only('before', 'start', 'end'), '23:59:59.999 of the day is still "through that day"; 00:00 of the next day is not');
  assert.deepEqual(await found({ assignedFrom: '2031-03-10', assignedTo: '2031-03-10' }), only('start', 'end'), 'one whole day');
  assert.deepEqual(await found({ assignedFrom: '2031-03-11', assignedTo: '2031-03-11' }), only('after'));
  assert.deepEqual(await found({ assignedTo: '2031-03-09' }), only('before'));
  // a full timestamp is an exact inclusive bound
  assert.deepEqual(await found({ assignedTo: at.end }), only('before', 'start', 'end'));
  assert.deepEqual(await found({ assignedTo: '2031-03-10T23:59:59.998Z' }), only('before', 'start'));
  assert.deepEqual(await found({ assignedFrom: at.start }), only('start', 'end', 'after'));
  assert.deepEqual(await found({ assignedFrom: '2031-03-10T00:00:00.001Z' }), only('end', 'after'));
  assert.deepEqual(await found({ assignedFrom: '2031-03-10T12:00:00Z', assignedTo: '2031-03-10T12:00:00Z' }), []);
});

/* ═════════════════════════════ P5a — returnRecord on the assignments list ═════════════════════════════ */

test('BE-A2 assignments list: `returnRecord` = { returnedAt, hasDiscrepancies, unreturnedOpen } for a returned assignment, null for an active one', async () => {
  const admin = await as('admin');
  const emp = await fx.employee('ret');
  const prefix = `P9A ${RUN} ret`;

  // 1. a phone returned WITHOUT its charger adapter → a discrepancy, one OPEN unreturned item
  const open = await fx.phoneKit(emp, 'ret open');
  const openRet = await fx.giveBack(open.assignment, { returnCondition: 'GOOD', return: { chargerAdapterAssetId: null } });
  // 2. adapter AND cable missing → two OPEN, settled one by one below
  const two = await fx.phoneKit(emp, 'ret two', { cable: true });
  const twoRet = await fx.giveBack(two.assignment, { returnCondition: 'GOOD', return: { chargerAdapterAssetId: null, chargerCableAssetId: null } });
  // 3. a laptop back in the condition it left in → nothing to report
  const clean = await fx.assign(emp, await fx.asset('Laptops', `${prefix} clean laptop`), { condition: 'GOOD' });
  const cleanRet = await fx.giveBack(clean, { returnCondition: 'GOOD' });
  // 4. a laptop back DAMAGED → a discrepancy (condition), but nothing owed
  const worse = await fx.assign(emp, await fx.asset('Laptops', `${prefix} worse laptop`), { condition: 'GOOD' });
  const worseRet = await fx.giveBack(worse, { returnCondition: 'DAMAGED' });
  // 5. still handed out
  const active = await fx.assign(emp, await fx.asset('Laptops', `${prefix} active laptop`));

  assert.equal(openRet.hasDiscrepancies, true);
  assert.equal(cleanRet.hasDiscrepancies, false);
  assert.equal(worseRet.hasDiscrepancies, true);
  const rows = async (client = admin, extra = {}) => Object.fromEntries((await list(client, '/assignments', { employeeId: emp.id, pageSize: 100, ...extra })).data.map((r) => [r.id, r]));

  let page = await rows();
  assert.equal(Object.keys(page).length, 5, 'one page with returned and active rows mixed');
  assert.deepEqual(page[open.assignment.id].returnRecord, { returnedAt: openRet.returnedAt, hasDiscrepancies: true, unreturnedOpen: 1 });
  assert.deepEqual(page[two.assignment.id].returnRecord, { returnedAt: twoRet.returnedAt, hasDiscrepancies: true, unreturnedOpen: 2 });
  assert.deepEqual(page[clean.id].returnRecord, { returnedAt: cleanRet.returnedAt, hasDiscrepancies: false, unreturnedOpen: 0 });
  assert.deepEqual(page[worse.id].returnRecord, { returnedAt: worseRet.returnedAt, hasDiscrepancies: true, unreturnedOpen: 0 });
  assert.equal(page[active.id].returnRecord, null, 'an active assignment has no return record');
  assert.deepEqual(Object.keys(page[open.assignment.id].returnRecord).sort(), ['hasDiscrepancies', 'returnedAt', 'unreturnedOpen']);
  assert.equal(typeof page[open.assignment.id].returnRecord.unreturnedOpen, 'number');
  for (const r of Object.values(page)) {
    assert.ok(!('returnRecords' in r), 'the raw relation does not leak into the row');
    assert.ok('returnRecord' in r, 'every row carries the key');
    for (const key of ['id', 'assignmentCode', 'type', 'status', 'employee', 'workIdentity', 'asset', 'assignedAt', 'expectedReturnAt', 'returnedAt']) assert.ok(key in r, `the row keeps ${key}`);
  }
  assert.equal(page[open.assignment.id].returnRecord.returnedAt, page[open.assignment.id].returnedAt, 'the same moment the assignment itself reports');

  // it agrees with the detail endpoints of the same assignment
  for (const [a, expected] of [[open.assignment.id, 1], [two.assignment.id, 2], [clean.id, 0]]) {
    const owed = (await admin.req('GET', `/assignments/${a}/unreturned`)).body.data;
    assert.equal(owed.filter((e) => e.status === 'OPEN').length, expected);
    assert.equal((await admin.req('GET', `/assignments/${a}/return-record`)).body.data.hasDiscrepancies, page[a].returnRecord.hasDiscrepancies);
  }
  assert.equal((await admin.req('GET', `/assignments/${active.id}/return-record`)).status, 404);

  // settling an item lowers the count (RESOLVED is not OPEN); the discrepancy of the return itself stays
  assert.equal((await fx.resolve(two.assignment.id, { assetId: two.adapter.id, resolution: 'RETURNED', condition: 'FAIR' })).status, 200);
  page = await rows();
  assert.deepEqual(page[two.assignment.id].returnRecord, { returnedAt: twoRet.returnedAt, hasDiscrepancies: true, unreturnedOpen: 1 });
  assert.equal((await fx.resolve(two.assignment.id, { assetId: two.cable.id, resolution: 'LOST' })).status, 200);
  page = await rows();
  assert.deepEqual(page[two.assignment.id].returnRecord, { returnedAt: twoRet.returnedAt, hasDiscrepancies: true, unreturnedOpen: 0 });
  assert.equal(page[open.assignment.id].returnRecord.unreturnedOpen, 1, 'the other assignments are untouched');

  // the summary follows the filters and every sort (the rows of a sorted page carry it just the same)
  const returned = await list(admin, '/assignments', { employeeId: emp.id, status: 'RETURNED', sort: 'assignmentCode', order: 'desc', pageSize: 100 });
  assert.equal(returned.data.length, 4);
  assert.ok(returned.data.every((r) => r.returnRecord && r.returnRecord.returnedAt === r.returnedAt));
  const activeOnly = await list(admin, '/assignments', { employeeId: emp.id, status: 'ACTIVE', sort: 'employee', pageSize: 100 });
  assert.deepEqual(activeOnly.data.map((r) => [r.id, r.returnRecord]), [[active.id, null]]);

  // a team leader sees the summary of the rows of their own room only; the same numbers as the admin's
  const emp1 = await fx.employee('ret tr1', { room: 'TR1' });
  const tlKit = await fx.phoneKit(emp1, 'ret tr1');
  const tlRet = await fx.giveBack(tlKit.assignment, { returnCondition: 'GOOD', return: { chargerAdapterAssetId: null } });
  const tl1 = await as('tl.tr1');
  const tl2 = await as('tl.tr2');
  assert.deepEqual((await rows(tl1, { employeeId: emp1.id }))[tlKit.assignment.id].returnRecord, { returnedAt: tlRet.returnedAt, hasDiscrepancies: true, unreturnedOpen: 1 });
  assert.deepEqual(Object.keys(await rows(tl2, { employeeId: emp1.id })), [], 'another room: not listed');
  assert.deepEqual(Object.keys(await rows(tl1)), [], 'the first employee has no room: not listed for a team leader');
});

test('BE-A2 assignments list: the summary reads the LATEST ReturnRecord (a legacy second record decides)', { skip: NEEDS_DB }, async () => {
  const admin = await as('admin');
  const w = await world();
  const emp = await fx.employee('latest');
  const a = await fx.assign(emp, await fx.asset('Laptops', `P9A ${RUN} latest laptop`), { condition: 'GOOD' });
  const ret = await fx.giveBack(a, { returnCondition: 'DAMAGED', returnNotes: 'first return' });
  assert.equal(ret.hasDiscrepancies, true);
  const listed = async () => (await list(admin, '/assignments', { employeeId: emp.id })).data.find((r) => r.id === a.id).returnRecord;
  assert.deepEqual(await listed(), { returnedAt: ret.returnedAt, hasDiscrepancies: true, unreturnedOpen: 0 });

  // a newer record whose comparison shows no discrepancy (an old data shape — a return is claimed atomically today)
  const later = await db().returnRecord.create({
    data: {
      assignmentId: a.id, returnedAt: new Date(Date.parse(ret.returnedAt) + 60_000), returnedById: w.adminId, returnCondition: 'GOOD', returnNotes: 'second record',
      comparisonFields: { create: [{ fieldKey: 'condition', label: 'Phone condition', valueAtHandover: '"GOOD"', valueAtReturn: '"GOOD"', isDiscrepancy: false, severity: 'INFO' }] },
    },
  });
  try {
    assert.deepEqual(await listed(), { returnedAt: later.returnedAt.toISOString(), hasDiscrepancies: false, unreturnedOpen: 0 }, 'newest record, its comparison fields');
    const h = await historyOf(admin, a.assetId);
    assert.equal(h.rows[0].returnNotes, 'second record', 'handover-history reads the latest record too');
    assert.equal(h.rows[0].discrepancyCount, 0);
  } finally {
    await db().returnRecord.delete({ where: { id: later.id } }); // its comparison fields go with it
  }
  assert.deepEqual(await listed(), { returnedAt: ret.returnedAt, hasDiscrepancies: true, unreturnedOpen: 0 });
  assert.equal((await historyOf(admin, a.assetId)).rows[0].returnNotes, 'first return');
});

/* ═════════════════════════════ P5b — GET /assets/:id/handover-history ═════════════════════════════ */

const ROW_KEYS = ['assignedAt', 'assignmentCode', 'assignmentId', 'change', 'conditionAtHandover', 'discrepancyCount', 'employee', 'photoCount', 'returnCondition', 'returnNotes', 'returnedAt', 'role', 'status', 'unreturnedOpen'];
/** The row the doc describes for `assignment` (a create response), with what differs from a plain returned PRIMARY item. */
const row = (assignment, employee, over = {}) => ({
  assignmentId: assignment.id,
  assignmentCode: assignment.assignmentCode,
  status: 'RETURNED',
  role: 'PRIMARY',
  employee: { id: employee.id, fullName: employee.fullName },
  assignedAt: assignment.assignedAt,
  returnedAt: null,
  conditionAtHandover: 'GOOD',
  returnCondition: null,
  change: 'unknown',
  returnNotes: null,
  discrepancyCount: 0,
  unreturnedOpen: false,
  photoCount: 0,
  ...over,
});

test('handover-history: two deliveries / returns (GOOD → DAMAGED, then FAIR → GOOD) → newest first, change worse then better, notes, discrepancies, photos', async () => {
  const admin = await as('admin');
  const e1 = await fx.employee('hh e1');
  const e2 = await fx.employee('hh e2');
  const laptop = await fx.asset('Laptops', `P9A ${RUN} hh laptop`, { condition: 'GOOD' });

  const a1 = await fx.assign(e1, laptop, { condition: 'GOOD' });
  await fx.photo(a1.id, { assetId: laptop.id, type: 'FRONT' }); // this asset's own photo
  await fx.photo(a1.id, { type: 'BACK' }); // the whole handover: counts for the PRIMARY item
  const r1 = await fx.giveBack(a1, { returnCondition: 'DAMAGED', returnNotes: 'cracked screen' });
  await sleep(10);
  const a2 = await fx.assign(e2, laptop, { condition: 'FAIR' }); // the DAMAGED laptop is handed over as FAIR (the condition is written back)
  const r2 = await fx.giveBack(a2, { returnCondition: 'GOOD' });

  const h = await historyOf(admin, laptop.id);
  assert.deepEqual(Object.keys(h).sort(), ['asset', 'current', 'rows']);
  assert.deepEqual(h.asset, { id: laptop.id, code: laptop.code, name: laptop.name, condition: 'GOOD' });
  assert.deepEqual(Object.keys(h.current).sort(), ['assignmentCode', 'at', 'condition', 'source']);
  assert.deepEqual({ ...h.current, at: undefined }, { condition: 'GOOD', at: undefined, source: 'return', assignmentCode: a2.assignmentCode });
  assert.deepEqual(h.current, (await getAsset(admin, laptop.id)).lastConditionCheck, '`current` is the detail page\'s lastConditionCheck');

  assert.deepEqual(h.rows.map((r) => r.assignmentCode), [a2.assignmentCode, a1.assignmentCode], 'newest first');
  for (const r of h.rows) assert.deepEqual(Object.keys(r).sort(), ROW_KEYS, 'exactly the fields of the doc');
  assert.deepEqual(h.rows[0], row(a2, e2, { returnedAt: r2.returnedAt, conditionAtHandover: 'FAIR', returnCondition: 'GOOD', change: 'better' }));
  assert.deepEqual(h.rows[1], row(a1, e1, { returnedAt: r1.returnedAt, conditionAtHandover: 'GOOD', returnCondition: 'DAMAGED', change: 'worse', returnNotes: 'cracked screen', discrepancyCount: 1, photoCount: 2 }));

  // a third handover, still out: no return condition yet → unknown, nothing returned
  const a3 = await fx.assign(e1, laptop, { condition: 'GOOD' });
  const h3 = await historyOf(admin, laptop.id);
  assert.deepEqual(h3.rows.map((r) => r.assignmentCode), [a3.assignmentCode, a2.assignmentCode, a1.assignmentCode]);
  assert.deepEqual(h3.rows[0], row(a3, e1, { status: 'ACTIVE', conditionAtHandover: 'GOOD' }));
  assert.equal(h3.asset.condition, 'GOOD');
  assert.equal(h3.current.source, 'return', 'no condition change at the third handover (GOOD → GOOD)');

  // the same condition back → 'same'
  const r3 = await fx.giveBack(a3, { returnCondition: 'GOOD' });
  const h4 = await historyOf(admin, laptop.id);
  assert.deepEqual(h4.rows[0], row(a3, e1, { returnedAt: r3.returnedAt, conditionAtHandover: 'GOOD', returnCondition: 'GOOD', change: 'same' }));

  // the existing detail endpoint still answers (not shadowed by the new route) and the new route is not shadowed by it
  assert.equal((await getAsset(admin, laptop.id)).id, laptop.id);
});

test('handover-history: an asset that was never assigned → rows []; unknown asset 404, malformed id 400, no session 401; every read role may ask', async () => {
  const admin = await as('admin');
  const w = await world();
  const fresh = await fx.asset('Computers', `P9A ${RUN} hh fresh`, { condition: 'FAIR', roomId: w.room('TR1').id });
  const h = await historyOf(admin, fresh.id);
  assert.deepEqual(h.rows, []);
  assert.deepEqual(h.asset, { id: fresh.id, code: fresh.code, name: fresh.name, condition: 'FAIR' });
  assert.deepEqual({ ...h.current, at: undefined }, { condition: 'FAIR', at: undefined, source: 'created', assignmentCode: null });
  assert.equal(h.current.at, (await getAsset(admin, fresh.id)).createdAt);

  for (const user of ['manager', 'mr.mahmoud', 'tl.tr1']) assert.deepEqual((await historyOf(await as(user), fresh.id)).rows, [], `${user} may read it (the asset sits in TR1)`);
  const missing = await history(admin, UNKNOWN_ID);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
  const malformed = await history(admin, 'not-a-uuid');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');
  assert.equal((await history(anonymous(), fresh.id)).status, 401);
});

test('handover-history: room scope = photoHistory\'s — the asset gate of the detail, then only the assignments the viewer may open (TL own room, CCM call-centre rooms)', async () => {
  const [admin, manager, tl1, tl2, ccm] = await Promise.all(['admin', 'manager', 'tl.tr1', 'tl.tr2', 'mr.mahmoud'].map(as));
  const w = await world();
  const inTR1 = await fx.employee('hh scope tr1', { room: 'TR1' });
  const inTR2 = await fx.employee('hh scope tr2', { room: 'TR2' });
  // An asset that sits in TR1; handed over to a TR2 employee (a TR2 assignment), then to a TR1 employee, then again to the TR2 employee.
  const pc = await fx.asset('Computers', `P9A ${RUN} hh scoped pc`, { roomId: w.room('TR1').id });
  const s1 = await fx.assign(inTR2, pc);
  await fx.giveBack(s1);
  const s2 = await fx.assign(inTR1, pc);
  await fx.giveBack(s2);
  const s3 = await fx.assign(inTR2, pc); // still out: the asset is now held by a TR2 employee
  const codes = async (client) => (await historyOf(client, pc.id)).rows.map((r) => r.assignmentCode);

  assert.deepEqual(await codes(admin), [s3.assignmentCode, s2.assignmentCode, s1.assignmentCode]);
  assert.deepEqual(await codes(manager), [s3.assignmentCode, s2.assignmentCode, s1.assignmentCode], 'MANAGER is unrestricted');
  assert.deepEqual(await codes(ccm), [s3.assignmentCode, s2.assignmentCode, s1.assignmentCode], 'both rooms are call-centre rooms');
  // the TR1 team leader: the asset is theirs (it sits in TR1), the two TR2 hand-overs are not
  assert.deepEqual(await codes(tl1), [s2.assignmentCode]);
  // the TR2 team leader: the asset is held by a TR2 employee right now; the TR1 hand-over is not theirs
  assert.deepEqual(await codes(tl2), [s3.assignmentCode, s1.assignmentCode]);
  const raw = JSON.stringify((await history(tl1, pc.id)).body);
  assert.ok(!raw.includes(inTR2.fullName) && !raw.includes(s1.assignmentCode) && !raw.includes(s3.assignmentCode), 'nothing of the TR2 hand-overs leaks to the TR1 team leader');
  assert.ok(!JSON.stringify((await history(tl2, pc.id)).body).includes(inTR1.fullName), 'nor of the TR1 hand-over to the TR2 team leader');
  // `current` (the asset's own condition record) is not an assignment row: it is the same for everybody who may see the asset
  assert.deepEqual((await historyOf(tl1, pc.id)).current, (await historyOf(admin, pc.id)).current);

  // once the TR2 employee gives it back nobody of TR2 holds it: the TR2 team leader loses the asset itself — 404, never 403 (the detail's rule)
  await fx.giveBack(s3);
  assert.equal((await history(tl2, pc.id)).status, 404);
  assert.equal((await tl2.req('GET', `/assets/${pc.id}`)).status, 404, 'the same answer the detail gives');
  assert.deepEqual(await codes(tl1), [s2.assignmentCode]);
});

test('handover-history: an item still owed (OPEN) and one that came back late — unreturnedOpen, the late condition, and lastConditionCheck.source "return" for reason return-resolved', async () => {
  const admin = await as('admin');
  const emp = await fx.employee('hh late');
  const kit = await fx.phoneKit(emp, 'hh late', { cable: true });
  const ret = await fx.giveBack(kit.assignment, {
    returnCondition: 'GOOD',
    itemConditions: [{ assetId: kit.cable.id, condition: 'FAIR' }],
    return: { chargerAdapterAssetId: null }, // the adapter is not handed back; the cable is, a little worse for wear
  });
  const code = kit.assignment.assignmentCode;
  const phoneRow = (await historyOf(admin, kit.phone.id)).rows;
  const cableRow = (await historyOf(admin, kit.cable.id)).rows;
  const adapter = () => historyOf(admin, kit.adapter.id);

  // the phone came back as it left: its row has the assignment's discrepancy (the missing adapter) but nothing owed
  assert.deepEqual(phoneRow, [row(kit.assignment, emp, { returnedAt: ret.returnedAt, returnCondition: 'GOOD', change: 'same', discrepancyCount: 1 })]);
  // the cable: a non-primary item with its own return condition → worse
  assert.deepEqual(cableRow, [row(kit.assignment, emp, { role: 'CHARGER_CABLE', returnedAt: ret.returnedAt, returnCondition: 'FAIR', change: 'worse', discrepancyCount: 1 })]);

  // the adapter: still owed → no return condition, unreturnedOpen
  let h = await adapter();
  assert.deepEqual(h.rows, [row(kit.assignment, emp, { role: 'CHARGER_ADAPTER', returnedAt: ret.returnedAt, unreturnedOpen: true, discrepancyCount: 1 })]);
  assert.equal(h.rows[0].change, 'unknown');
  assert.equal(h.asset.condition, 'GOOD');
  assert.equal(h.current.source, 'created');

  // it turns up, DAMAGED: no longer owed, and the late condition is its return condition (AssignmentItem keeps none)
  const resolved = await fx.resolve(kit.assignment.id, { assetId: kit.adapter.id, resolution: 'RETURNED', condition: 'DAMAGED', notes: 'found in a drawer' });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  h = await adapter();
  assert.deepEqual(h.rows, [row(kit.assignment, emp, { role: 'CHARGER_ADAPTER', returnedAt: ret.returnedAt, returnCondition: 'DAMAGED', change: 'worse', discrepancyCount: 1 })]);
  assert.equal(h.asset.condition, 'DAMAGED');
  // …and the asset page says it came back at THIS assignment, not that somebody edited it by hand
  assert.deepEqual({ ...h.current, at: undefined }, { condition: 'DAMAGED', at: undefined, source: 'return', assignmentCode: code });
  const detail = await getAsset(admin, kit.adapter.id);
  assert.equal(detail.lastConditionCheck.source, 'return', 'reason "return-resolved" is a return, not "manual"');
  assert.equal(detail.lastConditionCheck.assignmentCode, code);
  assert.equal(detail.lastConditionCheck.condition, 'DAMAGED');
  assert.deepEqual(h.current, detail.lastConditionCheck);

  // lost for good: still no return condition, no longer owed
  const lostKit = await fx.phoneKit(emp, 'hh lost');
  await fx.giveBack(lostKit.assignment, { returnCondition: 'GOOD', return: { chargerAdapterAssetId: null } });
  assert.equal((await historyOf(admin, lostKit.adapter.id)).rows[0].unreturnedOpen, true);
  assert.equal((await fx.resolve(lostKit.assignment.id, { assetId: lostKit.adapter.id, resolution: 'LOST', notes: 'gone' })).status, 200);
  const lost = (await historyOf(admin, lostKit.adapter.id)).rows[0];
  assert.deepEqual([lost.unreturnedOpen, lost.returnCondition, lost.change], [false, null, 'unknown']);
});

test('handover-history: photoCount = the assignment\'s photos tagged with this asset, plus the whole-handover ones for the PRIMARY item (photoHistory\'s rule), handover + return alike', async () => {
  const admin = await as('admin');
  const emp = await fx.employee('hh photos');
  const kit = await fx.phoneKit(emp, 'hh photos', { cable: true });
  await fx.photo(kit.assignment.id, { assetId: kit.phone.id, type: 'FRONT' }); // phone
  await fx.photo(kit.assignment.id, { type: 'BACK' }); // whole handover
  await fx.photo(kit.assignment.id, { type: 'GENERAL' }); // whole handover
  await fx.photo(kit.assignment.id, { assetId: kit.adapter.id, type: 'CONDITION' }); // adapter
  await fx.giveBack(kit.assignment, { returnCondition: 'GOOD' });
  await fx.photo(kit.assignment.id, { assetId: kit.adapter.id, context: 'RETURN', type: 'CONDITION' }); // adapter, at return
  await fx.photo(kit.assignment.id, { context: 'RETURN', type: 'GENERAL' }); // whole return

  const count = async (asset) => (await historyOf(admin, asset.id)).rows[0].photoCount;
  assert.equal(await count(kit.phone), 1 + 2 + 1, 'PRIMARY: its own photo + the two whole-handover ones + the whole-return one');
  assert.equal(await count(kit.adapter), 2, 'a non-primary item: only the photos tagged with it (handover + return)');
  assert.equal(await count(kit.cable), 0, 'a photo of another item is not this asset\'s');
  // agrees with photoHistory of the same asset
  const photoHistory = (await getAsset(admin, kit.adapter.id)).photoHistory;
  assert.equal(photoHistory[0].handover.length + photoHistory[0].return.length, 2);
});
