'use strict';
const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const { asyncHandler } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { requireCapability, roomScope } = require('../middleware/rbac');
const { paginationQuery, paginate, pageMeta } = require('../utils/pagination');

/**
 * Read-only lookups needed by the Phase 1 inventory UI (room / holder pickers).
 * Write endpoints (README §6.3) belong to Phase 2 and are intentionally not implemented here.
 * Team Leaders only see their own room's data.
 */
const router = express.Router();
const read = requireCapability('people:read');

router.get(
  '/rooms',
  read,
  asyncHandler(async (req, res) => {
    const s = roomScope(req.user);
    const data = await prisma.room.findMany({
      where: s ? { id: s.roomId } : {},
      orderBy: { code: 'asc' },
      include: { managerEmployee: { select: { id: true, fullName: true } }, _count: { select: { employees: true, workIdentities: true } } },
    });
    res.json({ data });
  }),
);

router.get(
  '/departments',
  read,
  asyncHandler(async (req, res) => {
    const data = await prisma.departmentTeam.findMany({ orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }] });
    res.json({ data });
  }),
);

router.get(
  '/employees',
  read,
  validate({ query: z.object({ ...paginationQuery, q: z.string().trim().max(100).optional(), roomId: z.uuid().optional(), departmentTeamId: z.uuid().optional() }) }),
  asyncHandler(async (req, res) => {
    const f = req.validQuery;
    const s = roomScope(req.user);
    const where = { ...(s ? { roomId: s.roomId } : f.roomId ? { roomId: f.roomId } : {}), ...(f.departmentTeamId && { departmentTeamId: f.departmentTeamId }), ...(f.q && { fullName: { contains: f.q, mode: 'insensitive' } }) };
    const [total, data] = await Promise.all([
      prisma.employee.count({ where }),
      prisma.employee.findMany({ where, orderBy: { fullName: 'asc' }, include: { departmentTeam: { select: { id: true, name: true } }, room: { select: { id: true, code: true } } }, ...paginate(f) }),
    ]);
    res.json({ data, meta: pageMeta(f, total) });
  }),
);

router.get(
  '/work-identities',
  read,
  asyncHandler(async (req, res) => {
    const s = roomScope(req.user);
    const data = await prisma.workIdentity.findMany({
      where: s ? { roomId: s.roomId } : {},
      orderBy: [{ roomId: 'asc' }, { name: 'asc' }],
      include: { room: { select: { id: true, code: true } }, departmentTeam: { select: { id: true, name: true } } },
    });
    res.json({ data });
  }),
);

module.exports = router;
