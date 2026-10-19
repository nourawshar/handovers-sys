'use strict';
const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const { asyncHandler, notFound } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { requireCapability, roomScope } = require('../middleware/rbac');
const { paginationQuery, paginate, pageMeta } = require('../utils/pagination');
const { audit } = require('../services/audit.service');
const { loadAssignment, applyReturn, assertReturnable, comparableKeys } = require('../services/return.service');

/**
 * BE-2 (return / handback comparison) + BE-3 (assignment-scoped timeline).
 * Mounted at /assignments (the card's new file set). BE-1's assignments.routes.js
 * will share the same mount for the core list/detail/create endpoints.
 */
const router = express.Router();
const read = requireCapability('assignments:read');
const write = requireCapability('assignments:write'); // Admin only

const idParams = z.object({ id: z.uuid() });

/** TEAM_LEADER must only reach assignments whose room they manage (fail closed when unscoped). */
function scoped(scope) {
  return scope ? { workIdentity: { roomId: scope.roomId } } : {};
}

/** Full hydrated assignment for return flow + TEAM_LEADER room guard. */
async function loadScoped(id, req) {
  const assignment = await loadAssignment(id);
  if (!assignment) throw notFound('Assignment');
  const scope = roomScope(req.user);
  if (scope && (assignment.workIdentity?.roomId ?? assignment.employee?.roomId) !== scope.roomId) {
    throw notFound('Assignment');
  }
  return assignment;
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
    res.json({
      data: {
        assignmentId: assignment.id,
        assignmentCode: assignment.assignmentCode,
        out: buildOutSnapshot(assignment),
      },
    });
  }),
);

// POST /api/v1/assignments/:id/return — submit return-state; compares + closes out (contract §8.2)
const returnBody = z.object({
  returnCondition: z.enum(['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'DISPOSED'].map((v) => v)).nullish(),
  returnNotes: z.string().trim().max(1000).nullish(),
  return: z
    .object(
      Object.fromEntries(comparableKeys().map((k) => [k, z.union([z.string().trim(), z.number(), z.boolean(), z.null()]).optional()])),
    )
    .strict()
    .nullish(),
});

router.post(
  '/:id/return',
  write,
  validate({ params: idParams, body: z.object({ ...returnBody.shape, return: returnBody.shape.return }) }),
  asyncHandler(async (req, res) => {
    const assignment = await loadScoped(req.params.id, req);
    assertReturnable(assignment); // 404, and 409 for non-ACTIVE (incl. already RETURNED → idempotent guard)
    const { returnCondition, returnNotes, return: returnState } = req.body;
    const result = await applyReturn(assignment, { returnCondition, returnNotes, returnState }, req.user);
    await audit(req, 'assignment.return', 'Assignment', assignment.id, {
      assignmentCode: assignment.assignmentCode,
      hasDiscrepancies: result.hasDiscrepancies,
      discrepancyFields: result.comparison.filter((c) => c.isDiscrepancy).map((c) => c.fieldKey),
    });
    res.json({
      data: {
        assignmentId: assignment.id,
        assignmentCode: assignment.assignmentCode,
        status: 'RETURNED',
        returnedAt: new Date(),
        hasDiscrepancies: result.hasDiscrepancies,
        discrepancies: result.comparison,
      },
    });
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

module.exports = router;