'use strict';
const prisma = require('../db');

/** Append-only audit of privileged actions (README §10). Never throws into the request path. */
async function audit(req, action, targetType, targetId, meta) {
  try {
    await prisma.auditLog.create({
      data: { actorId: req.user?.id ?? null, action, targetType, targetId, meta: meta ?? undefined, ip: req.ip },
    });
  } catch (e) {
    console.error('[audit] failed to write audit log', e.message);
  }
}

module.exports = { audit };
