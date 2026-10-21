'use strict';
/**
 * Phase 4 report queries + shared row-shaping + CSV/XLSX export serializer (BE-4).
 * All five reports are read-only and room-scoped for TEAM_LEADER / CALL_CENTER_MANAGER
 * (contract §10, §11). Row shapes match docs/API_CONTRACT.md §10.1–10.5 field names verbatim.
 */
const ExcelJS = require('exceljs');
const prisma = require('../db');

const DAY_MS = 86400000;
const BACKUP_STALENESS_DAYS = Number(process.env.BACKUP_STALENESS_DAYS || 7);

const NOW = () => new Date();
const daysBetween = (from, to) => Math.floor((to.getTime() - from.getTime()) / DAY_MS);
const toDateOnly = (d) => (d ? d.toISOString().slice(0, 10) : null);

/** Report slugs → humanised column map (key → header) shared by the JSON table and the export. */
const REPORT_COLUMNS = {
  'who-has-what': [
    { key: 'employeeFullName', header: 'Employee' },
    { key: 'workIdentityName', header: 'Work identity' },
    { key: 'roomCode', header: 'Room' },
    { key: 'assetCode', header: 'Asset code' },
    { key: 'assetName', header: 'Asset name' },
    { key: 'categoryName', header: 'Category' },
    { key: 'assignmentCode', header: 'Assignment code' },
    { key: 'assignedAt', header: 'Assigned at' },
    { key: 'expectedReturnAt', header: 'Expected return at' },
  ],
  condition: [
    { key: 'categoryName', header: 'Category' },
    { key: 'condition', header: 'Condition' },
    { key: 'count', header: 'Count' },
  ],
  'backup-staleness': [
    { key: 'assetCode', header: 'Asset code' },
    { key: 'assetName', header: 'Asset name' },
    { key: 'wa1PhoneNumber', header: 'WA1 phone number' },
    { key: 'wa1BackupDate', header: 'WA1 backup date' },
    { key: 'wa1BackupUsedGB', header: 'WA1 backup used GB' },
    { key: 'daysSinceBackup', header: 'Days since backup' },
    { key: 'employeeFullName', header: 'Employee' },
    { key: 'workIdentityName', header: 'Work identity' },
  ],
  'outstanding-assignments': [
    { key: 'assignmentCode', header: 'Assignment code' },
    { key: 'type', header: 'Type' },
    { key: 'status', header: 'Status' },
    { key: 'employeeFullName', header: 'Employee' },
    { key: 'assetCode', header: 'Asset code' },
    { key: 'assignedAt', header: 'Assigned at' },
    { key: 'expectedReturnAt', header: 'Expected return at' },
    { key: 'daysOverdue', header: 'Days overdue' },
  ],
  'room-composition': [
    { key: 'roomCode', header: 'Room code' },
    { key: 'managerFullName', header: 'Manager' },
    { key: 'employeeFullName', header: 'Employee' },
    { key: 'workIdentityName', header: 'Work identity' },
    { key: 'assignedAssetCodes', header: 'Assigned asset codes' },
  ],
};

/**
 * Assignment room = workIdentity.roomId ?? employee.roomId (contract §11, plan gap 3),
 * matching the guard in assignments.routes.js loadScoped. Expressing "??" in Prisma:
 *   workIdentity is in that room, OR (no work identity AND the employee is in that room).
 */
const assignmentRoomFilter = (roomId) => ({
  OR: [{ workIdentity: { roomId } }, { workIdentity: { is: null }, employee: { roomId } }],
});

/** TEAM_LEADER scope → where fragment filtering an Assignment by its room.
 *  CALL_CENTER_MANAGER scope → any CALLCENTER room (workIdentity room, or employee room when no WIP). */
const assignmentRoomWhere = (scope) => {
  if (!scope) return {};
  if (scope.allCallCenter) {
    return {
      OR: [
        { workIdentity: { room: { teamType: 'CALLCENTER' } } },
        { workIdentity: { is: null }, employee: { room: { teamType: 'CALLCENTER' } } },
      ],
    };
  }
  return assignmentRoomFilter(scope.roomId);
};

const sliceForPage = (rows, { page, pageSize }) => {
  const skip = (page - 1) * pageSize;
  return rows.slice(skip, skip + pageSize);
};

// ───────────────────────────── who-has-what (§10.1) ─────────────────────────────
async function whoHasWhat(filters, scope) {
  const f = filters;
  const and = [{ status: 'ACTIVE' }];
  if (scope) {
    // TEAM_LEADER: forced to own room; CALL_CENTER_MANAGER: all CALLCENTER rooms (fail closed).
    and.push(assignmentRoomWhere(scope));
  } else if (f.scope === 'room' && f.roomId) {
    and.push(assignmentRoomFilter(f.roomId));
  } else if (f.scope === 'team' && f.departmentTeamId) {
    and.push({ employee: { departmentTeamId: f.departmentTeamId } });
  } else if (f.scope === 'category' && f.categoryId) {
    and.push({
      OR: [
        { asset: { categoryId: f.categoryId } },
        { asset: { category: { parentId: f.categoryId } } },
      ],
    });
  }

  const rows = await prisma.assignment.findMany({
    where: { AND: and },
    orderBy: [{ assignedAt: 'asc' }, { assignmentCode: 'asc' }],
    include: {
      employee: { include: { room: { select: { code: true } } } },
      workIdentity: { include: { room: { select: { code: true } } } },
      asset: {
        include: {
          room: { select: { code: true } },
          category: { select: { name: true } },
        },
      },
    },
  });

  const out = rows.map((a) => ({
    employeeFullName: a.employee?.fullName ?? null,
    workIdentityName: a.workIdentity?.name ?? null,
    roomCode: a.workIdentity?.room?.code ?? a.employee?.room?.code ?? a.asset?.room?.code ?? null,
    assetCode: a.asset?.code ?? null,
    assetName: a.asset?.name ?? null,
    categoryName: a.asset?.category?.name ?? null,
    assignmentCode: a.assignmentCode,
    assignedAt: a.assignedAt,
    expectedReturnAt: a.expectedReturnAt,
  }));

  return sliceForPage(out, f);
}

// ───────────────────────────── condition (§10.2) ─────────────────────────────
async function condition(filters, scope) {
  const f = filters;
  const where = scope ? (scope.allCallCenter ? { room: { teamType: 'CALLCENTER' } } : { roomId: scope.roomId }) : {};
  if (f.categoryId) where.categoryId = f.categoryId;
  // `status` filters by asset condition; when absent, exclude DISPOSED (plan R-premise: "all non-DISPOSED").
  where.condition = f.status || { not: 'DISPOSED' };

  const grouped = await prisma.asset.groupBy({
    by: ['categoryId', 'condition'],
    _count: { _all: true },
    where,
    orderBy: { categoryId: 'asc' },
  });

  const ids = [...new Set(grouped.map((g) => g.categoryId))];
  const cats = ids.length
    ? await prisma.assetCategory.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(cats.map((c) => [c.id, c.name]));

  const rows = grouped.map((g) => ({
    categoryName: nameById.get(g.categoryId) ?? null,
    condition: g.condition,
    count: g._count._all,
  }));

  return sliceForPage(rows, f);
}

// ───────────────────────────── backup-staleness (§10.3) ─────────────────────────────
async function backupStaleness(filters, scope) {
  const f = filters;
  const threshold = f.days !== undefined && f.days !== null ? f.days : BACKUP_STALENESS_DAYS;
  const now = NOW();

  const and = [
    { status: 'ACTIVE' },
    { type: 'PHONE' },
    { phoneDetail: { isNot: null } },
    { phoneDetail: { wa1BackupDate: { not: null } } },
    assignmentRoomWhere(scope),
  ];

  const rows = await prisma.assignment.findMany({
    where: { AND: and },
    include: {
      phoneDetail: { select: { wa1BackupDate: true, wa1PhoneNumber: true, wa1BackupUsedGB: true } },
      asset: { select: { code: true, name: true } },
      employee: { select: { fullName: true } },
      workIdentity: { select: { name: true } },
    },
  });

  const stale = rows
    .map((a) => ({
      assetCode: a.asset?.code ?? null,
      assetName: a.asset?.name ?? null,
      wa1PhoneNumber: a.phoneDetail?.wa1PhoneNumber ?? null,
      wa1BackupDate: toDateOnly(a.phoneDetail?.wa1BackupDate),
      wa1BackupUsedGB: a.phoneDetail?.wa1BackupUsedGB != null ? Number(a.phoneDetail.wa1BackupUsedGB) : null,
      daysSinceBackup: daysBetween(a.phoneDetail.wa1BackupDate, now),
      employeeFullName: a.employee?.fullName ?? null,
      workIdentityName: a.workIdentity?.name ?? null,
    }))
    .filter((r) => r.daysSinceBackup > threshold);

  return sliceForPage(stale, f);
}

// ───────────────────────────── outstanding-assignments (§10.4) ─────────────────────────────
async function outstandingAssignments(filters, scope) {
  const f = filters;
  const now = NOW();

  const and = [
    { status: 'ACTIVE' },
    { expectedReturnAt: { not: null } },
    { expectedReturnAt: { lt: now } },
    assignmentRoomWhere(scope),
  ];

  const rows = await prisma.assignment.findMany({
    where: { AND: and },
    orderBy: { expectedReturnAt: 'asc' },
    include: {
      employee: { select: { fullName: true } },
      asset: { select: { code: true } },
    },
  });

  const overdue = rows
    .map((a) => ({
      assignmentCode: a.assignmentCode,
      type: a.type,
      status: a.status,
      employeeFullName: a.employee?.fullName ?? null,
      assetCode: a.asset?.code ?? null,
      assignedAt: a.assignedAt,
      expectedReturnAt: a.expectedReturnAt,
      daysOverdue: daysBetween(a.expectedReturnAt, now),
    }))
    .filter((r) => (f.days !== undefined && f.days !== null ? r.daysOverdue >= f.days : true));

  return sliceForPage(overdue, f);
}

// ───────────────────────────── room-composition (§10.5) ─────────────────────────────
async function roomComposition(filters, scope) {
  const f = filters;
  // TEAM_LEADER forced to own room; CALL_CENTER_MANAGER all CALLCENTER rooms; otherwise the requested roomId (or all rooms).
  const roomFilter = scope ? (scope.allCallCenter ? { teamType: 'CALLCENTER' } : { id: scope.roomId }) : f.roomId ? { id: f.roomId } : {};

  const rooms = await prisma.room.findMany({
    where: roomFilter,
    orderBy: { code: 'asc' },
    include: {
      managerEmployee: { select: { fullName: true } },
      employees: { select: { fullName: true } },
      workIdentities: { select: { id: true, name: true } },
    },
  });

  // Aggregate active assignment asset codes per work identity.
  const wiIds = rooms.flatMap((r) => r.workIdentities.map((w) => w.id));
  const active = wiIds.length
    ? await prisma.assignment.findMany({
        where: { status: 'ACTIVE', workIdentityId: { in: wiIds } },
        select: { workIdentityId: true, asset: { select: { code: true } } },
      })
    : [];
  const codesByWi = new Map();
  for (const a of active) {
    if (!codesByWi.has(a.workIdentityId)) codesByWi.set(a.workIdentityId, []);
    if (a.asset?.code) codesByWi.get(a.workIdentityId).push(a.asset.code);
  }

  const rows = [];
  for (const r of rooms) {
    for (const e of r.employees) {
      rows.push({
        roomCode: r.code,
        managerFullName: r.managerEmployee?.fullName ?? null,
        employeeFullName: e.fullName,
        workIdentityName: null,
        assignedAssetCodes: [],
      });
    }
    for (const w of r.workIdentities) {
      rows.push({
        roomCode: r.code,
        managerFullName: r.managerEmployee?.fullName ?? null,
        employeeFullName: null,
        workIdentityName: w.name,
        assignedAssetCodes: codesByWi.get(w.id) || [],
      });
    }
  }

  return sliceForPage(rows, f);
}

const BUILDERS = {
  'who-has-what': whoHasWhat,
  condition,
  'backup-staleness': backupStaleness,
  'outstanding-assignments': outstandingAssignments,
  'room-composition': roomComposition,
};

// ───────────────────────────── export serializers ─────────────────────────────
const csvEscape = (v) => {
  const s = v == null ? '' : String(v);
  return /[\",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(rows, columns) {
  const header = columns.map((c) => c.header).join(',');
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c.key])).join(','));
  // UTF-8 BOM so Excel reads Turkish characters correctly; CRLF per RFC 4180.
  return '\uFEFF' + [header, ...body].join('\r\n') + '\r\n';
}

async function toXlsx(rows, columns) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Report');
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: 20 }));
  for (const r of rows) ws.addRow(r);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

async function buildRows(reportId, filters, scope) {
  if (!BUILDERS[reportId]) return null;
  return BUILDERS[reportId](filters, scope);
}

module.exports = {
  REPORT_COLUMNS,
  BACKUP_STALENESS_DAYS,
  whoHasWhat,
  condition,
  backupStaleness,
  outstandingAssignments,
  roomComposition,
  buildRows,
  toCsv,
  toXlsx,
};
