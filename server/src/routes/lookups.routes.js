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
