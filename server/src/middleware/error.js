'use strict';
const { ZodError } = require('zod');
const { Prisma } = require('@prisma/client');
const multer = require('multer');
const { AppError } = require('../utils/errors');
const config = require('../config');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Internal server error';
  let details;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Request validation failed';
    details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  } else if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR';
    message =
      err.code === 'LIMIT_FILE_SIZE' ? `File exceeds the ${config.MAX_UPLOAD_MB} MB limit` : `Upload error: ${err.message}`;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        status = 409;
        code = 'UNIQUE_VIOLATION';
        message = `Duplicate value for: ${[].concat(err.meta?.target ?? 'unique field').join(', ')}`;
        break;
      case 'P2003':
        status = 409;
        code = 'FK_VIOLATION';
        message = 'Operation violates a relation (record is referenced or reference is missing)';
        break;
      case 'P2025':
        status = 404;
        code = 'NOT_FOUND';
        message = 'Record not found';
        break;
      default:
        break;
    }
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Malformed JSON body';
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body too large';
  }

  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}`, err);

  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.originalUrl} not found` } });
}

module.exports = { errorHandler, notFoundHandler };
