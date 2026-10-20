'use strict';
const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { requireCapability, roomScope } = require('../middleware/rbac');
const { paginationQuery } = require('../utils/pagination');
const {
  REPORT_COLUMNS,
  buildRows,
  toCsv,
  toXlsx,
} = require('../services/report.service');

const router = express.Router();
const read = requireCapability('reports:read'); // ADMIN / MANAGER / TEAM_LEADER
const exportCap = requireCapability('reports:export'); // ADMIN / MANAGER (TEAM_LEADER → 403)

const conditionEnum = z.enum(['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'DISPOSED']);
const daysQ = z.coerce.number().int().min(0).optional();

const whoQuery = z.object({
  ...paginationQuery,
  scope: z.enum(['room', 'team', 'category']).optional(),
  roomId: z.uuid().optional(),
  departmentTeamId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
});
const conditionQuery = z.object({
  ...paginationQuery,
  categoryId: z.uuid().optional(),
  status: conditionEnum.optional(),
});
const stalenessQuery = z.object({ ...paginationQuery, days: daysQ });
const outstandingQuery = z.object({ ...paginationQuery, days: daysQ });
const compositionQuery = z.object({ ...paginationQuery, roomId: z.uuid().optional() });
// Union of every report filter, so export reuses the same filters as the on-screen report.
const exportQuery = z.object({
  ...paginationQuery,
  scope: z.enum(['room', 'team', 'category']).optional(),
  roomId: z.uuid().optional(),
  departmentTeamId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  status: conditionEnum.optional(),
  days: daysQ,
});

const SLUGS = Object.keys(REPORT_COLUMNS);

// GET /reports/who-has-what (§10.1)
router.get(
  '/who-has-what',
  read,
  validate({ query: whoQuery }),
  asyncHandler(async (req, res) => {
    const data = await buildRows('who-has-what', req.validQuery, roomScope(req.user));
    res.json({ data });
  }),
);

// GET /reports/condition (§10.2)
router.get(
  '/condition',
  read,
  validate({ query: conditionQuery }),
  asyncHandler(async (req, res) => {
    const data = await buildRows('condition', req.validQuery, roomScope(req.user));
    res.json({ data });
  }),
);

// GET /reports/backup-staleness (§10.3)
router.get(
  '/backup-staleness',
  read,
  validate({ query: stalenessQuery }),
  asyncHandler(async (req, res) => {
    const data = await buildRows('backup-staleness', req.validQuery, roomScope(req.user));
    res.json({ data });
  }),
);

// GET /reports/outstanding-assignments (§10.4)
router.get(
  '/outstanding-assignments',
  read,
  validate({ query: outstandingQuery }),
  asyncHandler(async (req, res) => {
    const data = await buildRows('outstanding-assignments', req.validQuery, roomScope(req.user));
    res.json({ data });
  }),
);

// GET /reports/room-composition (§10.5)
router.get(
  '/room-composition',
  read,
  validate({ query: compositionQuery }),
  asyncHandler(async (req, res) => {
    const data = await buildRows('room-composition', req.validQuery, roomScope(req.user));
    res.json({ data });
  }),
);

// GET /reports/:id/export (§10.6) — CSV (default) or XLSX by Accept header. ADM/MGR only.
router.get(
  '/:id/export',
  exportCap,
  validate({ query: exportQuery }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!SLUGS.includes(id)) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: `Report '${id}' not found` } });
    }
    const rows = await buildRows(id, req.validQuery, roomScope(req.user));
    const columns = REPORT_COLUMNS[id];
    const date = new Date().toISOString().slice(0, 10);
    const accept = req.get('accept') || '';
    const wantXlsx = accept.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const filename = `${id}-${date}.${wantXlsx ? 'xlsx' : 'csv'}`;

    if (wantXlsx) {
      const buf = await toXlsx(rows, columns);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buf);
    }
    const csv = toCsv(rows, columns);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  }),
);

module.exports = router;
