'use strict';
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

function signAccessToken(user) {
  return jwt.sign({ role: user.role, roomId: user.roomId ?? null }, config.JWT_ACCESS_SECRET, {
    subject: user.id,
    expiresIn: config.accessTtlSec,
    issuer: 'handovers-sys',
    algorithm: 'HS256',
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, config.JWT_ACCESS_SECRET, { issuer: 'handovers-sys', algorithms: ['HS256'] });
}

/** Opaque, high-entropy refresh token (only its SHA-256 is stored). */
const newRefreshToken = () => crypto.randomBytes(48).toString('base64url');

function baseCookie() {
  return { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax' };
}

function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...baseCookie(), path: '/', maxAge: config.accessTtlSec * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseCookie(),
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: config.refreshTtlMs,
  });
}

function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie(), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(), sameSite: 'strict', path: REFRESH_COOKIE_PATH });
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  signAccessToken,
  verifyAccessToken,
  newRefreshToken,
  setAuthCookies,
  clearAuthCookies,
};
