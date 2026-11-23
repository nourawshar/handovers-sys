'use strict';
const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const { asyncHandler, notFound, badRequest } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { requireCapability, roomScope } = require('../middleware/rbac');
const { paginationQuery, paginate, pageMeta } = require('../utils/pagination');
const { audit } = require('../services/audit.service');
const { upload, persistImages, removeFile } = require('../services/upload.service');
const { loadAssignment, applyReturn, assertReturnable, comparableKeys, photoSummary, photoSets, buildReturnRecord, getUnreturned, resolveUnreturned, RESOLUTIONS } = require('../services/return.service');

/**
 * BE-2 (return / handback comparison) + BE-3 (assignment-scoped timeline).
 * Mounted at /assignments (the card's new file set). BE-1's assignments.routes.js
 * will share the same mount for the core list/detail/create endpoints.
 */
const router = express.Router();
const read = requireCapability('assignments:read');
const write = requireCapability('assignments:write'); // Admin only

const idParams = z.object({ id: z.uuid() });

/**
 * An assignment's room is its seat's room, else its employee's room (workIdentity.roomId ??
 * employee.roomId) — the rule assignments.routes.js applies to the detail view. This is its database
 * filter (the timeline endpoint); loadScoped() below applies the same rule to the loaded assignment.
 *   TEAM_LEADER          → that room must be theirs
 *   CALL_CENTER_MANAGER  → it must be a CALLCENTER room
 * Both fail closed.
 */
function scoped(scope) {
  if (!scope) return {};
  const room = scope.allCallCenter ? { teamType: 'CALLCENTER' } : { id: scope.roomId };
  return {
    OR: [
      { workIdentity: { room } }, // the seat has a room and it is in scope
      { OR: [{ workIdentity: { is: null } }, { workIdentity: { roomId: null } }], employee: { room } }, // no seat room → the employee's room
    ],
  };
}

/** The room an assignment belongs to (seat room, else employee room) with its team type, or null. */
function assignmentRoom(assignment) {
  const holder = assignment.workIdentity?.roomId ? assignment.workIdentity : assignment.employee;
  return holder?.roomId ? { id: holder.roomId, teamType: holder.room?.teamType } : null;
}

/** Full hydrated assignment for return flow + TEAM_LEADER / CALL_CENTER_MANAGER room guard (404 outside the scope). */
async function loadScoped(id, req) {
  const assignment = await loadAssignment(id);
  if (!assignment) throw notFound('Assignment');
  const scope = roomScope(req.user);
  if (scope) {
    const room = assignmentRoom(assignment);
    const inScope = room && (scope.allCallCenter ? room.teamType === 'CALLCENTER' : room.id === scope.roomId);
    if (!inScope) throw notFound('Assignment');
  }
  return assignment;
}

/** Room-scope guard only — 404 outside the scope, by the very rule loadScoped() applies (`scoped()` is its database
 *  form, as the timeline uses it) — for the read endpoints that load their own, much smaller payload. */
async function assertInScope(id, req) {
  const found = await prisma.assignment.findFirst({ where: { id, ...scoped(roomScope(req.user)) }, select: { id: true } });
  if (!found) throw notFound('Assignment');
}

// GET /api/v1/assignments/:id/return-form — pre-filled out-state snapshot (contract §8.1)
router.get(
  '/:id/return-form',
  read,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const assignment = await loadScoped(req.params.id, req);
    assertReturnable(assignment); // 404 / 409 (not ACTIVE)
    const { buildOutSnapshot } = require('../services/return.service');
    // BE-1: human-readable out (no raw UUIDs) + dropdown options + handover photos.
    const [bitrixAccounts, chargerCables, chargerAdapters] = await Promise.all([
      prisma.account.findMany({
        where: { kind: 'BITRIX', isActive: true },
        orderBy: [{ email: 'asc' }, { identifier: 'asc' }],
        select: { id: true, identifier: true, email: true },
      }),
      prisma.asset.findMany({
        where: { category: { name: 'Charger Cables' } },
        orderBy: { code: 'asc' },
        select: { id: true, code: true, name: true, status: true },
      }),
      prisma.asset.findMany({
        where: { category: { name: 'Charger Adapters' } },
        orderBy: { code: 'asc' },
        select: { id: true, code: true, name: true, status: true },
      }),
    ]);
    res.json({
      data: {
        assignmentId: assignment.id,
        assignmentCode: assignment.assignmentCode,
        out: buildOutSnapshot(assignment),
        options: { bitrixAccounts, chargerCables, chargerAdapters },
        handoverPhotos: (assignment.photos ?? []).filter((p) => p.context !== 'RETURN').map(photoSummary),
      },
    });
  }),
);

// POST /api/v1/assignments/:id/return — submit return-state; compares + closes out (contract §8.2)
const condition = z.enum(['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'DISPOSED']);
const returnBody = z.object({
  returnCondition: condition.nullish(),
  returnNotes: z.string().trim().max(1000).nullish(),
  /** Phase 7 #5 — condition each OTHER involved asset (bundled accessory / SIM / charger) comes back in. */
  itemConditions: z
    .array(z.object({ assetId: z.uuid(), condition }).strict())
    .max(30)
    .refine((list) => new Set(list.map((i) => i.assetId)).size === list.length, 'itemConditions must not repeat an assetId')
    .nullish(),
  return: z
    .object({
      ...Object.fromEntries(comparableKeys().map((k) => [k, z.union([z.string().trim(), z.number(), z.boolean(), z.null()]).optional()])),
      // The comparison ranks this against the handover condition, so it must be a real condition.
      condition: condition.nullish(),
    })
    .strict()
    .nullish(),
});

router.post(
  '/:id/return',
  write,
  validate({ params: idParams, body: z.object({ ...returnBody.shape, return: returnBody.shape.return }) }),
  asyncHandler(async (req, res) => {
    const assignment = await loadScoped(req.params.id, req);
    assertReturnable(assignment); // 404, and 409 for non-ACTIVE (fast path; applyReturn re-checks atomically inside its transaction)
    const { returnCondition, returnNotes, itemConditions, return: returnState } = req.body;
    const result = await applyReturn(assignment, { returnCondition, returnNotes, returnState, itemConditions }, req.user);
    const discrepancies = result.comparison.filter((c) => c.isDiscrepancy);
    await audit(req, 'assignment.return', 'Assignment', assignment.id, {
      assignmentCode: assignment.assignmentCode,
      hasDiscrepancies: result.hasDiscrepancies,
      discrepancyFields: discrepancies.map((c) => c.fieldKey),
      unreturnedItems: result.unreturnedItems,
    });
    res.json({
      data: {
        assignmentId: assignment.id,
        assignmentCode: assignment.assignmentCode,
        status: 'RETURNED',
        returnedAt: result.returnedAt,
        hasDiscrepancies: result.hasDiscrepancies,
        // F-21: `discrepancies` holds ONLY the rows flagged isDiscrepancy; the full field-by-field
        // list (flagged or not) is `comparison`, which is what the return screen renders.
        discrepancies,
        comparison: result.comparison,
        // F-05 / F-06: required items that did NOT come back — [{ kind, code, name }], kind being
        // SIM1 | SIM2 | CHARGER_CABLE | CHARGER_ADAPTER | BITRIX. They stay bound to the employee
        // (assets ASSIGNED with their holder, the Bitrix account keeps its assignment).
        unreturnedItems: result.unreturnedItems,
        photos: photoSets(assignment), // BE-1: handover vs return images
        // Phase 7 #5: what the return did to each returned asset's own condition/status,
        // primary first — [{ assetId, code, name, role, from, to, changed, status }].
        assetConditions: result.assetConditions,
      },
    });
  }),
);

// POST /api/v1/assignments/:id/return/photos — re-upload front/back at return (context RETURN, BE-1)
router.post(
  '/:id/return/photos',
  write,
  validate({ params: idParams }),
  upload.array('photos', 10),
  asyncHandler(async (req, res) => {
    const assignment = await loadScoped(req.params.id, req);
    assertReturnable(assignment); // 404 / 409 (not ACTIVE)
    if (!req.files?.length) throw badRequest('No images uploaded (multipart field name: "photos")');
    const type = z.enum(['FRONT', 'BACK', 'CONDITION', 'GENERAL']).default('GENERAL').parse(req.body?.type || undefined);
    const saved = await persistImages(req.files, 'assignments');
    const photos = await prisma.$transaction(
      saved.map((s) =>
        prisma.photo.create({
          data: { ...s, type, context: 'RETURN', assignmentId: assignment.id, uploadedById: req.user.id },
          select: { id: true, type: true, context: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
        }),
      ),
    ).catch(async (e) => {
      await Promise.all(saved.map((s) => removeFile(s.path)));
      throw e;
    });
    await audit(req, 'assignment.return.photo.upload', 'Assignment', assignment.id, { count: photos.length });
    res.status(201).json({ data: photos.map((p) => ({ ...p, url: `/api/v1/photos/${p.id}/file` })) });
  }),
);

// GET /api/v1/assignments/:id/timeline — append-only assignment history (contract §9.2)
router.get(
  '/:id/timeline',
  read,
  validate({
    params: idParams,
    query: z.object({ ...paginationQuery, eventType: z.enum(['ASSIGNED', 'RETURNED', 'REASSIGNED', 'UPDATED', 'DISCREPANCY', 'NOTE']).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const a = await prisma.assignment.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!a) throw notFound('Assignment');
    const scope = roomScope(req.user);
    const inRoom = await prisma.assignment.findFirst({
      where: { id: req.params.id, ...scoped(scope) },
      select: { id: true },
    });
    if (scope && !inRoom) throw notFound('Assignment');

    const f = req.validQuery;
    const where = { assignmentId: req.params.id, ...(f.eventType && { eventType: f.eventType }) };
    const [total, rows] = await Promise.all([
      prisma.assignmentTimelineEntry.count({ where }),
      prisma.assignmentTimelineEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, assignmentId: true, assetId: true, employeeId: true, workIdentityId: true,
          eventType: true, snapshot: true, createdById: true, createdAt: true,
          createdBy: { select: { id: true, fullName: true } },
        },
        ...paginate(f),
      }),
    ]);
    res.json({ data: rows, meta: pageMeta(f, total) });
  }),
);

/*
 * Phase 9 P5a — the return record, the items that did not come back, and settling them.
 * Route order: assignments.routes.js (mounted first, at the same /assignments prefix) only has the single-segment
 * GET /:id plus POST /phone, /generic, /:id/activate and /:id/photos, and nothing in this router is a bare /:id —
 * every path below ends in a fixed tail, so none of them can be shadowed by a /:id route.
 */

// GET /api/v1/assignments/:id/return-record — the second record of a returned assignment: items, comparison, what is
// still owed, photos of both ends. 404 when the assignment was never returned; same room scope as the detail.
router.get(
  '/:id/return-record',
  read,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    await assertInScope(req.params.id, req); // 404 outside the TEAM_LEADER / CALL_CENTER_MANAGER room scope
    const record = await buildReturnRecord(req.params.id);
    if (!record) throw notFound('Return record'); // never returned (ACTIVE / DRAFT assignment)
    res.json({ data: record });
  }),
);

// GET /api/v1/assignments/:id/unreturned — the items that did not come back (OPEN) and the ones already settled
// (RESOLVED), same entries as `unreturned` of the return record. An assignment that was not returned owes nothing: [].
router.get(
  '/:id/unreturned',
  read,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    await assertInScope(req.params.id, req);
    res.json({ data: (await getUnreturned([req.params.id])).get(req.params.id) ?? [] });
  }),
);

// POST /api/v1/assignments/:id/unreturned/resolve — ADMIN. Settle one OPEN item: RETURNED (it came back late — asset
// AVAILABLE, holder cleared, `condition` applied when given; account unbound) or LOST (asset LOST / DISPOSED + note;
// account deactivated and unbound). 400 when the item is not part of the assignment, 409 when it is not OPEN (also: a
// second resolve). `condition` only means something for a RETURNED asset — it is ignored for LOST and for accounts.
const resolveBody = z
  .object({
    assetId: z.uuid().nullish(),
    accountId: z.uuid().nullish(),
    resolution: z.enum(RESOLUTIONS),
    condition: condition.nullish(),
    notes: z.string().trim().max(1000).nullish(),
  })
  .strict()
  .refine((b) => Boolean(b.assetId) !== Boolean(b.accountId), { message: 'Give exactly one of assetId or accountId', path: ['assetId'] });

router.post(
  '/:id/unreturned/resolve',
  write,
  validate({ params: idParams, body: resolveBody }),
  asyncHandler(async (req, res) => {
    const assignment = await loadScoped(req.params.id, req); // 404 for an unknown assignment
    const { assetId, accountId, resolution, condition: toCondition, notes } = req.body;
    const { item, unreturned, effects } = await resolveUnreturned(
      assignment,
      { assetId: assetId ?? null, accountId: accountId ?? null, resolution, condition: toCondition ?? null, notes: notes ?? null },
      req.user,
    );
    await audit(req, 'assignment.unreturned.resolve', 'Assignment', assignment.id, {
      assignmentCode: assignment.assignmentCode,
      resolution,
      ...(assetId ? { assetId } : { accountId }),
      ...effects, // code, role, condition, notes + what changed (assetStatus, conditionFrom/To, accountActive)
    });
    res.json({ data: { assignmentId: assignment.id, assignmentCode: assignment.assignmentCode, item, unreturned } });
  }),
);

module.exports = router;
