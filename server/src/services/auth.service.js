'use strict';
const crypto = require('node:crypto');
const argon2 = require('argon2');
const prisma = require('../db');
const config = require('../config');
const { unauthorized } = require('../utils/errors');
const { sha256 } = require('../utils/crypto');
const { signAccessToken, newRefreshToken } = require('../utils/tokens');

const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const hashPassword = (pw) => argon2.hash(pw, ARGON_OPTS);

// Used to equalise timing when the username does not exist (prevents user enumeration).
let dummyHashPromise;
const dummyHash = () => (dummyHashPromise ??= argon2.hash('dummy-password-for-timing', ARGON_OPTS));

const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  fullName: u.fullName,
  role: u.role,
  roomId: u.roomId ?? null,
  room: u.room ? { id: u.room.id, code: u.room.code } : null,
});

async function issueSession(user, { familyId, ip, userAgent } = {}) {
  const refreshToken = newRefreshToken();
  const row = await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(refreshToken),
      familyId: familyId ?? crypto.randomUUID(),
      expiresAt: new Date(Date.now() + config.refreshTtlMs),
      ip: ip ?? null,
      userAgent: userAgent?.slice(0, 255) ?? null,
    },
  });
  return { accessToken: signAccessToken(user), refreshToken, refreshRowId: row.id, familyId: row.familyId };
}

async function login(username, password, meta) {
  const user = await prisma.user.findUnique({ where: { username }, include: { room: true } });
  const ok = await argon2.verify(user?.passwordHash ?? (await dummyHash()), password).catch(() => false);
  if (!user || !ok || !user.isActive) throw unauthorized('Invalid username or password', 'INVALID_CREDENTIALS');

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const session = await issueSession(user, meta);
  return { user: publicUser(user), session };
}

/** Rotating refresh with reuse detection: a revoked token being replayed kills the whole family. */
async function refresh(rawToken, meta) {
  if (!rawToken) throw unauthorized('Missing refresh token', 'NO_REFRESH_TOKEN');
  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(rawToken) },
    include: { user: { include: { room: true } } },
  });
  if (!row) throw unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN');

  if (row.revokedAt) {
    await prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    throw unauthorized('Refresh token reuse detected; please log in again', 'REFRESH_REUSE');
  }
  if (row.expiresAt <= new Date() || !row.user.isActive) throw unauthorized('Refresh token expired', 'INVALID_REFRESH_TOKEN');

  // Atomic claim: only one concurrent request may rotate this token.
  const claimed = await prisma.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (claimed.count !== 1) throw unauthorized('Refresh token already used', 'REFRESH_REUSE');

  const session = await issueSession(row.user, { ...meta, familyId: row.familyId });
  await prisma.refreshToken.update({ where: { id: row.id }, data: { replacedBy: session.refreshRowId } });
  return { user: publicUser(row.user), session };
}

async function logout(rawToken) {
  if (!rawToken) return;
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (row) {
    await prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
}

const revokeAllForUser = (userId) =>
  prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });

module.exports = { hashPassword, login, refresh, logout, revokeAllForUser, publicUser };
