'use strict';
/**
 * Phase 9 — card BE-A1 (docs/PHASE_9_REQUESTS.md, P2 backend + P4 backend): `sort` + `order` and the extra filters on
 * GET /accounts, /employees, /users and /audit-logs.
 *
 * Talks to a RUNNING server over HTTP only (BASE_URL). Point it at your own server + scratch database, never at the dev
 * server behind :4000: it creates employees, accounts and users (users cannot be deleted — they are deactivated):
 *
 *   createdb scratch_db
 *   DATABASE_URL='postgresql://postgres@localhost:5432/scratch_db?schema=public' npx prisma migrate deploy && npm run seed
 *   DATABASE_URL='…same…' LOGIN_RATE_LIMIT=1000 PORT=3001 node src/server.js &
 *   BASE_URL=http://localhost:3001 node --test tests/phase9.sort.test.js
 *
 * Isolation: every fixture carries this run's tag (`p9s-<RUN>-…` / `P9S <RUN> …`) and every list is read through `q`
 * (the audit trail through a fixture actor), so suites running in parallel against the same server cannot disturb it.
 * String order is only asserted between values that differ in a plain letter at the same position (Alpha < Bravo < …),
 * which every PostgreSQL collation (C, en_US, tr_TR) orders alike.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.BASE_URL || '';
if (!BASE) throw new Error('phase9.sort.test.js needs BASE_URL (your own server, e.g. http://localhost:3001)');
if (new URL(BASE).port === '4000') throw new Error('refusing to run against :4000 (the shared dev server) — start your own server on another port');

/* ───────────────────────────── tiny API client ───────────────────────────── */

const PW = { admin: 'Admin#12345', manager: 'Manager#12345', 'tl.tr1': 'Leader#12345', 'mr.mahmoud': 'Mahmoud#12345' };

class Client {
  constructor() { this.cookies = {}; }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, path, { body } = {}) {
    const headers = { Cookie: this.cookieHeader() };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
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

/* ───────────────────────────── fixtures + helpers ───────────────────────────── */

const RUN = Date.now().toString(36); // lowercase base-36: unique per run, identical in every fixture of the run
const PASSWORD = 'P9sFixture#12345';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;

const made = { accounts: [], employees: [], users: [], assets: [], assignments: [] };
const names = new Map(); // id → readable name, only so a failed assertion prints "Alpha, Bravo" instead of uuids
const nameOf = (rows) => rows.map((r) => names.get(r.id) ?? r.id);
const ids = (rows) => rows.map((r) => r.id);

let worldPromise;
/** Seeded reference data: rooms TR1/TR2, the departments Call Center / Banko / Muhasebe and the admin's own id. */
function world() {
  worldPromise ??= (async () => {
    const admin = await as('admin');
    const rooms = (await admin.req('GET', '/rooms')).body.data;
    const depts = (await admin.req('GET', '/departments')).body.data;
    const pick = (rows, key, what) => (value) => { const r = rows.find((x) => x[key] === value); assert.ok(r, `seed ${what} ${value}`); return r; };
    return { room: pick(rooms, 'code', 'room'), dept: pick(depts, 'name', 'department'), adminId: (await admin.req('GET', '/auth/me')).body.user.id };
  })();
  return worldPromise;
}

async function create(path, body, bucket, name, client) {
  const r = await (client ?? (await as('admin'))).req('POST', path, { body });
  assert.equal(r.status, 201, `POST ${path} (${name}): ${JSON.stringify(r.body)}`);
  bucket.push(r.body.data.id);
  names.set(r.body.data.id, name);
  await sleep(4); // createdAt has millisecond resolution: keep "newest first" unambiguous
  return r.body.data;
}
const newAccount = (name, fields, client) => create('/accounts', { password: PASSWORD, ...fields }, made.accounts, name, client);
const newEmployee = (scope, name, departmentTeamId, roomId, label = name) => create('/employees', { fullName: `P9S ${RUN} ${scope} ${name}`, departmentTeamId, ...(roomId && { roomId }) }, made.employees, label);
const newUser = (scope, name, role, fullName, extra = {}) => create('/users', { username: `p9s-${RUN}-${scope}-${name.toLowerCase()}`, password: PASSWORD, fullName, role, ...extra }, made.users, name);

let actorPromise;
/** A second ADMIN of our own, whose full name sorts before every seeded one ("AAA …") — the second actor of the audit trail. */
function actor() {
  actorPromise ??= (async () => {
    const username = `p9s-${RUN}-actor`;
    const user = await create('/users', { username, password: PASSWORD, fullName: `AAA P9S ${RUN}`, role: 'ADMIN' }, made.users, 'actor');
    PW[username] = PASSWORD;
    return { id: user.id, client: await as(username) };
  })();
  return actorPromise;
}

after(async () => {
  const admin = await as('admin');
  for (const id of made.assignments) await admin.req('POST', `/assignments/${id}/return`, { body: { returnCondition: 'GOOD' } }); // 409 once returned — fine
  for (const id of made.accounts) await admin.req('DELETE', `/accounts/${id}`);
  for (const id of made.employees) await admin.req('DELETE', `/employees/${id}`); // soft-deleted (LEFT) once it has history
  for (const id of made.assets) await admin.req('DELETE', `/assets/${id}`);
  for (const id of made.users) await admin.req('PATCH', `/users/${id}`, { body: { isActive: false } }); // users cannot be deleted
});

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

/** Both directions of one key: `asc` as given, `desc` expected to be `descExpected`. */
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

/* ───────────────────────────── GET /accounts ───────────────────────────── */

test('BE-A1 accounts: sort + order on every key (asc/desc), newest first by default', async () => {
  const admin = await as('admin');
  const prefix = `p9s-${RUN}-srt-`;
  const email = (n) => `${prefix}${n}@p9s.test`;
  // Created in this shuffled order, so createdAt asc = B, C, A.
  const B = await newAccount('B bravo', { kind: 'BITRIX', identifier: `${prefix}bravo`, email: email('bravo'), isActive: false });
  const C = await newAccount('C charlie', { kind: 'OTHER', identifier: `${prefix}charlie` }); // no email
  const A = await newAccount('A alpha', { kind: 'GMAIL', identifier: `${prefix}alpha`, email: email('alpha') });
  const f = { q: prefix };

  // No parameters at all = createdAt desc — the account that was just added is the first row.
  await assertOrder(admin, '/accounts', f, {}, [A, C, B]);
  await assertBothWays(admin, '/accounts', f, 'createdAt', [B, C, A], [A, C, B]);
  await assertBothWays(admin, '/accounts', f, 'identifier', [A, B, C], [C, B, A]);
  await assertBothWays(admin, '/accounts', f, 'kind', [A, B, C], [C, B, A]); // enum order GMAIL < WHATSAPP < BITRIX < OTHER
  await assertBothWays(admin, '/accounts', f, 'email', [A, B, C], [B, A, C]); // accounts without an email sort last, both ways
  await assertBothWays(admin, '/accounts', f, 'isActive', [B, A, C], [A, C, B]); // false < true; ties by kind (A GMAIL, C OTHER)
  // `order` alone sorts the default key; `sort` alone takes the endpoint's default order (desc for accounts).
  await assertOrder(admin, '/accounts', f, { order: 'asc' }, [B, C, A]);
  await assertOrder(admin, '/accounts', f, { sort: 'identifier' }, [C, B, A]);

  // First of asc is last of desc (unique keys), and the unfiltered list is newest first too.
  const { data: all, meta } = await list(admin, '/accounts', { pageSize: 100 });
  for (let i = 1; i < all.length; i += 1) assert.ok(all[i - 1].createdAt >= all[i].createdAt, `unfiltered /accounts is not newest first at row ${i}`);
  if (meta.total <= 100) {
    const pos = (x) => all.findIndex((r) => r.id === x.id);
    assert.ok(pos(A) >= 0 && pos(A) < pos(C) && pos(C) < pos(B), 'the newest fixture account comes first in the unfiltered list');
  }
});

test('BE-A1 accounts: pages stay stable when the sort key has duplicates (kind / isActive all equal)', async () => {
  const admin = await as('admin');
  const prefix = `p9s-${RUN}-pga-`;
  const rows = [];
  for (const n of [4, 1, 6, 2, 7, 3, 5]) rows.push(await newAccount(`pg-${n}`, { kind: 'OTHER', identifier: `${prefix}${n}` }));
  const byIdentifier = [...rows].sort((a, b) => (a.identifier < b.identifier ? -1 : 1));
  for (const sort of ['kind', 'isActive']) {
    for (const order of ['asc', 'desc']) {
      for (const pageSize of [3, 1]) {
        const whole = await assertStablePaging(admin, '/accounts', { q: prefix, sort, order }, pageSize, rows.length);
        // Documented tie-break inside equal values: kind, then identifier (both directions), then id.
        assert.deepEqual(nameOf(whole), nameOf(byIdentifier), `sort=${sort} order=${order}`);
      }
    }
  }
  // …and so does the default order, whatever the page size.
  await assertStablePaging(admin, '/accounts', { q: prefix }, 2, rows.length);
});

test('BE-A1 accounts: kind / isActive / isWhatsAppBackup / inUse filters; kind=GMAIL&isActive=true feeds the wizard regardless of isWhatsAppBackup (P4)', async () => {
  const admin = await as('admin');
  const prefix = `p9s-${RUN}-flt-`;
  const email = (n) => `${prefix}${n}@p9s.test`;
  const G1 = await newAccount('G1 backup gmail', { kind: 'GMAIL', identifier: `${prefix}g1`, email: email('g1'), isWhatsAppBackup: true });
  const G2 = await newAccount('G2 plain gmail', { kind: 'GMAIL', identifier: `${prefix}g2`, email: email('g2'), isWhatsAppBackup: false });
  const G3 = await newAccount('G3 inactive gmail', { kind: 'GMAIL', identifier: `${prefix}g3`, email: email('g3'), isWhatsAppBackup: true, isActive: false });
  const W = await newAccount('W whatsapp', { kind: 'WHATSAPP', identifier: `${prefix}w`, isWhatsAppBackup: false }); // the auto-created kind keeps being accepted
  const O = await newAccount('O other', { kind: 'OTHER', identifier: `${prefix}o` });
  assert.equal(W.kind, 'WHATSAPP');
  assert.equal(G1.isWhatsAppBackup, true);
  const f = { q: prefix };

  // The wizard dropdown: every ACTIVE Gmail account, flagged as WhatsApp backup or not.
  await assertOrder(admin, '/accounts', { ...f, kind: 'GMAIL', isActive: 'true' }, {}, [G2, G1]);
  await assertOrder(admin, '/accounts', { ...f, kind: 'GMAIL', isActive: 'true', pageSize: 100 }, { sort: 'email', order: 'asc' }, [G1, G2]);
  await assertOrder(admin, '/accounts', { ...f, kind: 'GMAIL', isActive: 'false' }, {}, [G3]);
  await assertOrder(admin, '/accounts', { ...f, kind: 'GMAIL', isActive: 'true', isWhatsAppBackup: 'true' }, {}, [G1]);
  await assertOrder(admin, '/accounts', { ...f, kind: 'GMAIL', isActive: 'true', isWhatsAppBackup: 'false' }, {}, [G2]);
  await assertOrder(admin, '/accounts', { ...f, kind: 'WHATSAPP' }, {}, [W]);
  await assertOrder(admin, '/accounts', { ...f, kind: 'OTHER' }, {}, [O]);
  await assertOrder(admin, '/accounts', { ...f, isActive: 'true' }, { sort: 'identifier', order: 'asc' }, [G1, G2, O, W]);
  await assertOrder(admin, '/accounts', { ...f, inUse: 'false' }, { sort: 'identifier', order: 'asc' }, [G1, G2, G3, O, W]); // none is bound to an assignment
  await assertOrder(admin, '/accounts', { ...f, inUse: 'true' }, {}, []);

  // create / patch keep working with kind WHATSAPP and isWhatsAppBackup (the Excel import and old data rely on both)
  const patched = await admin.req('PATCH', `/accounts/${W.id}`, { body: { isWhatsAppBackup: true } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.data.isWhatsAppBackup, true);
  await assertOrder(admin, '/accounts', { ...f, isWhatsAppBackup: 'true' }, { sort: 'identifier', order: 'asc' }, [G1, G3, W]);

  // The list shape is the one the UI already knows: masked password, no encrypted blob, nothing like `inUseBy`.
  const row = (await list(admin, '/accounts', { ...f, kind: 'OTHER' })).data[0];
  assert.equal(row.password, '••••••••');
  assert.equal(row.hasPassword, true);
  for (const key of ['inUseBy', 'passwordEnc']) assert.ok(!(key in row), `list rows must not carry ${key}`);
  for (const key of ['id', 'kind', 'identifier', 'email', 'isWhatsAppBackup', 'isActive', 'currentAssignmentId', 'createdAt']) assert.ok(key in row, `list rows keep ${key}`);
});

test('BE-A1 accounts: backupInUse = the email is the wa1/wa2 backup address of an ACTIVE phone assignment (case-insensitive)', async () => {
  const admin = await as('admin');
  const { dept } = await world();
  const prefix = `p9s-${RUN}-bk-`;
  const email = (n) => `${prefix}${n}@p9s.test`;
  const U1 = await newAccount('U1 wa1 backup', { kind: 'GMAIL', identifier: `${prefix}u1`, email: email('u1') }); // account lower case, assignment UPPER CASE
  const U2 = await newAccount('U2 wa2 backup', { kind: 'GMAIL', identifier: `${prefix}u2`, email: email('u2').toUpperCase() }); // account UPPER CASE, assignment lower case
  const U3 = await newAccount('U3 unused gmail', { kind: 'GMAIL', identifier: `${prefix}u3`, email: email('u3') });
  const U4 = await newAccount('U4 no email', { kind: 'OTHER', identifier: `${prefix}u4` }); // NULL email must stay in the `false` set
  const f = { q: prefix };
  const sorted = { sort: 'identifier', order: 'asc' };

  // Nothing is a backup yet.
  await assertOrder(admin, '/accounts', { ...f, backupInUse: 'true' }, sorted, []);
  await assertOrder(admin, '/accounts', { ...f, backupInUse: 'false' }, sorted, [U1, U2, U3, U4]);

  // An ACTIVE phone assignment that names U1 (typed in capitals) and U2 (typed in lower case) as its WhatsApp backup
  // addresses: the match ignores case on both sides.
  const holder = await newEmployee('bk', 'Holder', dept('Call Center').id);
  const flat = (await admin.req('GET', '/asset-categories?includeInactive=true')).body.flat;
  const phones = flat.find((c) => c.name === 'Phones' && !c.parentId);
  assert.ok(phones, 'seed category Phones');
  const imei = `99${String(Date.now()).slice(-11)}${String((counter += 1) % 100).padStart(2, '0')}`;
  const phone = await create('/assets', { categoryId: phones.id, name: `P9S ${RUN} phone`, condition: 'GOOD', phone: { imei } }, made.assets, 'phone');
  const assigned = await create('/assignments/phone', { employeeId: holder.id, phoneAssetId: phone.id, wa1BackupEmail: email('u1').toUpperCase(), wa2BackupEmail: email('u2') }, made.assignments, 'assignment');

  await assertOrder(admin, '/accounts', { ...f, backupInUse: 'true' }, sorted, [U1, U2]);
  await assertOrder(admin, '/accounts', { ...f, backupInUse: 'false' }, sorted, [U3, U4]);
  await assertOrder(admin, '/accounts', { ...f, backupInUse: 'true', kind: 'GMAIL', isActive: 'true' }, sorted, [U1, U2]); // combines with the other filters
  await assertOrder(admin, '/accounts', { ...f, backupInUse: 'true', kind: 'OTHER' }, sorted, []);
  await assertStablePaging(admin, '/accounts', { ...f, backupInUse: 'false', sort: 'kind' }, 1, 2); // the filter keeps meta.total honest
  assert.equal((await admin.req('GET', `/accounts?${qs({ ...f, backupInUse: 'maybe' })}`)).status, 400);

  // Once the assignment is returned the addresses are free again.
  const back = await admin.req('POST', `/assignments/${assigned.id}/return`, { body: { returnCondition: 'GOOD' } });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  await assertOrder(admin, '/accounts', { ...f, backupInUse: 'true' }, sorted, []);
  await assertOrder(admin, '/accounts', { ...f, backupInUse: 'false' }, sorted, [U1, U2, U3, U4]);
});

/* ───────────────────────────── GET /employees ───────────────────────────── */

test('BE-A1 employees: sort + order on every key (department / room through the relation), default fullName asc, legacy values', async () => {
  const admin = await as('admin');
  const { dept, room } = await world();
  const [CC, BANKO, MUH] = [dept('Call Center').id, dept('Banko').id, dept('Muhasebe').id];
  const [TR1, TR2] = [room('TR1').id, room('TR2').id];
  // Created in this shuffled order, so createdAt asc = C, E, A, D, B.
  const C = await newEmployee('srt', 'Charlie', CC, TR1);
  const E = await newEmployee('srt', 'Echo', MUH, TR1);
  const A = await newEmployee('srt', 'Alpha', CC, TR2);
  const D = await newEmployee('srt', 'Delta', MUH);
  const B = await newEmployee('srt', 'Bravo', BANKO);
  const f = { q: `P9S ${RUN} srt` };

  await assertOrder(admin, '/employees', f, {}, [A, B, C, D, E]); // default stays fullName asc
  await assertBothWays(admin, '/employees', f, 'fullName', [A, B, C, D, E], [E, D, C, B, A]);
  await assertBothWays(admin, '/employees', f, 'createdAt', [C, E, A, D, B], [B, D, A, E, C]);
  await assertBothWays(admin, '/employees', f, 'department', [B, A, C, D, E], [D, E, A, C, B]); // Banko < Call Center < Muhasebe, ties by fullName
  // Room code through the relation, ties by fullName. NULL (no room) is PostgreSQL's "largest": last when asc, first when desc.
  await assertBothWays(admin, '/employees', f, 'room', [C, E, A, B, D], [B, D, A, C, E]);
  await assertOrder(admin, '/employees', f, { order: 'desc' }, [E, D, C, B, A]);
  await assertOrder(admin, '/employees', f, { sort: 'createdAt' }, [C, E, A, D, B]); // employees' default order is asc

  // The values the current Employees page still sends keep their old meaning.
  await assertOrder(admin, '/employees', f, { sort: 'name' }, [A, B, C, D, E]);
  await assertOrder(admin, '/employees', f, { sort: 'lastAdded' }, [B, D, A, E, C]);
  await assertOrder(admin, '/employees', f, { sort: 'lastAdded', order: 'asc' }, [C, E, A, D, B]);

  // Room scope is untouched by sorting: a team leader only ever sees their own room, the CEO only call-centre rooms.
  const tl = await as('tl.tr1');
  await assertOrder(tl, '/employees', f, { sort: 'room', order: 'desc' }, [C, E]);
  const ceo = await as('mr.mahmoud');
  await assertOrder(ceo, '/employees', f, { sort: 'room', order: 'desc' }, [A, C, E]);
});

test('BE-A1 employees: pages stay stable when the sort key has duplicates (same department / same room)', async () => {
  const admin = await as('admin');
  const { dept, room } = await world();
  const rows = [];
  for (const n of [4, 1, 5, 2, 3]) rows.push(await newEmployee('pge', `Pg${n}`, dept('Call Center').id, room('TR1').id));
  const byName = [...rows].sort((a, b) => (a.fullName < b.fullName ? -1 : 1));
  for (const sort of ['department', 'room']) {
    for (const order of ['asc', 'desc']) {
      for (const pageSize of [2, 1]) {
        const whole = await assertStablePaging(admin, '/employees', { q: `P9S ${RUN} pge`, sort, order }, pageSize, rows.length);
        assert.deepEqual(nameOf(whole), nameOf(byName), `sort=${sort} order=${order}: ties are ordered by fullName`); // documented tie-break
      }
    }
  }
});

test('BE-A1 employees: rows that tie on every sort value fall back to id — asc, whatever the direction (same as GET /assets)', async () => {
  const admin = await as('admin');
  // One full name in six different departments (the unique key is fullName + department): sorting by fullName cannot
  // tell them apart, and no natural tie-break applies, so ONLY the final `id` decides — which is what keeps pages stable.
  const departments = (await admin.req('GET', '/departments')).body.data.slice(0, 6);
  assert.equal(departments.length, 6, 'the seed has at least six departments');
  const rows = [];
  for (const d of departments) rows.push(await newEmployee('idt', 'Same', d.id, null, `Same@${d.name}`));
  const byId = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1)); // uuid text order = PostgreSQL uuid order
  for (const order of ['asc', 'desc']) {
    const whole = await assertStablePaging(admin, '/employees', { q: `P9S ${RUN} idt`, sort: 'fullName', order }, 4, rows.length);
    assert.deepEqual(ids(whole), ids(byId), `sort=fullName order=${order}: ties are ordered by id asc`);
  }
});

test('BE-A1 employees: filter by room and by department (alone and combined)', async () => {
  const admin = await as('admin');
  const { dept, room } = await world();
  const [CC, BANKO, MUH] = [dept('Call Center').id, dept('Banko').id, dept('Muhasebe').id];
  const [TR1, TR2] = [room('TR1').id, room('TR2').id];
  const A = await newEmployee('flt', 'Alpha', CC, TR2);
  const B = await newEmployee('flt', 'Bravo', BANKO);
  const C = await newEmployee('flt', 'Charlie', CC, TR1);
  const E = await newEmployee('flt', 'Echo', MUH, TR1);
  const f = { q: `P9S ${RUN} flt` };
  const by = (extra, expected) => assertOrder(admin, '/employees', { ...f, ...extra }, {}, expected);

  await by({ roomId: TR1 }, [C, E]);
  await by({ roomId: TR2 }, [A]);
  await by({ departmentTeamId: CC }, [A, C]);
  await by({ departmentTeamId: BANKO }, [B]);
  await by({ roomId: TR1, departmentTeamId: MUH }, [E]);
  await by({ roomId: TR2, departmentTeamId: BANKO }, []); // both filters apply
  const { data } = await list(admin, '/employees', { ...f, roomId: TR1, sort: 'department', order: 'desc' });
  assert.ok(data.length === 2 && data.every((e) => e.room?.id === TR1), 'every row of a room filter belongs to that room');
  assert.equal((await list(admin, '/employees', { ...f, roomId: TR1, pageSize: 1 })).meta.total, 2);
});

/* ───────────────────────────── GET /users ───────────────────────────── */

test('BE-A1 users: sort + order on every key, newest first by default, role / isActive filters, stable pages', async () => {
  const admin = await as('admin');
  const { room } = await world();
  // Created in this shuffled order, so createdAt asc = u4, u1, u5, u3, u2. Roles: u2 and u3 are both MANAGERs.
  const u4 = await newUser('usr', 'Delta', 'TEAM_LEADER', `P9S ${RUN} Xia`, { roomId: room('TR1').id });
  const u1 = await newUser('usr', 'Alpha', 'ADMIN', `P9S ${RUN} Yan`);
  const u5 = await newUser('usr', 'Echo', 'CALL_CENTER_MANAGER', `P9S ${RUN} Vic`);
  const u3 = await newUser('usr', 'Charlie', 'MANAGER', `P9S ${RUN} Zed`);
  const u2 = await newUser('usr', 'Bravo', 'MANAGER', `P9S ${RUN} Wil`);
  const f = { q: `p9s-${RUN}-usr` };

  await assertOrder(admin, '/users', f, {}, [u2, u3, u5, u1, u4]); // createdAt desc (it was username asc before Phase 9)
  await assertBothWays(admin, '/users', f, 'createdAt', [u4, u1, u5, u3, u2], [u2, u3, u5, u1, u4]);
  await assertBothWays(admin, '/users', f, 'username', [u1, u2, u3, u4, u5], [u5, u4, u3, u2, u1]);
  await assertBothWays(admin, '/users', f, 'fullName', [u5, u2, u4, u1, u3], [u3, u1, u4, u2, u5]); // Vic Wil Xia Yan Zed
  // Enum order ADMIN < MANAGER < TEAM_LEADER < CALL_CENTER_MANAGER; the two MANAGERs keep username asc both ways.
  await assertBothWays(admin, '/users', f, 'role', [u1, u2, u3, u4, u5], [u5, u4, u2, u3, u1]);
  await assertOrder(admin, '/users', f, { sort: 'username' }, [u5, u4, u3, u2, u1]); // users' default order is desc

  // The tie between the two MANAGERs straddles the page boundary: [u5 u4 u2 | u3 u1].
  await assertStablePaging(admin, '/users', { ...f, sort: 'role', order: 'desc' }, 3, 5);
  await assertStablePaging(admin, '/users', { ...f, sort: 'role', order: 'asc' }, 2, 5);

  // Filters: role, isActive, both, and combined with a sort.
  await assertOrder(admin, '/users', { ...f, role: 'MANAGER' }, {}, [u2, u3]);
  await assertOrder(admin, '/users', { ...f, role: 'MANAGER' }, { sort: 'username', order: 'desc' }, [u3, u2]);
  await assertOrder(admin, '/users', { ...f, role: 'TEAM_LEADER' }, {}, [u4]);
  await assertOrder(admin, '/users', { ...f, role: 'ADMIN' }, {}, [u1]);
  await assertOrder(admin, '/users', { ...f, role: 'CALL_CENTER_MANAGER' }, {}, [u5]);
  assert.equal((await admin.req('PATCH', `/users/${u5.id}`, { body: { isActive: false } })).status, 200);
  await assertOrder(admin, '/users', { ...f, isActive: 'false' }, {}, [u5]);
  await assertOrder(admin, '/users', { ...f, isActive: 'true' }, { sort: 'username', order: 'asc' }, [u1, u2, u3, u4]);
  await assertOrder(admin, '/users', { ...f, isActive: 'true', role: 'CALL_CENTER_MANAGER' }, {}, []);
  await assertOrder(admin, '/users', { ...f, isActive: 'false', role: 'CALL_CENTER_MANAGER' }, {}, [u5]);
  assert.equal((await admin.req('GET', `/users?${qs({ ...f, role: 'JANITOR' })}`)).status, 400);
});

/* ───────────────────────────── GET /audit-logs ───────────────────────────── */

test('BE-A1 audit-logs: sort + order on createdAt / action / actor, newest first by default, stable pages', async () => {
  const admin = await as('admin');
  const { dept, adminId } = await world();
  const { id: actorId, client: second } = await actor();
  const from = new Date().toISOString();
  await sleep(5);

  // Five rows by the fixture admin (account.create ×2, account.delete, employee.create, employee.delete) …
  const prefix = `p9s-${RUN}-log-`;
  const a1 = await newAccount('a1', { kind: 'OTHER', identifier: `${prefix}1` }, second);
  const a2 = await newAccount('a2', { kind: 'OTHER', identifier: `${prefix}2` }, second);
  assert.equal((await second.req('DELETE', `/accounts/${a1.id}`)).status, 204);
  await sleep(4);
  const emp = await second.req('POST', '/employees', { body: { fullName: `P9S ${RUN} log Temp`, departmentTeamId: dept('Call Center').id } });
  assert.equal(emp.status, 201, JSON.stringify(emp.body));
  await sleep(4);
  assert.equal((await second.req('DELETE', `/employees/${emp.body.data.id}`)).status, 204);
  await sleep(4);
  // … and one account.create by the seeded admin: the second actor of the `actor` sort.
  const a3 = await newAccount('a3', { kind: 'OTHER', identifier: `${prefix}3` });
  await sleep(5);
  const to = new Date().toISOString();

  const mine = { actorId, from, to };
  const newest = (await list(admin, '/audit-logs', { ...mine, pageSize: 100 })).data;
  assert.deepEqual(newest.map((x) => x.action), ['employee.delete', 'employee.create', 'account.delete', 'account.create', 'account.create'], 'default order is newest first');
  assert.deepEqual(newest.slice(3).map((x) => x.targetId), [a2.id, a1.id]);
  for (const x of newest) names.set(x.id, `${x.action}${x.targetId === a1.id ? '#1' : x.targetId === a2.id ? '#2' : ''}`);
  const byAction = (dir) => [...newest].sort((x, y) => (x.action < y.action ? -dir : x.action > y.action ? dir : 0)); // stable: equal actions stay newest first
  await assertBothWays(admin, '/audit-logs', mine, 'createdAt', [...newest].reverse(), newest);
  await assertOrder(admin, '/audit-logs', mine, { sort: 'createdAt' }, newest); // order defaults to desc
  await assertBothWays(admin, '/audit-logs', mine, 'action', byAction(1), byAction(-1));

  // The two account.create rows share their action (and actor): pages of 1 and 2 split the tie and must not move.
  for (const order of ['asc', 'desc']) for (const pageSize of [1, 2]) await assertStablePaging(admin, '/audit-logs', { ...mine, sort: 'action', order }, pageSize, 5);
  await assertStablePaging(admin, '/audit-logs', { ...mine, sort: 'actor', order: 'asc' }, 2, 5); // one actor: every row ties

  // actor sorts by the actor's full name: "AAA P9S …" (fixture admin) < "System Admin" (seeded admin).
  const both = { action: 'account.create', from, to };
  for (const [order, fixtureFirst] of [['asc', true], ['desc', false]]) {
    const { data } = await list(admin, '/audit-logs', { ...both, sort: 'actor', order, pageSize: 100 });
    const positions = (id) => data.flatMap((x, i) => (x.actor?.id === id ? [i] : []));
    const [fixture, seeded] = [positions(actorId), positions(adminId)];
    assert.equal(fixture.length, 2, 'both fixture account.create rows are in the window');
    assert.ok(seeded.length >= 1 && data.some((x) => x.targetId === a3.id), 'the seeded admin\'s row is in the window');
    if (fixtureFirst) assert.ok(Math.max(...fixture) < Math.min(...seeded), 'actor asc: AAA before System Admin');
    else assert.ok(Math.max(...seeded) < Math.min(...fixture), 'actor desc: System Admin before AAA');
    assert.deepEqual(fixture.map((i) => data[i].targetId), [a2.id, a1.id], 'inside one actor, newest first (both directions)');
  }

  // The filters that existed before keep working next to the sort.
  assert.equal((await list(admin, '/audit-logs', { ...mine, action: 'employee.', sort: 'action' })).meta.total, 2);
  assert.equal((await list(admin, '/audit-logs', { actorId, targetId: a1.id, sort: 'action', order: 'asc' })).meta.total, 2); // create + delete
});

/* ───────────────────────────── whitelist + validation ───────────────────────────── */

const ENDPOINTS = [
  { path: '/accounts', keys: ['createdAt', 'identifier', 'email', 'kind', 'isActive'] },
  { path: '/employees', keys: ['fullName', 'createdAt', 'department', 'room'] },
  { path: '/users', keys: ['createdAt', 'username', 'fullName', 'role'] },
  { path: '/audit-logs', keys: ['createdAt', 'action', 'actor'] },
];

test('BE-A1 every endpoint: an unknown sort key (or order) is a 400 VALIDATION_ERROR naming the allowed keys; every allowed key works', async () => {
  const admin = await as('admin');
  for (const { path, keys } of ENDPOINTS) {
    for (const bad of ['bogus', '', 'CreatedAt', 'createdAt;DROP TABLE "User"', 'password', 'passwordHash', 'id', 'meta']) {
      const r = await admin.req('GET', `${path}?${qs({ sort: bad })}`);
      assert.equal(r.status, 400, `${path} sort=${JSON.stringify(bad)} → ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, 'VALIDATION_ERROR');
      const issue = r.body.error.details.find((d) => d.path === 'sort');
      assert.ok(issue, `${path}: the issue points at \`sort\``);
      for (const key of keys) assert.ok(issue.message.includes(key), `${path}: the message "${issue.message}" names ${key}`);
    }
    const order = await admin.req('GET', `${path}?${qs({ order: 'sideways' })}`);
    assert.equal(order.status, 400, `${path} order=sideways`);
    assert.equal(order.body.error.code, 'VALIDATION_ERROR');
    assert.ok(order.body.error.details.some((d) => d.path === 'order' && /asc/.test(d.message) && /desc/.test(d.message)));
    assert.equal((await admin.req('GET', `${path}?sort=${keys[0]}&sort=${keys[1]}`)).status, 400, `${path}: repeated sort`);

    for (const key of keys) for (const dir of ['asc', 'desc']) {
      const r = await admin.req('GET', `${path}?${qs({ sort: key, order: dir, pageSize: 5 })}`);
      assert.equal(r.status, 200, `${path} sort=${key} order=${dir} → ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(Array.isArray(r.body.data) && r.body.meta.pageSize === 5);
    }
  }
  // Employees: the two pre-Phase-9 values stay accepted but are not advertised.
  const legacy = await admin.req('GET', `/employees?${qs({ sort: 'nope' })}`);
  for (const old of ['name', 'lastAdded']) {
    assert.ok(!legacy.body.error.details[0].message.includes(old));
    assert.equal((await admin.req('GET', `/employees?${qs({ sort: old })}`)).status, 200);
  }
});

test('BE-A1 sorting does not widen access: users + audit-logs stay ADMIN-only, accounts stay hidden from team leaders / call-centre managers', async () => {
  const manager = await as('manager');
  const tl = await as('tl.tr1');
  const ceo = await as('mr.mahmoud');
  for (const path of ['/users', '/audit-logs']) {
    for (const c of [manager, tl, ceo]) assert.equal((await c.req('GET', `${path}?${qs({ sort: ENDPOINTS.find((e) => e.path === path).keys[1], order: 'asc' })}`)).status, 403, path);
  }
  for (const c of [tl, ceo]) assert.equal((await c.req('GET', `/accounts?${qs({ sort: 'email', backupInUse: 'true' })}`)).status, 403);
  const masked = await manager.req('GET', `/accounts?${qs({ sort: 'email', order: 'asc', pageSize: 5 })}`);
  assert.equal(masked.status, 200); // the manager may read (masked) accounts, sorted or not
  assert.ok(masked.body.data.every((a) => a.password === '••••••••'));
});
