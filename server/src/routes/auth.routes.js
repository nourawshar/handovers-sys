'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../db');
const config = require('../config');
const { z } = require('zod');
const { asyncHandler, notFound } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { REFRESH_COOKIE, setAuthCookies, clearAuthCookies } = require('../utils/tokens');
const authService = require('../services/auth.service');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.LOGIN_RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' } },
});

const loginBody = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(200) });
const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

router.post(
  '/login',
  loginLimiter,
  validate({ body: loginBody }),
  asyncHandler(async (req, res) => {
    const { user, session } = await authService.login(req.body.username, req.body.password, meta(req));
    setAuthCookies(res, session);
    // Tokens are in HttpOnly cookies; the access token is also returned for non-browser API clients (curl/tests).
    res.json({ user, accessToken: session.accessToken, expiresIn: config.accessTtlSec });
  }),
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    try {
      const { user, session } = await authService.refresh(req.cookies?.[REFRESH_COOKIE], meta(req));
      setAuthCookies(res, session);
      res.json({ user, accessToken: session.accessToken, expiresIn: config.accessTtlSec });
    } catch (e) {
      clearAuthCookies(res);
      throw e;
    }
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await authService.logout(req.cookies?.[REFRESH_COOKIE]);
    clearAuthCookies(res);
    res.status(204).end();
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, include: { room: true } });
    if (!user) throw notFound('User');
    res.json({
      user: authService.publicUser(user),
      scope: { allRooms: user.role !== 'TEAM_LEADER', roomId: user.role === 'TEAM_LEADER' ? user.roomId : null },
    });
  }),
);

module.exports = router;
