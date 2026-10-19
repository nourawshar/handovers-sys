'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const config = require('./config');
const prisma = require('./db');
const { errorHandler, notFoundHandler } = require('./middleware/error');
const { authenticate } = require('./middleware/auth');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', config.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  if (config.NODE_ENV !== 'test') app.use(morgan(config.isProd ? 'combined' : 'dev'));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Public
  app.get('/health', async (req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'degraded' });
    }
  });
  app.use('/api/v1/auth', require('./routes/auth.routes'));

  // Everything below requires a valid session; each route then declares its capability (RBAC, §9).
  const api = express.Router();
  api.use(authenticate);
  api.use('/users', require('./routes/users.routes'));
  api.use('/asset-categories', require('./routes/categories.routes'));
  api.use('/assets', require('./routes/assets.routes'));
  api.use('/accounts', require('./routes/accounts.routes'));
  api.use('/photos', require('./routes/photos.routes'));
  api.use('/', require('./routes/lookups.routes')); // /rooms /departments /employees /work-identities (read-only, Phase 1)
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
