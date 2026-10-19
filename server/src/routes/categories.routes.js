'use strict';
const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const { asyncHandler, notFound, badRequest, conflict } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { requireCapability } = require('../middleware/rbac');
const { boolQuery } = require('../utils/pagination');
const { audit } = require('../services/audit.service');

const router = express.Router();
const read = requireCapability('inventory:read');
const write = requireCapability('inventory:write');

const idParams = z.object({ id: z.uuid() });
const fieldParams = z.object({ fieldId: z.uuid() });

const prefix = z.string().trim().toUpperCase().regex(/^[A-Z]{2,5}$/, '2-5 letters, e.g. PHN');
const fieldKey = z.string().trim().regex(/^[a-z][a-z0-9_]{0,49}$/, 'lowercase letters, digits, underscore; must start with a letter');

const categoryCreate = z
  .object({
    name: z.string().trim().min(1).max(100),
    parentId: z.uuid().nullish(),
    kind: z.enum(['physical', 'digital', 'account']).default('physical'),
    codePrefix: prefix.default('AST'),
    isActive: z.boolean().default(true),
  })
  .strict();
const categoryPatch = categoryCreate.partial().strict();

const fieldBase = z.object({
  key: fieldKey,
  label: z.string().trim().min(1).max(100),
  type: z.enum(['string', 'number', 'date', 'boolean', 'select', 'textarea']).default('string'),
  options: z.array(z.string().trim().min(1).max(100)).min(1).max(100).nullish(),
  required: z.boolean().default(false),
  isSearchable: z.boolean().default(false),
  isIdentifier: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10000).default(0),
});
const fieldCreate = fieldBase.strict().refine((f) => f.type !== 'select' || (f.options && f.options.length), {
  path: ['options'],
  message: 'options are required for select fields',
});
const fieldPatch = fieldBase.omit({ key: true, type: true }).partial().strict();

const fieldOrder = [{ sortOrder: 'asc' }, { label: 'asc' }];

/** GET /asset-categories — flat list with parentId + nested children; ?includeFields=true */
router.get(
  '/',
  read,
  validate({ query: z.object({ includeInactive: boolQuery.optional(), includeFields: boolQuery.optional(), kind: z.enum(['physical', 'digital', 'account']).optional() }) }),
  asyncHandler(async (req, res) => {
    const { includeInactive, includeFields, kind } = req.validQuery;
    // Only Admin/Manager may see deactivated categories
    const showInactive = includeInactive && req.user.role !== 'TEAM_LEADER';
    const rows = await prisma.assetCategory.findMany({
      where: { ...(showInactive ? {} : { isActive: true }), ...(kind && { kind }) },
      orderBy: { name: 'asc' },
      include: { _count: { select: { assets: true } }, ...(includeFields && { fields: { orderBy: fieldOrder } }) },
    });
    const byId = new Map(rows.map((r) => [r.id, { ...r, assetCount: r._count.assets, _count: undefined, children: [] }]));
    const roots = [];
    for (const node of byId.values()) {
      const parent = node.parentId && byId.get(node.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    res.json({ data: roots, flat: [...byId.values()].map(({ children, ...n }) => n) });
  }),
);

router.post(
  '/',
  write,
  validate({ body: categoryCreate }),
  asyncHandler(async (req, res) => {
    if (req.body.parentId) {
      const parent = await prisma.assetCategory.findUnique({ where: { id: req.body.parentId } });
      if (!parent) throw badRequest('parentId does not exist');
      if (parent.parentId) throw badRequest('Only one level of subcategories is supported');
    }
    const data = await prisma.assetCategory.create({ data: { ...req.body, parentId: req.body.parentId ?? null } });
    await audit(req, 'category.create', 'AssetCategory', data.id, { name: data.name });
    res.status(201).json({ data });
  }),
);

router.patch(
  '/:id',
  write,
  validate({ params: idParams, body: categoryPatch }),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const existing = await prisma.assetCategory.findUnique({ where: { id }, include: { _count: { select: { children: true } } } });
    if (!existing) throw notFound('Category');
    if (req.body.parentId !== undefined && req.body.parentId !== null) {
      if (req.body.parentId === id) throw badRequest('A category cannot be its own parent');
      if (existing._count.children) throw badRequest('A category with subcategories cannot become a subcategory');
      const parent = await prisma.assetCategory.findUnique({ where: { id: req.body.parentId } });
      if (!parent) throw badRequest('parentId does not exist');
      if (parent.parentId) throw badRequest('Only one level of subcategories is supported');
    }
    const data = await prisma.assetCategory.update({ where: { id }, data: req.body });
    await audit(req, 'category.update', 'AssetCategory', id, { changes: Object.keys(req.body) });
    res.json({ data });
  }),
);

router.delete(
  '/:id',
  write,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const existing = await prisma.assetCategory.findUnique({ where: { id }, include: { _count: { select: { assets: true, children: true } } } });
    if (!existing) throw notFound('Category');
    if (existing._count.assets || existing._count.children) {
      throw conflict(
        `Category is in use (${existing._count.assets} asset(s), ${existing._count.children} subcategorie(s)); deactivate it instead (PATCH isActive=false)`,
        { assets: existing._count.assets, children: existing._count.children },
      );
    }
    await prisma.assetCategory.delete({ where: { id } });
    await audit(req, 'category.delete', 'AssetCategory', id, { name: existing.name });
    res.status(204).end();
  }),
);

// ── Custom-column designer ──

router.get(
  '/:id/fields',
  read,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const cat = await prisma.assetCategory.findUnique({ where: { id: req.params.id } });
    if (!cat) throw notFound('Category');
    const data = await prisma.assetCategoryField.findMany({ where: { categoryId: cat.id }, orderBy: fieldOrder });
    res.json({ data });
  }),
);

router.post(
  '/:id/fields',
  write,
  validate({ params: idParams, body: fieldCreate }),
  asyncHandler(async (req, res) => {
    const cat = await prisma.assetCategory.findUnique({ where: { id: req.params.id } });
    if (!cat) throw notFound('Category');
    const { options, ...rest } = req.body;
    const data = await prisma.assetCategoryField.create({
      data: { ...rest, categoryId: cat.id, options: rest.type === 'select' ? options : undefined },
    });
    await audit(req, 'category.field.create', 'AssetCategoryField', data.id, { categoryId: cat.id, key: data.key });
    res.status(201).json({ data });
  }),
);

router.patch(
  '/fields/:fieldId',
  write,
  validate({ params: fieldParams, body: fieldPatch }),
  asyncHandler(async (req, res) => {
    const field = await prisma.assetCategoryField.findUnique({ where: { id: req.params.fieldId } });
    if (!field) throw notFound('Field');
    if (req.body.options && field.type !== 'select') throw badRequest('options only apply to select fields');
    const data = await prisma.assetCategoryField.update({ where: { id: field.id }, data: req.body });
    await audit(req, 'category.field.update', 'AssetCategoryField', field.id, { changes: Object.keys(req.body) });
    res.json({ data });
  }),
);

router.delete(
  '/fields/:fieldId',
  write,
  validate({ params: fieldParams }),
  asyncHandler(async (req, res) => {
    const field = await prisma.assetCategoryField.findUnique({ where: { id: req.params.fieldId }, include: { _count: { select: { values: true } } } });
    if (!field) throw notFound('Field');
    await prisma.assetCategoryField.delete({ where: { id: field.id } }); // cascades stored values
    await audit(req, 'category.field.delete', 'AssetCategoryField', field.id, { key: field.key, valuesRemoved: field._count.values });
    res.status(204).end();
  }),
);

module.exports = router;
