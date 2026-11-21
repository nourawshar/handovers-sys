'use strict';
const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const { asyncHandler, notFound } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { requireCapability, roomScope, can } = require('../middleware/rbac');
const { resolveStored, removeFile } = require('../services/upload.service');
const { audit } = require('../services/audit.service');
const { assignmentScopeWhere } = require('../services/assignment.service');

const router = express.Router();
const idParams = z.object({ id: z.uuid() });

/** Asset visibility for a scoped user — the same rule as GET /assets/:id (assets.routes.js scopeWhere):
 *  TEAM_LEADER → asset in their room or held by an employee of their room;
 *  CALL_CENTER_MANAGER → asset in any CALLCENTER room or held by an employee of one. Keep the two in sync. */
function assetScopeWhere(scope) {
  if (scope.allCallCenter) {
    return { OR: [{ room: { teamType: 'CALLCENTER' } }, { currentHolder: { room: { teamType: 'CALLCENTER' } } }] };
  }
  return { OR: [{ roomId: scope.roomId }, { currentHolder: { roomId: scope.roomId } }] };
}

/** Stream a stored image. Auth required. A photo is as visible as its parent: an asset photo follows the
 *  asset detail rule, an assignment photo follows the assignment detail rule (seat room, else employee
 *  room) — for TEAM_LEADER (own room) and CALL_CENTER_MANAGER (call-centre rooms) alike. Photos that
 *  belong to neither (e.g. account photos) are never shown to scoped users. */
router.get(
  '/:id/file',
  requireCapability('inventory:read'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const scope = roomScope(req.user);
    const visible = scope ? { OR: [{ asset: assetScopeWhere(scope) }, { assignment: assignmentScopeWhere(scope) }] } : {};
    const photo = await prisma.photo.findFirst({ where: { AND: [{ id: req.params.id }, visible] } });
    if (!photo) throw notFound('Photo');
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
