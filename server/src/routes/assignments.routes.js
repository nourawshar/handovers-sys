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
 *  CALL_CENTER_MANAGER reaches assignments in any CALLCENTER room (workIdentity room, or the
 *  employee's room when there is no work identity — matching the report convention). */
function scoped(scope) {
  if (!scope) return {};
  if (scope.allCallCenter) {
    return {
      OR: [
        { workIdentity: { room: { teamType: 'CALLCENTER' } } },
        { workIdentity: { is: null }, employee: { room: { teamType: 'CALLCENTER' } } },
      ],
    };
  }
  return { workIdentity: { roomId: scope.roomId } };
}

/** Full hydrated assignment for detail + TEAM_LEADER / CALL_CENTER_MANAGER room guard. */
async function loadScoped(id, req, include) {
  const assignment = await prisma.assignment.findUnique({ where: { id }, include });
  if (!assignment) throw notFound('Assignment');
  const scope = roomScope(req.user);
  if (scope) {
    const roomId = assignment.workIdentity?.roomId ?? assignment.employee?.roomId;
    if (scope.allCallCenter) {
      // CALL_CENTER_MANAGER: the assignment's room must be a CALLCENTER room.
      const room = await prisma.room.findUnique({ where: { id: roomId ?? '00000000-0000-0000-0000-000000000000' }, select: { teamType: true } });
      if (!room || room.teamType !== 'CALLCENTER') throw notFound('Assignment');
    } else if (roomId !== scope.roomId) {
      throw notFound('Assignment');
    }
  }
  return assignment;
}

const detailInclude = {
  employee: { select: { id: true, fullName: true } },
  workIdentity: { select: { id: true, name: true, roomId: true } },
  asset: { select: { id: true, code: true, name: true } },
  items: { include: { asset: { select: { id: true, code: true, name: true } } } },
  phoneDetail: {
    include: {
      bitrixAccount: { select: { id: true, identifier: true, email: true } },
      chargerCableAsset: { select: { id: true, code: true, name: true } },
      chargerAdapterAsset: { select: { id: true, code: true, name: true } },
    },
  },
  photos: { orderBy: { createdAt: 'asc' }, select: { id: true, type: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true } },
  timelineEntries: { orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, eventType: true, snapshot: true, createdAt: true, createdBy: { select: { id: true, fullName: true } } } },
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
    if (f.roomId) and.push({ workIdentity: { roomId: f.roomId } });
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
          asset: { select: { id: true, code: true, name: true } },
        },
        ...paginate(f),
      }),
    ]);
    res.json({ data: rows, meta: pageMeta(f, total) });
  }),
);

// GET /api/v1/assignments/:id — full detail (contract §7.2)
router.get(
  '/:id',
  read,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const assignment = await loadScoped(req.params.id, req, detailInclude);
    res.json({
      data: {
        ...assignment,
        photos: assignment.photos.map((p) => ({ ...p, url: `/api/v1/photos/${p.id}/file` })),
      },
    });
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
    res.status(201).json({ data: full });
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
    res.status(201).json({ data: full });
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
    conditionAtHandover: condition,
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
    res.status(201).json({ data: full });
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

// POST /api/v1/assignments/:id/photos — front/back photos (contract §7.2 photos + §4.12 pattern)
router.post(
  '/:id/photos',
  write,
  validate({ params: idParams }),
  upload.array('photos', 10),
  asyncHandler(async (req, res) => {
    const assignment = await prisma.assignment.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!assignment) throw notFound('Assignment');
    if (!req.files?.length) throw badRequest('No images uploaded (multipart field name: "photos")');
    const type = z.enum(['FRONT', 'BACK', 'CONDITION', 'GENERAL']).default('GENERAL').parse(req.body?.type || undefined);
    const saved = await persistImages(req.files, 'assignments');
    const photos = await prisma.$transaction(
      saved.map((s) => prisma.photo.create({ data: { ...s, type, assignmentId: assignment.id, uploadedById: req.user.id }, select: { id: true, type: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true } })),
    ).catch(async (e) => {
      await Promise.all(saved.map((s) => removeFile(s.path)));
      throw e;
    });
    await audit(req, 'assignment.photo.upload', 'Assignment', assignment.id, { count: photos.length });
    res.status(201).json({ data: photos.map((p) => ({ ...p, url: `/api/v1/photos/${p.id}/file` })) });
  }),
);

module.exports = router;
