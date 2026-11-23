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

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 3600 * 1000;

/** `createdAt` upper bound for the `to` filter. A date-only value ("2026-11-21") parses as 00:00 UTC and
 *  would silently drop that whole day, so it means "through the end of that day (UTC)" (QA F-17);
 *  a full timestamp stays an inclusive bound. */
function createdAtUpTo(to) {
  const t = to.trim();
  const d = new Date(t);
  return DATE_ONLY.test(t) ? { lt: new Date(d.getTime() + DAY_MS) } : { lte: d };
}

/**
 * Phase 9 / P2 — `sort` + `order`. The key is whitelisted (an unknown one is a 400 VALIDATION_ERROR that names the
 * allowed keys). Default = newest first, as before.
 */
const SORT_KEYS = ['createdAt', 'action', 'actor'];
const sortQuery = {
  sort: z.enum(SORT_KEYS, { error: `Unknown sort key. Allowed: ${SORT_KEYS.join(', ')}` }).default('createdAt'),
  order: z.enum(['asc', 'desc'], { error: 'Invalid order. Allowed: asc, desc' }).default('desc'),
};

/**
 * Prisma orderBy for a sort key: the key itself, then newest first inside equal values (an audit trail is read
 * newest-first) and ALWAYS `id` last, so rows with equal values page deterministically. `actor` sorts by the actor's
 * full name through the relation; entries without an actor (system events) are NULLs, which PostgreSQL puts last
 * when asc, first when desc.
 */
const orderByFor = (sort, dir) => [
  ...{
    createdAt: [{ createdAt: dir }],
    action: [{ action: dir }, { createdAt: 'desc' }],
    actor: [{ actor: { fullName: dir } }, { createdAt: 'desc' }],
  }[sort],
  { id: 'asc' },
];

const listQuery = z.object({
  ...paginationQuery,
  actorId: z.uuid().optional(),
  action: z.string().trim().max(100).optional(),
  targetType: z.string().trim().max(100).optional(),
  targetId: z.uuid().optional(),
  from: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid from date').optional(),
  to: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid to date').optional(),
  q: z.string().trim().max(100).optional(),
  ...sortQuery,
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
    if (f.to) and.push({ createdAt: createdAtUpTo(f.to) });
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
        orderBy: orderByFor(f.sort, f.order),
        include: { actor: { select: { id: true, fullName: true, username: true } } },
        ...paginate(f),
      }),
    ]);
    res.json({ data, meta: pageMeta(f, total) });
  }),
);

module.exports = router;
