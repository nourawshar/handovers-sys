'use strict';
const { z } = require('zod');

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(25);

const paginationQuery = { page, pageSize };

function paginate({ page: p, pageSize: s }) {
  return { skip: (p - 1) * s, take: s };
}

function pageMeta({ page: p, pageSize: s }, total) {
  return { page: p, pageSize: s, total, totalPages: Math.max(1, Math.ceil(total / s)) };
}

const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

module.exports = { paginationQuery, paginate, pageMeta, boolQuery };
