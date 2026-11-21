'use strict';

const prisma = require('../db');
const { conflict, badRequest, notFound } = require('../utils/errors');

/** BE-1 — Assignment creation + listing + detail (phone wizard persistence layer).
 * Owns the create-and-activate transaction, the dual-active guard, the handover
 * snapshot builder, and the generic DRAFT → ACTIVE activation path (shared with the
 * phone wizard and reused by Phase-3/4 "other types").
 */

/** Default expected return = assignedAt + 1 month (assumption A2 / README §8). */
const DEFAULT_RETURN_MONTHS = 1;

/** Next human-friendly assignment code, e.g. A-000042 (per-prefix PostgreSQL sequence).
 * Assignment codes use the single-letter prefix "A" (contract §7.1), which the asset
 * code generator rejects (it requires 2–5 letters), so this is its own sequence.
 */
async function nextAssignmentCode(tx = prisma) {
  const seq = 'assignment_code_seq';
  await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${seq}" START 1`);
  const [{ n }] = await tx.$queryRawUnsafe(`SELECT nextval('${seq}')::int AS n`);
  return `A-${String(n).padStart(6, 0)}`;
}

/** Transaction-scoped advisory locks on `${scope}:${key}`, always taken in sorted order (so concurrent
 * requests can never deadlock on lock order). The lock is released at COMMIT/ROLLBACK; outside a
 * transaction it is a no-op. Used to serialise handovers that touch the same asset or phone number:
 * the loser then reads the winner's committed state and gets a precise 409. */
async function lockKeys(tx, scope, keys) {
  for (const key of [...new Set(keys.filter(Boolean))].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${scope}:${key}`}))`;
  }
}

/** Assert that every given asset can be handed over right now (dual-active guard, contract §7.3/§7.6).
 * An asset is free only when ALL of these hold — otherwise a 409 CONFLICT names the first offender,
 * its status, its holder and (if any) the active assignment:
 *   - status is AVAILABLE (so IN_REPAIR / DISPOSED / ASSIGNED / RETURNED are refused — QA F-09),
 *   - it has no current holder (an asset left ASSIGNED by a return with missing items has no active
 *     item but is still held — QA F-03),
 *   - it is not part of another ACTIVE (or DRAFT-reserved) assignment.
 * Ids that do not exist are skipped here: the callers report those as a field-specific 400.
 * @param {string[]} assetIds
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} [excludeAssignmentId] skip items belonging to this assignment (its own DRAFT-reserved items)
 */
async function assertAssetsFree(assetIds, tx = prisma, excludeAssignmentId) {
  const unique = [...new Set(assetIds.filter(Boolean))];
  if (!unique.length) return;
  await lockKeys(tx, 'handover-asset', unique);
  const assets = await tx.asset.findMany({
    where: { id: { in: unique } },
    select: { id: true, code: true, name: true, status: true, currentHolderEmployeeId: true, currentHolder: { select: { id: true, fullName: true } } },
  });
  const activeItems = await tx.assignmentItem.findMany({
    where: { assetId: { in: unique }, isActive: true, ...(excludeAssignmentId ? { assignmentId: { not: excludeAssignmentId } } : {}) },
    select: { assetId: true, assignment: { select: { assignmentCode: true } } },
  });
  const byId = new Map(assets.map((a) => [a.id, a]));
  const assignmentCodeByAsset = new Map(activeItems.map((i) => [i.assetId, i.assignment.assignmentCode]));
  for (const id of unique) {
    const asset = byId.get(id);
    if (!asset) continue;
    const assignmentCode = assignmentCodeByAsset.get(id) ?? null;
    if (asset.status === 'AVAILABLE' && !asset.currentHolderEmployeeId && !assignmentCode) continue;
    const why = [`status ${asset.status}`];
    if (asset.currentHolder) why.push(`held by ${asset.currentHolder.fullName}`);
    if (assignmentCode) why.push(`in active assignment ${assignmentCode}`);
    throw conflict(`Asset "${asset.code}" (${asset.name}) is not available for handover: ${why.join(', ')}`, {
      assetId: asset.id,
      assetCode: asset.code,
      status: asset.status,
      heldBy: asset.currentHolder ?? null,
      assignmentCode,
    });
  }
}

/** Hand the assets over: ASSIGNED + holder (+ room). The UPDATE is a compare-and-swap on the free state
 * (AVAILABLE and unheld), so two concurrent handovers of one asset can never both win: the loser matches
 * fewer rows than expected and the whole transaction rolls back with a 409.
 * @param {string[]} assetIds distinct asset ids
 */
async function flipAssetsToAssigned(tx, assetIds, employeeId, roomId) {
  const res = await tx.asset.updateMany({
    where: { id: { in: assetIds }, status: 'AVAILABLE', currentHolderEmployeeId: null },
    data: { status: 'ASSIGNED', currentHolderEmployeeId: employeeId, ...(roomId ? { roomId } : {}) },
  });
  if (res.count !== assetIds.length) {
    throw conflict('An asset was handed over to someone else while this request was being processed; reload and try again');
  }
}

/** Load assets by id with their category (+ parent category), keyed by id. */
async function loadAssetsById(tx, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await tx.asset.findMany({
    where: { id: { in: unique } },
    select: {
      id: true, code: true, name: true,
      category: { select: { name: true, parent: { select: { name: true } } } },
    },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

/** True when the asset's category — or its parent category — is called `name` (case-insensitive). */
function inCategory(asset, name) {
  const wanted = name.trim().toLowerCase();
  return [asset.category?.name, asset.category?.parent?.name].some((n) => typeof n === 'string' && n.trim().toLowerCase() === wanted);
}

/** Phone-wizard slot → the category the asset in that slot must belong to (QA F-10). */
const PHONE_PART_CATEGORIES = [
  ['sim1AssetId', 'SIM Cards'],
  ['sim2AssetId', 'SIM Cards'],
  ['chargerCableAssetId', 'Charger Cables'],
  ['chargerAdapterAssetId', 'Charger Adapters'],
];

/** The SIM / charger assets of a phone handover must exist and sit in the matching category.
 * Throws 400 (never a Prisma FK 409) naming the offending field. */
async function assertPhonePartsValid(body, tx = prisma) {
  const found = await loadAssetsById(tx, PHONE_PART_CATEGORIES.map(([field]) => body[field]));
  for (const [field, categoryName] of PHONE_PART_CATEGORIES) {
    const id = body[field];
    if (!id) continue;
    const asset = found.get(id);
    if (!asset) throw badRequest(`${field} does not exist`);
    if (!inCategory(asset, categoryName)) {
      throw badRequest(`${field} must be an asset of the "${categoryName}" category ("${asset.code}" is in "${asset.category?.name}")`);
    }
  }
}

/** Assert that none of the given account ids is currently bound to an ACTIVE assignment.
 * Throws 409 CONFLICT on the first offender (dual-active guard for accounts, §7.6).
 * NOTE: This only checks actual account IDs (Bitrix). WhatsApp identifiers (wa1:/wa2:)
 * are checked separately by the route handler because they are not UUIDs.
 * @param {string[]} accountIds - Actual account IDs (UUIDs)
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 */
async function assertAccountsFree(accountIds, tx = prisma) {
  const unique = [...new Set(accountIds.filter(Boolean))];
  if (!unique.length) return;
  const used = await tx.account.findFirst({
    where: { id: { in: unique }, currentAssignmentId: { not: null } },
    select: { id: true, identifier: true, currentAssignment: { select: { assignmentCode: true, status: true } } },
  });
  if (used) {
    throw conflict(`Account "${used.identifier}" is already in use by assignment ${used.currentAssignment?.assignmentCode ?? '(unknown)'}`);
  }
}

/** Assert that the given IMEI is not already assigned to an ACTIVE phone assignment.
 * The IMEI lives on the phone's PhoneDetail; a phone already in an ACTIVE assignment
 * is caught by assertAssetsFree, but the IMEI is checked explicitly for clarity.
 * @param {string} imei
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 */
async function assertImeiFree(imei, tx = prisma) {
  if (!imei) return;
  const phone = await tx.phoneDetail.findUnique({ where: { imei }, select: { assetId: true } });
  if (!phone) return;
  const active = await tx.assignmentItem.findFirst({ where: { assetId: phone.assetId, isActive: true }, select: { id: true } });
  if (active) throw conflict(`IMEI ${imei} is already assigned to an active assignment`);
}

/** Digits only: "+90 536 970 08 89" and "905369700889" are the same phone number. */
const digitsOf = (n) => String(n ?? '').replace(/\D/g, '');

/** PhoneAssignmentDetail columns that hold a phone number, with the label used in error messages. */
const NUMBER_SLOTS = [
  ['sim1Number', 'SIM 1'],
  ['sim2Number', 'SIM 2'],
  ['wa1PhoneNumber', 'WhatsApp 1'],
  ['wa2PhoneNumber', 'WhatsApp 2'],
];

/** Assert that none of the given phone numbers (SIM or WhatsApp — the SIM number is the single source,
 * so they share one namespace) is already used by another ACTIVE assignment (QA F-02). Two places hold
 * a number and both are checked: a WHATSAPP account bound to a live assignment, and the SIM / WhatsApp
 * columns of every ACTIVE phone assignment. Numbers are compared digits-only. Throws 409 naming the
 * assignment code. Concurrent requests for the same number are serialised with a transaction-scoped
 * advisory lock, so the loser sees the winner's committed row instead of both passing the check.
 * @param {Array<string|null|undefined>} numbers
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} [excludeAssignmentId] ignore this assignment (e.g. while activating it)
 */
async function assertNumbersFree(numbers, tx = prisma, excludeAssignmentId) {
  const wanted = [...new Set(numbers.map(digitsOf).filter(Boolean))];
  if (!wanted.length) return;
  await lockKeys(tx, 'handover-phone-number', wanted);
  const live = { status: 'ACTIVE', ...(excludeAssignmentId ? { id: { not: excludeAssignmentId } } : {}) };

  const accounts = await tx.account.findMany({
    where: { kind: 'WHATSAPP', currentAssignment: live },
    select: { identifier: true, currentAssignment: { select: { assignmentCode: true } } },
  });
  for (const a of accounts) {
    if (!wanted.includes(digitsOf(a.identifier))) continue;
    const assignmentCode = a.currentAssignment.assignmentCode;
    throw conflict(`WhatsApp account "${a.identifier}" is already in use by active assignment ${assignmentCode}`, { number: a.identifier, assignmentCode });
  }

  const details = await tx.phoneAssignmentDetail.findMany({
    where: { assignment: live },
    select: { sim1Number: true, sim2Number: true, wa1PhoneNumber: true, wa2PhoneNumber: true, assignment: { select: { assignmentCode: true } } },
  });
  for (const d of details) {
    for (const [field, label] of NUMBER_SLOTS) {
      if (!d[field] || !wanted.includes(digitsOf(d[field]))) continue;
      const assignmentCode = d.assignment.assignmentCode;
      throw conflict(`Phone number "${d[field]}" is already in use (${label}) by active assignment ${assignmentCode}`, { number: d[field], slot: label, assignmentCode });
    }
  }
}

/** Prisma `where` for "this assignment sits in a room matching `roomWhere`" — the assignment's room is the
 * work-identity (seat) room, else the employee's room (contract §11). Used by the list, the detail guard and
 * the photo guard so all three give the same answer.
 * @param {import('@prisma/client').Prisma.RoomWhereInput} roomWhere e.g. { id } or { teamType: 'CALLCENTER' }
 */
function assignmentRoomWhere(roomWhere) {
  return {
    OR: [
      { workIdentity: { room: roomWhere } },
      { OR: [{ workIdentity: { is: null } }, { workIdentity: { roomId: null } }], employee: { room: roomWhere } },
    ],
  };
}

/** Room scope (rbac.roomScope) → assignment `where`. null scope = unrestricted. */
function assignmentScopeWhere(scope) {
  if (!scope) return {};
  return assignmentRoomWhere(scope.allCallCenter ? { teamType: 'CALLCENTER' } : { id: scope.roomId });
}

/** Resolve a WorkIdentity on-the-fly from { name, departmentTeamId, roomId },
 * creating it or re-activating an existing seat (CHANGE 4, contract §5.10).
 *
 * - Call-center identities (roomId set) use the @unique([name, roomId]) upsert.
 * - Non-call-center identities (roomId null) must NOT use upsert on the compound
 *   key: Postgres treats NULL as distinct in a unique index, so a NULL-room
 *   "name_roomId" upsert can never match. We match explicitly on
 *   name + departmentTeamId via findFirst instead (unique constraint §5.1).
 *
 * Returns the resolved WorkIdentity row ({ id, ... }). Caller uses `.id`.
 */
async function resolveWorkIdentity({ name, departmentTeamId, roomId }, tx = prisma) {
  const n = String(name ?? '').trim();
  if (!n) throw badRequest('workIdentity.name is required');
  if (roomId) {
    // Call-center seat: unique index @unique([name, roomId]) matches exactly.
    return tx.workIdentity.upsert({
      where: { name_roomId: { name: n, roomId } },
      update: { departmentTeamId: departmentTeamId ?? null, isActive: true },
      create: { name: n, departmentTeamId: departmentTeamId ?? null, roomId, isActive: true },
    });
  }
  // Non-call-center: room is null. Match explicitly by name + department.
  const existing = await tx.workIdentity.findFirst({
    where: { name: n, departmentTeamId },
  });
  if (existing) return existing;
  return tx.workIdentity.create({ data: { name: n, departmentTeamId, roomId, isActive: true } });
}

/** Resolve phone account IDs from the request body.
 * @param {Object} body - The request body
 * @returns {Object} { accountIds: string[], waIds: Array<{type: 'wa1'|'wa2', number: string}> }
 * - accountIds: Valid account IDs (UUIDs) for Bitrix accounts
 * - waIds: WhatsApp number identifiers (not UUIDs, handled separately)
 */
function resolvePhoneAccountIds({ bitrixAccountId, wa1PhoneNumber, wa2PhoneNumber }) {
  const accountIds = [];
  const waIds = [];
  if (bitrixAccountId) accountIds.push(bitrixAccountId);
  if (wa1PhoneNumber) waIds.push({ type: 'wa1', number: wa1PhoneNumber });
  if (wa2PhoneNumber) waIds.push({ type: 'wa2', number: wa2PhoneNumber });
  return { accountIds, waIds };
}

/** BE-1 — Phone assignment creation + listing + detail.
 * Core phone wizard (contract §7.6): create + activate atomically in one transaction.
 * @returns the fully hydrated ACTIVE assignment.
 */
async function createPhoneAssignment(body, userId) {
  const {
    employeeId, workIdentityId, workIdentity, phoneAssetId, imei,
    sim1Number, sim1AssetId,
    wa1Business, wa1PhoneNumber, wa1BackupEmail, wa1BackupDate, wa1BackupUsedGB, wa1BackupTotalGB,
    wa1ChatNormalCount, wa1ChatArchivedCount, wa1AppVariant,
    sim2Number, sim2AssetId,
    wa2Business, wa2PhoneNumber, wa2BackupEmail, wa2BackupDate, wa2BackupUsedGB, wa2BackupTotalGB,
    wa2ChatNormalCount, wa2ChatArchivedCount, wa2AppVariant,
    bitrixAccountId, chargerCableAssetId, chargerAdapterAssetId,
    expectedReturnAt, notes,
    condition,
  } = body;

  const assetIds = phoneAssetIds({ phoneAssetId, sim1AssetId, sim2AssetId, chargerCableAssetId, chargerAdapterAssetId });
  const { accountIds, waIds } = resolvePhoneAccountIds({ bitrixAccountId, wa1PhoneNumber, wa2PhoneNumber });

  // The same asset in two slots would collide on the (assignment, asset) unique key and surface as a 409.
  if (new Set(assetIds).size !== assetIds.length) throw badRequest('The same asset cannot be used in more than one slot of a phone handover');

  // SIM-single-source invariant (SIM_WHATSAPP_CORRECTIONS_PLAN): the SIM number and the
  // WhatsApp number must be the same. Enforce server-side so a bad client can't corrupt the record.
  if (sim1Number && wa1PhoneNumber && String(sim1Number).trim() !== String(wa1PhoneNumber).trim()) {
    throw badRequest('sim1Number and wa1PhoneNumber must be equal (the SIM number is the single source)');
  }
  if (sim2Number && wa2PhoneNumber && String(sim2Number).trim() !== String(wa2PhoneNumber).trim()) {
    throw badRequest('sim2Number and wa2PhoneNumber must be equal (the SIM number is the single source)');
  }
  // Slot 1 and slot 2 are two different SIMs: one number cannot sit in both.
  const slot1Number = digitsOf(sim1Number || wa1PhoneNumber);
  const slot2Number = digitsOf(sim2Number || wa2PhoneNumber);
  if (slot1Number && slot1Number === slot2Number) throw badRequest('The SIM 1 / WhatsApp 1 number and the SIM 2 / WhatsApp 2 number must be different');
  const phoneNumbers = [sim1Number, sim2Number, wa1PhoneNumber, wa2PhoneNumber];

  return prisma.$transaction(async (tx) => {
    // workIdentityId (legacy) takes precedence; otherwise upsert the seat on-the-fly.
    const wid = workIdentityId ?? (workIdentity && (await resolveWorkIdentity(workIdentity, tx)).id);

    // Validate the phone asset is a Phones-category asset.
    const phoneAsset = await tx.asset.findUnique({
      where: { id: phoneAssetId },
      include: { category: { select: { name: true } }, phoneDetail: { select: { imei: true } } },
    });
    if (!phoneAsset) throw badRequest('phoneAssetId does not exist');
    if (phoneAsset.category.name !== 'Phones') throw badRequest('phoneAssetId must be a Phones-category asset');

    // A request IMEI is only a cross-check of the selected phone (the IMEI lives on the asset): it must match (QA F-08).
    const assetImei = phoneAsset.phoneDetail?.imei ?? null;
    if (imei && imei !== assetImei) {
      throw badRequest(assetImei ? `imei does not match the IMEI recorded for phone "${phoneAsset.code}"` : `imei was supplied but phone "${phoneAsset.code}" has no IMEI on record`);
    }

    // SIM / charger ids must exist and be of the right category (400, not a FK 409) — QA F-10.
    await assertPhonePartsValid({ sim1AssetId, sim2AssetId, chargerCableAssetId, chargerAdapterAssetId }, tx);

    // Dual-use guards: assets (status/holder/active item), IMEI, accounts, phone numbers.
    await assertAssetsFree(assetIds, tx);
    await assertImeiFree(imei ?? assetImei, tx);
    await assertAccountsFree(accountIds, tx);
    await assertNumbersFree(phoneNumbers, tx);

    const code = await nextAssignmentCode(tx);
    const now = new Date();
    const expReturn = expectedReturnAt ? new Date(expectedReturnAt) : new Date(now.getTime() + DEFAULT_RETURN_MONTHS * 30 * 24 * 3600 * 1000);

    const assignment = await tx.assignment.create({
      data: {
        assignmentCode: code,
        type: 'PHONE',
        employeeId,
        workIdentityId: wid ?? null,
        assetId: phoneAssetId,
        status: 'ACTIVE',
        assignedAt: now,
        expectedReturnAt: expReturn,
        notes: notes ?? null,
        createdById: userId,
      },
    });

    // Assignment items: PRIMARY + SIM1 + SIM2 + CHARGER_CABLE + CHARGER_ADAPTER (only for present assets).
    const items = [
      { assetId: phoneAssetId, role: 'PRIMARY', conditionAtHandover: phoneAsset.condition },
      ...(sim1AssetId ? [{ assetId: sim1AssetId, role: 'SIM1', conditionAtHandover: condition ?? 'GOOD' }] : []),
      ...(sim2AssetId ? [{ assetId: sim2AssetId, role: 'SIM2', conditionAtHandover: condition ?? 'GOOD' }] : []),
      ...(chargerCableAssetId ? [{ assetId: chargerCableAssetId, role: 'CHARGER_CABLE', conditionAtHandover: condition ?? 'GOOD' }] : []),
      ...(chargerAdapterAssetId ? [{ assetId: chargerAdapterAssetId, role: 'CHARGER_ADAPTER', conditionAtHandover: condition ?? 'GOOD' }] : []),
    ];
    await tx.assignmentItem.createMany({
      data: items.map((i) => ({ ...i, assignmentId: assignment.id, isActive: true })),
    });

    // Phone assignment detail (full §3.2 field set).
    const phoneDetail = await tx.phoneAssignmentDetail.create({
      data: {
        assignmentId: assignment.id,
        sim1Number: sim1Number ?? null,
        sim1AssetId: sim1AssetId ?? null,
        wa1Business: wa1Business ?? false,
        wa1PhoneNumber: wa1PhoneNumber ?? null,
        wa1BackupEmail: wa1BackupEmail ?? null,
        wa1BackupDate: wa1BackupDate ? new Date(wa1BackupDate) : null,
        wa1BackupUsedGB: wa1BackupUsedGB ?? null,
        wa1BackupTotalGB: wa1BackupTotalGB ?? null,
        wa1ChatNormalCount: wa1ChatNormalCount ?? null,
        wa1ChatArchivedCount: wa1ChatArchivedCount ?? null,
        wa1AppVariant: wa1AppVariant ?? null,
        sim2Number: sim2Number ?? null,
        sim2AssetId: sim2AssetId ?? null,
        wa2Business: wa2Business ?? false,
        wa2PhoneNumber: wa2PhoneNumber ?? null,
        wa2BackupEmail: wa2BackupEmail ?? null,
        wa2BackupDate: wa2BackupDate ? new Date(wa2BackupDate) : null,
        wa2BackupUsedGB: wa2BackupUsedGB ?? null,
        wa2BackupTotalGB: wa2BackupTotalGB ?? null,
        wa2ChatNormalCount: wa2ChatNormalCount ?? null,
        wa2ChatArchivedCount: wa2ChatArchivedCount ?? null,
        wa2AppVariant: wa2AppVariant ?? null,
        bitrixAccountId: bitrixAccountId ?? null,
        chargerCableAssetId: chargerCableAssetId ?? null,
        chargerAdapterAssetId: chargerAdapterAssetId ?? null,
        notes: notes ?? null,
      },
    });

    // Flip assets to ASSIGNED + holder + room.
    const widRoom = wid ? await tx.workIdentity.findUnique({ where: { id: wid }, select: { roomId: true } }) : null;
    await flipAssetsToAssigned(tx, assetIds, employeeId, widRoom?.roomId);

    // Bind accounts: actual account IDs (Bitrix) by ID, WhatsApp by identifier.
    if (accountIds.length) {
      await tx.account.updateMany({ where: { id: { in: accountIds } }, data: { currentAssignmentId: assignment.id } });
    }
    // WhatsApp accounts are bound by identifier (the number). assertNumbersFree() above already proved no
    // other live assignment uses these numbers, so this only (re)binds a free — or stale — account.
    for (const wa of waIds) {
      const account = await tx.account.findFirst({
        where: { kind: 'WHATSAPP', identifier: { in: [...new Set([wa.number, digitsOf(wa.number)])] } },
      });
      if (account) {
        await tx.account.update({ where: { id: account.id }, data: { currentAssignmentId: assignment.id } });
      }
    }

    // Handover snapshot timeline entry (primary asset).
    const snapshot = buildSnapshot(assignment, phoneDetail, items);
    await writeAssignedEntry(tx, assignment, phoneAssetId, snapshot, userId);

    // Per-item timeline entries (BE-19): every non-primary item gets its own entry.
    for (const item of items) {
      if (item.assetId === phoneAssetId) continue;
      await writeAssignedEntry(tx, assignment, item.assetId, snapshot, userId);
    }

    return { assignment, phoneDetail, items, snapshot };
  });
}

/** Build the handover snapshot for the timeline entry.
 * @param {Object} assignment - The assignment object
 * @param {Object} phoneDetail - The phone detail object (or null)
 * @param {Array} items - The assignment items
 * @returns {Object} The snapshot object
 */
function buildSnapshot(assignment, phoneDetail, items) {
  return {
    assignmentCode: assignment.assignmentCode,
    type: assignment.type,
    status: assignment.status,
    assignedAt: assignment.assignedAt,
    expectedReturnAt: assignment.expectedReturnAt,
    employeeId: assignment.employeeId,
    workIdentityId: assignment.workIdentityId,
    assetId: assignment.assetId,
    notes: assignment.notes ?? null,
    phoneDetail: phoneDetail ?? null,
    items: items?.map((i) => ({
      assetId: i.assetId,
      role: i.role,
      conditionAtHandover: i.conditionAtHandover,
      isActive: i.isActive ?? true,
    })) ?? [],
  };
}

/** Append an ASSIGNED timeline entry for one asset of an assignment.
 * Uses Prisma's unchecked (scalar-FK) input throughout: it rejects a mix of `connect`
 * relations and scalar FKs such as `createdById` ("Unknown argument `createdById`"), and
 * `employeeId` is required on every entry. Same style as return.service.js.
 */
function writeAssignedEntry(tx, assignment, assetId, snapshot, userId) {
  return tx.assignmentTimelineEntry.create({
    data: {
      assignmentId: assignment.id,
      assetId,
      employeeId: assignment.employeeId,
      workIdentityId: assignment.workIdentityId ?? null,
      eventType: 'ASSIGNED',
      snapshot,
      createdById: userId,
    },
  });
}

/** Get the asset IDs that are part of the phone assignment.
 * @param {Object} opts - The options
 * @returns {string[]} Array of asset IDs
 */
function phoneAssetIds({ phoneAssetId, sim1AssetId, sim2AssetId, chargerCableAssetId, chargerAdapterAssetId }) {
  const ids = [phoneAssetId];
  if (sim1AssetId) ids.push(sim1AssetId);
  if (sim2AssetId) ids.push(sim2AssetId);
  if (chargerCableAssetId) ids.push(chargerCableAssetId);
  if (chargerAdapterAssetId) ids.push(chargerAdapterAssetId);
  return ids;
}

/** Create a draft assignment (not yet active).
 * @param {Object} body - The request body
 * @returns {Promise<Object>} The created assignment
 */
async function createDraft(body, userId) {
  const code = await nextAssignmentCode();
  const now = new Date();
  const expReturn = new Date(now.getTime() + DEFAULT_RETURN_MONTHS * 30 * 24 * 3600 * 1000);
  return prisma.assignment.create({
    data: {
      assignmentCode: code,
      type: 'PHONE',
      employeeId: body.employeeId,
      phoneAssetId: body.phoneAssetId,
      status: 'DRAFT',
      assignedAt: now,
      expectedReturnAt: expReturn,
      notes: body.notes ?? null,
      createdById: userId,
    },
  });
}

/** Activate a draft assignment.
 * @param {string} assignmentId - The assignment ID
 * @param {string} userId - The user ID
 * @returns {Promise<Object>} The activated assignment
 */
async function activate(assignmentId, userId) {
  return prisma.assignment.update({
    where: { id: assignmentId },
    data: { status: 'ACTIVE', updatedAt: new Date() },
  });
}

/** CREATE + ACTIVATE a NON-phone assignment atomically in one transaction.
 * Accepts LAPTOP / PRINTER / SIM / GENERAL asset types. PHONE is rejected by the
 * route-level schema (phones must go through /assignments/phone).
 * Flipping the PRIMARY asset to ASSIGNED, setting holder + room from the resolved
 * work identity, writing an ASSIGNED timeline snapshot (phoneDetail:null),
 * and honouring expectedReturnAt.
 * @returns {Promise<{assignment, items, snapshot}>}
 */
async function createGenericAssignment(body, userId) {
  const {
    type, employeeId, workIdentityId, workIdentity, assetId,
    conditionAtHandover, expectedReturnAt, notes,
  } = body;
  // The route schema is .nullish(): a client may send null, which must behave like "not provided".
  const accessoryAssetIds = body.accessoryAssetIds ?? [];
  const accessoryConditions = body.accessoryConditions ?? [];

  // Accessory input sanity (400s before the DB is touched). A repeated id would otherwise hit the
  // (assignment, asset) unique key and come back as a confusing 409.
  if (new Set(accessoryAssetIds).size !== accessoryAssetIds.length) throw badRequest('accessoryAssetIds lists the same asset more than once');
  if (accessoryAssetIds.includes(assetId)) throw badRequest('assetId cannot also be listed in accessoryAssetIds');
  // Per-accessory handover condition (QA F-22). An accessory without an entry is handed over GOOD.
  const accessoryCondition = new Map();
  for (const { assetId: id, condition: c } of accessoryConditions) {
    if (!accessoryAssetIds.includes(id)) throw badRequest(`accessoryConditions refers to asset ${id}, which is not in accessoryAssetIds`);
    if (accessoryCondition.has(id)) throw badRequest(`accessoryConditions lists asset ${id} more than once`);
    accessoryCondition.set(id, c);
  }

  return prisma.$transaction(async (tx) => {
    // The PRIMARY asset must exist and must NOT be a Phones-category asset.
    const asset = await tx.asset.findUnique({
      where: { id: assetId },
      include: { category: { select: { name: true } } },
    });
    if (!asset) throw badRequest('assetId does not exist');
    if (asset.category.name === 'Phones') throw badRequest('phone assets must be assigned via /assignments/phone');

    // Accessories must exist: say so with a 400 instead of letting the FK error surface as a 409 (QA F-22).
    if (accessoryAssetIds.length) {
      const found = await loadAssetsById(tx, accessoryAssetIds);
      const unknown = accessoryAssetIds.filter((id) => !found.has(id));
      if (unknown.length) throw badRequest(`accessoryAssetIds contains unknown asset id(s): ${unknown.join(', ')}`);
    }

    // All involved assets (PRIMARY + accessories) must be free: AVAILABLE, unheld and in no active assignment.
    const allAssetIds = [assetId, ...accessoryAssetIds];
    await assertAssetsFree(allAssetIds, tx);

    // workIdentityId (legacy) takes precedence; otherwise upsert the seat on-the-fly.
    const wid = workIdentityId ?? (workIdentity && (await resolveWorkIdentity(workIdentity, tx)).id);

    const code = await nextAssignmentCode(tx);
    const now = new Date();
    const expReturn = expectedReturnAt ? new Date(expectedReturnAt) : new Date(now.getTime() + DEFAULT_RETURN_MONTHS * 30 * 24 * 3600 * 1000);

    const assignment = await tx.assignment.create({
      data: {
        assignmentCode: code,
        type, // validated by the route (genericType) — 'GENERIC' is not an AssignmentType value
        employeeId,
        workIdentityId: wid ?? null,
        assetId,
        status: 'ACTIVE',
        assignedAt: now,
        expectedReturnAt: expReturn,
        notes: notes ?? null,
        createdById: userId,
      },
    });

    // Assignment items: PRIMARY + BUNDLED (accessories, each with its own handover condition).
    const items = [
      { assignmentId: assignment.id, assetId, role: 'PRIMARY', conditionAtHandover: conditionAtHandover ?? 'GOOD', isActive: true },
      ...accessoryAssetIds.map((id) => ({ assignmentId: assignment.id, assetId: id, role: 'BUNDLED', conditionAtHandover: accessoryCondition.get(id) ?? 'GOOD', isActive: true })),
    ];
    await tx.assignmentItem.createMany({
      data: items,
    });

    // Flip ALL involved assets to ASSIGNED + holder + room (from the work identity's room).
    const widRoom = wid ? await tx.workIdentity.findUnique({ where: { id: wid }, select: { roomId: true } }) : null;
    await flipAssetsToAssigned(tx, allAssetIds, employeeId, widRoom?.roomId);

    // ASSIGNED handover snapshot (no phone detail for generic types).
    const snapshot = buildSnapshot(assignment, null, items);
    await writeAssignedEntry(tx, assignment, assignment.assetId, snapshot, userId);

    // Per-item timeline entries (BE-19): every bundled (accessory) item gets its own entry.
    for (const item of items) {
      if (item.assetId === assetId) continue;
      await writeAssignedEntry(tx, assignment, item.assetId, snapshot, userId);
    }

    return { assignment, items, snapshot };
  });
}

module.exports = {
  DEFAULT_RETURN_MONTHS,
  nextAssignmentCode,
  assertAssetsFree,
  assertAccountsFree,
  assertImeiFree,
  assertNumbersFree,
  assertPhonePartsValid,
  assignmentRoomWhere,
  assignmentScopeWhere,
  resolveWorkIdentity,
  buildSnapshot,
  phoneAssetIds,
  resolvePhoneAccountIds,
  createDraft,
  activate,
  createPhoneAssignment,
  createGenericAssignment,
};
