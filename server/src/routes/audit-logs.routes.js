'use strict';
const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const { asyncHandler } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { requireCapability } = require('../middleware/rbac');
const { paginationQuery, paginate, pageMeta } = require('../utils/pagination');

const router = express.Router();
// ADMIN only — the audit trail is privileged (CHANGE 8 / BE-17).
router.use(requireCapability('audit:read'));

const listQuery = z.object({
  ...paginationQuery,
  actorId: z.uuid().optional(),
  action: z.string().trim().max(100).optional(),
  targetType: z.string().trim().max(100).optional(),
  targetId: z.uuid().optional(),
  from: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid from date').optional(),
  to: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid to date').optional(),
  q: z.string().trim().max(100).optional(),
});

// GET /api/v1/audit-logs — paginated, filterable audit trail (contract §8 extension).
router.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const f = req.validQuery;
    const and = [];
    if (f.actorId) and.push({ actorId: f.actorId });
    if (f.action) and.push({ action: { contains: f.action, mode: 'insensitive' } });
    if (f.targetType) and.push({ targetType: { contains: f.targetType, mode: 'insensitive' } });
    if (f.targetId) and.push({ targetId: f.targetId });
    if (f.from) and.push({ createdAt: { gte: new Date(f.from) } });
    if (f.to) and.push({ createdAt: { lte: new Date(f.to) } });
    if (f.q)
      and.push({
        OR: [
          { action: { contains: f.q, mode: 'insensitive' } },
          { targetType: { contains: f.q, mode: 'insensitive' } },
        ],
      });
    const where = { AND: and };
    const [total, data] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { id: true, fullName: true, username: true } } },
        ...paginate(f),
      }),
    ]);
    res.json({ data, meta: pageMeta(f, total) });
  }),
);

module.exports = router;
