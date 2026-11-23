'use strict';
const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const { asyncHandler, notFound, badRequest, conflict } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { requireCapability, roomScope } = require('../middleware/rbac');
const { paginationQuery, paginate, pageMeta } = require('../utils/pagination');
const { audit } = require('../services/audit.service');
const { upload, persistImages, removeFile } = require('../services/upload.service');
const svc = require('../services/asset.service');
const { assignmentScopeWhere } = require('../services/assignment.service');
const { getUnreturned } = require('../services/return.service');

const router = express.Router();
const read = requireCapability('inventory:read');
const write = requireCapability('inventory:write');

const idParams = z.object({ id: z.uuid() });
/** Conditions ranked best → worst: NEW > GOOD > FAIR > POOR > DAMAGED > DISPOSED. The position is the rank (handover-history
 *  `change`); it is also the enum's declaration order, which is the order PostgreSQL gives `sort=condition`. */
const CONDITION_RANK = ['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'DISPOSED'];
const condition = z.enum(CONDITION_RANK);
// ASSIGNED / RETURNED are owned by the assignment lifecycle (Phase 2/3) and cannot be set by hand.
const manualStatus = z.enum(['AVAILABLE', 'IN_REPAIR', 'DISPOSED']);
const status = z.enum(['AVAILABLE', 'ASSIGNED', 'RETURNED', 'DISPOSED', 'IN_REPAIR']);

const phoneBody = z.object({
  imei: z.string().trim().regex(/^\d{14,17}$/, 'IMEI must be 14-17 digits'),
  color: z.string().trim().max(50).nullish(),
  storage: z.string().trim().max(50).nullish(),
  model: z.string().trim().max(100).nullish(),
  make: z.string().trim().max(100).nullish(),
  carrier: z.string().trim().max(100).nullish(),
  operatingSystem: z.string().trim().max(100).nullish(),
  appBinary: z.enum(['BUSINESS', 'NORMAL']).nullish(),
}).strict();

const customFields = z.record(z.string(), z.unknown());

const createBody = z
  .object({
    categoryId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    serialNumber: z.string().trim().max(100).nullish(),
    qty: z.number().int().min(0).max(100000).default(1),
    condition: condition.default('GOOD'),
    status: manualStatus.default('AVAILABLE'),
    roomId: z.uuid().nullish(),
    notes: z.string().trim().max(5000).nullish(),
    customFields: customFields.default({}),
    phone: phoneBody.nullish(),
  })
  .strict();

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    categoryId: z.uuid(),
    serialNumber: z.string().trim().max(100).nullable(),
    qty: z.number().int().min(0).max(100000),
    condition,
    status: manualStatus,
    roomId: z.uuid().nullable(),
    notes: z.string().trim().max(5000).nullable(),
    customFields,
    phone: phoneBody.partial().strict().nullable(),
  })
  .partial()
  .strict();

/**
 * Phase 9 / P2 — `sort` + `order` on the list. The key is whitelisted (an unknown one is a 400 VALIDATION_ERROR that
 * names the allowed keys). Default = newest first, as before. `updatedAt` is the pre-Phase-9 key: still accepted so
 * nothing that used it breaks, but not advertised.
 */
const SORT_KEYS = ['createdAt', 'code', 'name', 'condition', 'status', 'category'];
const sortQuery = {
  sort: z.enum([...SORT_KEYS, 'updatedAt'], { error: `Unknown sort key. Allowed: ${SORT_KEYS.join(', ')}` }).default('createdAt'),
  order: z.enum(['asc', 'desc'], { error: 'Invalid order. Allowed: asc, desc' }).default('desc'),
};

/**
 * Prisma orderBy for a sort key: the key itself, then the asset code as the natural tie-break (so a column of equal
 * conditions / statuses reads in code order) and ALWAYS `id` last, so rows with equal values page deterministically.
 * `category` sorts by the category's name through the relation; `condition` and `status` follow the enum's declaration
 * order (best → worst condition, the lifecycle order of the status) — the order PostgreSQL gives an enum column.
 */
const orderByFor = (sort, dir) => [
  ...{
    createdAt: [{ createdAt: dir }],
    updatedAt: [{ updatedAt: dir }],
    code: [{ code: dir }],
    name: [{ name: dir }, { code: 'asc' }],
    condition: [{ condition: dir }, { code: 'asc' }],
    status: [{ status: dir }, { code: 'asc' }],
    category: [{ category: { name: dir } }, { code: 'asc' }],
  }[sort],
  { id: 'asc' },
];

const listQuery = z.object({
  ...paginationQuery,
  q: z.string().trim().max(100).optional(),
  imei: z.string().trim().max(20).optional(),
  code: z.string().trim().max(50).optional(),
  categoryId: z.uuid().optional(),
  condition: condition.optional(),
  status: status.optional(),
  roomId: z.uuid().optional(),
  holderId: z.uuid().optional(),
  ...sortQuery,
});

/** The asset's own gallery: inventory photos uploaded to the asset itself (POST /assets/:id/photos). Photos taken
 *  during a handover / return carry an assignmentId (and, for an item, this asset's id as assetId); they belong to
 *  that assignment and are reported per assignment in `photoHistory`, never mixed into the gallery (Phase 8 R5). */
const galleryPhotos = { assignmentId: null };

const listInclude = {
  category: { select: { id: true, name: true, parentId: true } },
  phoneDetail: { select: { imei: true, model: true, make: true, color: true, storage: true } },
  room: { select: { id: true, code: true } },
  currentHolder: { select: { id: true, fullName: true } },
  customValues: true,
  _count: { select: { photos: { where: galleryPhotos } } }, // gallery count — assignment photos are not the asset's own
};

/**
 * Shape an asset's EAV customValues into a { key: value } map, dropping the raw rows.
 * Shared by the list and detail handlers so the SIM wizard can read customFields.phone_number.
 */
function shapeCustomFields(asset, fields) {
  const { customValues, ...rest } = asset;
  return { ...rest, customFields: svc.shapeCustomFields(fields, customValues) };
}

/** Team leaders see assets located in their room or held by an employee of their room.
 *  CALL_CENTER_MANAGER sees assets in any CALLCENTER room or held by an employee of one. */
function scopeWhere(user) {
  const s = roomScope(user);
  if (!s) return {};
  if (s.allCallCenter) {
    return {
      OR: [
        { room: { teamType: 'CALLCENTER' } },
        { currentHolder: { room: { teamType: 'CALLCENTER' } } },
      ],
    };
  }
  return { OR: [{ roomId: s.roomId }, { currentHolder: { roomId: s.roomId } }] };
}

async function loadScoped(req, id, include) {
  const asset = await prisma.asset.findFirst({ where: { AND: [{ id }, scopeWhere(req.user)] }, include });
  if (!asset) throw notFound('Asset');
  return asset;
}

/** Category ids = the category plus its direct children. */
async function categoryIdsWithChildren(id) {
  const kids = await prisma.assetCategory.findMany({ where: { parentId: id }, select: { id: true } });
  return [id, ...kids.map((k) => k.id)];
}

/** Audit action under which a hand edit of an asset's condition is recorded (meta { from, to }). That is the only
 *  place such an edit can live: an AssignmentTimelineEntry needs an assignment and an employee, a hand edit has neither. */
const CONDITION_EDIT_ACTION = 'asset.condition.update';

/** Record a hand edit of the asset's condition inside the caller's transaction, so the edit and its record commit
 *  (or roll back) together. GET /assets/:id reads it back as lastConditionCheck.source 'manual'. */
function recordConditionEdit(tx, req, assetId, from, to) {
  return tx.auditLog.create({
    data: { actorId: req.user?.id ?? null, action: CONDITION_EDIT_ACTION, targetType: 'Asset', targetId: assetId, meta: { from, to }, ip: req.ip },
  });
}

/** `source` of a condition timeline entry. The handover write-back tags its entries reason 'handover' (the spec text
 *  also calls it 'delivery') → 'delivery'; 'return' → 'return', and so does 'return-resolved' — the entry written when
 *  an item that did not come back with the others is settled later as RETURNED (POST /assignments/:id/unreturned/resolve),
 *  which is still a return of that assignment (its assignmentCode is on the entry). The return flow predates the tag:
 *  its entries are UPDATED, carry an assignmentCode and no reason → 'return'. Anything else (another reason, or no
 *  assignment behind the entry) is a hand edit → 'manual'. */
function conditionEntrySource({ eventType, snapshot }) {
  const { reason, assignmentCode } = snapshot ?? {};
  if (reason === 'handover' || reason === 'delivery') return 'delivery';
  if (reason === 'return' || reason === 'return-resolved') return 'return';
  if (reason == null && eventType === 'UPDATED' && assignmentCode) return 'return';
  return 'manual';
}

/** lastConditionCheck (Phase 8 R4 rule 5): the newest record of this asset's condition being set — a handover /
 *  return timeline entry `{ field:'condition', from, to, assignmentCode, reason? }` or a hand edit (audit) — else its
 *  creation. { condition, at, source: 'created'|'delivery'|'return'|'manual', assignmentCode: string|null }. */
async function loadLastConditionCheck(asset) {
  const [entry, edit] = await Promise.all([
    prisma.assignmentTimelineEntry.findFirst({
      where: { assetId: asset.id, snapshot: { path: ['field'], equals: 'condition' } },
      orderBy: { createdAt: 'desc' },
      select: { eventType: true, snapshot: true, createdAt: true },
    }),
    prisma.auditLog.findFirst({
      where: { targetType: 'Asset', targetId: asset.id, action: CONDITION_EDIT_ACTION },
      orderBy: { createdAt: 'desc' },
      select: { meta: true, createdAt: true },
    }),
  ]);
  const valid = (value) => (condition.safeParse(value).success ? value : asset.condition); // never report a value outside the enum
  if (entry && (!edit || entry.createdAt >= edit.createdAt)) {
    const code = entry.snapshot?.assignmentCode;
    return { condition: valid(entry.snapshot?.to), at: entry.createdAt, source: conditionEntrySource(entry), assignmentCode: typeof code === 'string' ? code : null };
  }
  if (edit) return { condition: valid(edit.meta?.to), at: edit.createdAt, source: 'manual', assignmentCode: null };
  return { condition: asset.condition, at: asset.createdAt, source: 'created', assignmentCode: null };
}

/** photoHistory (Phase 8 R5): one block per assignment this asset was an item of, newest first, with the photos
 *  taken at handover and at return — those tagged with this asset (assetId) plus, when the asset is the assignment's
 *  PRIMARY item, the whole-handover / whole-return photos (assetId null). Photos tagged to another item of the same
 *  assignment are not this asset's. Assignments without any such photo are left out. A scoped user (TEAM_LEADER /
 *  CALL_CENTER_MANAGER) only gets the assignments they may open themselves (assignment room rule): seeing the asset
 *  does not make its earlier hand-overs to other rooms visible. */
async function loadPhotoHistory(assetId, user) {
  const ofThisAsset = { OR: [{ assetId }, { assetId: null }] };
  const assignments = await prisma.assignment.findMany({
    where: {
      AND: [
        { OR: [{ items: { some: { assetId } } }, { assetId }] }, // a legacy assignment may lack the item row of its primary asset
        { photos: { some: ofThisAsset } },
        assignmentScopeWhere(roomScope(user)),
      ],
    },
    select: {
      id: true, assignmentCode: true, status: true, assignedAt: true, returnedAt: true, createdAt: true,
      employee: { select: { fullName: true } },
      items: { where: { assetId }, select: { role: true } },
      photos: { where: ofThisAsset, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, type: true, context: true, assetId: true, createdAt: true } },
    },
  });
  const shape = ({ id, type, createdAt }) => ({ id, type, url: `/api/v1/photos/${id}/file`, createdAt });
  const blocks = [];
  for (const a of assignments) {
    const role = a.items[0]?.role ?? 'PRIMARY';
    // the query only returns this asset's photos and the untagged ones: those count for the PRIMARY item alone
    const shown = a.photos.filter((p) => p.assetId === assetId || role === 'PRIMARY');
    const handover = shown.filter((p) => p.context !== 'RETURN').map(shape);
    const returned = shown.filter((p) => p.context === 'RETURN').map(shape);
    if (!handover.length && !returned.length) continue;
    blocks.push({
      at: (a.assignedAt ?? a.createdAt).getTime(),
      createdAt: a.createdAt.getTime(),
      row: { assignmentId: a.id, assignmentCode: a.assignmentCode, status: a.status, employeeName: a.employee.fullName, assignedAt: a.assignedAt, returnedAt: a.returnedAt, role, handover, return: returned },
    });
  }
  return blocks.sort((x, y) => y.at - x.at || y.createdAt - x.createdAt || y.row.assignmentCode.localeCompare(x.row.assignmentCode)).map((b) => b.row);
}

/** How an item's condition changed between its handover and its return, by CONDITION_RANK (best → worst): 'same',
 *  'worse' (it came back in a worse condition), 'better' — or 'unknown' when there is no (valid) condition at one end
 *  of the comparison, i.e. the item was not returned yet or no return condition was recorded. */
function conditionChange(atHandover, atReturn) {
  const from = CONDITION_RANK.indexOf(atHandover);
  const to = CONDITION_RANK.indexOf(atReturn);
  if (from < 0 || to < 0) return 'unknown';
  return to === from ? 'same' : to > from ? 'worse' : 'better';
}

/** handover-history (Phase 9 P5b): the asset's condition over its handovers — one row per assignment this asset was
 *  an item of (an AssignmentItem row), newest first (assignedAt, else createdAt — the order of photoHistory).
 *    conditionAtHandover / returnCondition   the item's own values; `change` ranks them (conditionChange)
 *    returnNotes / discrepancyCount          the assignment's latest ReturnRecord: its notes, and how many of its
 *                                            comparison fields are discrepancies (whole assignment, not just this item)
 *    unreturnedOpen                          this asset still has to be handed back from that assignment (getUnreturned)
 *    photoCount                              the assignment's photos tagged with this asset, plus — when it is the
 *                                            assignment's PRIMARY item — the whole-handover / whole-return ones (photoHistory's rule)
 *  An item that came back late (settled as RETURNED after the return, with a condition) keeps AssignmentItem.returnCondition
 *  empty — the late condition is recorded in the resolution — so that condition is reported as its returnCondition.
 *  Like photoHistory, a scoped user (TEAM_LEADER / CALL_CENTER_MANAGER) only gets the assignments they may open
 *  themselves (assignment room rule). Constant number of queries: no per-row lookups. */
async function loadHandoverHistory(assetId, user) {
  const scope = roomScope(user);
  const ofThisAsset = { OR: [{ assetId }, { assetId: null }] };
  const items = await prisma.assignmentItem.findMany({
    where: { assetId, ...(scope && { assignment: assignmentScopeWhere(scope) }) },
    select: {
      role: true,
      conditionAtHandover: true,
      returnCondition: true,
      assignment: {
        select: {
          id: true, assignmentCode: true, status: true, assignedAt: true, returnedAt: true, createdAt: true,
          employee: { select: { id: true, fullName: true } },
          returnRecords: {
            orderBy: [{ returnedAt: 'desc' }, { id: 'asc' }],
            take: 1, // one return per assignment; the newest if a legacy row ever says otherwise
            select: { returnNotes: true, comparisonFields: { where: { isDiscrepancy: true }, select: { id: true } } },
          },
          photos: { where: ofThisAsset, select: { assetId: true } },
        },
      },
    },
  });
  if (!items.length) return [];

  // What is still owed / was settled later, for all the returned assignments at once.
  const owed = await getUnreturned(items.filter((i) => i.assignment.status === 'RETURNED').map((i) => i.assignment.id));

  const rows = items.map(({ role, conditionAtHandover, returnCondition, assignment: a }) => {
    const record = a.returnRecords[0] ?? null;
    const entry = (owed.get(a.id) ?? []).find((e) => e.kind === 'ASSET' && e.assetId === assetId) ?? null;
    const lateCondition = entry?.status === 'RESOLVED' && entry.resolution?.kind === 'RETURNED' ? entry.resolution.condition : null;
    const atReturn = [returnCondition, lateCondition].find((c) => CONDITION_RANK.includes(c)) ?? null;
    return {
      at: (a.assignedAt ?? a.createdAt).getTime(),
      createdAt: a.createdAt.getTime(),
      row: {
        assignmentId: a.id,
        assignmentCode: a.assignmentCode,
        status: a.status,
        role,
        employee: a.employee,
        assignedAt: a.assignedAt,
        returnedAt: a.returnedAt,
        conditionAtHandover,
        returnCondition: atReturn,
        change: conditionChange(conditionAtHandover, atReturn),
        returnNotes: record?.returnNotes || null,
        discrepancyCount: record?.comparisonFields.length ?? 0,
        unreturnedOpen: entry?.status === 'OPEN',
        photoCount: a.photos.filter((p) => p.assetId === assetId || role === 'PRIMARY').length,
      },
    };
  });
  return rows.sort((x, y) => y.at - x.at || y.createdAt - x.createdAt || y.row.assignmentCode.localeCompare(x.row.assignmentCode)).map((r) => r.row);
}

router.get(
  '/',
  read,
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const f = req.validQuery;
    const and = [scopeWhere(req.user)];
    if (f.categoryId) and.push({ categoryId: { in: await categoryIdsWithChildren(f.categoryId) } });
    if (f.condition) and.push({ condition: f.condition });
    if (f.status) and.push({ status: f.status });
    if (f.roomId) and.push({ roomId: f.roomId });
    if (f.holderId) and.push({ currentHolderEmployeeId: f.holderId });
    if (f.imei) and.push({ phoneDetail: { imei: { contains: f.imei } } });
    if (f.code) and.push({ code: { contains: f.code, mode: 'insensitive' } });
    if (f.q)
      and.push({
        OR: [
          { code: { contains: f.q, mode: 'insensitive' } },
          { name: { contains: f.q, mode: 'insensitive' } },
          { serialNumber: { contains: f.q, mode: 'insensitive' } },
          { phoneDetail: { imei: { contains: f.q } } },
          { phoneDetail: { model: { contains: f.q, mode: 'insensitive' } } },
          { currentHolder: { fullName: { contains: f.q, mode: 'insensitive' } } },
          { account: { identifier: { contains: f.q, mode: 'insensitive' } } },
        ],
      });
    const where = { AND: and };
    const [total, data] = await Promise.all([
      prisma.asset.count({ where }),
      prisma.asset.findMany({ where, include: listInclude, orderBy: orderByFor(f.sort, f.order), ...paginate(f) }),
    ]);
    // Batch field-definition lookups by category so the list can shape each item's customFields.
    const catIds = [...new Set(data.map((a) => a.categoryId))];
    const defsByCat = new Map();
    for (const cid of catIds) {
      const defs = await svc.fieldDefsFor(cid);
      if (defs) defsByCat.set(cid, defs.fields);
    }
    res.json({ data: data.map((a) => shapeCustomFields(a, defsByCat.get(a.categoryId) ?? [])), meta: pageMeta(f, total) });
  }),
);

// GET /api/v1/assets/:id/handover-history — Phase 9 P5b, the asset's condition over its handovers. Registered ahead of
// the `/:id` routes (and of any future `/:id/...` handler that could shadow it).
router.get(
  '/:id/handover-history',
  read,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const asset = await loadScoped(req, req.params.id); // 404 outside the room scope — the detail's rule
    const [current, rows] = await Promise.all([loadLastConditionCheck(asset), loadHandoverHistory(asset.id, req.user)]);
    res.json({ data: { asset: { id: asset.id, code: asset.code, name: asset.name, condition: asset.condition }, current, rows } });
  }),
);

router.get(
  '/:id',
  read,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const asset = await loadScoped(req, req.params.id, {
      ...listInclude,
      customValues: true,
      // `photos` is the asset's own gallery only; the photos of its hand-overs / returns are in `photoHistory`.
      photos: { where: galleryPhotos, orderBy: { createdAt: 'asc' }, select: { id: true, type: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true } },
      account: { select: { id: true, kind: true, identifier: true } },
      timelineEntries: { orderBy: { createdAt: 'desc' }, take: 20 },
    });
    const [defs, lastConditionCheck, photoHistory] = await Promise.all([
      svc.fieldDefsFor(asset.categoryId),
      loadLastConditionCheck(asset),
      loadPhotoHistory(asset.id, req.user),
    ]);
    const shaped = shapeCustomFields(asset, defs.fields);
    res.json({
      data: {
        ...shaped,
        photos: shaped.photos.map((p) => ({ ...p, url: `/api/v1/photos/${p.id}/file` })),
        photoHistory,
        lastConditionCheck,
        customFieldDefinitions: defs.fields,
      },
    });
  }),
);

router.post(
  '/',
  write,
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const defs = await svc.fieldDefsFor(b.categoryId);
    if (!defs) throw badRequest('categoryId does not exist');
    if (!defs.category.isActive) throw badRequest('Category is deactivated');
    if (b.roomId && !(await prisma.room.findUnique({ where: { id: b.roomId } }))) throw badRequest('roomId does not exist');
    const entries = svc.resolveCustomFields(defs.fields, b.customFields, { partial: false });

    const asset = await prisma.$transaction(async (tx) => {
      const code = await svc.nextCode(defs.category.codePrefix, tx);
      const created = await tx.asset.create({
        data: {
          code,
          categoryId: b.categoryId,
          name: b.name,
          serialNumber: b.serialNumber ?? null,
          qty: b.qty,
          condition: b.condition,
          status: b.condition === 'DISPOSED' ? 'DISPOSED' : b.status,
          roomId: b.roomId ?? null,
          notes: b.notes ?? null,
          ...(b.phone && { phoneDetail: { create: b.phone } }),
        },
      });
      await svc.writeCustomFields(tx, created.id, entries.filter((e) => e.value !== null));
      return created;
    });
    await audit(req, 'asset.create', 'Asset', asset.id, { code: asset.code });
    const full = await prisma.asset.findUnique({ where: { id: asset.id }, include: listInclude });
    res.status(201).json({ data: shapeCustomFields(full, defs.fields) });
  }),
);

router.patch(
  '/:id',
  write,
  validate({ params: idParams, body: patchBody }),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const { customFields: cf, phone, ...scalar } = req.body;
    const existing = await prisma.asset.findUnique({ where: { id }, include: { phoneDetail: true } });
    if (!existing) throw notFound('Asset');

    const activeItem = await prisma.assignmentItem.findFirst({ where: { assetId: id, isActive: true }, select: { id: true } });
    if (activeItem && (scalar.status || scalar.condition === 'DISPOSED' || scalar.categoryId))
      throw conflict('Asset is part of an active assignment; return it before changing status, category or disposing it');
    if (scalar.roomId && !(await prisma.room.findUnique({ where: { id: scalar.roomId } }))) throw badRequest('roomId does not exist');

    const targetCategory = scalar.categoryId ?? existing.categoryId;
    if (scalar.categoryId && scalar.categoryId !== existing.categoryId) {
      const nc = await prisma.assetCategory.findUnique({ where: { id: scalar.categoryId } });
      if (!nc || !nc.isActive) throw badRequest('categoryId does not exist or is deactivated');
    }
    const defs = await svc.fieldDefsFor(targetCategory);
    let entries = [];
    if (cf) entries = svc.resolveCustomFields(defs.fields, cf, { partial: true });
    const categoryChanged = scalar.categoryId && scalar.categoryId !== existing.categoryId;

    if (phone === null && existing.phoneDetail === null) {
      /* nothing to remove */
    } else if (phone && !existing.phoneDetail && !phone.imei) throw badRequest('phone.imei is required when adding phone details');

    if (scalar.condition === 'DISPOSED' && !scalar.status) scalar.status = 'DISPOSED';

    await prisma.$transaction(async (tx) => {
      if (Object.keys(scalar).length) await tx.asset.update({ where: { id }, data: scalar });
      // A hand edit of the condition is what lastConditionCheck reports as source 'manual' (handover / return
      // write their own timeline entries); recorded atomically with the edit, only when the value really changes.
      if (scalar.condition && scalar.condition !== existing.condition) await recordConditionEdit(tx, req, id, existing.condition, scalar.condition);
      if (categoryChanged) {
        // drop values whose field no longer applies to the new category
        await tx.assetCustomFieldValue.deleteMany({ where: { assetId: id, fieldId: { notIn: defs.fields.map((f) => f.id) } } });
      }
      await svc.writeCustomFields(tx, id, entries);
      if (phone === null) await tx.phoneDetail.deleteMany({ where: { assetId: id } });
      else if (phone) {
        if (existing.phoneDetail) await tx.phoneDetail.update({ where: { assetId: id }, data: phone });
        else await tx.phoneDetail.create({ data: { ...phone, assetId: id } });
      }
    });
    await audit(req, 'asset.update', 'Asset', id, { changes: Object.keys(req.body) });
    const asset = await prisma.asset.findUnique({ where: { id }, include: { ...listInclude, customValues: true } });
    res.json({ data: shapeCustomFields(asset, defs.fields) });
  }),
);

/** Hard delete only when the asset has no history; otherwise soft-dispose (history must never break, README §5.2). */
router.delete(
  '/:id',
  write,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const asset = await prisma.asset.findUnique({
      where: { id },
      include: { photos: true, _count: { select: { assignmentItems: true, timelineEntries: true, assignmentsAsPrimary: true } }, account: true },
    });
    if (!asset) throw notFound('Asset');
    const activeItem = await prisma.assignmentItem.findFirst({ where: { assetId: id, isActive: true } });
    if (activeItem) throw conflict('Asset is part of an active assignment; return it first');

    const hasHistory = asset._count.assignmentItems || asset._count.timelineEntries || asset._count.assignmentsAsPrimary || asset.account;
    if (hasHistory) {
      await prisma.$transaction(async (tx) => {
        await tx.asset.update({ where: { id }, data: { status: 'DISPOSED', condition: 'DISPOSED', currentHolderEmployeeId: null } });
        if (asset.condition !== 'DISPOSED') await recordConditionEdit(tx, req, id, asset.condition, 'DISPOSED'); // same rule as PATCH condition
      });
      await audit(req, 'asset.dispose', 'Asset', id, { code: asset.code });
      return res.json({ data: { id, softDeleted: true, status: 'DISPOSED' } });
    }
    await prisma.asset.delete({ where: { id } });
    await Promise.all(asset.photos.map((p) => removeFile(p.path)));
    await audit(req, 'asset.delete', 'Asset', id, { code: asset.code });
    res.status(204).end();
  }),
);

router.post(
  '/:id/photos',
  write,
  validate({ params: idParams }),
  upload.array('photos', 10),
  asyncHandler(async (req, res) => {
    const asset = await prisma.asset.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!asset) throw notFound('Asset');
    if (!req.files?.length) throw badRequest('No images uploaded (multipart field name: "photos")');
    const type = z.enum(['FRONT', 'BACK', 'CONDITION', 'GENERAL']).default('GENERAL').parse(req.body?.type || undefined);
    const saved = await persistImages(req.files, 'assets');
    // These are the asset's own (gallery) photos: no assignmentId. Assignment photos go through /assignments/:id/photos.
    const photos = await prisma.$transaction(
      saved.map((s) => prisma.photo.create({ data: { ...s, type, assetId: asset.id, assignmentId: null, uploadedById: req.user.id }, select: { id: true, type: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true } })),
    ).catch(async (e) => {
      await Promise.all(saved.map((s) => removeFile(s.path)));
      throw e;
    });
    await audit(req, 'asset.photo.upload', 'Asset', asset.id, { count: photos.length });
    res.status(201).json({ data: photos.map((p) => ({ ...p, url: `/api/v1/photos/${p.id}/file` })) });
  }),
);

module.exports = router;
