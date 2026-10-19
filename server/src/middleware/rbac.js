'use strict';
const { forbidden } = require('../utils/errors');

/**
 * README §9 RBAC matrix, expressed as capabilities. Server-side only source of truth.
 *   ADMIN       full access
 *   MANAGER     read-only across all rooms/teams; may export reports; credentials masked
 *   TEAM_LEADER read-only, scoped to own room (User.roomId); no exports; no credentials
 */
const CAPABILITIES = {
  // reading
  'inventory:read': ['ADMIN', 'MANAGER', 'TEAM_LEADER'], // team leader is room-scoped (see roomScope)
  'people:read': ['ADMIN', 'MANAGER', 'TEAM_LEADER'],
  'accounts:read': ['ADMIN', 'MANAGER'], // credentials masked for MANAGER; TEAM_LEADER denied
  'assignments:read': ['ADMIN', 'MANAGER', 'TEAM_LEADER'], // TEAM_LEADER room-scoped (see roomScope)
  'reports:read': ['ADMIN', 'MANAGER', 'TEAM_LEADER'],
  'reports:export': ['ADMIN', 'MANAGER'],
  // writing (Admin only)
  'inventory:write': ['ADMIN'], // assets, categories, custom columns, photos
  'people:write': ['ADMIN'], // employees, departments, rooms, work identities
  'accounts:write': ['ADMIN'],
  'accounts:decrypt': ['ADMIN'],
  'assignments:write': ['ADMIN'],
  'users:manage': ['ADMIN'],
};

const can = (role, capability) => (CAPABILITIES[capability] ?? []).includes(role);

/** Route guard. Must run after `authenticate`. */
function requireCapability(capability) {
  if (!(capability in CAPABILITIES)) throw new Error(`Unknown capability: ${capability}`);
  return (req, res, next) => {
    if (!req.user) return next(forbidden());
    if (!can(req.user.role, capability)) return next(forbidden());
    next();
  };
}

/**
 * Room scope for the current user: null => unrestricted, { roomId } => restricted.
 * A TEAM_LEADER without a room is restricted to a non-existent room (fail closed).
 */
function roomScope(user) {
  if (user.role === 'TEAM_LEADER') return { roomId: user.roomId ?? '00000000-0000-0000-0000-000000000000' };
  return null;
}

module.exports = { CAPABILITIES, can, requireCapability, roomScope };
