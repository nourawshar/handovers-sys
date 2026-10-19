'use strict';
const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const { asyncHandler, notFound } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { requireCapability, roomScope, can } = require('../middleware/rbac');
const { resolveStored, removeFile } = require('../services/upload.service');
const { audit } = require('../services/audit.service');

const router = express.Router();
const idParams = z.object({ id: z.uuid() });

/** Stream a stored image. Auth required; Team Leaders only for photos of assets in their room. */
router.get(
  '/:id/file',
  requireCapability('inventory:read'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const photo = await prisma.photo.findUnique({ where: { id: req.params.id }, include: { asset: { select: { roomId: true, currentHolder: { select: { roomId: true } } } } } });
    if (!photo) throw notFound('Photo');
    const scope = roomScope(req.user);
    if (scope) {
      const a = photo.asset;
      if (!a || (a.roomId !== scope.roomId && a.currentHolder?.roomId !== scope.roomId)) throw notFound('Photo');
    }
    if (photo.accountId && !can(req.user.role, 'accounts:read')) throw notFound('Photo');
    res.set({ 'Content-Type': photo.mimeType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': 'inline' });
    res.sendFile(resolveStored(photo.path), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File missing on disk' } });
    });
  }),
);

router.delete(
  '/:id',
  requireCapability('inventory:write'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const photo = await prisma.photo.findUnique({ where: { id: req.params.id } });
    if (!photo) throw notFound('Photo');
    await prisma.photo.delete({ where: { id: photo.id } });
    await removeFile(photo.path);
    await audit(req, 'photo.delete', 'Photo', photo.id, { assetId: photo.assetId, accountId: photo.accountId });
    res.status(204).end();
  }),
);

module.exports = router;
