'use strict';
const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const { asyncHandler, notFound, badRequest, conflict } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { requireCapability, roomScope } = require('../middleware/rbac');
const { paginationQuery, paginate, pageMeta } = require('../utils/pagination');
const { audit } = require('../services/audit.service');

/**
 * Employees full CRUD (Phase 5 / BE-6).
 * Reads: people:read (ADMIN/MANAGER/TEAM_LEADER/CALL_CENTER_MANAGER — TL/CCM room-scoped).
 * Writes: people:write (Admin only).
 */
const router = express.Router();
const read = requireCapability('people:read');
const write = requireCapability('people:write');

const idParams = z.object({ id: z.uuid() });
const employeeStatus = z.enum(['ACTIVE', 'LEFT', 'ON_LEAVE']);

/**
 * Response shape shared by list/detail/create/update. Kept identical to the legacy
 * lookup includes (departmentTeam{id,name}, room{id,code}) so the FE keeps working.
 */
const detailInclude = {
  departmentTeam: { select: { id: true, name: true } },
  room: { select: { id: true, code: true } },
};

const createBody = z
  .object({
    fullName: z.string().trim().min(1).max(150),
    departmentTeamId: z.uuid(),
    roomId: z.uuid().nullish(),
    phoneContact: z.string().trim().max(50).nullish(),
    internalEmail: z.email().max(200).nullish(),
    notes: z.string().trim().max(5000).nullish(),
  })
  .strict();

const patchBody = z
  .object({
    fullName: z.string().trim().min(1).max(150),
    departmentTeamId: z.uuid(),
    roomId: z.uuid().nullable(),
    phoneContact: z.string().trim().max(50).nullable(),
    internalEmail: z.email().max(200).nullable(),
    notes: z.string().trim().max(5000).nullable(),
    status: employeeStatus,
  })
  .partial()
  .strict();

/** Validate that referenced FK rows exist; throws 400 otherwise (avoids P2003 → 500). */
async function assertRefs(departmentTeamId, roomId) {
  if (departmentTeamId && !(await prisma.departmentTeam.findUnique({ where: { id: departmentTeamId }, select: { id: true } })))
    throw badRequest('departmentTeamId does not exist');
  if (roomId && !(await prisma.room.findUnique({ where: { id: roomId }, select: { id: true } })))
    throw badRequest('roomId does not exist');
}

/** Map a Prisma P2002 unique violation (fullName+departmentTeamId) to a 409. */
function isDup(e) {
  return e?.code === 'P2002';
}

/** TEAM_LEADER → own room; CALL_CENTER_MANAGER → all CALLCENTER rooms; else unrestricted. */
function scopeWhere(user, f) {
  const s = roomScope(user);
  if (s) return s.allCallCenter ? { room: { teamType: 'CALLCENTER' } } : { roomId: s.roomId };
  return f.roomId ? { roomId: f.roomId } : {};
}

router.get(
  '/',
  read,
  validate({ query: z.object({ ...paginationQuery, q: z.string().trim().max(100).optional(), roomId: z.uuid().optional(), departmentTeamId: z.uuid().optional() }) }),
  asyncHandler(async (req, res) => {
    const f = req.validQuery;
    const where = { ...scopeWhere(req.user, f), ...(f.departmentTeamId && { departmentTeamId: f.departmentTeamId }), ...(f.q && { fullName: { contains: f.q, mode: 'insensitive' } }) };
    const [total, data] = await Promise.all([
      prisma.employee.count({ where }),
      prisma.employee.findMany({ where, orderBy: { fullName: 'asc' }, include: detailInclude, ...paginate(f) }),
    ]);
    res.json({ data, meta: pageMeta(f, total) });
  }),
);

router.get(
  '/:id',
  read,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const emp = await prisma.employee.findUnique({
      where: { id: req.params.id },
      include: {
        ...detailInclude,
        assignments: {
          orderBy: { createdAt: 'desc' },
          include: {
            asset: { select: { id: true, code: true, name: true } },
            workIdentity: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!emp) throw notFound('Employee');
    const history = emp.assignments.map((a) => ({
      assignmentId: a.id,
      assignmentCode: a.assignmentCode,
      assetCode: a.asset.code,
      assetName: a.asset.name,
      workIdentityName: a.workIdentity?.name ?? null,
      status: a.status,
      assignedAt: a.assignedAt,
      returnedAt: a.returnedAt,
    }));
    const { assignments, ...employee } = emp;
    res.json({ data: { ...employee, history } });
  }),
);

router.post(
  '/',
  write,
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    await assertRefs(req.body.departmentTeamId, req.body.roomId);
    try {
      const emp = await prisma.employee.create({
        data: { ...req.body, roomId: req.body.roomId ?? null, status: 'ACTIVE' },
        include: detailInclude,
      });
      await audit(req, 'employee.create', 'Employee', emp.id, { fullName: emp.fullName, departmentTeamId: emp.departmentTeamId });
      res.status(201).json({ data: emp });
    } catch (e) {
      if (isDup(e)) throw conflict('An employee with this fullName already exists in this department');
      throw e;
    }
  }),
);

router.patch(
  '/:id',
  write,
  validate({ params: idParams, body: patchBody }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.employee.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) throw notFound('Employee');
    await assertRefs(req.body.departmentTeamId, req.body.roomId);
    try {
      const emp = await prisma.employee.update({ where: { id: existing.id }, data: req.body, include: detailInclude });
      await audit(req, 'employee.update', 'Employee', emp.id, { changes: Object.keys(req.body) });
      res.json({ data: emp });
    } catch (e) {
      if (isDup(e)) throw conflict('An employee with this fullName already exists in this department');
      throw e;
    }
  }),
);

router.delete(
  '/:id',
  write,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const emp = await prisma.employee.findUnique({
      where: { id: req.params.id },
      include: {
        _count: { select: { managedRooms: true, currentAssets: true, assignments: true, timelineEntries: true } },
        assignments: { where: { status: 'ACTIVE' }, select: { id: true } },
      },
    });
    if (!emp) throw notFound('Employee');

    if (emp._count.managedRooms > 0) throw conflict('Employee is the manager of one or more rooms');
    if (emp._count.currentAssets > 0) throw conflict('Employee currently holds active assets');
    if (emp.assignments.length > 0) throw conflict('Employee has an active assignment');

    const hasHistory = emp._count.assignments > 0 || emp._count.timelineEntries > 0;
    if (hasHistory) {
      await prisma.employee.update({ where: { id: emp.id }, data: { status: 'LEFT' } });
      await audit(req, 'employee.deactivate', 'Employee', emp.id);
      return res.json({ data: { id: emp.id, softDeleted: true } });
    }

    await prisma.employee.delete({ where: { id: emp.id } });
    await audit(req, 'employee.delete', 'Employee', emp.id, { fullName: emp.fullName });
    res.status(204).end();
  }),
);

module.exports = router;
