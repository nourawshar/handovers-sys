'use strict';
const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const { asyncHandler, notFound, badRequest, conflict } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { requireCapability } = require('../middleware/rbac');
const { paginationQuery, paginate, pageMeta, boolQuery } = require('../utils/pagination');
const authService = require('../services/auth.service');
const { audit } = require('../services/audit.service');

const router = express.Router();
router.use(requireCapability('users:manage'));

const idParams = z.object({ id: z.uuid() });
const password = z.string().min(10, 'Password must be at least 10 characters').max(200);
// CHANGE 7 / BE-17: CALL_CENTER_MANAGER added (CEO + assistant, read-only across all call-center rooms).
const role = z.enum(['ADMIN', 'MANAGER', 'TEAM_LEADER', 'CALL_CENTER_MANAGER']);
// Room-scope discriminator: 'OWN_ROOM' = TEAM_LEADER scoped to User.roomId; null = unrestricted.
const scope = z.enum(['OWN_ROOM']).nullish();

const select = { id: true, username: true, fullName: true, role: true, roomId: true, scope: true, isActive: true, lastLoginAt: true, createdAt: true };

const createBody = z
  .object({
    username: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'Letters, digits, . _ - only'),
    password,
    fullName: z.string().trim().min(1).max(150),
    role,
    roomId: z.uuid().nullish(),
    scope,
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.role !== 'TEAM_LEADER' || v.roomId, { path: ['roomId'], message: 'roomId is required for TEAM_LEADER' })
  .refine((v) => v.role !== 'CALL_CENTER_MANAGER' || v.scope !== 'OWN_ROOM', { path: ['scope'], message: 'CALL_CENTER_MANAGER scope must be null (breadth comes from the role)' });

const patchBody = z
  .object({
    fullName: z.string().trim().min(1).max(150),
    role,
    roomId: z.uuid().nullable(),
    scope: z.enum(['OWN_ROOM']).nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .strict();

router.get(
  '/',
  validate({ query: z.object({ ...paginationQuery, q: z.string().trim().optional(), role: role.optional(), isActive: boolQuery.optional() }) }),
  asyncHandler(async (req, res) => {
    const { q, role: r, isActive } = req.validQuery;
    const where = {
      ...(r && { role: r }),
      ...(isActive !== undefined && { isActive }),
      ...(q && { OR: [{ username: { contains: q, mode: 'insensitive' } }, { fullName: { contains: q, mode: 'insensitive' } }] }),
    };
    const [total, data] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, select, orderBy: { username: 'asc' }, ...paginate(req.validQuery) }),
    ]);
    res.json({ data, meta: pageMeta(req.validQuery, total) });
  }),
);

router.post(
  '/',
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const { password: pw, ...rest } = req.body;
    const user = await prisma.user.create({
      data: { ...rest, roomId: rest.role === 'TEAM_LEADER' ? rest.roomId : null, scope: rest.role === 'TEAM_LEADER' ? 'OWN_ROOM' : rest.scope ?? null, passwordHash: await authService.hashPassword(pw) },
      select,
    });
    await audit(req, 'user.create', 'User', user.id, { role: user.role });
    res.status(201).json({ data: user });
  }),
);

router.patch(
  '/:id',
  validate({ params: idParams, body: patchBody }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('User');
    const next = { ...existing, ...req.body };
    if (next.role === 'TEAM_LEADER' && !next.roomId) throw badRequest('roomId is required for TEAM_LEADER');
    if (next.role === 'CALL_CENTER_MANAGER' && next.scope === 'OWN_ROOM') throw badRequest('CALL_CENTER_MANAGER scope must be null (breadth comes from the role)');
    if (existing.id === req.user.id && (req.body.isActive === false || (req.body.role && req.body.role !== 'ADMIN')))
      throw conflict('You cannot deactivate or demote your own account');
    const data = {
      ...req.body,
      ...(next.role !== 'TEAM_LEADER' && { roomId: null }),
      ...(next.role === 'TEAM_LEADER' && { scope: 'OWN_ROOM' }),
      ...(next.role !== 'TEAM_LEADER' && next.role !== 'CALL_CENTER_MANAGER' && { scope: null }),
    };
    const user = await prisma.user.update({ where: { id: existing.id }, data, select });
    if (req.body.isActive === false || req.body.role) await authService.revokeAllForUser(user.id);
    await audit(req, 'user.update', 'User', user.id, { changes: Object.keys(req.body) });
    res.json({ data: user });
  }),
);

router.patch(
  '/:id/password',
  validate({ params: idParams, body: z.object({ password }).strict() }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('User');
    await prisma.user.update({ where: { id: existing.id }, data: { passwordHash: await authService.hashPassword(req.body.password) } });
    await authService.revokeAllForUser(existing.id);
    await audit(req, 'user.password_reset', 'User', existing.id);
    res.status(204).end();
  }),
);

module.exports = router;
