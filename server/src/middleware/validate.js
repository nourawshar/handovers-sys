'use strict';

/**
 * validate({ body, query, params }) — parses with Zod and replaces the request values with the parsed
 * (coerced, stripped) result. ZodError is handled by the central error handler.
 */
function validate(schemas) {
  return (req, res, next) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) req.validQuery = schemas.query.parse(req.query);
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      next();
    } catch (e) {
      next(e);
    }
  };
}

module.exports = { validate };
