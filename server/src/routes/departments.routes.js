'use strict';
const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const { asyncHandler, notFound, badRequest, conflict } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { requireCapability } = require('../middleware/rbac');
const { audit } = require('../services/audit.service');

const router = express.Router();
// reads: anyone with people:read (TEAM_LEADER is room-scoped but departments are global); writes: Admin only (people:write).
const read = requireCapability('people:read');
const write = requireCapability('people:write');

const idParams = z.object({ id: z.uuid() });
const departmentType = z.enum(['CALLCENTER', 'HOSPITAL']);

const createBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    type: departmentType.default('CALLCENTER'),
    sortOrder: z.number().int().min(0).default(0),
    parentId: z.uuid().nullish(),
  })
  .strict();

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    type: departmentType,
    sortOrder: z.number().int().min(0),
    parentId: z.uuid().nullable(),
  })
  .partial()
  .strict();

async function assertParentExists(parentId) {
  if (!parentId) return;
  const parent = await prisma.departmentTeam.findUnique({ where: { id: parentId }, select: { id: true } });
  if (!parent) throw badRequest('parentId does not exist');
}

/** Catch Prisma unique (P2002) on department.name and surface it as a friendly 409. */
async function run(promise) {
  try {
    return await promise;
  } catch (e) {
    if (e?.code === 'P2002') throw conflict('A department with that name already exists');
    throw e;
  }
}

async function loadScopedDepartment(id) {
  const dept = await prisma.departmentTeam.findUnique({
    where: { id },
    include: { _count: { select: { employees: true, workIdentities: true, children: true } } },
  });
  if (!dept) throw notFound('Department');
  return dept;
}

router.get(
  '/',
  read,
  asyncHandler(async (req, res) => {
    // Preserve the legacy read-only lookup shape (bare { data: [...] }) the Phase 1 UI depends on.
    const data = await prisma.departmentTeam.findMany({ orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }] });
    res.json({ data });
  }),
);

router.post(
  '/',
  write,
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    await assertParentExists(req.body.parentId);
    const dept = await run(
      prisma.departmentTeam.create({
        data: { name: req.body.name, type: req.body.type, sortOrder: req.body.sortOrder, parentId: req.body.parentId ?? null },
      }),
    );
    await audit(req, 'department.create', 'DepartmentTeam', dept.id, { name: dept.name, type: dept.type });
    res.status(201).json({ data: dept });
  }),
);

router.patch(
  '/:id',
  write,
  validate({ params: idParams, body: patchBody }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.departmentTeam.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) throw notFound('Department');
    if (req.body.parentId !== undefined) {
      await assertParentExists(req.body.parentId);
      if (req.body.parentId === req.params.id) throw badRequest('parentId cannot reference the department itself');
    }
    const dept = await run(prisma.departmentTeam.update({ where: { id: req.params.id }, data: req.body }));
    await audit(req, 'department.update', 'DepartmentTeam', dept.id, { changes: Object.keys(req.body) });
    res.json({ data: dept });
  }),
);

router.delete(
  '/:id',
  write,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const dept = await loadScopedDepartment(req.params.id);
    // Block-only delete: a department referenced by an employee, work identity, or child department cannot be removed.
    if (dept._count.employees || dept._count.workIdentities || dept._count.children) {
      throw conflict('Department is still referenced by an employee, work identity, or child department and cannot be deleted');
    }
    await prisma.departmentTeam.delete({ where: { id: dept.id } });
    await audit(req, 'department.delete', 'DepartmentTeam', dept.id, { name: dept.name });
    res.status(204).end();
  }),
);

module.exports = router;