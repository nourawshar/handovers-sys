'use strict';
const prisma = require('../db');
const { unauthorized } = require('../utils/errors');
const { ACCESS_COOKIE, verifyAccessToken } = require('../utils/tokens');

/**
 * Authenticates via the HttpOnly access cookie, or `Authorization: Bearer <jwt>` (API clients).
 * Re-loads the user so deactivation / role / room changes take effect immediately.
 */
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    const token = req.cookies?.[ACCESS_COOKIE] ?? (header?.startsWith('Bearer ') ? header.slice(7) : null);
    if (!token) throw unauthorized();

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (e) {
      throw unauthorized(e.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token',
        e.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED');
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, username: true, fullName: true, role: true, roomId: true, isActive: true },
    });
    if (!user || !user.isActive) throw unauthorized('Account disabled or not found');
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { authenticate };
