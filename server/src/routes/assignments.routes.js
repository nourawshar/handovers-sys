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
const svc = require('../services/assignment.service');

const router = express.Router();
const read = requireCapability('assignments:read');
const write = requireCapability('assignments:write'); // Admin only

const idParams = z.object({ id: z.uuid() });
const assignmentType = z.enum(['PHONE', 'LAPTOP', 'PRINTER', 'SIM', 'GENERAL', 'COMPUTERS', 'MONITORS', 'MOUSE', 'KEYBOARDS', 'HEADPHONES']);
const genericType = z.enum(['LAPTOP', 'PRINTER', 'SIM', 'GENERAL', 'COMPUTERS', 'MONITORS', 'MOUSE', 'KEYBOARDS', 'HEADPHONES']); // PHONE goes through /phone
const assignmentStatus = z.enum(['DRAFT', 'ACTIVE', 'RETURNED', 'CLOSED']);
const condition = z.enum(['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'DISPOSED']);
const waVariant = z.enum(['BUSINESS', 'NORMAL']);
/** Accepts YYYY-MM-DD or full ISO datetime (contract §7.6 uses date-only). */
const dateish = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date');
/** CHANGE 4 — manual work-identity input (create/upsert on-the-fly). */
const workIdentityInput = z.object({
  name: z.string().trim().min(1).max(100),
  departmentTeamId: z.uuid().nullish(),
  roomId: z.uuid().nullish(),
});

/** TEAM_LEADER must only reach assignments whose room they manage (fail closed when unscoped).
 *  CALL_CENTER_MANAGER reaches assignments in any CALLCENTER room. An assignment's room is its work
 *  identity's (seat) room, else the employee's room — one rule, shared with the detail guard and the
 *  photo guard through assignment.service. */
const scoped = svc.assignmentScopeWhere;

/** Full hydrated assignment for detail + TEAM_LEADER / CALL_CENTER_MANAGER room guard.
 *  The guard is part of the query (same `scoped()` as the list), so a list row is always openable. */
async function loadScoped(id, req, include) {
  const assignment = await prisma.assignment.findFirst({ where: { AND: [{ id }, scoped(roomScope(req.user))] }, include });
  if (!assignment) throw notFound('Assignment');
  return assignment;
}

/** The employee of an assignment (R3): identity + department and room, which the handover form prints.
 *  presentAssignment() reshapes `departmentTeam` into `department`. */
const employeeSelect = {
  id: true,
  fullName: true,
  departmentTeam: { select: { id: true, name: true } },
  room: { select: { id: true, code: true } },
};

/** An item's asset (R3): everything the handover form prints per item — identity, serial number, quantity, notes,
 *  category, room, phone data. The category's custom columns are loaded separately for ALL items at once
 *  (svc.customFieldsByAsset), `categoryId` / `category.parentId` only tell which of them apply.
 *  `photos` = the asset's OWN gallery only (`assignmentId` null): a photo taken for an assignment (Phase 8 R5) may
 *  carry the asset's id too, but it belongs to that assignment's `photos`, not to the asset's gallery. */
const itemAssetSelect = {
  id: true,
  code: true,
  name: true,
  serialNumber: true,
  qty: true,
  notes: true,
  categoryId: true,
  category: { select: { id: true, name: true, parentId: true } },
  room: { select: { id: true, code: true } },
  phoneDetail: { select: { imei: true, make: true, model: true, color: true, storage: true } },
  photos: { where: { assignmentId: null }, orderBy: { createdAt: 'asc' }, select: { id: true, type: true } },
};

/** An assignment's OWN photos (R5): `assetId` says which item a photo shows (null = the whole handover),
 *  `context` whether it was taken at HANDOVER or at RETURN. */
const assignmentPhotoSelect = { id: true, type: true, context: true, assetId: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true };

/** Photo URL = the existing photo file endpoint. */
const photoUrl = (p) => `/api/v1/photos/${p.id}/file`;

/** items[].asset in the shape the handover form / detail page consume (R3):
 *  { id, code, name, serialNumber, qty, notes, category:{id,name}, room:{id,code}|null,
 *    phone:{imei,make,model,color,storage}|null, customFields:[{key,label,type,value}], photos:[{id,type,url}] } */
function shapeItemAsset(asset, customFields) {
  return {
    id: asset.id,
    code: asset.code,
    name: asset.name,
    serialNumber: asset.serialNumber,
    qty: asset.qty,
    notes: asset.notes,
    category: asset.category ? { id: asset.category.id, name: asset.category.name } : null,
    room: asset.room ?? null,
    phone: asset.phoneDetail ?? null,
    customFields,
    photos: (asset.photos ?? []).map((p) => ({ ...p, url: photoUrl(p) })),
  };
}

/** A loaded assignment (detailInclude / phoneDetailInclude) → the response body of the detail and of every create
 *  endpoint: `employee` gains `department` + `room`, every item's asset is enriched (custom fields of ALL items are
 *  read in a single query), `photos` = this assignment's own photos with their url. Existing fields are kept. */
async function presentAssignment(assignment) {
  const items = assignment.items ?? [];
  const customFields = await svc.customFieldsByAsset(items.map((it) => it.asset));
  const { employee } = assignment;
  return {
    ...assignment,
    employee: employee && { id: employee.id, fullName: employee.fullName, department: employee.departmentTeam ?? null, room: employee.room ?? null },
    items: items.map((it) => ({ ...it, asset: it.asset ? shapeItemAsset(it.asset, customFields.get(it.asset.id) ?? []) : it.asset })),
    photos: (assignment.photos ?? []).map((p) => ({ ...p, url: photoUrl(p) })),
  };
}

/** Print order of an assignment's items (R3 handover form, one block per item): the main asset first, then SIM 1,
 *  SIM 2, charger cable, charger adapter (= the AssignmentItemRole enum order), then the bundled accessories by code. */
const itemOrder = [{ role: 'asc' }, { asset: { code: 'asc' } }];

const detailInclude = {
  employee: { select: employeeSelect },
  workIdentity: { select: { id: true, name: true, roomId: true } },
  asset: { select: { id: true, code: true, name: true } },
  items: {
    orderBy: itemOrder,
    include: {
      asset: { select: itemAssetSelect },
    },
  },
  phoneDetail: {
    include: {
      bitrixAccount: { select: { id: true, identifier: true, email: true } },
      chargerCableAsset: { select: { id: true, code: true, name: true } },
      chargerAdapterAsset: { select: { id: true, code: true, name: true } },
    },
  },
  photos: { orderBy: { createdAt: 'asc' }, select: assignmentPhotoSelect },
  timelineEntries: { orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, eventType: true, snapshot: true, createdAt: true, createdBy: { select: { id: true, fullName: true } } } },
  // Return records with their discrepancy fields (BE-2): the discrepancy is surfaced
  // here — the comparison that the return flow produced — alongside the assignment view.
  returnRecords: {
    orderBy: { returnedAt: 'desc' },
    include: {
      comparisonFields: {
        where: { isDiscrepancy: true },
        select: { fieldKey: true, label: true, valueAtHandover: true, valueAtReturn: true, severity: true, isDiscrepancy: true },
      },
    },
  },
};

/** Phone-detail include: items carry conditionAtHandover + returnCondition (drawer needs them). */
const phoneDetailInclude = {
  employee: { select: employeeSelect },
  workIdentity: { select: { id: true, name: true, roomId: true } },
  asset: { select: { id: true, code: true, name: true } },
  items: {
    orderBy: itemOrder,
    select: {
      id: true,
      assetId: true,
      role: true,
      isActive: true,
      asset: { select: itemAssetSelect },
      conditionAtHandover: true,
      returnCondition: true,
    },
  },
  phoneDetail: {
    include: {
      bitrixAccount: { select: { id: true, identifier: true, email: true } },
      chargerCableAsset: { select: { id: true, code: true, name: true } },
      chargerAdapterAsset: { select: { id: true, code: true, name: true } },
    },
  },
  photos: { orderBy: { createdAt: 'asc' }, select: assignmentPhotoSelect },
  timelineEntries: { orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, eventType: true, snapshot: true, createdAt: true, createdBy: { select: { id: true, fullName: true } } } },
  returnRecords: {
    orderBy: { returnedAt: 'desc' },
    include: {
      comparisonFields: {
        where: { isDiscrepancy: true },
        select: { fieldKey: true, label: true, valueAtHandover: true, valueAtReturn: true, severity: true, isDiscrepancy: true },
      },
    },
  },
};

const listQuery = z.object({
  ...paginationQuery,
  type: assignmentType.optional(),
  status: assignmentStatus.optional(),
  employeeId: z.uuid().optional(),
  workIdentityId: z.uuid().optional(),
  roomId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
});

// GET /api/v1/assignments — list/filter (paginated, contract §7.1)
router.get(
  '/',
  read,
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const f = req.validQuery;
    const scope = roomScope(req.user);
    const and = [scoped(scope)];
    if (f.type) and.push({ type: f.type });
    if (f.status) and.push({ status: f.status });
    if (f.employeeId) and.push({ employeeId: f.employeeId });
    if (f.workIdentityId) and.push({ workIdentityId: f.workIdentityId });
    if (f.roomId) and.push(svc.assignmentRoomWhere({ id: f.roomId })); // same seat-else-employee rule as the scope
    if (f.q)
      and.push({
        OR: [
          { assignmentCode: { contains: f.q, mode: 'insensitive' } },
          { asset: { code: { contains: f.q, mode: 'insensitive' } } },
          { asset: { name: { contains: f.q, mode: 'insensitive' } } },
          { asset: { phoneDetail: { imei: { contains: f.q } } } },
          { phoneDetail: { sim1Number: { contains: f.q } } },
          { phoneDetail: { sim2Number: { contains: f.q } } },
          { employee: { fullName: { contains: f.q, mode: 'insensitive' } } },
          { workIdentity: { name: { contains: f.q, mode: 'insensitive' } } },
        ],
      });
    const where = { AND: and };
    const [total, rows] = await Promise.all([
      prisma.assignment.count({ where }),
      prisma.assignment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, assignmentCode: true, type: true, status: true,
          employeeId: true, workIdentityId: true, assetId: true,
          assignedAt: true, expectedReturnAt: true, returnedAt: true, createdById: true,
          employee: { select: { id: true, fullName: true } },
          workIdentity: { select: { id: true, name: true } },
          asset: { select: { id: true, code: true, name: true, phoneDetail: { select: { make: true, model: true } } } },
        },
        ...paginate(f),
      }),
    ]);
    res.json({ data: rows, meta: pageMeta(f, total) });
  }),
);

// GET /api/v1/assignments/:id — full detail (contract §7.2). Phase 8 R3/R5: employee carries department + room,
// every item's asset is the enriched shape (serial, qty, notes, category, room, phone, customFields), `photos` = this
// assignment's own photos { id, type, context, assetId, url, createdAt }.
router.get(
  '/:id',
  read,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const assignment = await loadScoped(req.params.id, req, phoneDetailInclude);
    res.json({ data: await presentAssignment(assignment) });
  }),
);

// POST /api/v1/assignments — create a DRAFT (contract §7.3)
const createBody = z
  .object({
    type: assignmentType,
    employeeId: z.uuid(),
    workIdentityId: z.uuid().nullish(),
    assetId: z.uuid(),
    expectedReturnAt: dateish.nullish(),
    notes: z.string().trim().max(5000).nullish(),
  })
  .strict();

router.post(
  '/',
  write,
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!(await prisma.employee.findUnique({ where: { id: b.employeeId }, select: { id: true } }))) throw badRequest('employeeId does not exist');
    if (b.workIdentityId && !(await prisma.workIdentity.findUnique({ where: { id: b.workIdentityId }, select: { id: true } }))) throw badRequest('workIdentityId does not exist');
    if (!(await prisma.asset.findUnique({ where: { id: b.assetId }, select: { id: true } }))) throw badRequest('assetId does not exist');

    const assignment = await svc.createDraft(b, req.user.id);
    await audit(req, 'assignment.create', 'Assignment', assignment.id, { assignmentCode: assignment.assignmentCode, status: 'DRAFT' });
    const full = await prisma.assignment.findUnique({ where: { id: assignment.id }, include: detailInclude });
    res.status(201).json({ data: await presentAssignment(full) });
  }),
);

// POST /api/v1/assignments/phone — core wizard (contract §7.6). Must precede /:id routes.
const phoneBody = z
  .object({
    employeeId: z.uuid(),
    workIdentityId: z.uuid().nullish(),
    workIdentity: workIdentityInput.nullish(),
    phoneAssetId: z.uuid(),
    imei: z.string().trim().regex(/^\d{14,17}$/, 'IMEI must be 14-17 digits').nullish(),
    sim1Number: z.string().trim().max(30).nullish(),
    sim1AssetId: z.uuid().nullish(),
    wa1Business: z.boolean().default(false),
    wa1PhoneNumber: z.string().trim().max(30).nullish(),
    wa1BackupEmail: z.email().max(200).nullish(),
    wa1BackupDate: dateish.nullish(),
    wa1BackupUsedGB: z.number().nonnegative().nullish(),
    wa1BackupTotalGB: z.number().nonnegative().nullish(),
    wa1ChatNormalCount: z.number().int().nonnegative().nullish(),
    wa1ChatArchivedCount: z.number().int().nonnegative().nullish(),
    wa1AppVariant: waVariant.nullish(),
    sim2Number: z.string().trim().max(30).nullish(),
    sim2AssetId: z.uuid().nullish(),
    wa2Business: z.boolean().default(false),
    wa2PhoneNumber: z.string().trim().max(30).nullish(),
    wa2BackupEmail: z.email().max(200).nullish(),
    wa2BackupDate: dateish.nullish(),
    wa2BackupUsedGB: z.number().nonnegative().nullish(),
    wa2BackupTotalGB: z.number().nonnegative().nullish(),
    wa2ChatNormalCount: z.number().int().nonnegative().nullish(),
    wa2ChatArchivedCount: z.number().int().nonnegative().nullish(),
    wa2AppVariant: waVariant.nullish(),
    bitrixAccountId: z.uuid().nullish(),
    chargerCableAssetId: z.uuid().nullish(),
    chargerAdapterAssetId: z.uuid().nullish(),
    expectedReturnAt: dateish.nullish(),
    notes: z.string().trim().max(5000).nullish(),
    /** Condition the PHONE is handed over in (Phase 8 R4). Default: the phone's current condition. Differs → the phone's own condition is updated. */
    phoneCondition: condition.nullish(),
    /** Condition of the SIM / charger items. Default: each item's own current condition. Differs → that asset's condition is updated. */
    condition: z.enum(['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'DISPOSED']).nullish(),
  })
  .strict();

router.post(
  '/phone',
  write,
  validate({ body: phoneBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!(await prisma.employee.findUnique({ where: { id: b.employeeId }, select: { id: true } }))) throw badRequest('employeeId does not exist');
    if (b.workIdentityId && !(await prisma.workIdentity.findUnique({ where: { id: b.workIdentityId }, select: { id: true } }))) throw badRequest('workIdentityId does not exist');
    if (b.bitrixAccountId && !(await prisma.account.findUnique({ where: { id: b.bitrixAccountId }, select: { id: true } }))) throw badRequest('bitrixAccountId does not exist');

    const { assignment, phoneDetail, items } = await svc.createPhoneAssignment(b, req.user.id);
    await audit(req, 'assignment.create', 'Assignment', assignment.id, { assignmentCode: assignment.assignmentCode, status: 'ACTIVE', type: 'PHONE' });
    const full = await prisma.assignment.findUnique({ where: { id: assignment.id }, include: detailInclude });
    res.status(201).json({ data: await presentAssignment(full) });
  }),
);

// POST /api/v1/assignments/generic — create + activate a NON-phone assignment
// atomically (CHANGE 1, contract §7.6 extension). Must precede /:id routes.
const genericBody = z
  .object({
    type: genericType,
    employeeId: z.uuid(),
    workIdentityId: z.uuid().nullish(),
    workIdentity: workIdentityInput.nullish(),
    assetId: z.uuid(),
    accessoryAssetIds: z.array(z.uuid()).max(20).nullish(),
    /** Optional per-accessory handover condition; an accessory without an entry is handed over in its current condition (QA F-22, Phase 8 R4). */
    accessoryConditions: z.array(z.object({ assetId: z.uuid(), condition }).strict()).max(20).nullish(),
    /** Condition the PRIMARY asset is handed over in. Optional (Phase 8 R4): default = the asset's current condition. */
    conditionAtHandover: condition.nullish(),
    expectedReturnAt: dateish.nullish(),
    notes: z.string().trim().max(5000).nullish(),
  })
  .strict();

router.post(
  '/generic',
  write,
  validate({ body: genericBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!(await prisma.employee.findUnique({ where: { id: b.employeeId }, select: { id: true } }))) throw badRequest('employeeId does not exist');
    if (b.workIdentityId && !(await prisma.workIdentity.findUnique({ where: { id: b.workIdentityId }, select: { id: true } }))) throw badRequest('workIdentityId does not exist');
    if (!(await prisma.asset.findUnique({ where: { id: b.assetId }, select: { id: true } }))) throw badRequest('assetId does not exist');

    const { assignment } = await svc.createGenericAssignment(b, req.user.id);
    await audit(req, 'assignment.create', 'Assignment', assignment.id, { assignmentCode: assignment.assignmentCode, status: 'ACTIVE', type: assignment.type });
    const full = await prisma.assignment.findUnique({ where: { id: assignment.id }, include: detailInclude });
    res.status(201).json({ data: await presentAssignment(full) });
  }),
);

// POST /api/v1/assignments/:id/activate — DRAFT→ACTIVE (contract §7.4)
router.post(
  '/:id/activate',
  write,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const assignment = await loadScoped(req.params.id, req, {
      items: { include: { asset: { select: { id: true, code: true, name: true } } } },
      phoneDetail: true,
    });
    if (assignment.status !== 'DRAFT') throw conflict(`Assignment is not DRAFT (status: ${assignment.status})`);

    const assetIds = assignment.items.map((i) => i.assetId);
    const accountIds = [];
    if (assignment.phoneDetail?.bitrixAccountId) accountIds.push(assignment.phoneDetail.bitrixAccountId);

    const { assignment: updated } = await svc.activate(prisma, assignment.id, {
      employeeId: assignment.employeeId,
      workIdentityId: assignment.workIdentityId,
      assetIds,
      accountIds,
      phoneDetail: assignment.phoneDetail,
      items: assignment.items,
      notes: assignment.notes,
    });
    await audit(req, 'assignment.activate', 'Assignment', assignment.id, { assignmentCode: assignment.assignmentCode });
    res.json({ data: { id: updated.id, status: updated.status, assignedAt: updated.assignedAt, expectedReturnAt: updated.expectedReturnAt } });
  }),
);

// POST /api/v1/assignments/:id/photos — photos of this assignment (contract §7.2 photos + §4.12 pattern).
// Phase 8 R5: optional multipart fields `assetId` (must be an item of the assignment, else 400; says which item the
// photo shows — absent = the whole handover) and `context` (HANDOVER default | RETURN). Both are stored on the Photo row.
const photoFields = z.object({
  type: z.enum(['FRONT', 'BACK', 'CONDITION', 'GENERAL']).default('GENERAL'),
  context: z.enum(['HANDOVER', 'RETURN']).default('HANDOVER'),
  assetId: z.uuid().optional(),
});

router.post(
  '/:id/photos',
  write,
  validate({ params: idParams }),
  upload.array('photos', 10),
  asyncHandler(async (req, res) => {
    const assignment = await prisma.assignment.findUnique({ where: { id: req.params.id }, select: { id: true, assetId: true } });
    if (!assignment) throw notFound('Assignment');
    if (!req.files?.length) throw badRequest('No images uploaded (multipart field name: "photos")');
    // Multipart text fields are strings; an empty one means "not given". Everything is validated before a file is written.
    const { type, context, assetId } = photoFields.parse({
      type: req.body?.type || undefined,
      context: req.body?.context || undefined,
      assetId: req.body?.assetId || undefined,
    });
    if (assetId && assetId !== assignment.assetId) {
      const item = await prisma.assignmentItem.findFirst({ where: { assignmentId: assignment.id, assetId }, select: { id: true } });
      if (!item) throw badRequest('assetId must be an item of this assignment');
    }
    const saved = await persistImages(req.files, 'assignments');
    const photos = await prisma.$transaction(
      saved.map((s) => prisma.photo.create({ data: { ...s, type, context, assetId: assetId ?? null, assignmentId: assignment.id, uploadedById: req.user.id }, select: assignmentPhotoSelect })),
    ).catch(async (e) => {
      await Promise.all(saved.map((s) => removeFile(s.path)));
      throw e;
    });
    await audit(req, 'assignment.photo.upload', 'Assignment', assignment.id, { count: photos.length, context, ...(assetId && { assetId }) });
    res.status(201).json({ data: photos.map((p) => ({ ...p, url: photoUrl(p) })) });
  }),
);

module.exports = router;
