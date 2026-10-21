'use strict';
const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const { asyncHandler, notFound, badRequest, conflict } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { requireCapability, roomScope } = require('../middleware/rbac');
const { audit } = require('../services/audit.service');

const router = express.Router();
// reads: anyone with people:read (TEAM_LEADER is room-scoped); writes: Admin only (people:write).
const read = requireCapability('people:read');
const write = requireCapability('people:write');

const idParams = z.object({ id: z.uuid() });
const teamType = z.enum(['CALLCENTER', 'HOSPITAL']);

/** Includes preserved from the Phase 1 read-only lookup so the frontend (useRooms) keeps working. */
const roomInclude = {
  managerEmployee: { select: { id: true, fullName: true } },
  _count: { select: { employees: true, workIdentities: true } },
};

const createBody = z
  .object({
    code: z.string().trim().min(1).max(50),
    teamType: teamType.default('CALLCENTER'),
    managerEmployeeId: z.uuid().nullish(),
  })
  .strict();

const patchBody = z
  .object({
    code: z.string().trim().min(1).max(50),
    teamType,
    managerEmployeeId: z.uuid().nullable(),
  })
  .partial()
  .strict();

async function assertManagerExists(managerEmployeeId) {
  if (!managerEmployeeId) return;
  const mgr = await prisma.employee.findUnique({ where: { id: managerEmployeeId }, select: { id: true } });
  if (!mgr) throw badRequest('managerEmployeeId does not exist');
}

/** Catch Prisma unique (P2002) on room.code and surface it as a friendly 409. */
async function run(promise) {
  try {
    return await promise;
  } catch (e) {
    if (e?.code === 'P2002') throw conflict('A room with that code already exists');
    throw e;
  }
}

router.get(
  '/',
  read,
  asyncHandler(async (req, res) => {
    const s = roomScope(req.user);
    const where = s ? (s.allCallCenter ? { teamType: 'CALLCENTER' } : { id: s.roomId }) : {};
    const data = await prisma.room.findMany({
      where,
      orderBy: { code: 'asc' },
      include: roomInclude,
    });
    res.json({ data });
  }),
);

router.get(
  '/:id',
  read,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const room = await prisma.room.findUnique({ where: { id: req.params.id }, include: roomInclude });
    if (!room) throw notFound('Room');
    // TEAM_LEADER may only see their own room; CALL_CENTER_MANAGER only CALLCENTER rooms (fail closed).
    const s = roomScope(req.user);
    if (s && (s.allCallCenter ? room.teamType !== 'CALLCENTER' : s.roomId !== room.id)) throw notFound('Room');
    res.json({ data: room });
  }),
);

router.post(
  '/',
  write,
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    await assertManagerExists(req.body.managerEmployeeId);
    const room = await run(
      prisma.room.create({
        data: {
          code: req.body.code,
          teamType: req.body.teamType,
          managerEmployeeId: req.body.managerEmployeeId ?? null,
        },
        include: roomInclude,
      }),
    );
    await audit(req, 'room.create', 'Room', room.id, { code: room.code, teamType: room.teamType });
    res.status(201).json({ data: room });
  }),
);

router.patch(
  '/:id',
  write,
  validate({ params: idParams, body: patchBody }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.room.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) throw notFound('Room');
    await assertManagerExists(req.body.managerEmployeeId);
    const room = await run(prisma.room.update({ where: { id: req.params.id }, data: req.body, include: roomInclude }));
    await audit(req, 'room.update', 'Room', room.id, { changes: Object.keys(req.body) });
    res.json({ data: room });
  }),
);

router.delete(
  '/:id',
  write,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const room = await prisma.room.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { employees: true, workIdentities: true, users: true, assets: true } } },
    });
    if (!room) throw notFound('Room');
    if (room._count.employees || room._count.workIdentities || room._count.users || room._count.assets) {
      throw conflict('Room is still referenced by an employee, work identity, user, or asset and cannot be deleted');
    }
    await prisma.room.delete({ where: { id: room.id } });
    await audit(req, 'room.delete', 'Room', room.id, { code: room.code });
    res.status(204).end();
  }),
);

module.exports = router;
