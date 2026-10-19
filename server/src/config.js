'use strict';
require('dotenv').config();
const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().positive().default(7),
  CREDENTIALS_ENC_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'CREDENTIALS_ENC_KEY must be 64 hex chars (32 bytes). Generate: openssl rand -hex 32'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(5),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(20),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const i of parsed.error.issues) console.error(`  - ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}

const config = parsed.data;

if (config.NODE_ENV === 'production') {
  const problems = [];
  if (!config.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in production (HTTPS only)');
  if (/^0+$/.test(config.CREDENTIALS_ENC_KEY)) problems.push('CREDENTIALS_ENC_KEY must not be the all-zero placeholder');
  if (/change-me/i.test(config.JWT_ACCESS_SECRET)) problems.push('JWT_ACCESS_SECRET must not be the placeholder value');
  if (problems.length) {
    console.error('Unsafe production configuration:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
}

module.exports = {
  ...config,
  corsOrigins: config.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
  isProd: config.NODE_ENV === 'production',
  accessTtlSec: Math.round(config.ACCESS_TOKEN_TTL_MIN * 60),
  refreshTtlMs: Math.round(config.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000),
  maxUploadBytes: Math.round(config.MAX_UPLOAD_MB * 1024 * 1024),
};
