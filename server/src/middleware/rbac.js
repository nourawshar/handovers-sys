'use strict';
const { forbidden } = require('../utils/errors');

/**
 * README §9 RBAC matrix, expressed as capabilities. Server-side only source of truth.
 *   ADMIN               full access
 *   MANAGER             read-only across all rooms/teams; may export reports; credentials masked
 *   TEAM_LEADER         read-only, scoped to own room (User.roomId); no exports; no credentials
 *   CALL_CENTER_MANAGER read-only across ALL call-center rooms (CEO + assistant); no exports;
 *                       no credentials (passwords are IT-only) — CHANGE 7 / BE-17
 */
const CAPABILITIES = {
  // reading
  'inventory:read': ['ADMIN', 'MANAGER', 'TEAM_LEADER', 'CALL_CENTER_MANAGER'], // TL/CCM room-scoped (see roomScope)
  'people:read': ['ADMIN', 'MANAGER', 'TEAM_LEADER', 'CALL_CENTER_MANAGER'],
  'accounts:read': ['ADMIN', 'MANAGER'], // credentials masked for MANAGER; TL/CCM denied
  'assignments:read': ['ADMIN', 'MANAGER', 'TEAM_LEADER', 'CALL_CENTER_MANAGER'], // TL/CCM room-scoped
  'reports:read': ['ADMIN', 'MANAGER', 'TEAM_LEADER', 'CALL_CENTER_MANAGER'],
  'reports:export': ['ADMIN', 'MANAGER'],
  // writing (Admin only)
  'inventory:write': ['ADMIN'], // assets, categories, custom columns, photos
  'people:write': ['ADMIN'], // employees, departments, rooms, work identities
  'accounts:write': ['ADMIN'],
  'accounts:decrypt': ['ADMIN'],
  'assignments:write': ['ADMIN'],
  'users:manage': ['ADMIN'],
  'audit:read': ['ADMIN'], // NEW — audit-logs page (CHANGE 8 / BE-17)
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
 * Room scope for the current user: null => unrestricted, { roomId } => own room,
 * { allCallCenter: true } => every CALLCENTER room.
 *   TEAM_LEADER         -> { roomId } (own room; fail closed when no room)
 *   CALL_CENTER_MANAGER -> { allCallCenter: true }
 *   ADMIN / MANAGER     -> null (unrestricted)
 */
function roomScope(user) {
  if (user.role === 'TEAM_LEADER') return { roomId: user.roomId ?? '00000000-0000-0000-0000-000000000000' };
  if (user.role === 'CALL_CENTER_MANAGER') return { allCallCenter: true };
  return null;
}

module.exports = { CAPABILITIES, can, requireCapability, roomScope };
