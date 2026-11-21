'use strict';
/**
 * Phase 7 QA fixes in the RETURN area — F-01 (atomic return), F-05/F-06 (items that did not come
 * back stay bound), F-07 (condition worsening is a discrepancy), F-12 (TL / CCM scope on the return
 * routes), F-21 (`discrepancies` vs `comparison`), F-26 (the asset keeps its room).
 *
 * Integration tests against a RUNNING server with the seed loaded — same style as api.test.js
 * (`npm test` runs api.test.js only; run this file explicitly):
 *   BASE_URL=http://localhost:3001 node --test tests/return.fixes.test.js
 * BASE_URL must point at a server YOU started (never the shared :4000), ideally on a scratch
 * database. The file only talks HTTP (no direct Prisma access, so no DATABASE_URL is needed) and
 * creates every fixture through the API with unique "RFX …" names, so it can be re-run; the "item
 * did not come back" scenarios leave their assets / Bitrix accounts bound by design — that is exactly
 * what they assert.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api/v1`;
const PW = { admin: 'Admin#12345', 'tl.tr1': 'Leader#12345', 'mr.mahmoud': 'Mahmoud#12345' };

class Client {
  constructor() { this.cookies = {}; }
  async req(method, path, { body } = {}) {
    const headers = { Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
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
const as = async (username) => {
  const c = new Client();
  const r = await c.req('POST', '/auth/login', { body: { username, password: PW[username] } });
  assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(r.body)}`);
  return c;
};

/* ------------------------------------------------------------------------------------------ *
 * Fixture helpers (API only)
 * ------------------------------------------------------------------------------------------ */
const stamp = Date.now().toString(36);
let seq = 0;
const uid = () => `${stamp}-${++seq}`;
const digits = (n) => `${Date.now()}${String(++seq).padStart(4, '0')}`.slice(-n).padStart(n, '7');

const fx = {
  async world(admin) {
    const cats = (await admin.req('GET', '/asset-categories')).body.flat;
    const rooms = (await admin.req('GET', '/rooms')).body.data;
    const deps = (await admin.req('GET', '/departments')).body.data;
    // seeded employees, looked up by name (this file creates employees of its own, so don't page the whole list).
    // Ayse Celik / Can Ozturk have no room: items that stay bound to them ("not returned") are invisible to
    // TEAM_LEADER / CALL_CENTER_MANAGER asset scopes, so they cannot disturb the other suites' room assertions.
    const emps = {};
    for (const name of ['Ahmet Yilmaz', 'Zeynep Aydin', 'Ayse Celik', 'Can Ozturk']) {
      const r = await admin.req('GET', `/employees?q=${encodeURIComponent(name)}&pageSize=5`);
      emps[name] = r.body.data.find((e) => e.fullName === name);
      assert.ok(emps[name], `seed employee ${name}`);
    }
    return {
      cat: (name) => { const c = cats.find((x) => x.name === name); assert.ok(c, `seed category ${name}`); return c; },
      room: (code) => { const r = rooms.find((x) => x.code === code); assert.ok(r, `seed room ${code}`); return r; },
      dept: (name) => { const d = deps.find((x) => x.name === name); assert.ok(d, `seed department ${name}`); return d; },
      emp: (fullName) => emps[fullName],
    };
  },
  /** A fresh GOOD / AVAILABLE asset of a seeded category. */
  async asset(admin, world, category, label, extra = {}) {
    const r = await admin.req('POST', '/assets', {
      body: { categoryId: world.cat(category).id, name: `RFX ${label} ${uid()}`, condition: 'GOOD', ...extra },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  },
  async phone(admin, world, label) {
    return fx.asset(admin, world, 'Phones', label, { phone: { imei: digits(15) } });
  },
  /** A Bitrix account whose e-mail differs from its identifier (so the unreturned item has a real name). */
  async bitrix(admin, label) {
    const id = `rfx-${label.replace(/[^a-z0-9]+/gi, '-')}-${uid()}`;
    const r = await admin.req('POST', '/accounts', { body: { kind: 'BITRIX', identifier: id, email: `${id}@clinic.local`, password: 'RfxPass#12345' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  },
  async assignGeneric(admin, { employeeId, asset, accessories = [], condition = 'GOOD', workIdentity }) {
    const r = await admin.req('POST', '/assignments/generic', {
      body: {
        type: accessories.length ? 'GENERAL' : 'LAPTOP',
        employeeId,
        assetId: asset.id,
        accessoryAssetIds: accessories.map((x) => x.id),
        conditionAtHandover: condition,
        ...(workIdentity && { workIdentity }),
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  },
  /** Phone assignment carrying a SIM, both chargers and a Bitrix account → every "required item"
   *  (`withSim2` adds a second SIM, `workIdentity` hands it over at a seat). */
  async assignPhone(admin, world, employeeId, label, { withSim2 = false, workIdentity } = {}) {
    const simNumber = `905${digits(9)}`;
    const sim2Number = `905${digits(9)}`;
    const [phone, sim, sim2, cable, adapter, bitrix] = await Promise.all([
      fx.phone(admin, world, `${label} phone`),
      fx.asset(admin, world, 'SIM Cards', `${label} sim`, { customFields: { phone_number: simNumber } }), // SIM Cards requires its number
      withSim2 ? fx.asset(admin, world, 'SIM Cards', `${label} sim2`, { customFields: { phone_number: sim2Number } }) : null,
      fx.asset(admin, world, 'Charger Cables', `${label} cable`),
      fx.asset(admin, world, 'Charger Adapters', `${label} adapter`),
      fx.bitrix(admin, label),
    ]);
    const r = await admin.req('POST', '/assignments/phone', {
      body: {
        employeeId, phoneAssetId: phone.id, condition: 'GOOD',
        ...(workIdentity && { workIdentity }),
        sim1AssetId: sim.id, sim1Number: simNumber,
        ...(sim2 && { sim2AssetId: sim2.id, sim2Number }),
        chargerCableAssetId: cable.id, chargerAdapterAssetId: adapter.id,
        bitrixAccountId: bitrix.id,
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { assignment: r.body.data, phone, sim, sim2, cable, adapter, bitrix, simNumber };
  },
  getAsset: async (admin, id) => {
    const r = await admin.req('GET', `/assets/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data;
  },
  getAssignment: async (admin, id) => {
    const r = await admin.req('GET', `/assignments/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data;
  },
  timeline: async (admin, id, query = '') => {
    const r = await admin.req('GET', `/assignments/${id}/timeline?pageSize=100${query}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data;
  },
  async account(admin, id) {
    const r = await admin.req('GET', `/accounts/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data;
  },
  ret: (admin, assignmentId, body) => admin.req('POST', `/assignments/${assignmentId}/return`, { body }),
};
const countBy = (rows, key) => rows.reduce((m, r) => ({ ...m, [r[key]]: (m[r[key]] ?? 0) + 1 }), {});
const conditionRow = (comparison) => comparison.find((c) => c.fieldKey === 'condition');

/* ------------------------------------------------------------------------------------------ *
 * F-01 — the ACTIVE → RETURNED transition is atomic
 * ------------------------------------------------------------------------------------------ */
test('F-01: 6 parallel returns of one assignment → exactly one 200, five 409, exactly one ReturnRecord', async () => {
  const admin = await as('admin');
  const world = await fx.world(admin);
  const emp = world.emp('Ahmet Yilmaz');

  // Control: an identical assignment returned once, sequentially — what ONE return writes.
  const controlAsset = await fx.asset(admin, world, 'Laptops', 'race control');
  const control = await fx.assignGeneric(admin, { employeeId: emp.id, asset: controlAsset });
  assert.equal((await fx.ret(admin, control.id, { returnCondition: 'DAMAGED' })).status, 200);
  const controlTimeline = countBy(await fx.timeline(admin, control.id), 'eventType');

  // The race: six simultaneous returns, each claiming a DIFFERENT condition.
  const asset = await fx.asset(admin, world, 'Laptops', 'race');
  const a = await fx.assignGeneric(admin, { employeeId: emp.id, asset });
  const conditions = ['DAMAGED', 'POOR', 'FAIR', 'DISPOSED', 'NEW', 'DAMAGED'];
  const results = await Promise.all(conditions.map((c) => fx.ret(admin, a.id, { returnCondition: c, returnNotes: `race ${c}` })));

  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409], JSON.stringify(results.map((r) => [r.status, r.body.error?.code])));
  for (const r of results.filter((x) => x.status === 409)) assert.equal(r.body.error.code, 'CONFLICT');

  const winnerIdx = results.findIndex((r) => r.status === 200);
  const winnerCondition = conditions[winnerIdx];
  assert.equal(results[winnerIdx].body.data.assetConditions[0].to, winnerCondition);

  // exactly one ReturnRecord, written by the winner only
  const detail = await fx.getAssignment(admin, a.id);
  assert.equal(detail.status, 'RETURNED');
  assert.equal(detail.returnRecords.length, 1, 'exactly one ReturnRecord');
  assert.equal(detail.returnRecords[0].returnCondition, winnerCondition);

  // the losers wrote nothing: the timeline is what a single return writes, the asset carries the winner's condition
  const timeline = countBy(await fx.timeline(admin, a.id), 'eventType');
  assert.equal(timeline.ASSIGNED, controlTimeline.ASSIGNED);
  assert.equal(timeline.RETURNED, controlTimeline.RETURNED, 'no duplicate RETURNED timeline entries');
  // GOOD → winner: only NEW is not a worsening, so only then is there no DISCREPANCY entry (and never more than one)
  assert.equal(timeline.DISCREPANCY ?? 0, winnerCondition === 'NEW' ? 0 : 1, 'no duplicate DISCREPANCY entries');
  const after = await fx.getAsset(admin, asset.id);
  assert.equal(after.condition, winnerCondition);
  assert.equal(after.status, winnerCondition === 'DISPOSED' ? 'DISPOSED' : 'AVAILABLE');
  const updated = after.timelineEntries.filter((e) => e.eventType === 'UPDATED');
  assert.equal(updated.length, 1, 'one UPDATED entry (GOOD → winner), not one per request');
  assert.deepEqual(updated[0].snapshot, { field: 'condition', from: 'GOOD', to: winnerCondition, assignmentCode: a.assignmentCode });

  // a later, sequential repeat is still a clean 409
  assert.equal((await fx.ret(admin, a.id, { returnCondition: 'GOOD' })).status, 409);
});

/* ------------------------------------------------------------------------------------------ *
 * F-07 (second half) — condition worsening is flagged
 * ------------------------------------------------------------------------------------------ */
test('F-07: comparison ranks the condition NEW > GOOD > FAIR > POOR > DAMAGED > DISPOSED — worse = WARNING (CRITICAL for DAMAGED/DISPOSED), same/better = INFO', async () => {
  const admin = await as('admin');
  const world = await fx.world(admin);
  const emp = world.emp('Ahmet Yilmaz');

  // [handover, returned, isDiscrepancy, severity]
  const matrix = [
    ['GOOD', 'GOOD', false, 'INFO'],
    ['GOOD', 'NEW', false, 'INFO'], // better
    ['FAIR', 'GOOD', false, 'INFO'], // better
    ['DAMAGED', 'POOR', false, 'INFO'], // better
    ['DAMAGED', 'DAMAGED', false, 'INFO'], // same
    ['NEW', 'GOOD', true, 'WARNING'],
    ['GOOD', 'FAIR', true, 'WARNING'],
    ['FAIR', 'POOR', true, 'WARNING'],
    ['GOOD', 'POOR', true, 'WARNING'],
    ['POOR', 'DAMAGED', true, 'CRITICAL'],
    ['GOOD', 'DAMAGED', true, 'CRITICAL'],
    ['GOOD', 'DISPOSED', true, 'CRITICAL'],
    ['DAMAGED', 'DISPOSED', true, 'CRITICAL'],
  ];
  for (const [handover, returned, isDiscrepancy, severity] of matrix) {
    const label = `${handover}→${returned}`;
    const asset = await fx.asset(admin, world, 'Laptops', `cond ${label}`);
    const a = await fx.assignGeneric(admin, { employeeId: emp.id, asset, condition: handover });
    const ret = await fx.ret(admin, a.id, { returnCondition: returned });
    assert.equal(ret.status, 200, `${label}: ${JSON.stringify(ret.body)}`);

    const row = conditionRow(ret.body.data.comparison);
    assert.deepEqual(row, { fieldKey: 'condition', label: 'Phone condition', valueAtHandover: handover, valueAtReturn: returned, isDiscrepancy, severity }, label);
    // nothing else differs on a generic assignment → the verdict of the whole return is the condition's
    assert.equal(ret.body.data.hasDiscrepancies, isDiscrepancy, label);
    assert.deepEqual(ret.body.data.discrepancies.map((c) => c.fieldKey), isDiscrepancy ? ['condition'] : [], label);

    // persisted the same way: the stored comparison row + the DISCREPANCY timeline entry
    const stored = (await fx.getAssignment(admin, a.id)).returnRecords[0].comparisonFields;
    assert.deepEqual(stored.map((c) => [c.fieldKey, c.severity]), isDiscrepancy ? [['condition', severity]] : [], `${label}: stored discrepancy rows`);
    const tl = countBy(await fx.timeline(admin, a.id), 'eventType');
    assert.equal(tl.DISCREPANCY ?? 0, isDiscrepancy ? 1 : 0, `${label}: DISCREPANCY timeline entry`);
  }
});

test('F-07: a DAMAGED return shows a CRITICAL condition row whichever way the condition is sent (top-level, return.condition, or both like the web form)', async () => {
  const admin = await as('admin');
  const world = await fx.world(admin);
  const emp = world.emp('Ahmet Yilmaz');
  const bodies = [
    ['returnCondition only', { returnCondition: 'DAMAGED' }],
    ['return.condition only', { return: { condition: 'DAMAGED' } }],
    ['both (web form)', { returnCondition: 'DAMAGED', return: { condition: 'DAMAGED' } }],
  ];
  for (const [label, body] of bodies) {
    const asset = await fx.asset(admin, world, 'Laptops', `damaged ${label}`);
    const a = await fx.assignGeneric(admin, { employeeId: emp.id, asset });
    const ret = await fx.ret(admin, a.id, body);
    assert.equal(ret.status, 200, `${label}: ${JSON.stringify(ret.body)}`);
    assert.deepEqual(
      conditionRow(ret.body.data.comparison),
      { fieldKey: 'condition', label: 'Phone condition', valueAtHandover: 'GOOD', valueAtReturn: 'DAMAGED', isDiscrepancy: true, severity: 'CRITICAL' },
      label,
    );
    assert.equal(ret.body.data.hasDiscrepancies, true);
    assert.equal((await fx.getAsset(admin, asset.id)).condition, 'DAMAGED', `${label}: the asset itself comes back DAMAGED`);
  }

  // return.condition must be a real condition (the comparison ranks it)
  const asset = await fx.asset(admin, world, 'Laptops', 'bad condition');
  const a = await fx.assignGeneric(admin, { employeeId: emp.id, asset });
  assert.equal((await fx.ret(admin, a.id, { return: { condition: 'BROKEN' } })).status, 400);
  assert.equal((await fx.getAssignment(admin, a.id)).status, 'ACTIVE', 'a rejected return closes nothing');
  assert.equal((await fx.ret(admin, a.id, { returnCondition: 'GOOD' })).status, 200, 'and the assignment can still be returned properly');
});

/* ------------------------------------------------------------------------------------------ *
 * F-05 / F-06 — required items that did not come back stay bound; unreturnedItems lists them
 * F-21 — `discrepancies` only holds flagged rows, `comparison` is the full list
 * ------------------------------------------------------------------------------------------ */
test('F-05/F-06/F-21: SIM / charger / Bitrix missing at return → stay bound to the employee, listed in unreturnedItems; the rest is released', async () => {
  const admin = await as('admin');
  const world = await fx.world(admin);
  const emp = world.emp('Can Ozturk');
  const { assignment, phone, sim, cable, adapter, bitrix } = await fx.assignPhone(admin, world, emp.id, 'partial');

  // before: everything is out with the employee, the Bitrix account is bound to the assignment
  for (const x of [phone, sim, cable, adapter]) {
    const row = await fx.getAsset(admin, x.id);
    assert.equal(row.status, 'ASSIGNED');
    assert.equal(row.currentHolder?.id, emp.id);
  }
  assert.equal((await fx.account(admin, bitrix.id)).currentAssignment?.id, assignment.id);

  // The charger adapter and the Bitrix account are dropped (explicit null); SIM + cable are simply not
  // mentioned — omitted keys mean "unchanged" (contract §8.2), i.e. they came back.
  const ret = await fx.ret(admin, assignment.id, {
    returnCondition: 'GOOD',
    returnNotes: 'adapter and Bitrix login not returned',
    return: { chargerAdapterAssetId: null, bitrixAccountId: null },
  });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  const data = ret.body.data;

  // response: the unreturned items (stable order: assets first, Bitrix last)
  assert.deepEqual(data.unreturnedItems, [
    { kind: 'CHARGER_ADAPTER', code: adapter.code, name: adapter.name },
    { kind: 'BITRIX', code: bitrix.identifier, name: bitrix.email },
  ]);

  // F-21: `discrepancies` = ONLY the flagged rows, `comparison` = every field
  assert.equal(data.hasDiscrepancies, true);
  assert.deepEqual(data.discrepancies.map((c) => [c.fieldKey, c.severity]).sort(), [['bitrixAccountId', 'CRITICAL'], ['chargerAdapterAssetId', 'CRITICAL']]);
  assert.ok(data.discrepancies.every((c) => c.isDiscrepancy === true));
  assert.ok(data.comparison.length > data.discrepancies.length, 'comparison carries the unflagged rows too');
  assert.ok(data.comparison.some((c) => c.isDiscrepancy === false), 'comparison keeps isDiscrepancy:false rows');
  assert.deepEqual(data.comparison.filter((c) => c.isDiscrepancy), data.discrepancies, 'discrepancies is exactly the flagged subset of comparison');
  for (const key of ['sim1Number', 'chargerCableAssetId']) {
    assert.deepEqual(data.comparison.find((c) => c.fieldKey === key).isDiscrepancy, false, `${key} came back`);
  }

  // assets: what came back is released, the adapter stays ASSIGNED to the employee (F-05)
  for (const x of [phone, sim, cable]) {
    const row = await fx.getAsset(admin, x.id);
    assert.equal(row.status, 'AVAILABLE', `${x.code} released`);
    assert.equal(row.currentHolder, null);
  }
  const adapterAfter = await fx.getAsset(admin, adapter.id);
  assert.equal(adapterAfter.status, 'ASSIGNED', 'missing adapter stays ASSIGNED');
  assert.equal(adapterAfter.currentHolder?.id, emp.id, '…with its holder');
  assert.ok(adapterAfter.timelineEntries.some((e) => e.eventType === 'NOTE' && e.snapshot.missing === true && e.snapshot.returnState === 'NOT_RETURNED'), 'asset history records "not returned"');

  // Bitrix follows the same rule (F-06): the account keeps its assignment, so it cannot be handed out again
  const bitrixAfter = await fx.account(admin, bitrix.id);
  assert.equal(bitrixAfter.currentAssignment?.id, assignment.id, 'missing Bitrix account stays bound');
  const reuse = await fx.phone(admin, world, 'partial reuse');
  const blocked = await admin.req('POST', '/assignments/phone', { body: { employeeId: world.emp('Zeynep Aydin').id, phoneAssetId: reuse.id, bitrixAccountId: bitrix.id } });
  assert.equal(blocked.status, 409, 'the still-bound Bitrix account cannot be assigned again');

  // the assignment itself is closed, and its history says what was not returned
  const detail = await fx.getAssignment(admin, assignment.id);
  assert.equal(detail.status, 'RETURNED');
  assert.ok(detail.items.every((i) => i.isActive === false));
  const main = (await fx.timeline(admin, assignment.id, '&eventType=RETURNED')).find((e) => e.snapshot.unreturnedItems);
  assert.deepEqual(main.snapshot.unreturnedItems, data.unreturnedItems);

  // what came back is reusable again
  assert.equal((await fx.getAsset(admin, sim.id)).status, 'AVAILABLE');
});

test('F-05/F-06: the web return form (every key sent, handover labels for the dropdowns) → nothing unreturned, everything released, Bitrix freed', async () => {
  const admin = await as('admin');
  const world = await fx.world(admin);
  const { assignment, phone, sim, cable, adapter, bitrix, simNumber } = await fx.assignPhone(admin, world, world.emp('Ahmet Yilmaz').id, 'complete');

  const form = (await admin.req('GET', `/assignments/${assignment.id}/return-form`)).body.data;
  assert.equal(form.out.bitrixAccountId, bitrix.email);
  const ret = await fx.ret(admin, assignment.id, {
    returnCondition: 'GOOD',
    return: {
      condition: 'GOOD',
      sim1Number: simNumber,
      sim2Number: null,
      bitrixAccountId: form.out.bitrixAccountId,
      chargerCableAssetId: form.out.chargerCableAssetId,
      chargerAdapterAssetId: form.out.chargerAdapterAssetId,
    },
  });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  assert.deepEqual(ret.body.data.unreturnedItems, []);
  assert.equal(ret.body.data.hasDiscrepancies, false);
  assert.deepEqual(ret.body.data.discrepancies, []);
  assert.ok(ret.body.data.comparison.length > 0);
  for (const x of [phone, sim, cable, adapter]) assert.equal((await fx.getAsset(admin, x.id)).status, 'AVAILABLE', `${x.code} released`);
  assert.equal((await fx.account(admin, bitrix.id)).currentAssignment, null, 'a Bitrix account that came back is freed');
});

test('F-05: a SIM that is not handed back (explicit null) stays ASSIGNED to the employee; a returned Bitrix account is still freed', async () => {
  const admin = await as('admin');
  const world = await fx.world(admin);
  const emp = world.emp('Ayse Celik');
  const { assignment, phone, sim, cable, adapter, bitrix } = await fx.assignPhone(admin, world, emp.id, 'nosim');

  const ret = await fx.ret(admin, assignment.id, { returnCondition: 'GOOD', return: { sim1Number: null } });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  assert.deepEqual(ret.body.data.unreturnedItems, [{ kind: 'SIM1', code: sim.code, name: sim.name }]);
  const simRow = ret.body.data.comparison.find((c) => c.fieldKey === 'sim1Number');
  assert.equal(simRow.isDiscrepancy, true);
  assert.equal(simRow.severity, 'CRITICAL');

  const simAfter = await fx.getAsset(admin, sim.id);
  assert.equal(simAfter.status, 'ASSIGNED');
  assert.equal(simAfter.currentHolder?.id, emp.id);
  for (const x of [phone, cable, adapter]) assert.equal((await fx.getAsset(admin, x.id)).status, 'AVAILABLE', `${x.code} released`);
  assert.equal((await fx.account(admin, bitrix.id)).currentAssignment, null, 'the Bitrix account came back (key omitted = unchanged) and is freed');
});

test('F-05: SIM 2 is not a "required" item (WARNING row, not CRITICAL) — still, a SIM 2 that is not handed back stays ASSIGNED and is listed', async () => {
  const admin = await as('admin');
  const world = await fx.world(admin);
  const emp = world.emp('Can Ozturk');
  const { assignment, phone, sim, sim2, cable, adapter, bitrix } = await fx.assignPhone(admin, world, emp.id, 'nosim2', { withSim2: true });

  const ret = await fx.ret(admin, assignment.id, { returnCondition: 'GOOD', return: { sim2Number: null } });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  assert.deepEqual(ret.body.data.unreturnedItems, [{ kind: 'SIM2', code: sim2.code, name: sim2.name }]);
  const row = ret.body.data.comparison.find((c) => c.fieldKey === 'sim2Number');
  assert.deepEqual([row.isDiscrepancy, row.severity], [true, 'WARNING']);

  const sim2After = await fx.getAsset(admin, sim2.id);
  assert.equal(sim2After.status, 'ASSIGNED');
  assert.equal(sim2After.currentHolder?.id, emp.id);
  for (const x of [phone, sim, cable, adapter]) assert.equal((await fx.getAsset(admin, x.id)).status, 'AVAILABLE', `${x.code} released`);
  assert.equal((await fx.account(admin, bitrix.id)).currentAssignment, null);
});

/* ------------------------------------------------------------------------------------------ *
 * F-26 — the asset keeps its last known room
 * ------------------------------------------------------------------------------------------ */
test('F-26: a returned asset keeps its room (only the holder is cleared) — AVAILABLE and DISPOSED alike', async () => {
  const admin = await as('admin');
  const world = await fx.world(admin);
  const emp = world.emp('Ahmet Yilmaz');
  const tr1 = world.room('TR1');
  const tr2 = world.room('TR2');

  // asset already located in TR1, handed over without a seat → stays in TR1 → comes back to TR1
  const stocked = await fx.asset(admin, world, 'Laptops', 'room kept', { roomId: tr1.id });
  const a1 = await fx.assignGeneric(admin, { employeeId: emp.id, asset: stocked });
  assert.equal((await fx.getAsset(admin, stocked.id)).room?.code, 'TR1');
  assert.equal((await fx.ret(admin, a1.id, { returnCondition: 'GOOD' })).status, 200);
  const back = await fx.getAsset(admin, stocked.id);
  assert.equal(back.status, 'AVAILABLE');
  assert.equal(back.currentHolder, null, 'holder cleared');
  assert.equal(back.room?.code, 'TR1', 'last known room kept');

  // handed over at a TR2 seat (the asset moves to TR2), returned DISPOSED → still TR2, status DISPOSED
  const moved = await fx.asset(admin, world, 'Laptops', 'room kept disposed', { roomId: tr1.id });
  const a2 = await fx.assignGeneric(admin, { employeeId: emp.id, asset: moved, workIdentity: { name: `RFX seat ${uid()}`, roomId: tr2.id } });
  assert.equal((await fx.getAsset(admin, moved.id)).room?.code, 'TR2');
  assert.equal((await fx.ret(admin, a2.id, { returnCondition: 'DISPOSED' })).status, 200);
  const gone = await fx.getAsset(admin, moved.id);
  assert.equal(gone.status, 'DISPOSED');
  assert.equal(gone.currentHolder, null);
  assert.equal(gone.room?.code, 'TR2', 'room kept even when written off');

  // phone bundle handed over at a TR2 seat: the SIM / chargers move to TR2 with it and keep TR2 when released
  const bundle = await fx.assignPhone(admin, world, emp.id, 'room phone', { workIdentity: { name: `RFX seat ${uid()}`, roomId: tr2.id } });
  const released = [bundle.phone, bundle.sim, bundle.cable, bundle.adapter];
  for (const x of released) assert.equal((await fx.getAsset(admin, x.id)).room?.code, 'TR2', `${x.code} is at the TR2 seat`);
  assert.equal((await fx.ret(admin, bundle.assignment.id, { returnCondition: 'GOOD' })).status, 200);
  for (const x of released) {
    const row = await fx.getAsset(admin, x.id);
    assert.equal(row.status, 'AVAILABLE', `${x.code} released`);
    assert.equal(row.room?.code, 'TR2', `${x.code} keeps its last known room`);
  }
});

/* ------------------------------------------------------------------------------------------ *
 * F-12 (returns side) — TEAM_LEADER / CALL_CENTER_MANAGER reach exactly the assignments of their room
 *   room = seat room (workIdentity.roomId), else the employee's room; CCM = every CALLCENTER room
 * ------------------------------------------------------------------------------------------ */
test('F-12: return-form + timeline use one room rule — seat room, else employee room; TL = own room, CCM = every call-centre room', async () => {
  const admin = await as('admin');
  const tl = await as('tl.tr1'); // TEAM_LEADER, room TR1
  const ccm = await as('mr.mahmoud'); // CALL_CENTER_MANAGER
  const world = await fx.world(admin);
  const [tr1, tr2] = [world.room('TR1'), world.room('TR2')];
  const callCenter = world.dept('Call Center');

  // A HOSPITAL room (none is seeded): one fixed room, reused across runs instead of a new one every time.
  let hospitalRoom = (await admin.req('GET', '/rooms')).body.data.find((r) => r.code === 'RFX-HOSPITAL');
  if (!hospitalRoom) {
    const created = await admin.req('POST', '/rooms', { body: { code: 'RFX-HOSPITAL', teamType: 'HOSPITAL' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    hospitalRoom = created.body.data;
  }

  const mkEmp = async (label, roomId) => {
    const r = await admin.req('POST', '/employees', { body: { fullName: `RFX ${label} ${uid()}`, departmentTeamId: callCenter.id, ...(roomId && { roomId }) } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  };
  const [inTr1, inTr2, noRoom] = await Promise.all([mkEmp('emp TR1', tr1.id), mkEmp('emp TR2', tr2.id), mkEmp('emp no room')]);

  const cases = [];
  const mk = async (name, employee, workIdentity, expect) => {
    const asset = await fx.asset(admin, world, 'Laptops', `scope ${name}`);
    const a = await fx.assignGeneric(admin, { employeeId: employee.id, asset, ...(workIdentity && { workIdentity }) });
    cases.push({ name, id: a.id, expect });
  };
  const seat = (roomId) => ({ name: `RFX seat ${uid()}`, ...(roomId ? { roomId } : { departmentTeamId: callCenter.id }) });
  //                 name                          employee  seat                      TL(TR1)  CCM
  await mk('no seat, employee in TR1', inTr1, null, { tl: true, ccm: true });
  await mk('no seat, employee in TR2', inTr2, null, { tl: false, ccm: true });
  await mk('no seat, employee without a room', noRoom, null, { tl: false, ccm: false });
  await mk('seat in TR1, employee in TR2 (seat wins)', inTr2, seat(tr1.id), { tl: true, ccm: true });
  await mk('seat in TR2, employee in TR1 (seat wins)', inTr1, seat(tr2.id), { tl: false, ccm: true });
  await mk('seat without a room, employee in TR1 (falls back to the employee)', inTr1, seat(null), { tl: true, ccm: true });
  await mk('seat without a room, employee in TR2 (falls back to the employee)', inTr2, seat(null), { tl: false, ccm: true });
  await mk('seat in a HOSPITAL room, employee in TR1', inTr1, seat(hospitalRoom.id), { tl: false, ccm: false });

  for (const { name, id, expect } of cases) {
    for (const [who, client] of [['TL tr1', tl], ['CCM', ccm]]) {
      const allowed = who === 'CCM' ? expect.ccm : expect.tl;
      for (const path of [`/assignments/${id}/return-form`, `/assignments/${id}/timeline`]) {
        const r = await client.req('GET', path);
        assert.equal(r.status, allowed ? 200 : 404, `${who} GET ${path.replace(id, ':id')} — ${name}: ${JSON.stringify(r.body).slice(0, 120)}`);
      }
    }
    // the admin always reaches it; scoped users still cannot write
    assert.equal((await admin.req('GET', `/assignments/${id}/timeline`)).status, 200);
    assert.equal((await ccm.req('POST', `/assignments/${id}/return`, { body: { returnCondition: 'GOOD' } })).status, 403);
  }

  // leave nothing held by the scoped employees behind (the other suites assert on TL / CCM asset scopes)
  for (const { id } of cases) assert.equal((await fx.ret(admin, id, { returnCondition: 'GOOD' })).status, 200);
});
