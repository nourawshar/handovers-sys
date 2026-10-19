'use strict';
const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const { asyncHandler, notFound, badRequest, conflict } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { requireCapability } = require('../middleware/rbac');
const { paginationQuery, paginate, pageMeta, boolQuery } = require('../utils/pagination');
const { encrypt, decrypt } = require('../utils/crypto');
const { audit } = require('../services/audit.service');
const { upload, persistImages, removeFile } = require('../services/upload.service');

const router = express.Router();
// TEAM_LEADER has no access to accounts at all (§9: credentials ❌). MANAGER sees masked records.
const read = requireCapability('accounts:read');
const write = requireCapability('accounts:write');
const decryptCap = requireCapability('accounts:decrypt');

const idParams = z.object({ id: z.uuid() });
const kind = z.enum(['GMAIL', 'WHATSAPP', 'BITRIX', 'OTHER']);

const MASK = '••••••••';

const publicSelect = {
  id: true, assetId: true, kind: true, subcategory: true, identifier: true, email: true,
  isWhatsAppBackup: true, isActive: true, currentAssignmentId: true, notes: true, createdAt: true, updatedAt: true,
  asset: { select: { id: true, code: true, name: true } },
  currentAssignment: { select: { id: true, assignmentCode: true, status: true } },
  _count: { select: { photos: true } },
};

/** The encrypted blob never leaves the server; clients only ever see a mask. */
const shape = (a) => ({ ...a, password: MASK, hasPassword: true });

const createBody = z
  .object({
    kind,
    subcategory: z.string().trim().max(100).nullish(),
    identifier: z.string().trim().min(1).max(200),
    email: z.email().max(200).nullish(),
    password: z.string().min(1).max(500),
    isWhatsAppBackup: z.boolean().default(false),
    isActive: z.boolean().default(true),
    assetId: z.uuid().nullish(),
    notes: z.string().trim().max(5000).nullish(),
  })
  .strict();

const patchBody = createBody.partial().extend({ email: z.email().max(200).nullable().optional(), subcategory: z.string().trim().max(100).nullable().optional(), assetId: z.uuid().nullable().optional(), notes: z.string().trim().max(5000).nullable().optional() }).strict();

async function assertAssetFree(assetId, exceptAccountId) {
  if (!assetId) return;
  if (!(await prisma.asset.findUnique({ where: { id: assetId }, select: { id: true } }))) throw badRequest('assetId does not exist');
  const used = await prisma.account.findUnique({ where: { assetId }, select: { id: true } });
  if (used && used.id !== exceptAccountId) throw conflict('That asset is already linked to another account');
}

router.get(
  '/',
  read,
  validate({ query: z.object({ ...paginationQuery, q: z.string().trim().max(100).optional(), kind: kind.optional(), isActive: boolQuery.optional(), isWhatsAppBackup: boolQuery.optional(), inUse: boolQuery.optional() }) }),
  asyncHandler(async (req, res) => {
    const f = req.validQuery;
    const where = {
      ...(f.kind && { kind: f.kind }),
      ...(f.isActive !== undefined && { isActive: f.isActive }),
      ...(f.isWhatsAppBackup !== undefined && { isWhatsAppBackup: f.isWhatsAppBackup }),
      ...(f.inUse !== undefined && { currentAssignmentId: f.inUse ? { not: null } : null }),
      ...(f.q && { OR: [{ identifier: { contains: f.q, mode: 'insensitive' } }, { email: { contains: f.q, mode: 'insensitive' } }, { subcategory: { contains: f.q, mode: 'insensitive' } }] }),
    };
    const [total, rows] = await Promise.all([
      prisma.account.count({ where }),
      prisma.account.findMany({ where, select: publicSelect, orderBy: [{ kind: 'asc' }, { identifier: 'asc' }], ...paginate(f) }),
    ]);
    res.json({ data: rows.map(shape), meta: pageMeta(f, total) });
  }),
);

router.get(
  '/:id',
  read,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const a = await prisma.account.findUnique({ where: { id: req.params.id }, select: { ...publicSelect, photos: { select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true } } } });
    if (!a) throw notFound('Account');
    res.json({ data: { ...shape(a), photos: a.photos.map((p) => ({ ...p, url: `/api/v1/photos/${p.id}/file` })) } });
  }),
);

router.post(
  '/',
  write,
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const { password, ...rest } = req.body;
    await assertAssetFree(rest.assetId);
    const a = await prisma.account.create({ data: { ...rest, assetId: rest.assetId ?? null, passwordEnc: encrypt(password) }, select: publicSelect });
    await audit(req, 'account.create', 'Account', a.id, { kind: a.kind, identifier: a.identifier });
    res.status(201).json({ data: shape(a) });
  }),
);

router.patch(
  '/:id',
  write,
  validate({ params: idParams, body: patchBody }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.account.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Account');
    const { password, ...rest } = req.body;
    if (rest.assetId !== undefined) await assertAssetFree(rest.assetId, existing.id);
    const a = await prisma.account.update({
      where: { id: existing.id },
      data: { ...rest, ...(password !== undefined && { passwordEnc: encrypt(password) }) },
      select: publicSelect,
    });
    await audit(req, password !== undefined ? 'account.password_change' : 'account.update', 'Account', a.id, { changes: Object.keys(req.body).filter((k) => k !== 'password') });
    res.json({ data: shape(a) });
  }),
);

router.delete(
  '/:id',
  write,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const a = await prisma.account.findUnique({ where: { id: req.params.id }, include: { photos: true, _count: { select: { phoneAssignmentDetails: true } } } });
    if (!a) throw notFound('Account');
    if (a.currentAssignmentId) throw conflict('Account is in use by an active assignment');
    if (a._count.phoneAssignmentDetails) {
      await prisma.account.update({ where: { id: a.id }, data: { isActive: false } }); // history must not break
      await audit(req, 'account.deactivate', 'Account', a.id);
      return res.json({ data: { id: a.id, softDeleted: true, isActive: false } });
    }
    await prisma.account.delete({ where: { id: a.id } });
    await Promise.all(a.photos.map((p) => removeFile(p.path)));
    await audit(req, 'account.delete', 'Account', a.id, { identifier: a.identifier });
    res.status(204).end();
  }),
);

/** Admin only, every call is audited. */
router.get(
  '/:id/decrypt',
  decryptCap,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const a = await prisma.account.findUnique({ where: { id: req.params.id }, select: { id: true, kind: true, identifier: true, email: true, passwordEnc: true } });
    if (!a) throw notFound('Account');
    let password;
    try {
      password = decrypt(a.passwordEnc);
    } catch {
      throw new (require('../utils/errors').AppError)(500, 'DECRYPT_FAILED', 'Stored credential could not be decrypted (wrong CREDENTIALS_ENC_KEY?)');
    }
    await audit(req, 'account.decrypt', 'Account', a.id, { identifier: a.identifier });
    res.set('Cache-Control', 'no-store');
    res.json({ data: { id: a.id, kind: a.kind, identifier: a.identifier, email: a.email, password } });
  }),
);

router.post(
  '/:id/photos',
  write,
  validate({ params: idParams }),
  upload.array('photos', 10),
  asyncHandler(async (req, res) => {
    const a = await prisma.account.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!a) throw notFound('Account');
    if (!req.files?.length) throw badRequest('No images uploaded (multipart field name: "photos")');
    const saved = await persistImages(req.files, 'accounts');
    const photos = await prisma.$transaction(
      saved.map((s) => prisma.photo.create({ data: { ...s, type: 'GENERAL', accountId: a.id, uploadedById: req.user.id }, select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true } })),
    ).catch(async (e) => {
      await Promise.all(saved.map((s) => removeFile(s.path)));
      throw e;
    });
    await audit(req, 'account.photo.upload', 'Account', a.id, { count: photos.length });
    res.status(201).json({ data: photos.map((p) => ({ ...p, url: `/api/v1/photos/${p.id}/file` })) });
  }),
);

module.exports = router;
