'use strict';
const prisma = require('../db');
const { badRequest } = require('../utils/errors');

/** Next human-friendly code for a prefix, e.g. PHN-000123 (per-prefix PostgreSQL sequence, created on demand). */
async function nextCode(prefix, tx = prisma) {
  if (!/^[A-Z]{2,5}$/.test(prefix)) throw new Error(`Invalid code prefix: ${prefix}`);
  const seq = `asset_code_seq_${prefix.toLowerCase()}`; // safe: validated above
  await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${seq}" START 1`);
  const [{ n }] = await tx.$queryRawUnsafe(`SELECT nextval('"${seq}"')::int AS n`);
  return `${prefix}-${String(n).padStart(6, '0')}`;
}

/** Make sure a sequence is at least `min` (used by the seed when explicit codes are inserted). */
async function bumpSequence(prefix, min) {
  const seq = `asset_code_seq_${prefix.toLowerCase()}`;
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${seq}" START 1`);
  await prisma.$queryRawUnsafe(`SELECT setval('"${seq}"', GREATEST($1::bigint, (SELECT last_value FROM "${seq}")))`, min);
}

/** Field definitions that apply to a category: its own plus the parent category's (subcategory inherits). */
async function fieldDefsFor(categoryId, tx = prisma) {
  const cat = await tx.assetCategory.findUnique({ where: { id: categoryId }, include: { parent: true } });
  if (!cat) return null;
  const ids = [cat.id, ...(cat.parentId ? [cat.parentId] : [])];
  const fields = await tx.assetCategoryField.findMany({ where: { categoryId: { in: ids } }, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] });
  return { category: cat, fields };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Validate & normalise one custom value against its definition. Returns the JSON value to store (null = clear). */
function coerceFieldValue(def, raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const fail = (msg) => badRequest(`Custom field "${def.key}": ${msg}`);
  switch (def.type) {
    case 'string':
    case 'textarea':
      if (typeof raw !== 'string') throw fail('must be a string');
      if (raw.length > (def.type === 'string' ? 500 : 5000)) throw fail('too long');
      return raw.trim();
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(n)) throw fail('must be a number');
      return n;
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 'false') return raw === 'true';
      throw fail('must be a boolean');
    case 'date':
      if (typeof raw !== 'string' || !ISO_DATE.test(raw) || Number.isNaN(Date.parse(raw))) throw fail('must be an ISO date (YYYY-MM-DD)');
      return raw;
    case 'select': {
      const opts = Array.isArray(def.options) ? def.options : [];
      if (typeof raw !== 'string' || !opts.includes(raw)) throw fail(`must be one of: ${opts.join(', ')}`);
      return raw;
    }
    default:
      throw fail('unsupported field type');
  }
}

/**
 * Validate a { key: value } map against the category definitions.
 * @param partial when true (PATCH) required-ness is only checked for keys being cleared.
 * @returns array of { fieldId, value } (value null => delete)
 */
function resolveCustomFields(fields, input, { partial, existing = {} }) {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const unknown = Object.keys(input ?? {}).filter((k) => !byKey.has(k));
  if (unknown.length) throw badRequest(`Unknown custom field(s) for this category: ${unknown.join(', ')}`);

  const out = [];
  for (const def of fields) {
    const provided = input && Object.prototype.hasOwnProperty.call(input, def.key);
    if (!provided) {
      if (!partial && def.required) throw badRequest(`Custom field "${def.key}" (${def.label}) is required`);
      continue;
    }
    const value = coerceFieldValue(def, input[def.key]);
    if (value === null && def.required) throw badRequest(`Custom field "${def.key}" (${def.label}) is required`);
    out.push({ fieldId: def.id, value });
  }
  return out;
}

async function writeCustomFields(tx, assetId, entries) {
  for (const { fieldId, value } of entries) {
    if (value === null) await tx.assetCustomFieldValue.deleteMany({ where: { assetId, fieldId } });
    else
      await tx.assetCustomFieldValue.upsert({
        where: { assetId_fieldId: { assetId, fieldId } },
        create: { assetId, fieldId, value },
        update: { value },
      });
  }
}

/** Shape EAV rows as { key: value } plus definitions. */
function shapeCustomFields(fields, values) {
  const byField = new Map(values.map((v) => [v.fieldId, v.value]));
  const map = {};
  for (const f of fields) map[f.key] = byField.get(f.id) ?? null;
  return map;
}

module.exports = { nextCode, bumpSequence, fieldDefsFor, resolveCustomFields, writeCustomFields, shapeCustomFields, coerceFieldValue };
